"""Clone API — staging, development, and testing clone endpoints."""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.clone import Clone
from api.models.instance import Instance
from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db, async_session
from core.instance_ops import clone_instance, destroy_clone, start_clone_container, stop_clone_container

router = APIRouter()


class CloneCreate(BaseModel):
    source_instance_id: str
    clone_type: str = "staging"  # staging, development, testing, disaster_recovery
    name: str | None = None
    clone_database: str | None = None
    neutralize: bool = True
    base_url: str | None = None


class CloneResponse(BaseModel):
    id: str
    name: str
    source_instance_id: str
    clone_type: str
    status: str
    clone_database: str | None = None
    neutralized: bool
    is_active: bool
    base_url: str | None = None
    duration_seconds: int | None = None
    error_message: str | None = None
    created_at: str


async def _bg_clone(clone_id: str):
    """Background task: execute clone."""
    async with async_session() as db:
        clone_result = await db.execute(select(Clone).where(Clone.id == clone_id))
        clone = clone_result.scalar_one_or_none()
        if not clone:
            return

        inst_result = await db.execute(select(Instance).where(Instance.id == clone.source_instance_id))
        source_inst = inst_result.scalar_one_or_none()
        if not source_inst:
            clone.status = "failed"
            clone.error_message = "Source instance not found"
            await db.commit()
            return

        srv_result = await db.execute(select(Server).where(Server.id == source_inst.server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            clone.status = "failed"
            clone.error_message = "Server not found"
            await db.commit()
            return

        await clone_instance(clone, source_inst, server, db)


@router.get("", response_model=list[CloneResponse])
async def list_clones(
    source_instance_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List all clones for the current user."""
    query = (
        select(Clone)
        .where(Clone.owner_id == user["telegram_id"])
        .where(Clone.status != "destroyed")
    )
    if source_instance_id:
        query = query.where(Clone.source_instance_id == source_instance_id)

    result = await db.execute(query.order_by(Clone.created_at.desc()))
    clones = result.scalars().all()
    return [_to_response(c) for c in clones]


@router.post("", status_code=201)
async def create_clone(
    body: CloneCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Create a new clone. Runs in background."""
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

    # Check max active clones (token safety: only 1 running at a time)
    active_result = await db.execute(
        select(Clone).where(
            Clone.source_instance_id == body.source_instance_id,
            Clone.is_active == True,
            Clone.status.notin_(["destroyed", "failed"]),
        )
    )
    active_clones = list(active_result.scalars().all())
    if active_clones:
        raise HTTPException(
            409,
            f"An active clone already exists ({active_clones[0].name}). "
            f"Stop or destroy it first to avoid token/sync conflicts.",
        )

    clone = Clone(
        name=body.name or f"{source_inst.name} — {body.clone_type}",
        source_instance_id=source_inst.id,
        clone_type=body.clone_type,
        clone_database=body.clone_database,
        neutralized=body.neutralize,
        base_url=body.base_url,
        owner_id=user["telegram_id"],
        status="pending",
    )
    db.add(clone)
    await db.commit()
    await db.refresh(clone)

    background_tasks.add_task(_bg_clone, clone.id)

    return {
        "id": clone.id,
        "status": "pending",
        "detail": f"Clone started: {source_inst.name} → {body.clone_type}",
    }


@router.get("/{clone_id}", response_model=CloneResponse)
async def get_clone(
    clone_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get clone status."""
    result = await db.execute(
        select(Clone).where(Clone.id == clone_id, Clone.owner_id == user["telegram_id"])
    )
    clone = result.scalar_one_or_none()
    if not clone:
        raise HTTPException(404, "Clone not found")
    return _to_response(clone)


@router.post("/{clone_id}/start")
async def start_clone(
    clone_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """
    Start a clone — spins up a dedicated Odoo Docker container.
    Only ONE clone per source instance can be active at a time (token safety).
    """
    result = await db.execute(
        select(Clone).where(Clone.id == clone_id, Clone.owner_id == user["telegram_id"])
    )
    clone = result.scalar_one_or_none()
    if not clone:
        raise HTTPException(404, "Clone not found")
    if clone.status not in ("ready", "stopped"):
        raise HTTPException(400, f"Cannot start clone in status '{clone.status}'")

    # Check no other clone is active for this source
    active_result = await db.execute(
        select(Clone).where(
            Clone.source_instance_id == clone.source_instance_id,
            Clone.is_active == True,
            Clone.id != clone_id,
        )
    )
    active = active_result.scalar_one_or_none()
    if active:
        raise HTTPException(
            409,
            f"Cannot start: clone '{active.name}' is already active. "
            f"Stop it first to avoid token/sync conflicts.",
        )

    # Get source instance and server for Docker operations
    inst_result = await db.execute(select(Instance).where(Instance.id == clone.source_instance_id))
    source_inst = inst_result.scalar_one_or_none()
    if not source_inst:
        raise HTTPException(404, "Source instance not found")

    srv_result = await db.execute(select(Server).where(Server.id == source_inst.server_id))
    server = srv_result.scalar_one_or_none()
    if not server:
        raise HTTPException(404, "Server not found")

    try:
        base_url = await start_clone_container(clone, source_inst, server)
        clone.base_url = base_url
        clone.status = "running"
        clone.is_active = True
        await db.commit()
        return {"detail": f"Clone '{clone.name}' started at {base_url}", "status": "running", "base_url": base_url}
    except Exception as e:
        raise HTTPException(500, f"Failed to start clone container: {e}")


@router.post("/{clone_id}/stop")
async def stop_clone(
    clone_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Stop a clone — stops and removes the dedicated Odoo container."""
    result = await db.execute(
        select(Clone).where(Clone.id == clone_id, Clone.owner_id == user["telegram_id"])
    )
    clone = result.scalar_one_or_none()
    if not clone:
        raise HTTPException(404, "Clone not found")

    # Stop the Docker container
    inst_result = await db.execute(select(Instance).where(Instance.id == clone.source_instance_id))
    source_inst = inst_result.scalar_one_or_none()
    if source_inst:
        srv_result = await db.execute(select(Server).where(Server.id == source_inst.server_id))
        server = srv_result.scalar_one_or_none()
        if server:
            await stop_clone_container(clone, source_inst, server)

    clone.status = "stopped"
    clone.is_active = False
    await db.commit()

    return {"detail": f"Clone '{clone.name}' stopped", "status": "stopped"}


@router.post("/{clone_id}/sync")
async def sync_clone(
    clone_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """
    Re-sync a clone from production — drops clone DB, re-clones from source,
    re-applies neutralization. The clone is stopped during sync.
    """
    result = await db.execute(
        select(Clone).where(Clone.id == clone_id, Clone.owner_id == user["telegram_id"])
    )
    clone = result.scalar_one_or_none()
    if not clone:
        raise HTTPException(404, "Clone not found")
    if clone.status in ("cloning", "neutralizing"):
        raise HTTPException(400, "Clone is already being synced")

    # Stop container if running
    inst_result = await db.execute(select(Instance).where(Instance.id == clone.source_instance_id))
    source_inst = inst_result.scalar_one_or_none()
    if not source_inst:
        raise HTTPException(404, "Source instance not found")
    srv_result = await db.execute(select(Server).where(Server.id == source_inst.server_id))
    server = srv_result.scalar_one_or_none()
    if not server:
        raise HTTPException(404, "Server not found")

    if clone.is_active:
        await stop_clone_container(clone, source_inst, server)

    # Reset clone state — will be re-cloned in background
    clone.status = "pending"
    clone.is_active = False
    clone.error_message = None
    await db.commit()

    background_tasks.add_task(_bg_clone, clone.id)

    return {"detail": f"Sync started for '{clone.name}'", "status": "pending"}


@router.delete("/{clone_id}")
async def delete_clone(
    clone_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Destroy a clone — drop database and remove filestore."""
    result = await db.execute(
        select(Clone).where(Clone.id == clone_id, Clone.owner_id == user["telegram_id"])
    )
    clone = result.scalar_one_or_none()
    if not clone:
        raise HTTPException(404, "Clone not found")

    # Get server for the source instance
    inst_result = await db.execute(select(Instance).where(Instance.id == clone.source_instance_id))
    source_inst = inst_result.scalar_one_or_none()
    if source_inst:
        srv_result = await db.execute(select(Server).where(Server.id == source_inst.server_id))
        server = srv_result.scalar_one_or_none()
        if server:
            await destroy_clone(clone, server, source_inst)

    clone.status = "destroyed"
    clone.is_active = False
    await db.commit()

    return {"detail": f"Clone '{clone.name}' destroyed"}


def _to_response(c: Clone) -> CloneResponse:
    return CloneResponse(
        id=c.id, name=c.name, source_instance_id=c.source_instance_id,
        clone_type=c.clone_type, status=c.status, clone_database=c.clone_database,
        neutralized=c.neutralized, is_active=c.is_active, base_url=c.base_url,
        duration_seconds=c.duration_seconds, error_message=c.error_message,
        created_at=c.created_at.isoformat(),
    )
