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
        try:
            await conn.execute(
                sqlalchemy.text("ALTER TYPE instance_status_enum ADD VALUE IF NOT EXISTS 'upgrading'")
            )
        except Exception:
            pass  # Fresh DB where create_all already includes the value
