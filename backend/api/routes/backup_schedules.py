"""Backup Schedules API — automated periodic backup management."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.backup_schedule import BackupSchedule
from api.models.instance import Instance
from core.auth import get_current_user
from core.database import get_db

router = APIRouter()


class ScheduleCreate(BaseModel):
    instance_id: str
    cron_expression: str = "0 2 * * *"
    timezone: str = "Europe/Rome"
    backup_format: str = "zip"
    include_filestore: bool = True
    destination_ids: list[str] | None = None
    keep_daily: int = 7
    keep_weekly: int = 4
    keep_monthly: int = 12
    notify_on_success: bool = False
    notify_on_failure: bool = True
    notification_channels: list[str] | None = None
    verify_after_backup: bool = True
    stop_instance_during_backup: bool = False
    pre_backup_command: str | None = None
    post_backup_command: str | None = None


class ScheduleUpdate(BaseModel):
    cron_expression: str | None = None
    timezone: str | None = None
    backup_format: str | None = None
    include_filestore: bool | None = None
    keep_daily: int | None = None
    keep_weekly: int | None = None
    keep_monthly: int | None = None
    notify_on_success: bool | None = None
    notify_on_failure: bool | None = None
    verify_after_backup: bool | None = None
    stop_instance_during_backup: bool | None = None


class ScheduleResponse(BaseModel):
    id: str
    instance_id: str
    enabled: bool
    cron_expression: str
    timezone: str
    backup_format: str
    include_filestore: bool
    keep_daily: int
    keep_weekly: int
    keep_monthly: int
    notify_on_success: bool
    notify_on_failure: bool
    verify_after_backup: bool
    stop_instance_during_backup: bool
    last_run_at: str | None = None
    last_status: str | None = None
    consecutive_failures: int
    total_runs: int
    created_at: str


def _to_response(s: BackupSchedule) -> ScheduleResponse:
    return ScheduleResponse(
        id=s.id, instance_id=s.instance_id, enabled=s.enabled,
        cron_expression=s.cron_expression, timezone=s.timezone,
        backup_format=s.backup_format, include_filestore=s.include_filestore,
        keep_daily=s.keep_daily, keep_weekly=s.keep_weekly, keep_monthly=s.keep_monthly,
        notify_on_success=s.notify_on_success, notify_on_failure=s.notify_on_failure,
        verify_after_backup=s.verify_after_backup,
        stop_instance_during_backup=s.stop_instance_during_backup,
        last_run_at=s.last_run_at.isoformat() if s.last_run_at else None,
        last_status=s.last_status,
        consecutive_failures=s.consecutive_failures, total_runs=s.total_runs,
        created_at=s.created_at.isoformat(),
    )


@router.get("", response_model=list[ScheduleResponse])
async def list_schedules(
    instance_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    query = select(BackupSchedule).where(BackupSchedule.owner_id == user["telegram_id"])
    if instance_id:
        query = query.where(BackupSchedule.instance_id == instance_id)
    result = await db.execute(query.order_by(BackupSchedule.created_at.desc()))
    return [_to_response(s) for s in result.scalars().all()]


@router.post("", status_code=201, response_model=ScheduleResponse)
async def create_schedule(
    body: ScheduleCreate,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # Validate instance ownership
    inst_result = await db.execute(
        select(Instance).where(Instance.id == body.instance_id, Instance.owner_id == user["telegram_id"])
    )
    if not inst_result.scalar_one_or_none():
        raise HTTPException(404, "Instance not found")

    schedule = BackupSchedule(
        instance_id=body.instance_id,
        owner_id=user["telegram_id"],
        cron_expression=body.cron_expression,
        timezone=body.timezone,
        backup_format=body.backup_format,
        include_filestore=body.include_filestore,
        destination_ids=body.destination_ids,
        keep_daily=body.keep_daily,
        keep_weekly=body.keep_weekly,
        keep_monthly=body.keep_monthly,
        notify_on_success=body.notify_on_success,
        notify_on_failure=body.notify_on_failure,
        notification_channels=body.notification_channels,
        verify_after_backup=body.verify_after_backup,
        stop_instance_during_backup=body.stop_instance_during_backup,
        pre_backup_command=body.pre_backup_command,
        post_backup_command=body.post_backup_command,
    )
    db.add(schedule)
    await db.commit()
    await db.refresh(schedule)
    return _to_response(schedule)


@router.get("/{schedule_id}", response_model=ScheduleResponse)
async def get_schedule(
    schedule_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(BackupSchedule).where(BackupSchedule.id == schedule_id, BackupSchedule.owner_id == user["telegram_id"])
    )
    schedule = result.scalar_one_or_none()
    if not schedule:
        raise HTTPException(404, "Schedule not found")
    return _to_response(schedule)


@router.patch("/{schedule_id}", response_model=ScheduleResponse)
async def update_schedule(
    schedule_id: str,
    body: ScheduleUpdate,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(BackupSchedule).where(BackupSchedule.id == schedule_id, BackupSchedule.owner_id == user["telegram_id"])
    )
    schedule = result.scalar_one_or_none()
    if not schedule:
        raise HTTPException(404, "Schedule not found")

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(schedule, field, value)

    await db.commit()
    await db.refresh(schedule)
    return _to_response(schedule)


@router.post("/{schedule_id}/toggle")
async def toggle_schedule(
    schedule_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(BackupSchedule).where(BackupSchedule.id == schedule_id, BackupSchedule.owner_id == user["telegram_id"])
    )
    schedule = result.scalar_one_or_none()
    if not schedule:
        raise HTTPException(404, "Schedule not found")

    schedule.enabled = not schedule.enabled
    await db.commit()
    return {"detail": f"Schedule {'enabled' if schedule.enabled else 'disabled'}", "enabled": schedule.enabled}


@router.delete("/{schedule_id}")
async def delete_schedule(
    schedule_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(BackupSchedule).where(BackupSchedule.id == schedule_id, BackupSchedule.owner_id == user["telegram_id"])
    )
    schedule = result.scalar_one_or_none()
    if not schedule:
        raise HTTPException(404, "Schedule not found")

    await db.delete(schedule)
    await db.commit()
    return {"detail": "Schedule deleted"}


@router.post("/{schedule_id}/run")
async def run_schedule_now(
    schedule_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(BackupSchedule).where(BackupSchedule.id == schedule_id, BackupSchedule.owner_id == user["telegram_id"])
    )
    schedule = result.scalar_one_or_none()
    if not schedule:
        raise HTTPException(404, "Schedule not found")

    from core.instance_ops import execute_scheduled_backup
    backup_id = await execute_scheduled_backup(schedule_id, db)

    return {"detail": "Backup triggered", "backup_id": backup_id}
