"""Odoo CMS plugin driver — Docker-based deployment on VM servers."""

from __future__ import annotations

import uuid
import textwrap

from loguru import logger

from plugins.base import CMSPlugin, CMSInstance
from core.server_manager import ServerInfo, ServerStatus
from core.vm_controller import VMDriver


class OdooPlugin(CMSPlugin):
    plugin_id = "odoo"
    plugin_name = "Odoo"
    supported_versions = ["18.0", "17.0", "16.0"]

    def __init__(self):
        self.vm_driver = VMDriver()

    def _instance_prefix(self, instance_id: str) -> str:
        return f"crx-odoo-{instance_id[:8]}"

    def _compose_content(self, instance_id: str, config: dict) -> str:
        """Generate docker-compose.yml for an Odoo instance."""
        prefix = self._instance_prefix(instance_id)
        version = config.get("version", "18.0")
        port = config.get("port", 8069)
        workers = config.get("workers", 2)
        ram_mb = config.get("ram_mb", 1024)
        db_password = config.get("db_password", uuid.uuid4().hex[:16])
        admin_password = config.get("admin_password", uuid.uuid4().hex[:16])

        mem_limit = f"{ram_mb}m"
        db_mem = f"{max(256, ram_mb // 2)}m"

        return textwrap.dedent(f"""\
            services:
              odoo:
                image: odoo:{version}
                container_name: {prefix}-odoo
                restart: unless-stopped
                ports:
                  - "{port}:8069"
                  - "{port + 3}:8072"
                environment:
                  - HOST={prefix}-db
                  - PORT=5432
                  - USER=odoo
                  - PASSWORD={db_password}
                volumes:
                  - {prefix}-data:/var/lib/odoo
                  - {prefix}-addons:/mnt/extra-addons
                  - {prefix}-config:/etc/odoo
                depends_on:
                  db:
                    condition: service_healthy
                deploy:
                  resources:
                    limits:
                      memory: {mem_limit}
                command: >-
                  -- --workers={workers}
                  --limit-memory-hard={ram_mb * 1024 * 1024}
                  --limit-memory-soft={int(ram_mb * 0.8) * 1024 * 1024}
                  --db_host={prefix}-db
                  --db_port=5432
                  --db_user=odoo
                  --db_password={db_password}
                  --admin-passwd={admin_password}
                  --proxy-mode=True

              db:
                image: postgres:16-alpine
                container_name: {prefix}-db
                restart: unless-stopped
                environment:
                  POSTGRES_USER: odoo
                  POSTGRES_PASSWORD: {db_password}
                  POSTGRES_DB: postgres
                volumes:
                  - {prefix}-pgdata:/var/lib/postgresql/data
                deploy:
                  resources:
                    limits:
                      memory: {db_mem}
                healthcheck:
                  test: ["CMD-SHELL", "pg_isready -U odoo"]
                  interval: 10s
                  timeout: 5s
                  retries: 5

            volumes:
              {prefix}-data:
              {prefix}-addons:
              {prefix}-config:
              {prefix}-pgdata:
        """)

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

    async def deploy(self, server_id: str, config: dict) -> CMSInstance:
        """Deploy Odoo via Docker Compose on a VM server."""
        instance_id = str(uuid.uuid4())
        prefix = self._instance_prefix(instance_id)
        version = config.get("version", "18.0")
        port = config.get("port", 8069)
        endpoint = config.get("endpoint", "")
        ssh_meta = config.get("ssh_metadata", {})

        server = self._server_info(server_id, endpoint, ssh_meta)
        compose = self._compose_content(instance_id, config)

        logger.info(f"Deploying Odoo {version} as {prefix} on {endpoint}:{port}")

        deploy_dir = f"/opt/crx-cloud/instances/{prefix}"
        await self.vm_driver._ssh_exec(
            server,
            f"mkdir -p {deploy_dir} && cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
        )

        await self.vm_driver._ssh_exec(
            server,
            f"cd {deploy_dir} && docker compose pull && docker compose up -d"
        )

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
