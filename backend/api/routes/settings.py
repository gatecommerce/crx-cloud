"""Settings management — API Keys, Backup Storage, Account."""

import hashlib
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.api_key import ApiKey
from api.models.backup_storage import BackupStorage
from api.models.instance import Instance
from api.models.backup import Backup
from core.auth import get_current_user
from core.database import get_db

router = APIRouter()


# --- Pydantic Models ---

class ApiKeyCreate(BaseModel):
    name: str

class ApiKeyResponse(BaseModel):
    id: str
    name: str
    key_prefix: str
    is_active: bool
    last_used_at: str | None
    created_at: str

class ApiKeyCreated(BaseModel):
    id: str
    name: str
    key: str  # Only returned once at creation!
    key_prefix: str

class BackupStorageCreate(BaseModel):
    name: str
    provider: str  # s3, azure, gcs, local
    config: dict = {}

class BackupStorageUpdate(BaseModel):
    name: str | None = None
    config: dict | None = None

class BackupStorageResponse(BaseModel):
    id: str
    name: str
    provider: str
    is_active: bool
    config: dict
    backup_count: int
    total_size_mb: int
    created_at: str

class AccountResponse(BaseModel):
    telegram_id: str
    name: str
    is_admin: bool
    language: str
    instances_count: int
    backups_count: int
    servers_count: int

class AccountUpdate(BaseModel):
    name: str | None = None
    language: str | None = None


# --- API Keys ---

def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()

@router.get("/api-keys", response_model=list[ApiKeyResponse])
async def list_api_keys(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ApiKey).where(ApiKey.owner_id == user["telegram_id"]).order_by(ApiKey.created_at.desc())
    )
    return [
        ApiKeyResponse(
            id=k.id, name=k.name, key_prefix=k.key_prefix,
            is_active=k.is_active,
            last_used_at=k.last_used_at.isoformat() if k.last_used_at else None,
            created_at=k.created_at.isoformat(),
        )
        for k in result.scalars().all()
    ]

@router.post("/api-keys", response_model=ApiKeyCreated, status_code=201)
async def create_api_key(
    body: ApiKeyCreate,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # Generate secure key: crx_<32 random chars>
    raw_key = f"crx_{secrets.token_urlsafe(32)}"
    key_prefix = raw_key[:8]
    key_hash = _hash_key(raw_key)

    api_key = ApiKey(
        owner_id=user["telegram_id"],
        name=body.name,
        key_prefix=key_prefix,
        key_hash=key_hash,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)

    return ApiKeyCreated(id=api_key.id, name=api_key.name, key=raw_key, key_prefix=key_prefix)

@router.delete("/api-keys/{key_id}")
async def revoke_api_key(
    key_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.owner_id == user["telegram_id"])
    )
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail="API key not found")
    await db.delete(key)
    await db.commit()
    return {"detail": f"API key '{key.name}' revoked"}

@router.patch("/api-keys/{key_id}/toggle")
async def toggle_api_key(
    key_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.owner_id == user["telegram_id"])
    )
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail="API key not found")
    key.is_active = not key.is_active
    await db.commit()
    return {"detail": f"API key '{key.name}' {'activated' if key.is_active else 'deactivated'}"}


# --- Backup Storage ---

@router.get("/backup-storages", response_model=list[BackupStorageResponse])
async def list_backup_storages(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(BackupStorage).where(BackupStorage.owner_id == user["telegram_id"]).order_by(BackupStorage.created_at.desc())
    )
    storages = result.scalars().all()
    # Mask sensitive fields in config
    resp = []
    for s in storages:
        safe_config = {**s.config} if s.config else {}
        for secret_key in ("secret_key", "access_key_secret", "password", "sas_token"):
            if secret_key in safe_config:
                safe_config[secret_key] = "***"
        resp.append(BackupStorageResponse(
            id=s.id, name=s.name, provider=s.provider,
            is_active=s.is_active, config=safe_config,
            backup_count=s.backup_count, total_size_mb=s.total_size_mb,
            created_at=s.created_at.isoformat(),
        ))
    return resp

@router.post("/backup-storages", response_model=BackupStorageResponse, status_code=201)
async def create_backup_storage(
    body: BackupStorageCreate,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    if body.provider not in ("s3", "azure", "gcs", "local"):
        raise HTTPException(status_code=400, detail="Unsupported provider. Use: s3, azure, gcs, local")

    storage = BackupStorage(
        owner_id=user["telegram_id"],
        name=body.name,
        provider=body.provider,
        config=body.config,
    )
    db.add(storage)
    await db.commit()
    await db.refresh(storage)

    return BackupStorageResponse(
        id=storage.id, name=storage.name, provider=storage.provider,
        is_active=storage.is_active, config=body.config,
        backup_count=0, total_size_mb=0,
        created_at=storage.created_at.isoformat(),
    )

@router.patch("/backup-storages/{storage_id}")
async def update_backup_storage(
    storage_id: str,
    body: BackupStorageUpdate,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(BackupStorage).where(BackupStorage.id == storage_id, BackupStorage.owner_id == user["telegram_id"])
    )
    storage = result.scalar_one_or_none()
    if not storage:
        raise HTTPException(status_code=404, detail="Backup storage not found")
    if body.name is not None:
        storage.name = body.name
    if body.config is not None:
        storage.config = body.config
    await db.commit()
    return {"detail": f"Backup storage '{storage.name}' updated"}

@router.post("/backup-storages/{storage_id}/activate")
async def activate_backup_storage(
    storage_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # Deactivate all others first
    result = await db.execute(
        select(BackupStorage).where(BackupStorage.owner_id == user["telegram_id"])
    )
    for s in result.scalars().all():
        s.is_active = (s.id == storage_id)
    await db.commit()
    return {"detail": "Backup storage activated"}

@router.delete("/backup-storages/{storage_id}")
async def delete_backup_storage(
    storage_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(BackupStorage).where(BackupStorage.id == storage_id, BackupStorage.owner_id == user["telegram_id"])
    )
    storage = result.scalar_one_or_none()
    if not storage:
        raise HTTPException(status_code=404, detail="Backup storage not found")
    if storage.is_active:
        raise HTTPException(status_code=400, detail="Cannot delete active backup storage")
    await db.delete(storage)
    await db.commit()
    return {"detail": f"Backup storage '{storage.name}' removed"}


# --- Account ---

@router.get("/account", response_model=AccountResponse)
async def get_account(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    tid = user["telegram_id"]
    instances_q = await db.execute(select(sa_func.count()).select_from(Instance).where(Instance.owner_id == tid))
    backups_q = await db.execute(
        select(sa_func.count()).select_from(Backup).join(Instance).where(Instance.owner_id == tid)
    )
    from api.models.server import Server
    servers_q = await db.execute(select(sa_func.count()).select_from(Server).where(Server.owner_id == tid))

    return AccountResponse(
        telegram_id=user["telegram_id"],
        name=user["name"],
        is_admin=user["is_admin"],
        language=user["lang"],
        instances_count=instances_q.scalar() or 0,
        backups_count=backups_q.scalar() or 0,
        servers_count=servers_q.scalar() or 0,
    )
