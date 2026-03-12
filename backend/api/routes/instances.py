"""CMS instance management endpoints — wired to real CMS plugin drivers."""

import logging
import re
import secrets
from pathlib import Path

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
    update_instance_settings,
    update_instance_domain,
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


class InstanceSettingsUpdate(BaseModel):
    auto_ssl: bool | None = None
    auto_update: bool | None = None
    enterprise: bool | None = None
    enterprise_bypass_license: bool | None = None


class InstanceDomainUpdate(BaseModel):
    domain: str | None = None
    aliases: list[str] = []
    http_redirect: bool = True


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


async def _bg_update_settings(instance_id: str, server_id: str, settings: dict):
    """Background task: apply settings changes via orchestrator."""
    async with async_session() as db:
        result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = result.scalar_one_or_none()
        if not inst:
            return
        srv_result = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            return
        await update_instance_settings(inst, server, db, settings)


async def _bg_bypass_license(instance_id: str, server_id: str, enable: bool):
    """Background task: set/unset Odoo enterprise license expiration bypass via JSONRPC."""
    import json as _json
    async with async_session() as db:
        result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = result.scalar_one_or_none()
        if not inst:
            return
        srv_result = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            return

        config = inst.config or {}
        port = config.get("port", 8069)
        db_name = config.get("db_name", inst.name)
        admin_password = config.get("admin_password", "admin")

        from core.server_manager import ServerInfo, ServerStatus
        from core.vm_controller import VMDriver
        vm = VMDriver()
        server_info = ServerInfo(
            id=server.id, name=server.name, server_type="vm",
            provider=server.provider or "", status=ServerStatus.ONLINE,
            endpoint=server.endpoint,
            metadata={"ssh_user": server.ssh_user or "root", "ssh_key_path": server.ssh_key_path or ""},
        )

        try:
            # Authenticate as admin
            auth_payload = _json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "call",
                "params": {"service": "common", "method": "authenticate",
                           "args": [db_name, "admin", admin_password, {}]}
            })
            auth_result = await vm._ssh_exec(
                server_info,
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{auth_payload}'"
            )
            uid = _json.loads(auth_result).get("result")
            if not uid:
                logging.getLogger(__name__).warning(f"Cannot auth for license bypass on {inst.name}")
                return

            # Set expiration date: far future if enabling bypass, empty if disabling
            expiry_date = "2099-12-31 23:59:59" if enable else ""

            set_payload = _json.dumps({
                "jsonrpc": "2.0", "id": 2, "method": "call",
                "params": {
                    "service": "object", "method": "execute_kw",
                    "args": [db_name, uid, admin_password, "ir.config_parameter", "set_param",
                             ["database.expiration_date", expiry_date]]
                }
            })
            await vm._ssh_exec(
                server_info,
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{set_payload}'"
            )

            # Also set expiration_reason to avoid "renewal required" banner
            reason = "" if enable else ""
            reason_payload = _json.dumps({
                "jsonrpc": "2.0", "id": 3, "method": "call",
                "params": {
                    "service": "object", "method": "execute_kw",
                    "args": [db_name, uid, admin_password, "ir.config_parameter", "set_param",
                             ["database.expiration_reason", reason]]
                }
            })
            await vm._ssh_exec(
                server_info,
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{reason_payload}'"
            )

            logging.getLogger(__name__).info(
                f"Enterprise license bypass {'enabled' if enable else 'disabled'} for {inst.name}"
            )
        except Exception as e:
            logging.getLogger(__name__).error(f"License bypass failed for {inst.name}: {e}")


async def _bg_update_domain(instance_id: str, server_id: str, domain_data: dict):
    """Background task: apply domain changes via orchestrator."""
    async with async_session() as db:
        result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = result.scalar_one_or_none()
        if not inst:
            return
        srv_result = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            return
        await update_instance_domain(inst, server, db, domain_data)


@router.patch("/{instance_id}/settings", response_model=InstanceResponse)
async def update_settings(
    instance_id: str,
    body: InstanceSettingsUpdate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    settings_changed: dict = {}

    if body.enterprise is not None:
        # Validate enterprise package exists for this version
        if body.enterprise:
            enterprise_path = Path(__file__).resolve().parents[2] / "data" / "enterprise" / inst.version
            if not enterprise_path.exists():
                raise HTTPException(
                    status_code=400,
                    detail=f"Enterprise package not found for version {inst.version}. Upload it first.",
                )
        settings_changed["enterprise"] = body.enterprise

    if body.auto_ssl is not None:
        settings_changed["auto_ssl"] = body.auto_ssl

    if body.auto_update is not None:
        settings_changed["auto_update"] = body.auto_update

    if body.enterprise_bypass_license is not None:
        if not (inst.config or {}).get("enterprise"):
            raise HTTPException(status_code=400, detail="Enterprise must be enabled first")
        settings_changed["enterprise_bypass_license"] = body.enterprise_bypass_license

    # Merge settings into config (don't replace)
    inst.config = {**(inst.config or {}), **settings_changed}

    # Enterprise activation is a long-running operation — set status to "upgrading"
    # BEFORE returning, so the frontend immediately starts polling
    if body.enterprise is True:
        inst.status = "upgrading"
        inst.config = {**(inst.config or {}), "enterprise_progress": "Starting enterprise activation..."}

    await db.commit()
    await db.refresh(inst)

    # Trigger orchestrator for enterprise or auto_ssl changes
    if body.enterprise is not None or body.auto_ssl is not None:
        background_tasks.add_task(_bg_update_settings, inst.id, server.id, settings_changed)

    # Bypass license is a quick JSONRPC call, no background task needed
    if body.enterprise_bypass_license is not None:
        background_tasks.add_task(
            _bg_bypass_license, inst.id, server.id, body.enterprise_bypass_license
        )

    return _to_response(inst)


@router.patch("/{instance_id}/domain", response_model=InstanceResponse)
async def update_domain(
    instance_id: str,
    body: InstanceDomainUpdate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    # Validate domain FQDN if provided
    if body.domain:
        fqdn_pattern = re.compile(r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,}$")
        if not fqdn_pattern.match(body.domain):
            raise HTTPException(status_code=400, detail=f"Invalid domain: {body.domain}")

    # Validate aliases
    for alias in body.aliases:
        fqdn_pattern = re.compile(r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,}$")
        if not fqdn_pattern.match(alias):
            raise HTTPException(status_code=400, detail=f"Invalid alias domain: {alias}")

    # Store aliases and http_redirect in config
    inst.config = {
        **(inst.config or {}),
        "aliases": body.aliases,
        "http_redirect": body.http_redirect,
    }
    if body.domain:
        inst.domain = body.domain
    await db.commit()
    await db.refresh(inst)

    # Trigger orchestrator for domain changes
    domain_data = {
        "domain": body.domain,
        "aliases": body.aliases,
        "http_redirect": body.http_redirect,
    }
    background_tasks.add_task(_bg_update_domain, inst.id, server.id, domain_data)

    return _to_response(inst)


@router.get("/{instance_id}/addons")
async def list_addons(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List addons installed on the instance (enterprise, custom, etc.)."""
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    addons = []
    config = inst.config or {}

    # Enterprise addon
    if config.get("enterprise"):
        is_upgrading = inst.status == "upgrading"

        # Get installed revision date from instance config
        installed_revision = config.get("enterprise_revision_date", "")

        # Get available revision date from global enterprise package
        available_revision = ""
        try:
            meta_path = Path(__file__).resolve().parents[2] / "data" / "enterprise" / inst.version / "meta.json"
            if meta_path.exists():
                import json as _json
                meta = _json.loads(meta_path.read_text())
                available_revision = meta.get("revision_date", "")
        except Exception:
            pass

        update_available = bool(available_revision and installed_revision and available_revision > installed_revision)

        addons.append({
            "type": "file",
            "name": "Odoo Enterprise",
            "branch": inst.version,
            "status": "installing" if is_upgrading else "installed",
            "can_update": not is_upgrading,
            "can_delete": not is_upgrading,
            "revision_date": installed_revision,
            "available_revision_date": available_revision,
            "update_available": update_available,
        })

    return addons


async def _bg_update_enterprise_addons(instance_id: str, server_id: str):
    """Background task: re-sync enterprise addons from global package."""
    async with async_session() as db:
        result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = result.scalar_one_or_none()
        if not inst:
            return
        srv_result = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            return
        await update_instance_settings(inst, server, db, {"enterprise": True})


@router.post("/{instance_id}/addons/enterprise/update")
async def update_enterprise_addons(
    instance_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Re-sync enterprise addons from global package (e.g. after re-upload)."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    if not (inst.config or {}).get("enterprise"):
        raise HTTPException(status_code=400, detail="Enterprise is not enabled on this instance")
    if inst.status != "running":
        raise HTTPException(status_code=400, detail="Instance must be running to update addons")

    background_tasks.add_task(_bg_update_enterprise_addons, inst.id, server.id)
    return {"detail": f"Enterprise addons update started for {inst.name}"}


@router.delete("/{instance_id}/addons/enterprise")
async def remove_enterprise_addons(
    instance_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Disable enterprise and revert to community edition."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    if not (inst.config or {}).get("enterprise"):
        raise HTTPException(status_code=400, detail="Enterprise is not enabled on this instance")

    # Set enterprise to false in config
    inst.config = {**(inst.config or {}), "enterprise": False}
    await db.commit()

    # Trigger orchestrator to revert compose
    background_tasks.add_task(_bg_update_settings, inst.id, server.id, {"enterprise": False})
    return {"detail": f"Enterprise addon removal started for {inst.name}"}
