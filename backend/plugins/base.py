"""Base CMS plugin interface — all CMS drivers must implement this."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class CMSInstance:
    id: str
    cms_type: str
    version: str
    name: str
    server_id: str
    domain: str = ""
    url: str = ""
    status: str = "stopped"
    config: dict = None

    def __post_init__(self):
        if self.config is None:
            self.config = {}


class CMSPlugin(ABC):
    """Base class for CMS plugins. Each CMS (Odoo, WP, Presta) implements this."""

    plugin_id: str = ""
    plugin_name: str = ""
    supported_versions: list[str] = []

    @abstractmethod
    async def deploy(self, server_id: str, config: dict) -> CMSInstance:
        """Deploy a new CMS instance on a server."""

    @abstractmethod
    async def configure(self, instance: CMSInstance, settings: dict) -> bool:
        """Apply configuration to a running instance."""

    @abstractmethod
    async def start(self, instance: CMSInstance) -> bool:
        """Start the CMS instance."""

    @abstractmethod
    async def stop(self, instance: CMSInstance) -> bool:
        """Stop the CMS instance."""

    @abstractmethod
    async def restart(self, instance: CMSInstance) -> bool:
        """Restart the CMS instance."""

    @abstractmethod
    async def backup(self, instance: CMSInstance) -> str:
        """Create a backup. Returns backup ID/path."""

    @abstractmethod
    async def restore(self, instance: CMSInstance, backup_id: str, include_filestore: bool = True) -> bool:
        """Restore from a backup."""

    @abstractmethod
    async def health_check(self, instance: CMSInstance) -> dict:
        """Check instance health. Returns status dict."""

    @abstractmethod
    async def get_info(self, instance: CMSInstance) -> dict:
        """Get CMS-specific info (modules, users, version details)."""

    async def install_module(self, instance: CMSInstance, module: str) -> bool:
        """Install a CMS module/plugin. Override per CMS."""
        raise NotImplementedError(f"{self.plugin_name} does not support module install")

    async def update(self, instance: CMSInstance, target_version: str) -> bool:
        """Update CMS to a new version. Override per CMS."""
        raise NotImplementedError(f"{self.plugin_name} does not support updates")
