"""Backup management endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.backup import Backup
from api.models.instance import Instance
from core.auth import get_current_user
from core.database import get_db

router = APIRouter()


class BackupResponse(BaseModel):
    id: str
    instance_id: str
    server_id: str
    backup_type: str
    status: str
    size_mb: int | None
    created_at: str


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
            created_at=b.created_at.isoformat(),
        )
        for b in backups
    ]


@router.post("/{instance_id}", status_code=201)
async def create_backup(
    instance_id: str,
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
    return {"detail": f"Restore triggered from backup {backup.id}"}
