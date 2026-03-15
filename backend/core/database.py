"""Database engine and session factory."""

import sqlalchemy
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from core.config import settings

engine = create_async_engine(settings.database_url, echo=(settings.app_env == "dev"))
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    """Dependency: yield an async DB session."""
    async with async_session() as session:
        yield session


async def init_db():
    """Create all tables (dev only — use Alembic in prod)."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # ALTER TYPE ... ADD VALUE must run outside a transaction block.
    # Use a separate engine with AUTOCOMMIT isolation.
    autocommit_engine = engine.execution_options(isolation_level="AUTOCOMMIT")
    async with autocommit_engine.connect() as conn:
        new_values = [
            ("instance_status_enum", "upgrading"),
            ("instance_status_enum", "migrating"),
            ("instance_status_enum", "cloning"),
            ("instance_status_enum", "backing_up"),
            ("backup_type_enum", "pre_migration"),
            ("backup_type_enum", "pre_clone"),
            ("backup_status_enum", "verifying"),
        ]
        for type_name, value in new_values:
            try:
                await conn.execute(
                    sqlalchemy.text(f"ALTER TYPE {type_name} ADD VALUE IF NOT EXISTS '{value}'")
                )
            except Exception:
                pass  # Fresh DB or value already exists

    # Add new columns to existing tables (idempotent)
    async with engine.begin() as conn:
        new_columns = [
            ("backups", "progress", "JSONB"),
        ]
        for table, column, col_type in new_columns:
            try:
                await conn.execute(
                    sqlalchemy.text(
                        f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {col_type}"
                    )
                )
            except Exception:
                pass
