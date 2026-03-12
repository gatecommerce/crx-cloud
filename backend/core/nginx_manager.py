"""Nginx reverse proxy manager — auto-configures per-instance virtual hosts.

Deploys Nginx config files to the remote server via SSH, handles SSL with
Let's Encrypt certbot, and manages reload/test.
"""

import asyncio
import base64
import os
import shutil
import tempfile
from dataclasses import dataclass, field

from loguru import logger


@dataclass
class NginxConfig:
    domain: str
    upstream_port: int
    instance_name: str
    ssl: bool = True
    aliases: list[str] = field(default_factory=list)
    http_redirect: bool = True


NGINX_HTTP_REDIRECT_TEMPLATE = """# CRX Cloud — {instance_name}
server {{
    listen 80;
    server_name {server_names};

    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {{
        root /var/www/certbot;
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}
"""

NGINX_HTTP_PASSTHROUGH_TEMPLATE = """# CRX Cloud — {instance_name} (HTTP passthrough)
server {{
    listen 80;
    server_name {server_names};

    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {{
        root /var/www/certbot;
    }}

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

NGINX_HTTPS_TEMPLATE = """# CRX Cloud — {instance_name} (SSL)
server {{
    listen 443 ssl http2;
    server_name {server_names};

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
    server_name {server_names};

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


def _safe_key_path(key_path: str) -> str:
    """Copy SSH key to a temp file with correct permissions (600).

    Fixes two Windows Docker volume issues:
    - Permissions: mounts show 0777, SSH rejects keys not 0600
    - Line endings: Windows writes CRLF, OpenSSH requires LF
    """
    if not key_path or not os.path.exists(key_path):
        return key_path
    safe_dir = os.path.join(tempfile.gettempdir(), "crx_ssh")
    os.makedirs(safe_dir, mode=0o700, exist_ok=True)
    safe_path = os.path.join(safe_dir, os.path.basename(key_path))
    # Read and strip CR (Windows CRLF -> Unix LF)
    with open(key_path, "rb") as f:
        content = f.read().replace(b"\r\n", b"\n")
    with open(safe_path, "wb") as f:
        f.write(content)
    os.chmod(safe_path, 0o600)
    return safe_path


def _ssh_args(host: str, user: str, key_path: str) -> list[str]:
    """Build SSH argument list."""
    args = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"]
    if key_path:
        args += ["-i", _safe_key_path(key_path)]
    args.append(f"{user}@{host}")
    return args


async def _ssh_exec(host: str, user: str, key_path: str, cmd: str) -> tuple[int, str]:
    """Execute command on remote server via SSH."""
    args = _ssh_args(host, user, key_path) + [cmd]
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    output = (stdout or b"").decode() + (stderr or b"").decode()
    return proc.returncode or 0, output.strip()


async def _ssh_write_file(host: str, user: str, key_path: str, remote_path: str, content: str) -> tuple[int, str]:
    """Write a file on the remote server via SSH using base64 to avoid shell escaping issues."""
    b64 = base64.b64encode(content.encode()).decode()
    cmd = f"echo {b64} | base64 -d > {remote_path}"
    return await _ssh_exec(host, user, key_path, cmd)


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

    # Build server_name string: primary domain + aliases
    server_names = domain
    if config.aliases:
        server_names += " " + " ".join(config.aliases)

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
            initial_conf = NGINX_HTTP_REDIRECT_TEMPLATE.format(
                instance_name=config.instance_name,
                server_names=server_names,
            ) + NGINX_NO_SSL_TEMPLATE.format(
                instance_name=config.instance_name,
                server_names=server_names,
                upstream_port=config.upstream_port,
                longpoll_port=longpoll_port,
            )
        else:
            initial_conf = NGINX_NO_SSL_TEMPLATE.format(
                instance_name=config.instance_name,
                server_names=server_names,
                upstream_port=config.upstream_port,
                longpoll_port=longpoll_port,
            )

        rc, out = await _ssh_write_file(
            host, ssh_user, ssh_key_path, conf_path, initial_conf
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
            # Build certbot -d flags for primary domain + all aliases
            certbot_domains = f"-d {domain}"
            for alias in config.aliases:
                certbot_domains += f" -d {alias}"

            logger.info(f"Requesting SSL certificate for {certbot_domains}")
            rc, out = await _ssh_exec(
                host, ssh_user, ssh_key_path,
                f"certbot certonly --nginx {certbot_domains} --non-interactive --agree-tos --email admin@{domain} 2>&1"
            )

            if rc == 0:
                # Choose HTTP block based on http_redirect setting
                if config.http_redirect:
                    http_block = NGINX_HTTP_REDIRECT_TEMPLATE.format(
                        instance_name=config.instance_name,
                        server_names=server_names,
                    )
                else:
                    http_block = NGINX_HTTP_PASSTHROUGH_TEMPLATE.format(
                        instance_name=config.instance_name,
                        server_names=server_names,
                        upstream_port=config.upstream_port,
                        longpoll_port=longpoll_port,
                    )

                # Write final HTTPS config
                final_conf = http_block + NGINX_HTTPS_TEMPLATE.format(
                    instance_name=config.instance_name,
                    server_names=server_names,
                    domain=domain,
                    upstream_port=config.upstream_port,
                    longpoll_port=longpoll_port,
                )
                await _ssh_write_file(
                    host, ssh_user, ssh_key_path, conf_path, final_conf
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


async def update_nginx(
    host: str,
    ssh_user: str,
    ssh_key_path: str,
    config: NginxConfig,
    old_domain: str = "",
) -> bool:
    """Update Nginx config for an instance (aliases, redirect, domain change).

    If old_domain differs from config.domain, removes old config first then sets up new.
    Otherwise, rewrites the config file in-place and reloads Nginx.
    """
    domain = config.domain
    if not domain:
        logger.info("No domain configured, skipping Nginx update")
        return True

    # Domain changed — remove old config, deploy fresh
    if old_domain and old_domain != domain:
        logger.info(f"Domain changed from {old_domain} to {domain}, replacing Nginx config")
        await remove_nginx(host, ssh_user, ssh_key_path, config.instance_name)
        return await setup_nginx(host, ssh_user, ssh_key_path, config)

    # Same domain — rewrite config with updated aliases/redirect and reload
    conf_name = f"crx-{config.instance_name}"
    conf_path = f"/etc/nginx/sites-available/{conf_name}"
    longpoll_port = config.upstream_port + 3

    server_names = domain
    if config.aliases:
        server_names += " " + " ".join(config.aliases)

    try:
        if config.ssl:
            # Check if SSL cert exists
            rc, _ = await _ssh_exec(
                host, ssh_user, ssh_key_path,
                f"test -f /etc/letsencrypt/live/{domain}/fullchain.pem"
            )
            if rc == 0:
                # SSL cert exists — write full HTTPS config
                if config.http_redirect:
                    http_block = NGINX_HTTP_REDIRECT_TEMPLATE.format(
                        instance_name=config.instance_name,
                        server_names=server_names,
                    )
                else:
                    http_block = NGINX_HTTP_PASSTHROUGH_TEMPLATE.format(
                        instance_name=config.instance_name,
                        server_names=server_names,
                        upstream_port=config.upstream_port,
                        longpoll_port=longpoll_port,
                    )

                conf_content = http_block + NGINX_HTTPS_TEMPLATE.format(
                    instance_name=config.instance_name,
                    server_names=server_names,
                    domain=domain,
                    upstream_port=config.upstream_port,
                    longpoll_port=longpoll_port,
                )
            else:
                # No SSL cert yet — HTTP-only with redirect for certbot
                conf_content = NGINX_HTTP_REDIRECT_TEMPLATE.format(
                    instance_name=config.instance_name,
                    server_names=server_names,
                ) + NGINX_NO_SSL_TEMPLATE.format(
                    instance_name=config.instance_name,
                    server_names=server_names,
                    upstream_port=config.upstream_port,
                    longpoll_port=longpoll_port,
                )
        else:
            conf_content = NGINX_NO_SSL_TEMPLATE.format(
                instance_name=config.instance_name,
                server_names=server_names,
                upstream_port=config.upstream_port,
                longpoll_port=longpoll_port,
            )

        rc, out = await _ssh_write_file(
            host, ssh_user, ssh_key_path, conf_path, conf_content
        )
        if rc != 0:
            logger.error(f"Failed to write updated Nginx config: {out}")
            return False

        # Test and reload
        rc, out = await _ssh_exec(host, ssh_user, ssh_key_path, "nginx -t 2>&1")
        if rc != 0:
            logger.error(f"Nginx config test failed after update: {out}")
            return False

        await _ssh_exec(host, ssh_user, ssh_key_path, "systemctl reload nginx")
        logger.info(f"Nginx config updated for {domain} (aliases={config.aliases}, redirect={config.http_redirect})")
        return True

    except Exception as e:
        logger.error(f"Nginx update failed for {domain}: {e}")
        return False
