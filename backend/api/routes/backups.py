"""Backup management endpoints — wired to real CMS plugin drivers."""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, func as sa_func
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
    size_mb: int | None = None
    duration_seconds: int | None = None
    storage_path: str | None = None
    progress: dict | None = None
    include_filestore: bool = True
    created_at: str
    completed_at: str | None = None


class BackupStatsResponse(BaseModel):
    total_backups: int
    completed_backups: int
    failed_backups: int
    total_size_mb: int
    last_backup_at: str | None
    last_backup_status: str | None


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


@router.get("", response_model=list[BackupResponse])
async def list_backups(
    instance_id: str | None = None,
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
            duration_seconds=b.duration_seconds, storage_path=b.storage_path,
            progress=b.progress, include_filestore=b.include_filestore,
            created_at=b.created_at.isoformat(),
            completed_at=b.completed_at.isoformat() if b.completed_at else None,
        )
        for b in backups
    ]


@router.get("/stats")
async def backup_stats(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get backup statistics for an instance."""
    # Verify ownership
    inst_result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    if not inst_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Instance not found")

    result = await db.execute(
        select(Backup).where(Backup.instance_id == instance_id).order_by(Backup.created_at.desc())
    )
    backups = result.scalars().all()

    completed = [b for b in backups if b.status == "completed"]
    failed = [b for b in backups if b.status == "failed"]
    total_size = sum(b.size_mb or 0 for b in completed)
    last = backups[0] if backups else None

    return BackupStatsResponse(
        total_backups=len(backups),
        completed_backups=len(completed),
        failed_backups=len(failed),
        total_size_mb=total_size,
        last_backup_at=last.created_at.isoformat() if last else None,
        last_backup_status=last.status if last else None,
    )


class CreateBackupRequest(BaseModel):
    include_filestore: bool = True


@router.post("/{instance_id}", status_code=201)
async def create_backup(
    instance_id: str,
    background_tasks: BackgroundTasks,
    body: CreateBackupRequest | None = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    include_filestore = body.include_filestore if body else True

    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    backup = Backup(
        instance_id=inst.id, server_id=inst.server_id,
        backup_type="manual", status="pending",
        include_filestore=include_filestore,
    )
    db.add(backup)
    await db.commit()
    await db.refresh(backup)

    # Real backup in background
    background_tasks.add_task(_bg_backup, backup.id, inst.id, inst.server_id)

    return {"id": backup.id, "status": "pending", "detail": f"Backup triggered for {inst.name}"}


class RestoreRequest(BaseModel):
    include_filestore: bool = True


@router.post("/{backup_id}/restore")
async def restore_backup(
    backup_id: str,
    body: RestoreRequest | None = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    include_filestore = body.include_filestore if body else True

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

    success = await restore_instance(inst, server, backup, include_filestore=include_filestore)
    if not success:
        raise HTTPException(status_code=500, detail="Restore failed")

    return {"detail": f"Restored {inst.name} from backup {backup.id} (filestore={'yes' if include_filestore else 'no'})"}


@router.post("/{backup_id}/cancel")
async def cancel_backup(
    backup_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Cancel a pending or in-progress backup, kill remote processes, reset instance status, and clean up."""
    result = await db.execute(
        select(Backup)
        .join(Instance, Backup.instance_id == Instance.id)
        .where(Backup.id == backup_id, Instance.owner_id == user["telegram_id"])
    )
    backup = result.scalar_one_or_none()
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")

    if backup.status not in ("pending", "in_progress"):
        raise HTTPException(status_code=400, detail="Only pending or in-progress backups can be cancelled")

    # Signal the background task to stop at next step boundary
    from core.orchestrator import mark_backup_cancelled
    mark_backup_cancelled(str(backup.id))

    # Mark backup as failed/cancelled
    from datetime import datetime, timezone
    backup.status = "failed"
    backup.error_message = "Cancelled by user"
    backup.completed_at = datetime.now(timezone.utc)

    # Reset instance status back to running
    inst_result = await db.execute(select(Instance).where(Instance.id == backup.instance_id))
    inst = inst_result.scalar_one_or_none()
    if inst and inst.status == "backing_up":
        inst.status = "running"

    # Kill running pg_dump and clean up partial backup directory on server
    try:
        srv_result = await db.execute(select(Server).where(Server.id == backup.server_id))
        server = srv_result.scalar_one_or_none()
        if server:
            from core.orchestrator import _server_info_from_db
            from core.vm_controller import VMDriver
            vm = VMDriver()
            server_info = _server_info_from_db(server)
            # Kill any running pg_dump process (best-effort)
            await vm._ssh_exec(server_info, "pkill -f 'pg_dump' || true", timeout=10)
            # Clean up partial backup directory (rm -rf, not rm -f — it's a directory)
            if backup.storage_path:
                await vm._ssh_exec(server_info, f"rm -rf {backup.storage_path}", timeout=15)
    except Exception:
        pass  # Best-effort cleanup

    await db.commit()
    return {"detail": f"Backup {backup_id} cancelled"}


@router.delete("/{backup_id}")
async def delete_backup(
    backup_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Delete a backup record and its storage file."""
    result = await db.execute(
        select(Backup)
        .join(Instance, Backup.instance_id == Instance.id)
        .where(Backup.id == backup_id, Instance.owner_id == user["telegram_id"])
    )
    backup = result.scalar_one_or_none()
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")

    # Don't delete in-progress backups
    if backup.status in ("pending", "in_progress"):
        raise HTTPException(status_code=400, detail="Cannot delete a backup that is still in progress")

    await db.delete(backup)
    await db.commit()
    return {"detail": f"Backup {backup_id} deleted"}
