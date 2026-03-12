"""API Key model — secure programmatic access tokens."""

import uuid
import secrets
from datetime import datetime

from sqlalchemy import String, Boolean, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column

from core.database import Base


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    owner_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(8), nullable=False)  # first 8 chars for display
    key_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
