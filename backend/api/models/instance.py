"""Instance model — a CMS deployment on a server."""

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Enum as SAEnum, DateTime, ForeignKey, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class Instance(Base):
    __tablename__ = "instances"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    cms_type: Mapped[str] = mapped_column(
        SAEnum("odoo", "wordpress", "prestashop", "woocommerce", "custom", name="cms_type_enum"),
        nullable=False,
    )
    version: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(
        SAEnum("running", "stopped", "deploying", "error", "updating", "upgrading", name="instance_status_enum"),
        default="deploying",
    )

    # Server link
    server_id: Mapped[str] = mapped_column(String(36), ForeignKey("servers.id"), nullable=False)

    # Network
    domain: Mapped[str | None] = mapped_column(String(255))
    url: Mapped[str | None] = mapped_column(String(500))
    port: Mapped[int | None] = mapped_column(Integer)

    # Resources
    workers: Mapped[int] = mapped_column(Integer, default=2)
    ram_mb: Mapped[int] = mapped_column(Integer, default=2048)
    cpu_cores: Mapped[int] = mapped_column(Integer, default=1)

    # CMS-specific config (plugins, modules, theme, etc.)
    config: Mapped[dict | None] = mapped_column(JSON, default=dict)

    # Owner
    owner_id: Mapped[str | None] = mapped_column(String(36))

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    server = relationship("Server", back_populates="instances")
    backups = relationship("Backup", back_populates="instance", cascade="all, delete-orphan")
