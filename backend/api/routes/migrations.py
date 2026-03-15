"""Migration API — server-to-server instance migration endpoints."""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.instance import Instance
from api.models.migration import Migration
from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db, async_session
from core.instance_ops import migrate_instance, estimate_migration

router = APIRouter()


class MigrationCreate(BaseModel):
    source_instance_id: str
    target_server_id: str
    strategy: str = "cold"
    include_filestore: bool = True
    target_database: str | None = None


class MigrationResponse(BaseModel):
    id: str
    source_instance_id: str
    target_server_id: str
    strategy: str
    status: str
    source_db_size_mb: int | None = None
    duration_seconds: int | None = None
    error_message: str | None = None
    created_at: str


class MigrationEstimate(BaseModel):
    database_size: str
    filestore_size: str
    total_size: str
    estimated_minutes: float
    space_needed: str
    space_available: str
    space_sufficient: bool | None = None


async def _bg_migrate(migration_id: str):
    """Background task: execute migration."""
    async with async_session() as db:
        mig_result = await db.execute(select(Migration).where(Migration.id == migration_id))
        migration = mig_result.scalar_one_or_none()
        if not migration:
            return

        inst_result = await db.execute(select(Instance).where(Instance.id == migration.source_instance_id))
        source_inst = inst_result.scalar_one_or_none()
        src_srv_result = await db.execute(select(Server).where(Server.id == migration.source_server_id))
        source_server = src_srv_result.scalar_one_or_none()
        tgt_srv_result = await db.execute(select(Server).where(Server.id == migration.target_server_id))
        target_server = tgt_srv_result.scalar_one_or_none()

        if not all([source_inst, source_server, target_server]):
            migration.status = "failed"
            migration.error_message = "Source instance or servers not found"
            await db.commit()
            return

        await migrate_instance(migration, source_inst, source_server, target_server, db)


@router.get("", response_model=list[MigrationResponse])
async def list_migrations(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List all migrations for the current user."""
    result = await db.execute(
        select(Migration)
        .join(Instance, Migration.source_instance_id == Instance.id)
        .where(Instance.owner_id == user["telegram_id"])
        .order_by(Migration.created_at.desc())
    )
    migrations = result.scalars().all()
    return [
        MigrationResponse(
            id=m.id, source_instance_id=m.source_instance_id,
            target_server_id=m.target_server_id, strategy=m.strategy,
            status=m.status, source_db_size_mb=m.source_db_size_mb,
            duration_seconds=m.duration_seconds, error_message=m.error_message,
            created_at=m.created_at.isoformat(),
        )
        for m in migrations
    ]


@router.post("", status_code=201)
async def create_migration(
    body: MigrationCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Start a new migration. The actual migration runs in background."""
    # Validate source instance
    inst_result = await db.execute(
        select(Instance).where(
            Instance.id == body.source_instance_id,
            Instance.owner_id == user["telegram_id"],
        )
    )
    source_inst = inst_result.scalar_one_or_none()
    if not source_inst:
        raise HTTPException(404, "Source instance not found")

    # Validate target server
    srv_result = await db.execute(
        select(Server).where(
            Server.id == body.target_server_id,
            Server.owner_id == user["telegram_id"],
        )
    )
    target_server = srv_result.scalar_one_or_none()
    if not target_server:
        raise HTTPException(404, "Target server not found")

    if body.strategy != "cold":
        raise HTTPException(400, "Only 'cold' strategy is currently supported")

    migration = Migration(
        source_instance_id=source_inst.id,
        source_server_id=source_inst.server_id,
        target_server_id=target_server.id,
        strategy=body.strategy,
        include_filestore=body.include_filestore,
        target_database=body.target_database,
        status="pending",
    )
    db.add(migration)
    await db.commit()
    await db.refresh(migration)

    background_tasks.add_task(_bg_migrate, migration.id)

    return {
        "id": migration.id,
        "status": "pending",
        "detail": f"Migration started: {source_inst.name} → {target_server.name}",
    }


@router.get("/{migration_id}", response_model=MigrationResponse)
async def get_migration(
    migration_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get migration status and details."""
    result = await db.execute(
        select(Migration)
        .join(Instance, Migration.source_instance_id == Instance.id)
        .where(Migration.id == migration_id, Instance.owner_id == user["telegram_id"])
    )
    migration = result.scalar_one_or_none()
    if not migration:
        raise HTTPException(404, "Migration not found")
    return MigrationResponse(
        id=migration.id, source_instance_id=migration.source_instance_id,
        target_server_id=migration.target_server_id, strategy=migration.strategy,
        status=migration.status, source_db_size_mb=migration.source_db_size_mb,
        duration_seconds=migration.duration_seconds, error_message=migration.error_message,
        created_at=migration.created_at.isoformat(),
    )


@router.post("/{instance_id}/estimate")
async def estimate(
    instance_id: str,
    target_server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Estimate migration duration and space requirements."""
    inst_result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = inst_result.scalar_one_or_none()
    if not inst:
        raise HTTPException(404, "Instance not found")

    src_result = await db.execute(select(Server).where(Server.id == inst.server_id))
    source_server = src_result.scalar_one_or_none()
    tgt_result = await db.execute(select(Server).where(Server.id == target_server_id))
    target_server = tgt_result.scalar_one_or_none()

    if not source_server or not target_server:
        raise HTTPException(404, "Server not found")

    return await estimate_migration(inst, source_server, target_server)
