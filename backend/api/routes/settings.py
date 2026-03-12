"""Settings management — API Keys, Backup Storage, Account, Enterprise Packages."""

import hashlib
import json
import os
import secrets
import shutil
import zipfile
import tarfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.api_key import ApiKey
from api.models.backup_storage import BackupStorage
from api.models.instance import Instance
from api.models.backup import Backup
from core.auth import get_current_user
from core.database import get_db

from loguru import logger

ENTERPRISE_DIR = Path(__file__).resolve().parents[2] / "data" / "enterprise"

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


# --- Enterprise Packages ---

@router.get("/enterprise")
async def list_enterprise_packages(
    user: dict = Depends(get_current_user),
):
    """List available enterprise packages per version."""
    ENTERPRISE_DIR.mkdir(parents=True, exist_ok=True)
    packages = []
    for version_dir in sorted(ENTERPRISE_DIR.iterdir()):
        if not version_dir.is_dir():
            continue
        meta_path = version_dir / "meta.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                packages.append({
                    "version": version_dir.name,
                    "uploaded_at": meta.get("uploaded_at", ""),
                    "size_mb": meta.get("size_mb", 0),
                    "filename": meta.get("filename", ""),
                    "revision_date": meta.get("revision_date", ""),
                })
            except Exception:
                packages.append({
                    "version": version_dir.name,
                    "uploaded_at": "",
                    "size_mb": 0,
                    "filename": "",
                    "revision_date": "",
                })
        else:
            packages.append({
                "version": version_dir.name,
                "uploaded_at": "",
                "size_mb": 0,
                "filename": "",
                "revision_date": "",
            })
    return packages


def _detect_odoo_version(archive_path: Path, filename: str) -> str | None:
    """Auto-detect Odoo version from enterprise package.

    Detection priority:
    1. Filename (e.g. "odoo_19.0+e.20251015.tar.gz" -> 19.0)
    2. Top-level dir (e.g. "odoo-19.0+e.20251015/" -> 19.0)
    3. __manifest__.py Odoo-style version (e.g. "19.0.1.4.0" -> 19.0)
    """
    import re

    VALID_ODOO = {"15.0", "16.0", "17.0", "18.0", "19.0", "20.0"}

    # 1. Filename — most reliable for official Odoo packages
    for fm in re.finditer(r"(\d+\.\d+)", filename):
        if fm.group(1) in VALID_ODOO:
            logger.info(f"Version {fm.group(1)} detected from filename: {filename}")
            return fm.group(1)

    # 2. Inspect archive top-level dirs and manifests
    top_dirs: list[str] = []
    try:
        if filename.endswith(".zip"):
            with zipfile.ZipFile(archive_path, "r") as zf:
                all_names = zf.namelist()
                top_dirs = list({n.split("/")[0] for n in all_names if "/" in n})
        elif filename.endswith(".tar.gz") or filename.endswith(".tgz"):
            with tarfile.open(archive_path, "r:gz") as tf:
                top_dirs = list({m.name.split("/")[0] for m in tf.getmembers() if "/" in m.name})
    except Exception as e:
        logger.warning(f"Archive inspection failed: {e}")

    logger.debug(f"Archive top dirs: {top_dirs[:5]}")

    # Check top-level dir names (e.g. "odoo-19.0+e.20251015")
    for d in top_dirs:
        for dm in re.finditer(r"(\d+\.\d+)", d):
            if dm.group(1) in VALID_ODOO:
                logger.info(f"Version {dm.group(1)} detected from dir: {d}")
                return dm.group(1)

    # 3. Last resort: __manifest__.py (Odoo versions are like "19.0.1.4.0")
    try:
        if filename.endswith(".zip"):
            with zipfile.ZipFile(archive_path, "r") as zf:
                for name in zf.namelist():
                    if name.endswith("__manifest__.py"):
                        content = zf.read(name).decode("utf-8", errors="ignore")
                        vm = re.search(r"['\"]version['\"]\s*:\s*['\"](\d+\.\d+)\.\d+", content)
                        if vm and vm.group(1) in VALID_ODOO:
                            logger.info(f"Version {vm.group(1)} from manifest {name}")
                            return vm.group(1)
                        break
        elif filename.endswith(".tar.gz") or filename.endswith(".tgz"):
            with tarfile.open(archive_path, "r:gz") as tf:
                for member in tf.getmembers():
                    if member.name.endswith("__manifest__.py"):
                        f = tf.extractfile(member)
                        if f:
                            content = f.read().decode("utf-8", errors="ignore")
                            vm = re.search(r"['\"]version['\"]\s*:\s*['\"](\d+\.\d+)\.\d+", content)
                            if vm and vm.group(1) in VALID_ODOO:
                                logger.info(f"Version {vm.group(1)} from manifest {member.name}")
                                return vm.group(1)
                        break
    except Exception as e:
        logger.warning(f"Manifest inspection failed: {e}")

    logger.warning(f"Could not detect Odoo version from {filename}")
    return None


@router.post("/enterprise/upload")
async def upload_enterprise_package(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload an enterprise package — version is auto-detected from filename."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    fname = file.filename
    logger.info(f"Enterprise upload started: {fname}")

    # Auto-detect version from filename (e.g. odoo_19.0+e.20251015.tar.gz)
    import re
    VALID_ODOO = {"15.0", "16.0", "17.0", "18.0", "19.0", "20.0"}
    version = None
    for m in re.finditer(r"(\d+\.\d+)", fname):
        if m.group(1) in VALID_ODOO:
            version = m.group(1)
            break

    if not version:
        raise HTTPException(
            status_code=400,
            detail="Could not detect Odoo version from filename. Expected pattern like 'odoo_19.0+e.tar.gz'.",
        )

    logger.info(f"Enterprise version detected: {version} from {fname}")

    version_dir = ENTERPRISE_DIR / version
    # Clean old package if exists
    if version_dir.exists():
        shutil.rmtree(version_dir)
    version_dir.mkdir(parents=True, exist_ok=True)

    # Stream file to disk (avoids loading 300+ MB into memory)
    file_path = version_dir / fname
    size_bytes = 0
    with open(file_path, "wb") as out:
        while chunk := await file.read(1024 * 1024):  # 1MB chunks
            out.write(chunk)
            size_bytes += len(chunk)

    size_mb = round(size_bytes / (1024 * 1024), 2)
    logger.info(f"Enterprise package saved: {file_path} ({size_mb} MB)")

    # Extract revision date from filename (e.g. odoo_19.0+e.20251015.tar.gz → 2025-10-15)
    revision_date = ""
    date_match = re.search(r"(\d{4})(\d{2})(\d{2})", fname)
    if date_match:
        revision_date = f"{date_match.group(1)}-{date_match.group(2)}-{date_match.group(3)}"

    # Write meta.json
    uploaded_at = datetime.now(timezone.utc).isoformat()
    meta = {
        "uploaded_at": uploaded_at,
        "filename": fname,
        "size_mb": size_mb,
        "version": version,
        "revision_date": revision_date,
    }
    (version_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    return {
        "version": version,
        "uploaded_at": uploaded_at,
        "size_mb": size_mb,
        "filename": fname,
        "revision_date": revision_date,
    }


@router.delete("/enterprise/{version}")
async def delete_enterprise_package(
    version: str,
    user: dict = Depends(get_current_user),
):
    """Remove enterprise package for a specific version."""
    version_dir = ENTERPRISE_DIR / version
    if not version_dir.exists():
        raise HTTPException(status_code=404, detail=f"Enterprise package for version {version} not found")

    shutil.rmtree(version_dir)
    logger.info(f"Enterprise package removed for version {version}")
    return {"detail": f"Enterprise package for version {version} removed"}
