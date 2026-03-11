"""Nginx reverse proxy manager — auto-configures per-instance virtual hosts.

Deploys Nginx config files to the remote server via SSH, handles SSL with
Let's Encrypt certbot, and manages reload/test.
"""

import asyncio
from dataclasses import dataclass

from loguru import logger


@dataclass
class NginxConfig:
    domain: str
    upstream_port: int
    instance_name: str
    ssl: bool = True


NGINX_HTTP_TEMPLATE = """# CRX Cloud — {instance_name}
server {{
    listen 80;
    server_name {domain};

    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {{
        root /var/www/certbot;
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}
"""

NGINX_HTTPS_TEMPLATE = """# CRX Cloud — {instance_name} (SSL)
server {{
    listen 443 ssl http2;
    server_name {domain};

    ssl_certificate /etc/letsencrypt/live/{domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{domain}/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Proxy settings
    proxy_read_timeout 720s;
    proxy_connect_timeout 720s;
    proxy_send_timeout 720s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket support (Odoo live chat)
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Gzip
    gzip on;
    gzip_types text/css text/plain text/xml application/xml application/javascript application/json;

    # Max upload size
    client_max_body_size 200m;

    # Odoo longpolling
    location /longpolling {{
        proxy_pass http://127.0.0.1:{longpoll_port};
    }}

    location / {{
        proxy_pass http://127.0.0.1:{upstream_port};
        proxy_redirect off;
    }}

    # Static file caching
    location ~* /web/static/ {{
        proxy_pass http://127.0.0.1:{upstream_port};
        proxy_cache_valid 200 60m;
        expires 24h;
        add_header Cache-Control "public, immutable";
    }}
}}
"""

NGINX_NO_SSL_TEMPLATE = """# CRX Cloud — {instance_name} (no SSL)
server {{
    listen 80;
    server_name {domain};

    proxy_read_timeout 720s;
    proxy_connect_timeout 720s;
    proxy_send_timeout 720s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    client_max_body_size 200m;

    location /longpolling {{
        proxy_pass http://127.0.0.1:{longpoll_port};
    }}

    location / {{
        proxy_pass http://127.0.0.1:{upstream_port};
        proxy_redirect off;
    }}
}}
"""


async def _ssh_exec(host: str, user: str, key_path: str, cmd: str) -> tuple[int, str]:
    """Execute command on remote server via SSH."""
    ssh_opts = "-o StrictHostKeyChecking=no -o ConnectTimeout=10"
    if key_path:
        ssh_opts += f" -i {key_path}"

    full_cmd = f'ssh {ssh_opts} {user}@{host} "{cmd}"'
    proc = await asyncio.create_subprocess_shell(
        full_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    output = (stdout or b"").decode() + (stderr or b"").decode()
    return proc.returncode or 0, output.strip()


async def setup_nginx(
    host: str,
    ssh_user: str,
    ssh_key_path: str,
    config: NginxConfig,
) -> bool:
    """Deploy Nginx reverse proxy config for an instance.

    Steps:
    1. Ensure Nginx is installed
    2. Write server block config
    3. Test Nginx config
    4. Obtain SSL cert if domain provided
    5. Reload Nginx
    """
    domain = config.domain
    if not domain:
        logger.info("No domain configured, skipping Nginx setup")
        return True

    conf_name = f"crx-{config.instance_name}"
    conf_path = f"/etc/nginx/sites-available/{conf_name}"
    longpoll_port = config.upstream_port + 3  # Odoo longpolling convention

    try:
        # 1. Ensure Nginx is installed
        rc, _ = await _ssh_exec(host, ssh_user, ssh_key_path, "which nginx")
        if rc != 0:
            logger.info(f"Installing Nginx on {host}")
            rc, out = await _ssh_exec(
                host, ssh_user, ssh_key_path,
                "apt-get update -qq && apt-get install -y -qq nginx certbot python3-certbot-nginx"
            )
            if rc != 0:
                logger.error(f"Failed to install Nginx: {out}")
                return False

        # 2. Write initial HTTP-only config (needed for certbot challenge)
        if config.ssl:
            initial_conf = NGINX_HTTP_TEMPLATE.format(
                instance_name=config.instance_name,
                domain=domain,
            ) + NGINX_NO_SSL_TEMPLATE.format(
                instance_name=config.instance_name,
                domain=domain,
                upstream_port=config.upstream_port,
                longpoll_port=longpoll_port,
            )
        else:
            initial_conf = NGINX_NO_SSL_TEMPLATE.format(
                instance_name=config.instance_name,
                domain=domain,
                upstream_port=config.upstream_port,
                longpoll_port=longpoll_port,
            )

        # Escape for shell
        escaped = initial_conf.replace("'", "'\\''")
        rc, out = await _ssh_exec(
            host, ssh_user, ssh_key_path,
            f"echo '{escaped}' > {conf_path}"
        )
        if rc != 0:
            logger.error(f"Failed to write Nginx config: {out}")
            return False

        # Enable site
        await _ssh_exec(
            host, ssh_user, ssh_key_path,
            f"ln -sf {conf_path} /etc/nginx/sites-enabled/{conf_name}"
        )

        # 3. Test config
        rc, out = await _ssh_exec(host, ssh_user, ssh_key_path, "nginx -t 2>&1")
        if rc != 0:
            logger.error(f"Nginx config test failed: {out}")
            return False

        # Reload with initial config
        await _ssh_exec(host, ssh_user, ssh_key_path, "systemctl reload nginx")
        logger.info(f"Nginx HTTP config deployed for {domain}")

        # 4. SSL with certbot (if requested)
        if config.ssl:
            logger.info(f"Requesting SSL certificate for {domain}")
            rc, out = await _ssh_exec(
                host, ssh_user, ssh_key_path,
                f"certbot certonly --nginx -d {domain} --non-interactive --agree-tos --email admin@{domain} 2>&1"
            )

            if rc == 0:
                # Write final HTTPS config
                final_conf = NGINX_HTTP_TEMPLATE.format(
                    instance_name=config.instance_name,
                    domain=domain,
                ) + NGINX_HTTPS_TEMPLATE.format(
                    instance_name=config.instance_name,
                    domain=domain,
                    upstream_port=config.upstream_port,
                    longpoll_port=longpoll_port,
                )
                escaped = final_conf.replace("'", "'\\''")
                await _ssh_exec(
                    host, ssh_user, ssh_key_path,
                    f"echo '{escaped}' > {conf_path}"
                )

                # Test and reload
                rc2, out2 = await _ssh_exec(host, ssh_user, ssh_key_path, "nginx -t 2>&1")
                if rc2 == 0:
                    await _ssh_exec(host, ssh_user, ssh_key_path, "systemctl reload nginx")
                    logger.info(f"SSL configured for {domain}")
                else:
                    logger.warning(f"SSL config test failed, keeping HTTP: {out2}")
            else:
                logger.warning(f"Certbot failed for {domain}, keeping HTTP-only: {out}")

        return True

    except Exception as e:
        logger.error(f"Nginx setup failed for {domain}: {e}")
        return False


async def remove_nginx(
    host: str,
    ssh_user: str,
    ssh_key_path: str,
    instance_name: str,
) -> bool:
    """Remove Nginx config for an instance."""
    conf_name = f"crx-{instance_name}"
    try:
        await _ssh_exec(
            host, ssh_user, ssh_key_path,
            f"rm -f /etc/nginx/sites-enabled/{conf_name} /etc/nginx/sites-available/{conf_name}"
        )
        rc, out = await _ssh_exec(host, ssh_user, ssh_key_path, "nginx -t 2>&1")
        if rc == 0:
            await _ssh_exec(host, ssh_user, ssh_key_path, "systemctl reload nginx")
        logger.info(f"Nginx config removed for {instance_name}")
        return True
    except Exception as e:
        logger.error(f"Failed to remove Nginx config for {instance_name}: {e}")
        return False
