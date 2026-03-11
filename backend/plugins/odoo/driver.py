"""Odoo CMS plugin driver."""

from __future__ import annotations

from loguru import logger

from plugins.base import CMSPlugin, CMSInstance


class OdooPlugin(CMSPlugin):
    plugin_id = "odoo"
    plugin_name = "Odoo"
    supported_versions = ["18.0", "17.0", "16.0"]

    async def deploy(self, server_id: str, config: dict) -> CMSInstance:
        """Deploy Odoo via Helm (K8s) or systemd (VM)."""
        version = config.get("version", "18.0")
        logger.info(f"Deploying Odoo {version} on server {server_id}")
        # TODO: detect server type → K8s: helm install, VM: apt + systemd
        # TODO: create PostgreSQL database
        # TODO: configure odoo.conf
        return CMSInstance(
            id="",  # generated
            cms_type="odoo",
            version=version,
            name=config.get("name", "odoo"),
            server_id=server_id,
        )

    async def configure(self, instance: CMSInstance, settings: dict) -> bool:
        """Configure Odoo instance (workers, addons path, etc.)."""
        # TODO: update odoo.conf via SSH or ConfigMap
        logger.info(f"Configuring Odoo {instance.id}: {settings}")
        return True

    async def start(self, instance: CMSInstance) -> bool:
        # TODO: K8s: scale to 1, VM: systemctl start odoo
        return True

    async def stop(self, instance: CMSInstance) -> bool:
        # TODO: K8s: scale to 0, VM: systemctl stop odoo
        return True

    async def restart(self, instance: CMSInstance) -> bool:
        # TODO: K8s: rollout restart, VM: systemctl restart odoo
        return True

    async def backup(self, instance: CMSInstance) -> str:
        """Backup Odoo: pg_dump + filestore tar."""
        # TODO: pg_dump database, tar filestore, upload to S3
        logger.info(f"Backing up Odoo {instance.id}")
        return ""

    async def restore(self, instance: CMSInstance, backup_id: str) -> bool:
        """Restore Odoo from backup."""
        # TODO: download from S3, pg_restore, extract filestore
        return True

    async def health_check(self, instance: CMSInstance) -> dict:
        """Check Odoo health via /web/health endpoint."""
        # TODO: HTTP GET to instance URL/web/health
        return {"status": "unknown", "database": "unknown", "workers": 0}

    async def get_info(self, instance: CMSInstance) -> dict:
        """Get Odoo-specific info (installed modules, users, DB size)."""
        # TODO: XML-RPC call to get module list, user count, etc.
        return {
            "modules_installed": [],
            "users_count": 0,
            "database_size_mb": 0,
            "workers": 0,
        }

    async def install_module(self, instance: CMSInstance, module: str) -> bool:
        """Install Odoo module via XML-RPC or Git deploy."""
        # TODO: if OCA/community → git clone + restart
        # TODO: if already in addons → XML-RPC install
        logger.info(f"Installing module {module} on Odoo {instance.id}")
        return True
