"""Backup model — a snapshot of an instance's data."""

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, Enum as SAEnum, DateTime, ForeignKey, JSON, func
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
        SAEnum("manual", "scheduled", "pre_update", "pre_migration", "pre_clone",
               name="backup_type_enum", create_constraint=False),
        default="manual",
    )
    status: Mapped[str] = mapped_column(
        SAEnum("pending", "in_progress", "completed", "failed", "verifying",
               name="backup_status_enum", create_constraint=False),
        default="pending",
    )
    backup_format: Mapped[str] = mapped_column(String(20), default="zip")  # zip, custom, sql
    storage_path: Mapped[str | None] = mapped_column(String(1000))  # S3 key or local path
    size_mb: Mapped[int | None] = mapped_column(Integer)

    # Multi-destination tracking
    storage_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("backup_storages.id"), nullable=True)
    destinations: Mapped[dict | None] = mapped_column(JSON)  # [{"storage_id": ..., "path": ..., "status": ...}]

    # Content flags
    include_filestore: Mapped[bool] = mapped_column(Boolean, default=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)

    # Schedule reference
    schedule_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    # Retention
    retain_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Metadata
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(String(2000))
    progress: Mapped[dict | None] = mapped_column(JSON)  # {"step": "db_dump|filestore|finalizing", "detail": "..."}

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)

    # Relationships
    instance = relationship("Instance", back_populates="backups")
    server = relationship("Server", back_populates="backups")
    storage = relationship("BackupStorage", foreign_keys=[storage_id])
