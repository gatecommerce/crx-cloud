"""VM controller — manage traditional servers via SSH + systemd."""

from __future__ import annotations

from loguru import logger

from core.server_manager import ServerDriver, ServerInfo, ServerStatus


class VMDriver(ServerDriver):
    """Driver for VM/VPS servers (Hetzner, DigitalOcean, any SSH-accessible)."""

    async def connect(self, server: ServerInfo) -> bool:
        """Connect to VM via SSH."""
        # TODO: paramiko SSH connection test
        logger.info(f"Connecting to VM: {server.name} at {server.endpoint}")
        return True

    async def get_metrics(self, server: ServerInfo) -> dict:
        """Get system metrics via SSH commands."""
        # TODO: SSH exec: free -m, df -h, top -bn1, uptime
        return {"cpu_percent": 0, "ram_percent": 0, "disk_percent": 0, "uptime": ""}

    async def execute(self, server: ServerInfo, command: str) -> str:
        """Execute SSH command."""
        # TODO: paramiko exec_command
        logger.info(f"VM execute on {server.name}: {command}")
        return ""

    async def health_check(self, server: ServerInfo) -> ServerStatus:
        """Check VM health via SSH ping + service status."""
        # TODO: SSH connect + systemctl status
        return ServerStatus.ONLINE

    async def install_service(
        self, server: ServerInfo, service_name: str, config: dict
    ) -> bool:
        """Install and configure a systemd service."""
        # TODO: upload config, systemctl enable/start
        logger.info(f"Installing {service_name} on {server.name}")
        return True

    async def restart_service(self, server: ServerInfo, service_name: str) -> bool:
        """Restart a systemd service."""
        # TODO: systemctl restart
        logger.info(f"Restarting {service_name} on {server.name}")
        return True
