"""Shared test fixtures — in-memory async SQLite for unit tests.

We override DATABASE_URL before any app module is imported so that
core.database creates a SQLite engine instead of requiring PostgreSQL.
"""

import asyncio
import os
import uuid

# MUST set before importing any app module
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["APP_ENV"] = "test"

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from core.database import Base

# Import all models so Base.metadata is populated
from api.models.server import Server
from api.models.instance import Instance
from api.models.backup import Backup
from api.models.backup_storage import BackupStorage
from api.models.backup_schedule import BackupSchedule
from api.models.migration import Migration
from api.models.clone import Clone


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        echo=False,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db(engine):
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def sample_server(db: AsyncSession):
    server = Server(
        id=str(uuid.uuid4()),
        name="test-hetzner-01",
        server_type="vm",
        provider="hetzner",
        status="online",
        endpoint="10.0.0.1",
        ssh_user="root",
        ssh_key_path="/root/.ssh/id_rsa",
        owner_id="user_001",
    )
    db.add(server)
    await db.commit()
    await db.refresh(server)
    return server


@pytest_asyncio.fixture
async def sample_target_server(db: AsyncSession):
    server = Server(
        id=str(uuid.uuid4()),
        name="test-hetzner-02",
        server_type="vm",
        provider="hetzner",
        status="online",
        endpoint="10.0.0.2",
        ssh_user="root",
        ssh_key_path="/root/.ssh/id_rsa",
        owner_id="user_001",
    )
    db.add(server)
    await db.commit()
    await db.refresh(server)
    return server


@pytest_asyncio.fixture
async def sample_instance(db: AsyncSession, sample_server: Server):
    instance = Instance(
        id=str(uuid.uuid4()),
        name="odoo-prod-01",
        cms_type="odoo",
        version="17.0",
        status="running",
        server_id=sample_server.id,
        domain="erp.example.com",
        config={"db_name": "odoo_prod", "prefix": "crx-odoo-abcd1234"},
        owner_id="user_001",
    )
    db.add(instance)
    await db.commit()
    await db.refresh(instance)
    return instance
