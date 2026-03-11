"""VM controller — manage traditional servers via SSH + systemd."""

from __future__ import annotations

import asyncio
from functools import partial

import paramiko
from loguru import logger

from core.server_manager import ServerDriver, ServerInfo, ServerStatus


class VMDriver(ServerDriver):
    """Driver for VM/VPS servers (Hetzner, DigitalOcean, any SSH-accessible)."""

    def _get_ssh_client(self, server: ServerInfo) -> paramiko.SSHClient:
        """Create and configure an SSH client."""
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        ssh_user = server.metadata.get("ssh_user", "root")
        ssh_key = server.metadata.get("ssh_key_path")
        ssh_port = server.metadata.get("ssh_port", 22)

        kwargs = {"hostname": server.endpoint, "username": ssh_user, "port": ssh_port, "timeout": 10}
        if ssh_key:
            kwargs["key_filename"] = ssh_key
        client.connect(**kwargs)
        return client

    async def _ssh_exec(self, server: ServerInfo, command: str) -> str:
        """Execute SSH command asynchronously."""
        loop = asyncio.get_event_loop()

        def _run():
            client = self._get_ssh_client(server)
            try:
                _, stdout, stderr = client.exec_command(command, timeout=30)
                exit_code = stdout.channel.recv_exit_status()
                if exit_code != 0:
                    error = stderr.read().decode().strip()
                    raise RuntimeError(f"SSH command failed (exit {exit_code}): {error}")
                return stdout.read().decode().strip()
            finally:
                client.close()

        return await loop.run_in_executor(None, _run)

    async def connect(self, server: ServerInfo) -> bool:
        """Connect to VM via SSH."""
        try:
            result = await self._ssh_exec(server, "hostname")
            logger.info(f"Connected to VM: {server.name} ({result})")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to {server.name}: {e}")
            return False

    async def get_metrics(self, server: ServerInfo) -> dict:
        """Get system metrics via SSH commands."""
        try:
            # Single SSH call with multiple commands
            cmd = (
                "echo CPU=$(top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}');"
                "echo RAM=$(free | awk '/Mem:/{printf \"%.0f\", $3/$2*100}');"
                "echo DISK=$(df / | awk 'NR==2{print $5}' | tr -d '%');"
                "echo UPTIME=$(uptime -p)"
            )
            raw = await self._ssh_exec(server, cmd)
            metrics = {}
            for line in raw.split("\n"):
                if "=" in line:
                    k, v = line.split("=", 1)
                    metrics[k.strip()] = v.strip()

            return {
                "cpu_percent": round(float(metrics.get("CPU", "0"))),
                "ram_percent": int(metrics.get("RAM", "0")),
                "disk_percent": int(metrics.get("DISK", "0")),
                "uptime": metrics.get("UPTIME", "unknown"),
            }
        except Exception as e:
            logger.warning(f"Metrics unavailable for {server.name}: {e}")
            return {"cpu_percent": 0, "ram_percent": 0, "disk_percent": 0, "uptime": "unknown"}

    async def execute(self, server: ServerInfo, command: str) -> str:
        """Execute SSH command."""
        return await self._ssh_exec(server, command)

    async def health_check(self, server: ServerInfo) -> ServerStatus:
        """Check VM health via SSH ping + service status."""
        try:
            await self._ssh_exec(server, "systemctl is-system-running")
            return ServerStatus.ONLINE
        except Exception:
            return ServerStatus.OFFLINE

    async def install_service(
        self, server: ServerInfo, service_name: str, config: dict
    ) -> bool:
        """Install and configure a systemd service."""
        try:
            unit = config.get("unit_content", "")
            if not unit:
                logger.error(f"No unit content for {service_name}")
                return False
            # Write unit file and enable
            escaped = unit.replace("'", "'\\''")
            await self._ssh_exec(
                server,
                f"echo '{escaped}' > /etc/systemd/system/{service_name}.service "
                f"&& systemctl daemon-reload "
                f"&& systemctl enable --now {service_name}",
            )
            logger.info(f"Installed {service_name} on {server.name}")
            return True
        except Exception as e:
            logger.error(f"Failed to install {service_name}: {e}")
            return False

    async def restart_service(self, server: ServerInfo, service_name: str) -> bool:
        """Restart a systemd service."""
        try:
            await self._ssh_exec(server, f"systemctl restart {service_name}")
            logger.info(f"Restarted {service_name} on {server.name}")
            return True
        except Exception as e:
            logger.error(f"Failed to restart {service_name}: {e}")
            return False
