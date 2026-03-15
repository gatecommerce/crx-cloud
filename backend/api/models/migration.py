"""Migration model — server-to-server instance migration tracking."""

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, Enum as SAEnum, DateTime, ForeignKey, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class Migration(Base):
    __tablename__ = "migrations"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # Source
    source_instance_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("instances.id"), nullable=False
    )
    source_server_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("servers.id"), nullable=False
    )
    # Target
    target_instance_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("instances.id"), nullable=True
    )
    target_server_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("servers.id"), nullable=False
    )

    strategy: Mapped[str] = mapped_column(
        SAEnum("cold", "warm", "blue_green", name="migration_strategy_enum"),
        default="cold",
    )
    status: Mapped[str] = mapped_column(
        SAEnum(
            "pending", "preflight", "backing_up", "stopping",
            "dumping", "transferring", "restoring", "verifying",
            "completed", "failed", "rolled_back",
            name="migration_status_enum",
        ),
        default="pending",
    )

    # Config
    include_filestore: Mapped[bool] = mapped_column(Boolean, default=True)
    pre_migration_backup_id: Mapped[str | None] = mapped_column(String(500))
    target_database: Mapped[str | None] = mapped_column(String(120))

    # Results
    source_db_size_mb: Mapped[int | None] = mapped_column(Integer)
    filestore_size_mb: Mapped[int | None] = mapped_column(Integer)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(String(2000))
    steps_log: Mapped[dict | None] = mapped_column(JSON)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)

    # Relationships
    source_instance = relationship("Instance", foreign_keys=[source_instance_id])
    source_server = relationship("Server", foreign_keys=[source_server_id])
    target_server = relationship("Server", foreign_keys=[target_server_id])
