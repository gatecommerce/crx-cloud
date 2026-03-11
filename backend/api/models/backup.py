"""Backup model — a snapshot of an instance's data."""

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Enum as SAEnum, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class Backup(Base):
    __tablename__ = "backups"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    instance_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("instances.id"), nullable=False
    )
    server_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("servers.id"), nullable=False
    )
    backup_type: Mapped[str] = mapped_column(
        SAEnum("manual", "scheduled", "pre_update", name="backup_type_enum"),
        default="manual",
    )
    status: Mapped[str] = mapped_column(
        SAEnum("pending", "in_progress", "completed", "failed", name="backup_status_enum"),
        default="pending",
    )
    storage_path: Mapped[str | None] = mapped_column(String(1000))  # S3 key or local path
    size_mb: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)

    # Relationships
    instance = relationship("Instance", back_populates="backups")
    server = relationship("Server", back_populates="backups")
