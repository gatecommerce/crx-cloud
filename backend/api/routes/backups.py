"""Backup management endpoints — wired to real CMS plugin drivers."""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.backup import Backup
from api.models.instance import Instance
from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db, async_session
from core.orchestrator import backup_instance, restore_instance

router = APIRouter()


class BackupResponse(BaseModel):
    id: str
    instance_id: str
    server_id: str
    backup_type: str
    status: str
    size_mb: int | None
    storage_path: str | None = None
    created_at: str


async def _bg_backup(backup_id: str, instance_id: str, server_id: str):
    """Background task: run backup via CMS plugin driver."""
    async with async_session() as db:
        b_result = await db.execute(select(Backup).where(Backup.id == backup_id))
        backup = b_result.scalar_one_or_none()
        if not backup:
            return
        i_result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = i_result.scalar_one_or_none()
        s_result = await db.execute(select(Server).where(Server.id == server_id))
        server = s_result.scalar_one_or_none()
        if not inst or not server:
            backup.status = "failed"
            await db.commit()
            return
        await backup_instance(inst, server, backup, db)


@router.get("/", response_model=list[BackupResponse])
async def list_backups(
    instance_id: str | None = None,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    query = (
        select(Backup)
        .join(Instance, Backup.instance_id == Instance.id)
        .where(Instance.owner_id == user["telegram_id"])
    )
    if instance_id:
        query = query.where(Backup.instance_id == instance_id)
    result = await db.execute(query.order_by(Backup.created_at.desc()))
    backups = result.scalars().all()
    return [
        BackupResponse(
            id=b.id, instance_id=b.instance_id, server_id=b.server_id,
            backup_type=b.backup_type, status=b.status, size_mb=b.size_mb,
            storage_path=b.storage_path,
            created_at=b.created_at.isoformat(),
        )
        for b in backups
    ]


@router.post("/{instance_id}", status_code=201)
async def create_backup(
    instance_id: str,
    background_tasks: BackgroundTasks,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    backup = Backup(
        instance_id=inst.id, server_id=inst.server_id,
        backup_type="manual", status="pending",
    )
    db.add(backup)
    await db.commit()
    await db.refresh(backup)

    # Real backup in background
    background_tasks.add_task(_bg_backup, backup.id, inst.id, inst.server_id)

    return {"id": backup.id, "status": "pending", "detail": f"Backup triggered for {inst.name}"}


@router.post("/{backup_id}/restore")
async def restore_backup(
    backup_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Backup)
        .join(Instance, Backup.instance_id == Instance.id)
        .where(Backup.id == backup_id, Instance.owner_id == user["telegram_id"])
    )
    backup = result.scalar_one_or_none()
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")

    if backup.status != "completed":
        raise HTTPException(status_code=400, detail="Backup not completed")

    i_result = await db.execute(select(Instance).where(Instance.id == backup.instance_id))
    inst = i_result.scalar_one_or_none()
    s_result = await db.execute(select(Server).where(Server.id == backup.server_id))
    server = s_result.scalar_one_or_none()
    if not inst or not server:
        raise HTTPException(status_code=404, detail="Instance or server not found")

    success = await restore_instance(inst, server, backup)
    if not success:
        raise HTTPException(status_code=500, detail="Restore failed")

    return {"detail": f"Restored {inst.name} from backup {backup.id}"}
