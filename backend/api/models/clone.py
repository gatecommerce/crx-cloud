"""Clone model — staging/dev/test copies of instances."""

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, Enum as SAEnum, DateTime, ForeignKey, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class Clone(Base):
    __tablename__ = "clones"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)

    # Source instance
    source_instance_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("instances.id"), nullable=False
    )

    # The cloned instance (created during clone process)
    clone_instance_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("instances.id"), nullable=True
    )

    clone_type: Mapped[str] = mapped_column(
        SAEnum("staging", "development", "testing", "disaster_recovery", name="clone_type_enum"),
        default="staging",
    )
    status: Mapped[str] = mapped_column(
        SAEnum(
            "pending", "cloning", "neutralizing", "ready", "running",
            "stopped", "failed", "destroyed",
            name="clone_status_enum",
        ),
        default="pending",
    )

    # Clone config
    clone_database: Mapped[str | None] = mapped_column(String(120))
    neutralized: Mapped[bool] = mapped_column(Boolean, default=True)
    base_url: Mapped[str | None] = mapped_column(String(500))

    # Safety: only one clone can be "running" per source instance (token conflicts)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)

    # Results
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(String(2000))
    neutralization_log: Mapped[dict | None] = mapped_column(JSON)

    # Owner
    owner_id: Mapped[str | None] = mapped_column(String(36))

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    source_instance = relationship("Instance", foreign_keys=[source_instance_id])
    clone_instance = relationship("Instance", foreign_keys=[clone_instance_id])
