"""Server model — a managed machine (K8s cluster or VM)."""

import uuid
from datetime import datetime

from sqlalchemy import String, Enum as SAEnum, DateTime, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class Server(Base):
    __tablename__ = "servers"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    server_type: Mapped[str] = mapped_column(
        SAEnum("kubernetes", "vm", name="server_type_enum"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(50), nullable=False)  # aks, eks, gke, hetzner, custom...
    status: Mapped[str] = mapped_column(
        SAEnum("online", "offline", "provisioning", "error", name="server_status_enum"),
        default="offline",
    )
    endpoint: Mapped[str] = mapped_column(String(500), nullable=False)  # kubeconfig path or SSH host
    region: Mapped[str | None] = mapped_column(String(50))
    ssh_key_path: Mapped[str | None] = mapped_column(String(500))
    ssh_user: Mapped[str | None] = mapped_column(String(100))
    kubeconfig: Mapped[str | None] = mapped_column(String(5000))  # inline kubeconfig or path
    namespace: Mapped[str | None] = mapped_column(String(100), default="default")
    meta: Mapped[dict | None] = mapped_column(JSON, default=dict)

    # Owner
    owner_id: Mapped[str | None] = mapped_column(String(36))

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    instances = relationship("Instance", back_populates="server", cascade="all, delete-orphan")
    backups = relationship("Backup", back_populates="server")
