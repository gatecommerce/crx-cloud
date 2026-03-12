"""CMS instance management endpoints — wired to real CMS plugin drivers."""

import logging
import re
import secrets

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.instance import Instance
from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db, async_session
from core.orchestrator import (
    deploy_instance,
    restart_instance,
    stop_instance,
    start_instance,
    remove_instance,
    health_check_instance,
    get_instance_logs,
    get_plugin,
)

try:
    from core.dns_manager import create_subdomain, generate_subdomain
except ImportError:
    create_subdomain = None  # type: ignore[assignment]
    generate_subdomain = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

router = APIRouter()


class InstanceCreate(BaseModel):
    server_id: str
    cms_type: str = "odoo"
    version: str = "18.0"
    name: str
    domain: str = ""
    workers: int = 2
    ram_mb: int = 2048
    cpu_cores: int = 1
    config: dict = {}
    # Enterprise fields
    admin_password: str = ""
    language: str = "en_US"
    country: str = ""
    db_name: str = ""
    use_external_db: bool = False
    external_db_host: str = ""
    external_db_port: int = 5432
    external_db_name: str = ""
    external_db_user: str = ""
    external_db_password: str = ""
    edition: str = "community"
    demo_data: bool = False
    auto_domain: bool = True


class InstanceResponse(BaseModel):
    id: str
    server_id: str
    cms_type: str
    version: str
    name: str
    domain: str | None
    status: str
    url: str | None
    workers: int
    ram_mb: int
    cpu_cores: int
    config: dict = {}


def _to_response(i: Instance) -> InstanceResponse:
    return InstanceResponse(
        id=i.id, server_id=i.server_id, cms_type=i.cms_type,
        version=i.version, name=i.name, domain=i.domain,
        status=i.status, url=i.url, workers=i.workers,
        ram_mb=i.ram_mb, cpu_cores=i.cpu_cores,
        config=i.config or {},
    )


async def _get_instance_and_server(
    instance_id: str, owner_id: str, db: AsyncSession
) -> tuple[Instance, Server]:
    """Fetch instance + its server, raise 404 if not found."""
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == owner_id)
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    srv_result = await db.execute(select(Server).where(Server.id == inst.server_id))
    server = srv_result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    return inst, server


async def _bg_deploy(instance_id: str, server_id: str):
    """Background task: deploy instance via CMS plugin driver."""
    async with async_session() as db:
        result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = result.scalar_one_or_none()
        if not inst:
            return
        srv_result = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            inst.status = "error"
            inst.config = {**(inst.config or {}), "error": "Server not found"}
            await db.commit()
            return
        await deploy_instance(inst, server, db)


def _slugify(name: str) -> str:
    """Convert instance name to a valid subdomain slug."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9-]", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "instance"


@router.get("", response_model=list[InstanceResponse])
async def list_instances(
    server_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    query = select(Instance).where(Instance.owner_id == user["telegram_id"])
    if server_id:
        query = query.where(Instance.server_id == server_id)
    result = await db.execute(query)
    return [_to_response(i) for i in result.scalars().all()]


@router.post("", response_model=InstanceResponse, status_code=201)
async def create_instance(
    body: InstanceCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    srv = await db.execute(
        select(Server).where(Server.id == body.server_id, Server.owner_id == user["telegram_id"])
    )
    server = srv.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    plugin = get_plugin(body.cms_type)
    if not plugin:
        raise HTTPException(status_code=400, detail=f"Unsupported CMS: {body.cms_type}")

    if body.version not in plugin.supported_versions:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported version {body.version}. Available: {plugin.supported_versions}",
        )

    # --- Enterprise feature: admin password auto-generation ---
    admin_password = body.admin_password or secrets.token_urlsafe(12)

    # --- Enterprise feature: auto-domain ---
    domain = body.domain
    if body.auto_domain and not domain:
        slug = _slugify(body.name)
        domain = f"{slug}.site.crx.team"
        # Try to create DNS record if dns_manager is available
        try:
            if create_subdomain is not None:
                await create_subdomain(slug, server.ip_address if hasattr(server, "ip_address") else "")
        except Exception:
            logger.warning("Failed to create DNS record for %s — continuing without it", domain)

    # --- Build enriched config with all enterprise fields ---
    instance_config = {**body.config}
    instance_config.update({
        "admin_password": admin_password,
        "language": body.language,
        "country": body.country,
        "db_name": body.db_name or _slugify(body.name).replace("-", "_"),
        "edition": body.edition,
        "demo_data": body.demo_data,
        "auto_domain": body.auto_domain,
        "use_external_db": body.use_external_db,
    })
    if body.use_external_db:
        instance_config.update({
            "external_db_host": body.external_db_host,
            "external_db_port": body.external_db_port,
            "external_db_name": body.external_db_name,
            "external_db_user": body.external_db_user,
            "external_db_password": body.external_db_password,
        })

    instance = Instance(
        name=body.name, cms_type=body.cms_type, version=body.version,
        server_id=body.server_id, domain=domain, status="deploying",
        workers=body.workers, ram_mb=body.ram_mb, cpu_cores=body.cpu_cores,
        config=instance_config, owner_id=user["telegram_id"],
    )
    db.add(instance)
    await db.commit()
    await db.refresh(instance)

    # Real deploy in background
    background_tasks.add_task(_bg_deploy, instance.id, server.id)

    return _to_response(instance)


@router.get("/{instance_id}", response_model=InstanceResponse)
async def get_instance(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    return _to_response(inst)


@router.post("/{instance_id}/restart")
async def restart_instance_endpoint(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    success = await restart_instance(inst, server)
    if not success:
        raise HTTPException(status_code=500, detail="Restart failed")
    return {"detail": f"Restarted {inst.name}"}


@router.post("/{instance_id}/stop")
async def stop_instance_endpoint(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    success = await stop_instance(inst, server)
    if not success:
        raise HTTPException(status_code=500, detail="Stop failed")
    inst.status = "stopped"
    await db.commit()
    return {"detail": f"Stopped {inst.name}"}


@router.post("/{instance_id}/start")
async def start_instance_endpoint(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    success = await start_instance(inst, server)
    if not success:
        raise HTTPException(status_code=500, detail="Start failed")
    inst.status = "running"
    await db.commit()
    return {"detail": f"Started {inst.name}"}


@router.post("/{instance_id}/scale")
async def scale_instance(
    instance_id: str,
    workers: int = 2,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    inst.workers = workers
    await db.commit()
    return {"detail": f"Scaled {inst.name} to {workers} workers"}


@router.get("/{instance_id}/health")
async def instance_health(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    health = await health_check_instance(inst, server)
    return {"instance_id": inst.id, "name": inst.name, **health}


@router.get("/{instance_id}/logs")
async def instance_logs(
    instance_id: str,
    lines: int = 100,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    logs = await get_instance_logs(inst, server, lines)
    return {"instance_id": inst.id, "name": inst.name, "logs": logs}


@router.delete("/{instance_id}")
async def delete_instance(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    await remove_instance(inst, server)
    await db.delete(inst)
    await db.commit()
    return {"detail": f"Instance {inst.name} removed"}
