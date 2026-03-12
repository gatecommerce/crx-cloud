"""Odoo CMS plugin driver — Docker-based deployment on VM servers."""

from __future__ import annotations

import asyncio
import uuid
from loguru import logger

from plugins.base import CMSPlugin, CMSInstance
from core.server_manager import ServerInfo, ServerStatus
from core.vm_controller import VMDriver


class OdooPlugin(CMSPlugin):
    plugin_id = "odoo"
    plugin_name = "Odoo"
    supported_versions = ["19.0", "18.0", "17.0", "16.0"]

    def __init__(self):
        self.vm_driver = VMDriver()

    def _instance_prefix(self, instance_id: str) -> str:
        return f"crx-odoo-{instance_id[:8]}"

    def _compose_content(self, instance_id: str, config: dict) -> str:
        """Generate docker-compose.yml for an Odoo instance."""
        prefix = self._instance_prefix(instance_id)
        version = config.get("version", "19.0")
        port = config.get("port", 8069)
        workers = config.get("workers", 2)
        ram_mb = config.get("ram_mb", 1024)
        db_password = config.get("db_password", uuid.uuid4().hex[:16])
        admin_password = config.get("admin_password", uuid.uuid4().hex[:16])
        instance_name = config.get("name", "odoo")
        db_name = config.get("db_name", instance_name)
        language = config.get("language", "en_US")
        use_external_db = config.get("use_external_db", False)
        enterprise = config.get("enterprise", False)

        # External DB connection params
        ext_db_host = config.get("external_db_host", "")
        ext_db_port = config.get("external_db_port", 5432)
        ext_db_name = config.get("external_db_name", "postgres")
        ext_db_user = config.get("external_db_user", "odoo")
        ext_db_password = config.get("external_db_password", db_password)

        mem_limit = f"{ram_mb}m"
        db_mem = f"{max(256, ram_mb // 2)}m"

        # Resolve DB connection details based on mode
        if use_external_db:
            db_host = ext_db_host
            db_port = ext_db_port
            db_user = ext_db_user
            db_pass = ext_db_password
            env_host = ext_db_host
            env_port = str(ext_db_port)
        else:
            db_host = f"{prefix}-db"
            db_port = 5432
            db_user = "odoo"
            db_pass = db_password
            env_host = f"{prefix}-db"
            env_port = "5432"

        # Build Odoo command line
        # NOTE: Do NOT include --database here — Odoo auto-creates and initializes
        # the DB on startup when --database is set, bypassing our JSONRPC create_database
        # which properly handles demo data, language, and admin password.
        # The dbfilter in odoo.conf handles DB selection after creation.
        cmd_parts = [
            f"-- --workers={workers}",
            f"--limit-memory-hard={ram_mb * 1024 * 1024}",
            f"--limit-memory-soft={int(ram_mb * 0.8) * 1024 * 1024}",
            f"--db_host={db_host}",
            f"--db_port={db_port}",
            f"--db_user={db_user}",
            f"--db_password={db_pass}",
            "--proxy-mode",
        ]

        # Enterprise addons path must come BEFORE community addons (Odoo requirement)
        if enterprise:
            cmd_parts.append("--addons-path=/mnt/enterprise-addons,/mnt/extra-addons")

        # Odoo config file (admin_passwd can only be set via conf in Odoo 17+)
        addons_path_conf = ""
        if enterprise:
            addons_path_conf = "addons_path = /mnt/enterprise-addons,/mnt/extra-addons\n"

        odoo_conf = (
            f"[options]\n"
            f"admin_passwd = {admin_password}\n"
            f"db_host = {db_host}\n"
            f"db_port = {db_port}\n"
            f"db_user = {db_user}\n"
            f"db_password = {db_pass}\n"
            f"dbfilter = ^{db_name}$\n"
            f"{addons_path_conf}"
        )

        command_str = " ".join(cmd_parts)

        # Build YAML directly with explicit indentation (2-space standard)
        lines = [
            "services:",
            "  odoo:",
            f"    image: odoo:{version}",
            f"    container_name: {prefix}-odoo",
            "    restart: unless-stopped",
            "    ports:",
            f'      - "{port}:8069"',
            f'      - "{port + 3}:8072"',
            "    environment:",
            f"      - HOST={env_host}",
            f"      - PORT={env_port}",
            f"      - USER={db_user}",
            f"      - PASSWORD={db_pass}",
            "    volumes:",
            f"      - {prefix}-data:/var/lib/odoo",
            f"      - {prefix}-addons:/mnt/extra-addons",
            f"      - ./odoo.conf:/etc/odoo/odoo.conf:ro",
        ]

        if enterprise:
            lines.append(f"      - /opt/crx-cloud/enterprise/{version}/addons:/mnt/enterprise-addons:ro")

        if not use_external_db:
            lines += [
                "    depends_on:",
                "      db:",
                "        condition: service_healthy",
            ]

        lines += [
            "    deploy:",
            "      resources:",
            "        limits:",
            f"          memory: {mem_limit}",
            f"    command: >-",
            f"      {command_str}",
        ]

        # DB service (local only)
        if not use_external_db:
            lines += [
                "  db:",
                "    image: postgres:16-alpine",
                f"    container_name: {prefix}-db",
                "    restart: unless-stopped",
                "    environment:",
                "      POSTGRES_USER: odoo",
                f"      POSTGRES_PASSWORD: {db_password}",
                "      POSTGRES_DB: postgres",
                "    volumes:",
                f"      - {prefix}-pgdata:/var/lib/postgresql/data",
                "    deploy:",
                "      resources:",
                "        limits:",
                f"          memory: {db_mem}",
                "    healthcheck:",
                '      test: ["CMD-SHELL", "pg_isready -U odoo"]',
                "      interval: 10s",
                "      timeout: 5s",
                "      retries: 5",
            ]

        # Volumes
        lines += [
            "volumes:",
            f"  {prefix}-data:",
            f"  {prefix}-addons:",
        ]
        if not use_external_db:
            lines.append(f"  {prefix}-pgdata:")

        return "\n".join(lines) + "\n", odoo_conf

    def _server_info(self, server_id: str, endpoint: str, metadata: dict) -> ServerInfo:
        return ServerInfo(
            id=server_id,
            name=f"server-{server_id[:8]}",
            server_type="vm",
            provider="",
            status=ServerStatus.ONLINE,
            endpoint=endpoint,
            metadata=metadata,
        )

    async def _rpc_create_db(self, server: ServerInfo, port: int, master_pwd: str,
                             db_name: str, language: str, password: str,
                             demo: bool = False, country: str = "") -> bool:
        """Create Odoo database via JSONRPC — same API used by the web wizard.

        This properly sets: demo flag in DB, admin language, admin password, country.
        Much more reliable than CLI for demo data + language.

        NOTE: Can take 1-5 minutes, so we use 600s SSH timeout.
        """
        import json as _json
        payload = _json.dumps({
            "jsonrpc": "2.0",
            "method": "call",
            "params": {
                "service": "db",
                "method": "create_database",
                "args": [master_pwd, db_name, demo, language, password, "admin",
                         country or False, ""]
            }
        })
        cmd = (
            f"curl -s -X POST http://localhost:{port}/jsonrpc "
            f"-H 'Content-Type: application/json' "
            f"-d '{payload}' --max-time 600"
        )
        logger.info(f"JSONRPC create_database: db={db_name}, lang={language}, demo={demo}, country={country}")
        result = await self.vm_driver._ssh_exec(server, cmd, timeout=600)
        logger.info(f"JSONRPC create_database result: {result.strip()[:500]}")
        try:
            data = _json.loads(result)
            if data.get("error"):
                logger.error(f"JSONRPC create_database error: {data['error']}")
                return False
            return True
        except Exception as e:
            logger.error(f"JSONRPC create_database parse error: {e}, raw={result[:200]}")
            return False

    async def _set_admin_password(self, server: ServerInfo, prefix: str, db_name: str, port: int, password: str) -> None:
        """Set admin user password via Odoo JSONRPC (uses ORM so hash is always correct)."""
        import json as _json
        try:
            # Authenticate with default password 'admin' first
            auth_payload = _json.dumps({
                "jsonrpc": "2.0", "method": "call",
                "params": {"service": "common", "method": "authenticate",
                           "args": [db_name, "admin", "admin", {}]}
            })
            auth_cmd = (
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{auth_payload}'"
            )
            result = await self.vm_driver._ssh_exec(server, auth_cmd)
            auth_data = _json.loads(result)
            uid = auth_data.get("result")
            if not uid:
                logger.warning(f"Cannot auth as admin to set password (uid={uid})")
                return

            # Change password via ORM write
            write_payload = _json.dumps({
                "jsonrpc": "2.0", "method": "call",
                "params": {"service": "object", "method": "execute",
                           "args": [db_name, uid, "admin", "res.users", "write",
                                    [uid], {"password": password}]}
            })
            write_cmd = (
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{write_payload}'"
            )
            result = await self.vm_driver._ssh_exec(server, write_cmd)
            write_data = _json.loads(result)
            if write_data.get("result"):
                logger.info(f"Admin password changed for '{db_name}' via JSONRPC")
            else:
                logger.warning(f"Password change failed: {write_data}")
        except Exception as e:
            logger.warning(f"Failed to set admin password: {e}")

    async def deploy(self, server_id: str, config: dict) -> CMSInstance:
        """Deploy Odoo via Docker Compose on a VM server."""
        instance_id = str(uuid.uuid4())
        prefix = self._instance_prefix(instance_id)
        version = config.get("version", "19.0")
        port = config.get("port", 8069)
        endpoint = config.get("endpoint", "")
        ssh_meta = config.get("ssh_metadata", {})

        # Extract new enterprise config fields with defaults
        admin_password = config.get("admin_password", uuid.uuid4().hex[:16])
        db_password = config.get("db_password", uuid.uuid4().hex[:16])
        db_name = config.get("db_name", config.get("name", "odoo"))
        language = config.get("language", "en_US")
        country = config.get("country", "")
        use_external_db = config.get("use_external_db", False)
        edition = config.get("edition", "community")
        demo_data = config.get("demo_data", False)

        # Ensure passwords are in config for _compose_content
        config_with_defaults = {**config}
        config_with_defaults.setdefault("admin_password", admin_password)
        config_with_defaults.setdefault("db_password", db_password)
        config_with_defaults.setdefault("db_name", db_name)
        config_with_defaults.setdefault("language", language)
        config_with_defaults.setdefault("use_external_db", use_external_db)

        server = self._server_info(server_id, endpoint, ssh_meta)
        compose, odoo_conf = self._compose_content(instance_id, config_with_defaults)

        logger.info(f"Deploying Odoo {version} ({edition}) as {prefix} on {endpoint}:{port}")

        deploy_dir = f"/opt/crx-cloud/instances/{prefix}"
        await self.vm_driver._ssh_exec(
            server,
            f"mkdir -p {deploy_dir} && cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
        )
        # Write odoo.conf (master password + db filter)
        await self.vm_driver._ssh_exec(
            server,
            f"cat > {deploy_dir}/odoo.conf << 'CONFEOF'\n{odoo_conf}CONFEOF"
        )

        await self.vm_driver._ssh_exec(
            server,
            f"cd {deploy_dir} && docker compose pull && docker compose up -d"
        )

        # Wait for Odoo to become healthy (up to 90s)
        logger.info(f"Waiting for Odoo {prefix} to start on port {port}...")
        for attempt in range(18):  # 18 * 5s = 90s
            await asyncio.sleep(5)
            result = await self.vm_driver._ssh_exec(
                server,
                f"curl -s -o /dev/null -w '%{{http_code}}' http://localhost:{port}/web/login 2>/dev/null || echo 000"
            )
            code = result.strip().split("\n")[-1]
            if code in ("200", "303"):
                logger.info(f"Odoo {prefix} is healthy (HTTP {code}) after {(attempt+1)*5}s")
                break
            # Check if container is crashing
            container_status = await self.vm_driver._ssh_exec(
                server,
                f"docker inspect --format='{{{{.State.Status}}}}' {prefix}-odoo 2>/dev/null || echo unknown"
            )
            if "exited" in container_status or "dead" in container_status:
                logs = await self.vm_driver._ssh_exec(server, f"docker logs {prefix}-odoo --tail 5 2>&1")
                raise RuntimeError(f"Odoo container crashed: {logs}")
        else:
            logger.warning(f"Odoo {prefix} did not become healthy within 90s, marking as running anyway")

        # Auto-create database so user lands on login page, not setup wizard
        # Strategy: JSONRPC create_database (same API as web wizard) — properly handles
        # demo flag, language, admin password, and country in one call.
        logger.info(f"Creating database '{db_name}' on {prefix} (lang={language}, demo={demo_data})...")
        try:
            db_created = await self._rpc_create_db(
                server, port, admin_password, db_name,
                language, admin_password, demo_data, country
            )
            if db_created:
                logger.info(f"Database '{db_name}' created via JSONRPC (demo={demo_data}, lang={language})")
            else:
                logger.warning(f"JSONRPC create_database failed for '{db_name}'")

        except Exception as e:
            logger.warning(f"Database auto-create failed: {e}, user will see setup wizard")

        logger.info(f"Odoo {version} deployed: {prefix} on port {port}")

        return CMSInstance(
            id=instance_id,
            cms_type="odoo",
            version=version,
            name=config.get("name", f"odoo-{version}"),
            server_id=server_id,
            url=f"http://{endpoint}:{port}",
            status="running",
            config={
                "port": port,
                "deploy_dir": deploy_dir,
                "prefix": prefix,
                "workers": config.get("workers", 2),
                "admin_password": admin_password,
                "db_password": db_password,
                "db_name": db_name,
                "language": language,
                "country": country,
                "edition": edition,
                "demo_data": demo_data,
                "use_external_db": use_external_db,
            },
        )

    async def configure(self, instance: CMSInstance, settings: dict) -> bool:
        logger.info(f"Configuring Odoo {instance.id}: {settings}")
        return True

    async def start(self, instance: CMSInstance) -> bool:
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)
            await self.vm_driver._ssh_exec(server, f"cd {deploy_dir} && docker compose start")
            return True
        except Exception as e:
            logger.error(f"Failed to start Odoo {instance.id}: {e}")
            return False

    async def stop(self, instance: CMSInstance) -> bool:
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)
            await self.vm_driver._ssh_exec(server, f"cd {deploy_dir} && docker compose stop")
            return True
        except Exception as e:
            logger.error(f"Failed to stop Odoo {instance.id}: {e}")
            return False

    async def restart(self, instance: CMSInstance) -> bool:
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)
            await self.vm_driver._ssh_exec(server, f"cd {deploy_dir} && docker compose restart odoo")
            return True
        except Exception as e:
            logger.error(f"Failed to restart Odoo {instance.id}: {e}")
            return False

    async def backup(self, instance: CMSInstance) -> str:
        """Backup Odoo: pg_dump + filestore."""
        try:
            prefix = instance.config.get("prefix", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            backup_id = uuid.uuid4().hex[:12]
            backup_dir = f"/opt/crx-cloud/backups/{prefix}/{backup_id}"

            await self.vm_driver._ssh_exec(
                server,
                f"mkdir -p {backup_dir} && "
                f"docker exec {prefix}-db pg_dump -U odoo -Fc postgres > {backup_dir}/db.dump && "
                f"docker cp {prefix}-odoo:/var/lib/odoo/filestore {backup_dir}/filestore 2>/dev/null || true"
            )

            logger.info(f"Backup {backup_id} created for {prefix}")
            return backup_dir
        except Exception as e:
            logger.error(f"Backup failed for {instance.id}: {e}")
            return ""

    async def restore(self, instance: CMSInstance, backup_id: str) -> bool:
        try:
            prefix = instance.config.get("prefix", "")
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose stop odoo && "
                f"docker exec -i {prefix}-db pg_restore -U odoo -d postgres --clean --if-exists < {backup_id}/db.dump && "
                f"docker compose start odoo"
            )
            logger.info(f"Restored {prefix} from {backup_id}")
            return True
        except Exception as e:
            logger.error(f"Restore failed for {instance.id}: {e}")
            return False

    async def health_check(self, instance: CMSInstance) -> dict:
        try:
            port = instance.config.get("port", 8069)
            prefix = instance.config.get("prefix", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            result = await self.vm_driver._ssh_exec(
                server,
                f"curl -sf --max-time 5 http://127.0.0.1:{port}/web/health 2>/dev/null || echo 'FAIL'; "
                f"docker inspect {prefix}-odoo --format '{{{{.State.Status}}}}' 2>/dev/null || echo 'missing'"
            )
            lines = result.strip().split("\n")
            http_ok = lines[0] != "FAIL" if lines else False
            container_status = lines[1] if len(lines) > 1 else "unknown"

            return {
                "status": "healthy" if http_ok else "unhealthy",
                "http_ok": http_ok,
                "container": container_status,
                "port": port,
            }
        except Exception as e:
            return {"status": "error", "error": str(e)}

    async def get_info(self, instance: CMSInstance) -> dict:
        return {
            "cms_type": "odoo",
            "version": instance.version,
            "port": instance.config.get("port", 8069),
            "workers": instance.config.get("workers", 2),
            "deploy_dir": instance.config.get("deploy_dir", ""),
            "prefix": instance.config.get("prefix", ""),
        }

    async def install_module(self, instance: CMSInstance, module: str) -> bool:
        try:
            prefix = instance.config.get("prefix", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            await self.vm_driver._ssh_exec(
                server,
                f"docker exec {prefix}-odoo odoo -d postgres -i {module} --stop-after-init"
            )
            logger.info(f"Installed module {module} on {prefix}")
            return True
        except Exception as e:
            logger.error(f"Module install failed: {e}")
            return False

    async def remove(self, instance: CMSInstance) -> bool:
        """Remove Odoo instance completely."""
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose down -v && rm -rf {deploy_dir}"
            )
            logger.info(f"Removed Odoo instance {instance.id}")
            return True
        except Exception as e:
            logger.error(f"Failed to remove {instance.id}: {e}")
            return False

    async def update_compose(self, instance: CMSInstance, new_config: dict) -> bool:
        """Regenerate docker-compose.yml and restart with new config."""
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            # Merge new_config into existing instance config
            merged_config = {**instance.config, **new_config}
            compose, odoo_conf = self._compose_content(instance.id, merged_config)

            # Write updated docker-compose.yml
            await self.vm_driver._ssh_exec(
                server,
                f"cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
            )
            # Write updated odoo.conf
            await self.vm_driver._ssh_exec(
                server,
                f"cat > {deploy_dir}/odoo.conf << 'CONFEOF'\n{odoo_conf}CONFEOF"
            )

            # Apply changes — Docker recreates only changed services
            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose up -d"
            )

            logger.info(f"Updated compose for {instance.id} with config: {list(new_config.keys())}")
            return True
        except Exception as e:
            logger.error(f"Failed to update compose for {instance.id}: {e}")
            return False

    async def sync_enterprise_addons(self, server: ServerInfo, version: str, package_path: str) -> bool:
        """Upload and extract enterprise addons on the remote server.

        Steps:
        1. SCP the tar.gz to server
        2. Extract it
        3. Find the addons directory (odoo-XX.X+e.../odoo/addons/)
        4. Symlink/copy to /opt/crx-cloud/enterprise/{version}/addons/
        """
        base_dir = f"/opt/crx-cloud/enterprise/{version}"
        addons_dir = f"{base_dir}/addons"
        try:
            # Create base directory
            await self.vm_driver._ssh_exec(server, f"mkdir -p {base_dir}")

            # SCP the package to the server
            ssh_user = server.metadata.get("ssh_user", "root")
            ssh_key = server.metadata.get("ssh_key_path", "")
            key_opt = f"-i {ssh_key}" if ssh_key else ""

            import subprocess
            scp_cmd = f"scp {key_opt} -o StrictHostKeyChecking=no {package_path} {ssh_user}@{server.endpoint}:{base_dir}/"
            logger.info(f"SCP enterprise package to {server.endpoint}:{base_dir}/")
            proc = await asyncio.to_thread(
                subprocess.run, scp_cmd, shell=True, capture_output=True, text=True, timeout=600
            )
            if proc.returncode != 0:
                logger.error(f"SCP failed: {proc.stderr}")
                return False

            # Get filename on server
            import os
            remote_file = f"{base_dir}/{os.path.basename(package_path)}"

            # Extract and find addons directory
            # Odoo enterprise tar.gz structure: odoo-19.0+e.YYYYMMDD/odoo/addons/
            extract_script = f"""
cd {base_dir} && \\
rm -rf addons extract_tmp && \\
mkdir -p extract_tmp && \\
tar xzf {remote_file} -C extract_tmp && \\
ODOO_DIR=$(find extract_tmp -maxdepth 1 -type d -name 'odoo*' | head -1) && \\
if [ -d "$ODOO_DIR/odoo/addons" ]; then
    mv "$ODOO_DIR/odoo/addons" addons
elif [ -d "$ODOO_DIR/addons" ]; then
    mv "$ODOO_DIR/addons" addons
elif [ -d "$ODOO_DIR" ]; then
    mv "$ODOO_DIR" addons
fi && \\
rm -rf extract_tmp && \\
ADDON_COUNT=$(ls -1d addons/*/  2>/dev/null | wc -l) && \\
echo "ENTERPRISE_ADDONS_OK count=$ADDON_COUNT"
"""
            result = await self.vm_driver._ssh_exec(server, extract_script, timeout=300)
            if "ENTERPRISE_ADDONS_OK" not in result:
                logger.error(f"Enterprise extraction failed: {result}")
                return False

            logger.info(f"Enterprise addons extracted on {server.endpoint}: {result.strip()}")
            return True
        except Exception as e:
            logger.error(f"Failed to sync enterprise addons for v{version}: {e}")
            return False

    async def enable_enterprise(self, instance: CMSInstance) -> bool:
        """Enable enterprise on a running instance.

        Steps:
        1. Update docker-compose + odoo.conf with enterprise addons path
        2. Restart container
        3. Trigger Odoo to update apps list
        4. Install web_enterprise module
        """
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            port = instance.config.get("port", 8069)
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)
            db_name = instance.config.get("db_name", instance.name)
            admin_password = instance.config.get("admin_password", "admin")

            # 1. Regenerate compose + conf with enterprise=True
            merged_config = {**instance.config, "enterprise": True}
            compose, odoo_conf = self._compose_content(instance.id, merged_config)

            await self.vm_driver._ssh_exec(
                server,
                f"cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
            )
            await self.vm_driver._ssh_exec(
                server,
                f"cat > {deploy_dir}/odoo.conf << 'CONFEOF'\n{odoo_conf}CONFEOF"
            )

            # 2. Restart with new config
            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose up -d"
            )

            # 3. Wait for Odoo to be ready
            for i in range(30):
                await asyncio.sleep(5)
                check = await self.vm_driver._ssh_exec(
                    server,
                    f"curl -s -o /dev/null -w '%{{http_code}}' http://localhost:{port}/web/login"
                )
                if "200" in check:
                    break
            else:
                logger.warning("Odoo not ready after 150s, proceeding anyway")

            # 4. Update module list via JSONRPC
            import json as _json
            update_payload = _json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "call",
                "params": {
                    "service": "object", "method": "execute_kw",
                    "args": [db_name, 2, admin_password, "ir.module.module", "update_list", []]
                }
            })
            await self.vm_driver._ssh_exec(
                server,
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{update_payload}' --max-time 120",
                timeout=120
            )
            logger.info(f"Updated module list for {instance.name}")

            # 5. Install web_enterprise module
            # First find the module ID
            find_payload = _json.dumps({
                "jsonrpc": "2.0", "id": 2, "method": "call",
                "params": {
                    "service": "object", "method": "execute_kw",
                    "args": [db_name, 2, admin_password, "ir.module.module", "search_read",
                             [[["name", "=", "web_enterprise"]]],
                             {"fields": ["id", "state"], "limit": 1}]
                }
            })
            result = await self.vm_driver._ssh_exec(
                server,
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{find_payload}' --max-time 30",
                timeout=30
            )
            logger.info(f"web_enterprise lookup: {result[:200]}")

            # Install the module via button_immediate_install
            install_payload = _json.dumps({
                "jsonrpc": "2.0", "id": 3, "method": "call",
                "params": {
                    "service": "object", "method": "execute_kw",
                    "args": [db_name, 2, admin_password, "ir.module.module", "search",
                             [[["name", "=", "web_enterprise"]]]]
                }
            })
            result = await self.vm_driver._ssh_exec(
                server,
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{install_payload}' --max-time 30",
                timeout=30
            )

            # Parse module ID and install
            try:
                import json
                data = json.loads(result)
                module_ids = data.get("result", [])
                if module_ids:
                    install_btn_payload = _json.dumps({
                        "jsonrpc": "2.0", "id": 4, "method": "call",
                        "params": {
                            "service": "object", "method": "execute_kw",
                            "args": [db_name, 2, admin_password, "ir.module.module",
                                     "button_immediate_install", [module_ids]]
                        }
                    })
                    await self.vm_driver._ssh_exec(
                        server,
                        f"curl -s -X POST http://localhost:{port}/jsonrpc "
                        f"-H 'Content-Type: application/json' "
                        f"-d '{install_btn_payload}' --max-time 300",
                        timeout=300
                    )
                    logger.info(f"web_enterprise installed on {instance.name}")
                else:
                    logger.warning(f"web_enterprise module not found on {instance.name}")
            except Exception as e:
                logger.warning(f"Failed to parse/install web_enterprise: {e}")

            return True
        except Exception as e:
            logger.error(f"Failed to enable enterprise on {instance.name}: {e}")
            return False
