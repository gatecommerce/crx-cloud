"""Backup Storage model — external storage provider configuration."""

import uuid
from datetime import datetime

from sqlalchemy import String, Boolean, Integer, JSON, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column

from core.database import Base


class BackupStorage(Base):
    __tablename__ = "backup_storages"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    owner_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)  # s3, azure, gcs, local
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    config: Mapped[dict | None] = mapped_column(JSON)  # bucket, region, credentials etc.
    backup_count: Mapped[int] = mapped_column(Integer, default=0)
    total_size_mb: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
