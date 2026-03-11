"""Server management — connect, monitor, and control servers (K8s + VM)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import Enum
from dataclasses import dataclass, field


class ServerType(str, Enum):
    KUBERNETES = "kubernetes"
    VM = "vm"


class ServerStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"
    PROVISIONING = "provisioning"
    ERROR = "error"


@dataclass
class ServerInfo:
    id: str
    name: str
    server_type: ServerType
    provider: str  # azure, aws, hetzner, custom
    status: ServerStatus = ServerStatus.OFFLINE
    endpoint: str = ""
    cpu_cores: int = 0
    ram_mb: int = 0
    disk_gb: int = 0
    metadata: dict = field(default_factory=dict)


class ServerDriver(ABC):
    """Base driver for server management."""

    @abstractmethod
    async def connect(self, server: ServerInfo) -> bool:
        """Test connection to server."""

    @abstractmethod
    async def get_metrics(self, server: ServerInfo) -> dict:
        """Get CPU, RAM, disk metrics."""

    @abstractmethod
    async def execute(self, server: ServerInfo, command: str) -> str:
        """Execute command on server."""

    @abstractmethod
    async def health_check(self, server: ServerInfo) -> ServerStatus:
        """Check server health."""
