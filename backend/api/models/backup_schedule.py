"""Backup Schedule model — automated periodic backups with multi-destination and rotation."""

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, DateTime, ForeignKey, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class BackupSchedule(Base):
    __tablename__ = "backup_schedules"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    instance_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("instances.id"), nullable=False
    )
    owner_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

    # Schedule
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    cron_expression: Mapped[str] = mapped_column(String(100), default="0 2 * * *")  # Daily 2 AM
    timezone: Mapped[str] = mapped_column(String(50), default="Europe/Rome")

    # What to backup
    backup_format: Mapped[str] = mapped_column(String(20), default="zip")  # zip, custom, sql
    include_filestore: Mapped[bool] = mapped_column(Boolean, default=True)

    # Where to backup (list of backup_storage IDs)
    destination_ids: Mapped[dict | None] = mapped_column(JSON)  # ["storage_id_1", "storage_id_2"]

    # Retention policy
    keep_daily: Mapped[int] = mapped_column(Integer, default=7)
    keep_weekly: Mapped[int] = mapped_column(Integer, default=4)
    keep_monthly: Mapped[int] = mapped_column(Integer, default=12)

    # Notifications
    notify_on_success: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_on_failure: Mapped[bool] = mapped_column(Boolean, default=True)
    notification_channels: Mapped[dict | None] = mapped_column(JSON)  # ["telegram", "email"]

    # Verification
    verify_after_backup: Mapped[bool] = mapped_column(Boolean, default=True)
    stop_instance_during_backup: Mapped[bool] = mapped_column(Boolean, default=False)

    # Pre/post hooks (SSH commands)
    pre_backup_command: Mapped[str | None] = mapped_column(String(1000))
    post_backup_command: Mapped[str | None] = mapped_column(String(1000))

    # Stats
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_status: Mapped[str | None] = mapped_column(String(20))
    last_duration_seconds: Mapped[int | None] = mapped_column(Integer)
    last_size_mb: Mapped[int | None] = mapped_column(Integer)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    total_runs: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    instance = relationship("Instance")
