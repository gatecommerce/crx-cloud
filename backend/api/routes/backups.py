"""Backup management endpoints."""

from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.get("/")
async def list_backups(instance_id: str | None = None):
    """List backups, optionally filtered by instance."""
    return []


@router.post("/{instance_id}")
async def create_backup(instance_id: str):
    """Trigger a manual backup for an instance."""
    raise HTTPException(status_code=501, detail="Not implemented yet")


@router.post("/{backup_id}/restore")
async def restore_backup(backup_id: str):
    """Restore an instance from a backup."""
    raise HTTPException(status_code=501, detail="Not implemented yet")
