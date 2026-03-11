"""PrestaShop CMS plugin driver."""

from __future__ import annotations

from loguru import logger

from plugins.base import CMSPlugin, CMSInstance


class PrestaShopPlugin(CMSPlugin):
    plugin_id = "prestashop"
    plugin_name = "PrestaShop"
    supported_versions = ["9.0", "8.2", "8.1"]

    async def deploy(self, server_id: str, config: dict) -> CMSInstance:
        """Deploy PrestaShop via Helm (K8s) or CLI (VM)."""
        version = config.get("version", "9.0")
        logger.info(f"Deploying PrestaShop {version} on server {server_id}")
        # TODO: K8s: helm install, VM: composer create-project + install
        return CMSInstance(
            id="",
            cms_type="prestashop",
            version=version,
            name=config.get("name", "prestashop"),
            server_id=server_id,
        )

    async def configure(self, instance: CMSInstance, settings: dict) -> bool:
        """Configure PrestaShop via REST API."""
        # TODO: PrestaShop WebService API configuration
        return True

    async def start(self, instance: CMSInstance) -> bool:
        return True

    async def stop(self, instance: CMSInstance) -> bool:
        return True

    async def restart(self, instance: CMSInstance) -> bool:
        return True

    async def backup(self, instance: CMSInstance) -> str:
        """Backup PrestaShop: mysqldump + img/modules tar."""
        logger.info(f"Backing up PrestaShop {instance.id}")
        return ""

    async def restore(self, instance: CMSInstance, backup_id: str) -> bool:
        return True

    async def health_check(self, instance: CMSInstance) -> dict:
        return {"status": "unknown", "php_version": "", "modules_count": 0}

    async def get_info(self, instance: CMSInstance) -> dict:
        # TODO: PrestaShop WebService API
        return {
            "modules_active": [],
            "theme": "",
            "products_count": 0,
            "orders_today": 0,
            "database_size_mb": 0,
        }

    async def install_module(self, instance: CMSInstance, module: str) -> bool:
        """Install PrestaShop module."""
        logger.info(f"Installing module {module} on PrestaShop {instance.id}")
        return True
