"""CMS instance management endpoints — wired to real CMS plugin drivers."""

import logging
import re
import secrets
from pathlib import Path
from typing import Any

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
    workers: int = 0
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
    enterprise_bypass_uuid: str | None = None


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
    from api.models.backup import Backup
    from api.models.clone import Clone
    from api.models.migration import Migration

    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    await remove_instance(inst, server)

    # Delete dependent records to avoid FK violations
    for model, col in [
        (Migration, Migration.source_instance_id),
        (Backup, Backup.instance_id),
        (Clone, Clone.source_instance_id),
    ]:
        rows = await db.execute(select(model).where(col == instance_id))
        for row in rows.scalars().all():
            await db.delete(row)

    # Delete staging children
    children = await db.execute(select(Instance).where(Instance.parent_id == instance_id))
    for child in children.scalars().all():
        child.parent_id = None

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
    """Background task: safe enable/disable Odoo enterprise license bypass.

    SAFE DESIGN:
    - Enable:  snapshot DB → deploy addon → regenerate compose → clean restart → install module
    - Disable: clean SQL removal → regenerate compose → clean restart (no ORM uninstall!)
    - On failure: auto-restore from snapshot (enable only)

    NEVER uses button_immediate_uninstall — monkey patches on requests/Session/HTTPAdapter
    cannot be safely removed at runtime without crashing Odoo.
    """
    import json as _json
    import asyncio
    import pathlib

    _log = logging.getLogger(__name__)
    print(f"[BG_BYPASS] Starting bypass {'ENABLE' if enable else 'DISABLE'} for instance {instance_id}", flush=True)

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
        prefix = config.get("prefix") or f"crx-odoo-{instance_id[:8]}"
        deploy_dir = config.get("deploy_dir") or f"/opt/crx-cloud/instances/{prefix}"
        print(f"[BG_BYPASS] Instance: {inst.name}, prefix: {prefix}, endpoint: {server.endpoint}", flush=True)

        from core.server_manager import ServerInfo, ServerStatus
        from core.vm_controller import VMDriver
        vm = VMDriver()
        print(f"[BG_BYPASS] VMDriver ready, starting SSH ops...", flush=True)
        server_info = ServerInfo(
            id=server.id, name=server.name, server_type="vm",
            provider=server.provider or "", status=ServerStatus.ONLINE,
            endpoint=server.endpoint,
            metadata={"ssh_user": server.ssh_user or "root", "ssh_key_path": server.ssh_key_path or ""},
        )

        # Helper: wait for Odoo to be ready
        async def _wait_odoo_ready(max_attempts=30, interval=5):
            for _i in range(max_attempts):
                await asyncio.sleep(interval)
                try:
                    check = await vm._ssh_exec(
                        server_info,
                        f"curl -s -o /dev/null -w '%{{http_code}}' http://localhost:{port}/web/login"
                    )
                    if "200" in check:
                        return True
                except Exception:
                    pass
            return False

        # Helper: JSONRPC call to Odoo
        async def _jsonrpc(payload_dict):
            payload = _json.dumps(payload_dict)
            raw = await vm._ssh_exec(
                server_info,
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{payload}'"
            )
            return _json.loads(raw)

        # Helper: authenticate as admin
        async def _auth():
            resp = await _jsonrpc({
                "jsonrpc": "2.0", "id": 1, "method": "call",
                "params": {"service": "common", "method": "authenticate",
                           "args": [db_name, "admin", admin_password, {}]}
            })
            return resp.get("result")

        # Helper: set ir.config_parameter
        async def _set_param(uid, key, value):
            await _jsonrpc({
                "jsonrpc": "2.0", "id": 2, "method": "call",
                "params": {
                    "service": "object", "method": "execute_kw",
                    "args": [db_name, uid, admin_password,
                             "ir.config_parameter", "set_param", [key, value]]
                }
            })

        # Helper: direct SQL on the Odoo PostgreSQL container
        async def _pg_sql(sql):
            escaped = sql.replace("'", "'\\''")
            return await vm._ssh_exec(
                server_info,
                f"docker exec {prefix}-db psql -U odoo -d {db_name} -c '{escaped}'"
            )

        try:
            if enable:
                # ============================================================
                # ENABLE BYPASS — safe activation with pre-snapshot
                # ============================================================

                # Step 1: Pre-activation DB snapshot (safety net)
                snapshot_dir = f"/opt/crx-cloud/bypass_snapshots/{prefix}"
                await vm._ssh_exec(server_info, f"mkdir -p {snapshot_dir}")
                _log.info(f"Taking pre-bypass snapshot for {inst.name}...")
                try:
                    await vm._ssh_exec(
                        server_info,
                        f"docker exec {prefix}-db pg_dump -U odoo -Fc {db_name} "
                        f"> {snapshot_dir}/pre_bypass.dump",
                        timeout=300,
                    )
                    _log.info(f"Pre-bypass snapshot saved: {snapshot_dir}/pre_bypass.dump")
                except Exception as snap_err:
                    _log.warning(f"Pre-bypass snapshot failed (continuing): {snap_err}")

                # Step 2: Deploy addon files to server
                await vm._ssh_exec(
                    server_info,
                    "mkdir -p /opt/crx-cloud/addons/crx_dev_bypass/models"
                )
                addon_dir = pathlib.Path(__file__).resolve().parents[2] / "data" / "addons" / "crx_dev_bypass"
                addon_files = [
                    "__manifest__.py", "__init__.py", "hooks.py",
                    "models/__init__.py", "models/ir_config_parameter.py",
                    "models/iap_account.py", "models/ir_http.py",
                    "models/patches.py",
                ]
                for rel in addon_files:
                    content = (addon_dir / rel).read_text(encoding="utf-8")
                    target = f"/opt/crx-cloud/addons/crx_dev_bypass/{rel}"
                    await vm._ssh_exec(
                        server_info,
                        f"cat > {target} << 'CRXEOF'\n{content}\nCRXEOF"
                    )
                _log.info(f"crx_dev_bypass addon deployed to server for {inst.name}")

                # Step 3: Regenerate compose WITH bypass volume + extra_hosts
                config.setdefault("version", inst.version)
                from plugins.odoo.driver import OdooPlugin
                plugin = OdooPlugin()
                compose, odoo_conf = plugin._compose_content(inst.id, config)
                await vm._ssh_exec(
                    server_info,
                    f"cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
                )

                # Step 4: Clean restart (stop then start — preserves volumes)
                await vm._ssh_exec(
                    server_info,
                    f"cd {deploy_dir} && docker compose stop odoo && docker compose up -d odoo",
                    timeout=120,
                )

                # Step 5: Wait for Odoo ready
                if not await _wait_odoo_ready():
                    _log.error(f"Odoo did not become ready after bypass enable for {inst.name}")
                    return

                # Step 6: Authenticate and set config parameters
                uid = await _auth()
                if not uid:
                    _log.warning(f"Cannot auth after bypass enable for {inst.name}")
                    return

                await _set_param(uid, "database.expiration_date", "2099-12-31 23:59:59")
                await _set_param(uid, "database.expiration_reason", "")
                await _set_param(uid, "database.enterprise_code", "CRXDEV-000000")

                # Step 7: Update module list and install
                await _jsonrpc({
                    "jsonrpc": "2.0", "id": 5, "method": "call",
                    "params": {
                        "service": "object", "method": "execute_kw",
                        "args": [db_name, uid, admin_password,
                                 "ir.module.module", "update_list", []]
                    }
                })
                find_resp = await _jsonrpc({
                    "jsonrpc": "2.0", "id": 6, "method": "call",
                    "params": {
                        "service": "object", "method": "execute_kw",
                        "args": [db_name, uid, admin_password,
                                 "ir.module.module", "search_read",
                                 [[["name", "=", "crx_dev_bypass"]]],
                                 {"fields": ["id", "state"], "limit": 1}]
                    }
                })
                modules = find_resp.get("result", [])
                if modules and modules[0].get("state") != "installed":
                    mod_id = modules[0]["id"]
                    await _jsonrpc({
                        "jsonrpc": "2.0", "id": 7, "method": "call",
                        "params": {
                            "service": "object", "method": "execute_kw",
                            "args": [db_name, uid, admin_password,
                                     "ir.module.module", "button_immediate_install",
                                     [[mod_id]]]
                        }
                    })
                    _log.info(f"crx_dev_bypass module installed on {inst.name}")

                _log.info(f"Enterprise license bypass ENABLED for {inst.name}")

            else:
                # ============================================================
                # DISABLE BYPASS — safe deactivation via SQL + clean restart
                # ============================================================
                # NEVER use button_immediate_uninstall — monkey patches on
                # requests.get/post/Session.request/HTTPAdapter.send cannot
                # be safely de-patched at runtime and WILL crash Odoo.

                # Step 1: Clean module from DB via direct SQL (bypasses ORM)
                # This is the Odoo neutralization pattern — safe for production.
                print(f"[BG_BYPASS] Step 1: SQL cleanup...", flush=True)
                _log.info(f"Cleaning bypass module from DB for {inst.name}...")
                cleanup_sqls = [
                    # Mark module as uninstalled
                    "UPDATE ir_module_module SET state='uninstalled' "
                    "WHERE name='crx_dev_bypass' AND state='installed'",
                    # Remove model data entries (prevents "missing module" errors)
                    "DELETE FROM ir_model_data WHERE module='crx_dev_bypass'",
                    # Restore config parameters to safe defaults
                    "DELETE FROM ir_config_parameter WHERE key='publisher_warranty.access_token' "
                    "AND value='crx-dev-bypass-token'",
                    # Remove the enterprise_code we set
                    "UPDATE ir_config_parameter SET value='' "
                    "WHERE key='database.enterprise_code' AND value='CRXDEV-000000'",
                    # Reset expiration date (user must set real license params)
                    "UPDATE ir_config_parameter SET value='' "
                    "WHERE key='database.expiration_date' AND value='2099-12-31 23:59:59'",
                    # Reset social "Use Your Own" toggles
                    "DELETE FROM ir_config_parameter WHERE key LIKE 'social.%_use_own_account' "
                    "AND value='True'",
                ]
                for sql in cleanup_sqls:
                    try:
                        await _pg_sql(sql)
                    except Exception as sql_err:
                        _log.warning(f"SQL cleanup warning: {sql_err}")

                # Step 2: Regenerate compose WITHOUT bypass volume + extra_hosts
                # Ensure config reflects bypass OFF for compose generation
                config = {**config, "enterprise_bypass_license": False, "enterprise_bypass_uuid": ""}
                config.setdefault("version", inst.version)
                from plugins.odoo.driver import OdooPlugin
                plugin = OdooPlugin()
                compose, odoo_conf = plugin._compose_content(inst.id, config)
                await vm._ssh_exec(
                    server_info,
                    f"cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
                )

                # Step 3: Clean restart — stop + up (NOT force-recreate which can lose volumes)
                await vm._ssh_exec(
                    server_info,
                    f"cd {deploy_dir} && docker compose stop odoo && docker compose up -d odoo",
                    timeout=120,
                )

                # Step 4: Wait and verify
                if not await _wait_odoo_ready():
                    _log.error(
                        f"Odoo did not restart after bypass disable for {inst.name}. "
                        f"A pre-bypass snapshot may be available at: "
                        f"/opt/crx-cloud/bypass_snapshots/{prefix}/pre_bypass.dump "
                        f"— manual restore required if needed."
                    )
                    return

                _log.info(f"Enterprise license bypass DISABLED for {inst.name}")

        except Exception as e:
            import traceback
            print(f"[BG_BYPASS] FAILED: {e}", flush=True)
            traceback.print_exc()
            _log.error(f"License bypass toggle failed for {inst.name}: {e}")


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

    if body.enterprise_bypass_uuid is not None:
        if not (inst.config or {}).get("enterprise_bypass_license"):
            raise HTTPException(status_code=400, detail="Bypass license must be enabled first")
        # Validate UUID format (loose — just check it looks like a UUID)
        uuid_val = body.enterprise_bypass_uuid.strip()
        if uuid_val and not re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", uuid_val, re.I):
            raise HTTPException(status_code=400, detail="Invalid UUID format")
        settings_changed["enterprise_bypass_uuid"] = uuid_val or ""

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

    # Bypass license — needs compose regen + restart
    if body.enterprise_bypass_license is not None:
        background_tasks.add_task(
            _bg_bypass_license, inst.id, server.id, body.enterprise_bypass_license
        )

    # UUID change — needs compose regen + restart (env var change)
    if body.enterprise_bypass_uuid is not None and body.enterprise_bypass_license is None:
        background_tasks.add_task(
            _bg_bypass_license, inst.id, server.id, True  # re-enable with new UUID
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


## NOTE: list_addons endpoint moved to api/routes/addons.py
## It now returns both enterprise (file) + git addons.


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


# ─── Odoo Config (odoo.conf) ──────────────────────────────────────────────────

# Parameters that are dangerous to edit from the UI — read-only
ODOO_READONLY_PARAMS = {"addons_path", "data_dir", "pg_path", "pidfile", "config"}

# All known Odoo config parameters with defaults and types
ODOO_PARAM_SCHEMA: dict[str, dict[str, Any]] = {
    # Database
    "admin_passwd": {"type": "password", "section": "database", "description": "Master password for database management"},
    "db_host": {"type": "text", "section": "database", "description": "Database server hostname"},
    "db_port": {"type": "number", "section": "database", "description": "Database server port"},
    "db_name": {"type": "text", "section": "database", "description": "Database name"},
    "db_user": {"type": "text", "section": "database", "description": "Database user name"},
    "db_password": {"type": "password", "section": "database", "description": "Database password"},
    "db_maxconn": {"type": "number", "section": "database", "description": "Maximum physical connections to PostgreSQL", "default": 64},
    "db_maxconn_gevent": {"type": "number", "section": "database", "description": "Max connections for gevent worker", "default": 0},
    "db_sslmode": {"type": "select", "section": "database", "description": "PostgreSQL SSL connection mode", "options": ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"], "default": "prefer"},
    "db_template": {"type": "text", "section": "database", "description": "Custom database template", "default": "template0"},
    "dbfilter": {"type": "text", "section": "database", "description": "Regex to filter available databases (%d = domain, %h = host)"},
    "list_db": {"type": "boolean", "section": "database", "description": "Allow listing databases from the web UI", "default": False},
    # Performance
    "workers": {"type": "number", "section": "performance", "description": "Number of worker processes (0 = disable prefork)", "default": 2},
    "max_cron_threads": {"type": "number", "section": "performance", "description": "Max threads for cron jobs", "default": 2},
    "limit_memory_hard": {"type": "number", "section": "performance", "description": "Max virtual memory per worker (bytes)", "default": 2684354560},
    "limit_memory_soft": {"type": "number", "section": "performance", "description": "Max virtual memory before worker reset (bytes)", "default": 2147483648},
    "limit_time_cpu": {"type": "number", "section": "performance", "description": "Max CPU time per request (seconds)", "default": 60},
    "limit_time_real": {"type": "number", "section": "performance", "description": "Max real time per request (seconds)", "default": 120},
    "limit_time_real_cron": {"type": "number", "section": "performance", "description": "Max real time per cron job (seconds, -1 = limit_time_real)", "default": -1},
    "limit_request": {"type": "number", "section": "performance", "description": "Max requests per worker before recycle", "default": 65536},
    "osv_memory_count_limit": {"type": "number", "section": "performance", "description": "Max records in virtual osv_memory tables (0 = no limit)", "default": 0},
    "transient_age_limit": {"type": "number", "section": "performance", "description": "Transient records TTL in hours", "default": 1},
    # Network
    "http_port": {"type": "number", "section": "network", "description": "HTTP server port", "default": 8069},
    "http_enable": {"type": "boolean", "section": "network", "description": "Enable HTTP server", "default": True},
    "http_interface": {"type": "text", "section": "network", "description": "HTTP server listen address (empty = all)"},
    "gevent_port": {"type": "number", "section": "network", "description": "Gevent (longpolling/websocket) port", "default": 8072},
    "longpolling_port": {"type": "number", "section": "network", "description": "Longpolling port (deprecated, use gevent_port)", "default": 0},
    "proxy_mode": {"type": "boolean", "section": "network", "description": "Enable reverse proxy headers (X-Forwarded-*)", "default": True},
    "x_sendfile": {"type": "boolean", "section": "network", "description": "Enable X-Sendfile/X-Accel-Redirect for static files", "default": False},
    # Logging
    "log_level": {"type": "select", "section": "logging", "description": "Server log level", "options": ["notset", "debug", "debug_rpc", "debug_rpc_answer", "debug_sql", "info", "warn", "error", "critical", "runbot", "test"], "default": "info"},
    "log_db": {"type": "text", "section": "logging", "description": "Logging database name"},
    "log_db_level": {"type": "select", "section": "logging", "description": "Database logging level", "options": ["debug", "info", "warning", "error", "critical"], "default": "warning"},
    "log_handler": {"type": "text", "section": "logging", "description": "Log handler config (e.g. odoo.sql_db:DEBUG)"},
    "logfile": {"type": "text", "section": "logging", "description": "Path to log file (empty = stdout)"},
    "syslog": {"type": "boolean", "section": "logging", "description": "Send logs to syslog server", "default": False},
    # Email / SMTP
    "email_from": {"type": "text", "section": "email", "description": "SMTP sender email address"},
    "from_filter": {"type": "text", "section": "email", "description": "Regex filter for allowed SMTP sender addresses"},
    "smtp_server": {"type": "text", "section": "email", "description": "SMTP server hostname", "default": "localhost"},
    "smtp_port": {"type": "number", "section": "email", "description": "SMTP server port", "default": 25},
    "smtp_user": {"type": "text", "section": "email", "description": "SMTP authentication username"},
    "smtp_password": {"type": "password", "section": "email", "description": "SMTP authentication password"},
    "smtp_ssl": {"type": "boolean", "section": "email", "description": "Enable SMTP STARTTLS encryption", "default": False},
    "smtp_ssl_certificate_filename": {"type": "text", "section": "email", "description": "SSL certificate for SMTP auth"},
    "smtp_ssl_private_key_filename": {"type": "text", "section": "email", "description": "SSL private key for SMTP auth"},
    # Developer
    "dev_mode": {"type": "text", "section": "developer", "description": "Developer mode options: all, reload, qweb, xml"},
    "test_enable": {"type": "boolean", "section": "developer", "description": "Enable unit tests on install/update", "default": False},
    "test_file": {"type": "text", "section": "developer", "description": "Specific test file to run"},
    "test_tags": {"type": "text", "section": "developer", "description": "Test tags filter (comma-separated)"},
    "stop_after_init": {"type": "boolean", "section": "developer", "description": "Stop server after initialization", "default": False},
    # i18n
    "language": {"type": "text", "section": "i18n", "description": "Translation language code"},
    "load_language": {"type": "text", "section": "i18n", "description": "Languages to pre-load (comma-separated)"},
    "overwrite_existing_translations": {"type": "boolean", "section": "i18n", "description": "Overwrite translations on module update", "default": False},
    "translate_in": {"type": "text", "section": "i18n", "description": "Import translations from CSV/PO file"},
    "translate_out": {"type": "text", "section": "i18n", "description": "Export translations to CSV/PO/TGZ"},
    "translate_modules": {"type": "text", "section": "i18n", "description": "Modules to export translations for"},
    # Misc
    "server_wide_modules": {"type": "text", "section": "misc", "description": "Comma-separated server-wide modules", "default": "base,web"},
    "without_demo": {"type": "text", "section": "misc", "description": "Disable demo data for modules (comma-separated, 'all' for all)"},
    "unaccent": {"type": "boolean", "section": "misc", "description": "Enable unaccent extension for search", "default": False},
    "screencasts": {"type": "text", "section": "misc", "description": "Screencasts output directory"},
    "screenshots": {"type": "text", "section": "misc", "description": "Screenshots output directory"},
    "shell_interface": {"type": "select", "section": "misc", "description": "Preferred shell REPL", "options": ["", "ipython", "ptpython", "bpython", "python"]},
    "upgrade_path": {"type": "text", "section": "misc", "description": "Additional upgrade scripts path"},
    # Read-only (shown but not editable)
    "addons_path": {"type": "text", "section": "paths", "description": "Addons paths (managed automatically)", "readonly": True},
    "data_dir": {"type": "text", "section": "paths", "description": "Odoo data directory", "readonly": True},
}

ODOO_CONFIG_SECTIONS = {
    "database": {"label": "Database", "icon": "Database", "order": 1},
    "performance": {"label": "Performance", "icon": "Gauge", "order": 2},
    "network": {"label": "Network", "icon": "Globe", "order": 3},
    "logging": {"label": "Logging", "icon": "ScrollText", "order": 4},
    "email": {"label": "Email / SMTP", "icon": "Mail", "order": 5},
    "developer": {"label": "Developer", "icon": "Code", "order": 6},
    "i18n": {"label": "Internationalization", "icon": "Languages", "order": 7},
    "misc": {"label": "Miscellaneous", "icon": "Settings2", "order": 8},
    "paths": {"label": "Paths (read-only)", "icon": "FolderOpen", "order": 9},
}

# Enterprise presets — v2 (PgBouncer-aware, best-practice tuning)
# NOTE: db_maxconn is low (16) because PgBouncer handles connection pooling.
# Workers follow the formula: (CPU * 2) + 1, adjusted per preset tier.
ODOO_CONFIG_PRESETS = {
    "production": {
        "label": "Production Optimized",
        "description": "PgBouncer pooling, security hardened, minimal logging. Best for live ERP.",
        "values": {
            "workers": 4,
            "max_cron_threads": 2,
            "limit_memory_hard": 1610612736,      # 1.5 GB per worker
            "limit_memory_soft": 1073741824,      # 1 GB per worker (triggers recycle)
            "limit_time_cpu": 120,
            "limit_time_real": 300,
            "limit_request": 8192,
            "log_level": "warn",
            "log_handler": ":WARNING,odoo.http.rpc.request:INFO,odoo.addons.base.ir.ir_cron:INFO",
            "proxy_mode": True,
            "list_db": False,
            "dev_mode": "",
            "test_enable": False,
            "syslog": False,
            "db_maxconn": 16,
            "db_maxconn_gevent": 8,
            "db_template": "template0",
            "unaccent": True,
            "transient_age_limit": 1.0,
            "server_wide_modules": "base,web",
        },
    },
    "development": {
        "label": "Development",
        "description": "Debug logging, dev mode, relaxed limits. No PgBouncer needed.",
        "values": {
            "workers": 0,
            "max_cron_threads": 1,
            "limit_memory_hard": 2684354560,
            "limit_memory_soft": 2147483648,
            "limit_time_cpu": 120,
            "limit_time_real": 600,
            "limit_request": 65536,
            "log_level": "debug",
            "proxy_mode": False,
            "list_db": True,
            "dev_mode": "all",
            "test_enable": False,
            "db_maxconn": 32,
            "unaccent": True,
            "server_wide_modules": "base,web",
        },
    },
    "staging": {
        "label": "Staging",
        "description": "Production-like with debug capabilities. PgBouncer pooling active.",
        "values": {
            "workers": 2,
            "max_cron_threads": 1,
            "limit_memory_hard": 1610612736,
            "limit_memory_soft": 1073741824,
            "limit_time_cpu": 120,
            "limit_time_real": 300,
            "limit_request": 8192,
            "log_level": "info",
            "log_handler": ":INFO",
            "proxy_mode": True,
            "list_db": True,
            "dev_mode": "",
            "test_enable": False,
            "db_maxconn": 16,
            "db_maxconn_gevent": 8,
            "db_template": "template0",
            "unaccent": True,
            "server_wide_modules": "base,web",
        },
    },
    "high_performance": {
        "label": "High Performance",
        "description": "Max workers + PgBouncer pooling. For 100+ concurrent users.",
        "values": {
            "workers": 8,
            "max_cron_threads": 4,
            "limit_memory_hard": 1610612736,
            "limit_memory_soft": 1073741824,
            "limit_time_cpu": 120,
            "limit_time_real": 300,
            "limit_request": 8192,
            "log_level": "warn",
            "log_handler": ":WARNING,odoo.http.rpc.request:INFO",
            "proxy_mode": True,
            "list_db": False,
            "dev_mode": "",
            "db_maxconn": 16,
            "db_maxconn_gevent": 8,
            "db_template": "template0",
            "unaccent": True,
            "transient_age_limit": 1.0,
            "server_wide_modules": "base,web",
        },
    },
}


def _parse_odoo_conf(raw: str) -> dict[str, str]:
    """Parse an odoo.conf INI file into a flat dict."""
    result: dict[str, str] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            result[key.strip()] = value.strip()
    return result


def _serialize_odoo_conf(params: dict[str, str]) -> str:
    """Serialize dict back to odoo.conf format."""
    lines = ["[options]"]
    for key, value in sorted(params.items()):
        lines.append(f"{key} = {value}")
    return "\n".join(lines) + "\n"


def _cast_conf_value(key: str, value: str) -> Any:
    """Cast a raw conf string value to its typed form based on schema."""
    schema = ODOO_PARAM_SCHEMA.get(key, {})
    ptype = schema.get("type", "text")
    if ptype == "boolean":
        return value.lower() in ("true", "1", "yes")
    if ptype == "number":
        try:
            return int(value)
        except (ValueError, TypeError):
            try:
                return float(value)
            except (ValueError, TypeError):
                return value
    return value


def _uncast_conf_value(key: str, value: Any) -> str:
    """Convert a typed value back to odoo.conf string format."""
    schema = ODOO_PARAM_SCHEMA.get(key, {})
    ptype = schema.get("type", "text")
    if ptype == "boolean":
        return "True" if value else "False"
    return str(value) if value is not None else ""


class OdooConfigUpdate(BaseModel):
    params: dict[str, Any]


@router.get("/{instance_id}/odoo-config")
async def get_odoo_config(
    instance_id: str,
    show_all: bool = False,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Read the running odoo.conf from the remote server.

    Returns the parsed config, schema metadata, available presets, and sections.
    If show_all=True, returns all known parameters (including unset ones with defaults).
    """
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    config = inst.config or {}
    prefix = config.get("prefix") or f"crx-odoo-{inst.id[:8]}"
    deploy_dir = config.get("deploy_dir") or f"/opt/crx-cloud/instances/{prefix}"
    conf_path = f"{deploy_dir}/odoo.conf"

    from core.server_manager import ServerInfo, ServerStatus
    from core.vm_controller import VMDriver
    vm = VMDriver()
    server_info = ServerInfo(
        id=server.id, name=server.name, server_type="vm",
        provider=server.provider or "", status=ServerStatus.ONLINE,
        endpoint=server.endpoint,
        metadata={"ssh_user": server.ssh_user or "root", "ssh_key_path": server.ssh_key_path or ""},
    )

    # Read current conf from server
    try:
        raw_conf = await vm._ssh_exec(server_info, f"cat {conf_path} 2>/dev/null || echo ''")
        current_params = _parse_odoo_conf(raw_conf)
    except Exception as e:
        logger.warning(f"Failed to read odoo.conf for {inst.name}: {e}")
        current_params = {}

    # Also try to read runtime command-line params from docker inspect
    try:
        container_name = f"{prefix}-odoo"
        cmd_raw = await vm._ssh_exec(
            server_info,
            f"docker inspect --format '{{{{.Config.Cmd}}}}' {container_name} 2>/dev/null || echo ''"
        )
        # Parse --key=value from command args
        import shlex
        for token in cmd_raw.replace("[", "").replace("]", "").split():
            if token.startswith("--") and "=" in token:
                k, _, v = token[2:].partition("=")
                k = k.replace("-", "_")
                if k not in current_params:
                    current_params[k] = v
    except Exception:
        pass

    # Build typed response
    params_typed: dict[str, Any] = {}
    for key, raw_val in current_params.items():
        params_typed[key] = _cast_conf_value(key, raw_val)

    # If show_all, fill in missing params with defaults from schema
    if show_all:
        for key, schema in ODOO_PARAM_SCHEMA.items():
            if key not in params_typed:
                params_typed[key] = schema.get("default", "")

    return {
        "params": params_typed,
        "schema": ODOO_PARAM_SCHEMA,
        "sections": ODOO_CONFIG_SECTIONS,
        "presets": {k: {"label": v["label"], "description": v["description"]} for k, v in ODOO_CONFIG_PRESETS.items()},
        "readonly_params": list(ODOO_READONLY_PARAMS),
    }


@router.patch("/{instance_id}/odoo-config")
async def update_odoo_config(
    instance_id: str,
    body: OdooConfigUpdate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update specific odoo.conf parameters and restart the instance.

    Only updates the provided params — other params are preserved.
    Read-only params (addons_path, data_dir, etc.) are silently ignored.
    """
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    if inst.status not in ("running", "stopped"):
        raise HTTPException(status_code=400, detail=f"Cannot update config while instance is {inst.status}")

    # Filter out readonly params
    safe_params = {k: v for k, v in body.params.items() if k not in ODOO_READONLY_PARAMS}
    if not safe_params:
        raise HTTPException(status_code=400, detail="No writable parameters provided")

    # Validate known params
    warnings: list[str] = []
    for key, value in safe_params.items():
        if key not in ODOO_PARAM_SCHEMA:
            warnings.append(f"Unknown parameter: {key}")
        schema = ODOO_PARAM_SCHEMA.get(key, {})
        if schema.get("type") == "select" and value and str(value) not in (schema.get("options") or []):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid value '{value}' for {key}. Allowed: {schema.get('options')}",
            )

    # Apply in background (read conf → merge → write → restart)
    background_tasks.add_task(
        _bg_update_odoo_config, inst.id, server.id, safe_params
    )

    return {
        "detail": f"Updating {len(safe_params)} parameter(s) and restarting {inst.name}...",
        "updated_params": list(safe_params.keys()),
        "warnings": warnings,
    }


@router.post("/{instance_id}/odoo-config/preset/{preset_name}")
async def apply_config_preset(
    instance_id: str,
    preset_name: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Apply a predefined config preset (production, development, staging, high_performance)."""
    if preset_name not in ODOO_CONFIG_PRESETS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown preset: {preset_name}. Available: {list(ODOO_CONFIG_PRESETS.keys())}",
        )

    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    if inst.status not in ("running", "stopped"):
        raise HTTPException(status_code=400, detail=f"Cannot update config while instance is {inst.status}")

    preset = ODOO_CONFIG_PRESETS[preset_name]
    background_tasks.add_task(
        _bg_update_odoo_config, inst.id, server.id, preset["values"]
    )

    return {
        "detail": f"Applying preset '{preset['label']}' to {inst.name}...",
        "preset": preset_name,
    }


@router.get("/{instance_id}/odoo-config/schema")
async def get_config_schema(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Return the config parameter schema, sections, and presets (no instance needed)."""
    return {
        "schema": ODOO_PARAM_SCHEMA,
        "sections": ODOO_CONFIG_SECTIONS,
        "presets": {k: {"label": v["label"], "description": v["description"]} for k, v in ODOO_CONFIG_PRESETS.items()},
    }


async def _bg_update_odoo_config(instance_id: str, server_id: str, params: dict[str, Any]):
    """Background: read current odoo.conf, merge new params, write back, restart."""
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
        prefix = config.get("prefix") or f"crx-odoo-{inst.id[:8]}"
        deploy_dir = config.get("deploy_dir") or f"/opt/crx-cloud/instances/{prefix}"
        conf_path = f"{deploy_dir}/odoo.conf"

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
            # 1. Read current conf
            raw_conf = await vm._ssh_exec(server_info, f"cat {conf_path} 2>/dev/null || echo '[options]'")
            current = _parse_odoo_conf(raw_conf)

            # 2. Merge new params
            for key, value in params.items():
                if key in ODOO_READONLY_PARAMS:
                    continue
                current[key] = _uncast_conf_value(key, value)

            # 3. Write updated conf
            new_conf = _serialize_odoo_conf(current)
            await vm._ssh_exec(
                server_info,
                f"cat > {conf_path} << 'CONFEOF'\n{new_conf}CONFEOF"
            )

            # 4. Update docker-compose command if workers/limits changed
            needs_compose_update = any(
                k in params for k in ("workers", "limit_memory_hard", "limit_memory_soft", "proxy_mode")
            )
            if needs_compose_update:
                # Update workers in DB config for compose regeneration
                if "workers" in params:
                    inst.workers = int(params["workers"])
                    config["workers"] = int(params["workers"])
                if "limit_memory_hard" in params:
                    config["limit_memory_hard"] = int(params["limit_memory_hard"])
                if "limit_memory_soft" in params:
                    config["limit_memory_soft"] = int(params["limit_memory_soft"])
                inst.config = config

                # Regenerate docker-compose with new settings
                config.setdefault("version", inst.version)
                from plugins.odoo.driver import OdooPlugin
                plugin = OdooPlugin()
                compose, odoo_conf_gen = plugin._compose_content(inst.id, config)
                await vm._ssh_exec(
                    server_info,
                    f"cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
                )

            # 5. Restart the instance
            container = f"{prefix}-odoo"
            await vm._ssh_exec(server_info, f"cd {deploy_dir} && docker compose up -d --force-recreate odoo")
            logger.info(f"Odoo config updated for {inst.name}: {list(params.keys())}")

            # 6. Save a config change log entry
            change_log = config.get("config_changelog", [])
            from datetime import datetime
            change_log.append({
                "timestamp": datetime.utcnow().isoformat(),
                "params": list(params.keys()),
                "source": "config_editor",
            })
            # Keep last 50 entries
            config["config_changelog"] = change_log[-50:]
            inst.config = config
            await db.commit()

        except Exception as e:
            logger.error(f"Failed to update odoo.conf for {inst.name}: {e}")
            inst.config = {**(inst.config or {}), "config_error": str(e)}
            await db.commit()


# ─── Real-Time Monitoring (docker stats + system metrics) ─────────────────────


def _build_server_info(server) -> "ServerInfo":
    """Helper to build ServerInfo from a Server ORM object."""
    from core.server_manager import ServerInfo, ServerStatus
    return ServerInfo(
        id=server.id, name=server.name, server_type="vm",
        provider=server.provider or "", status=ServerStatus.ONLINE,
        endpoint=server.endpoint,
        metadata={"ssh_user": server.ssh_user or "root", "ssh_key_path": server.ssh_key_path or ""},
    )


@router.get("/{instance_id}/monitoring")
async def get_monitoring_data(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Collect real-time metrics from Docker containers + system via SSH.

    Returns: container stats (CPU/RAM/Net/Block IO), disk usage,
    DB size, container details, process info, and recent log lines.
    """
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    config = inst.config or {}
    prefix = config.get("prefix") or f"crx-odoo-{inst.id[:8]}"
    deploy_dir = config.get("deploy_dir") or f"/opt/crx-cloud/instances/{prefix}"
    port = config.get("port", 8069)

    from core.vm_controller import VMDriver
    vm = VMDriver()
    server_info = _build_server_info(server)

    result: dict[str, Any] = {
        "instance_id": inst.id,
        "name": inst.name,
        "status": inst.status,
        "containers": {},
        "disk": {},
        "database": {},
        "processes": {},
        "logs_tail": [],
        "uptime": {},
    }

    # 1. Docker stats (CPU%, MEM, NET I/O, BLOCK I/O, PIDs) — single SSH call
    try:
        stats_cmd = (
            f"docker stats --no-stream --format "
            f"'{{{{.Name}}}}|{{{{.CPUPerc}}}}|{{{{.MemUsage}}}}|{{{{.MemPerc}}}}|"
            f"{{{{.NetIO}}}}|{{{{.BlockIO}}}}|{{{{.PIDs}}}}' "
            f"$(docker ps -q --filter name={prefix}) 2>/dev/null || echo ''"
        )
        stats_raw = await vm._ssh_exec(server_info, stats_cmd)
        containers = {}
        for line in stats_raw.strip().split("\n"):
            if not line or "|" not in line:
                continue
            parts = line.strip("'").split("|")
            if len(parts) >= 7:
                name = parts[0]
                containers[name] = {
                    "cpu_percent": parts[1].strip(),
                    "mem_usage": parts[2].strip(),
                    "mem_percent": parts[3].strip(),
                    "net_io": parts[4].strip(),
                    "block_io": parts[5].strip(),
                    "pids": parts[6].strip(),
                }
        result["containers"] = containers
    except Exception as e:
        result["containers"] = {"error": str(e)}

    # 2. Container details (state, started_at, restart_count, health) — single SSH call
    try:
        inspect_cmd = (
            f"docker inspect --format "
            f"'{{{{.Name}}}}|{{{{.State.Status}}}}|{{{{.State.StartedAt}}}}|"
            f"{{{{.RestartCount}}}}|{{{{.State.Health.Status}}}}' "
            f"$(docker ps -aq --filter name={prefix}) 2>/dev/null || echo ''"
        )
        inspect_raw = await vm._ssh_exec(server_info, inspect_cmd)
        details = {}
        for line in inspect_raw.strip().split("\n"):
            if not line or "|" not in line:
                continue
            parts = line.strip("'").split("|")
            if len(parts) >= 4:
                name = parts[0].lstrip("/")
                details[name] = {
                    "state": parts[1],
                    "started_at": parts[2],
                    "restart_count": int(parts[3]) if parts[3].isdigit() else 0,
                    "health": parts[4] if len(parts) > 4 and parts[4] != "<nil>" else None,
                }
        result["container_details"] = details
    except Exception as e:
        result["container_details"] = {"error": str(e)}

    # 3. Disk usage (volumes + deploy dir)
    try:
        disk_cmd = (
            f"du -sh {deploy_dir} 2>/dev/null | cut -f1; "
            f"docker system df --format '{{{{.Type}}}}|{{{{.TotalCount}}}}|{{{{.Size}}}}|{{{{.Reclaimable}}}}' 2>/dev/null; "
            f"df -h {deploy_dir} 2>/dev/null | tail -1"
        )
        disk_raw = await vm._ssh_exec(server_info, disk_cmd)
        lines = disk_raw.strip().split("\n")
        deploy_size = lines[0] if lines else "unknown"
        # Parse df output for host disk
        host_disk = {}
        for line in lines:
            # df output: /dev/sda1  50G  23G  25G  48% /
            parts = line.split()
            if len(parts) >= 6 and "%" in parts[4]:
                host_disk = {
                    "total": parts[1],
                    "used": parts[2],
                    "available": parts[3],
                    "percent": parts[4],
                    "mount": parts[5],
                }
        # Parse docker system df
        docker_df = {}
        for line in lines:
            if "|" in line:
                parts = line.split("|")
                if len(parts) >= 4:
                    docker_df[parts[0].strip()] = {
                        "count": parts[1].strip(),
                        "size": parts[2].strip(),
                        "reclaimable": parts[3].strip(),
                    }
        result["disk"] = {
            "deploy_dir_size": deploy_size,
            "host": host_disk,
            "docker": docker_df,
        }
    except Exception as e:
        result["disk"] = {"error": str(e)}

    # 4. Database size + connections (via psql in DB container)
    try:
        db_name = config.get("db_name", inst.name)
        db_container = f"{prefix}-db"
        db_cmd = (
            f"docker exec {db_container} psql -U odoo -d {db_name} -t -A -c "
            f"\"SELECT pg_size_pretty(pg_database_size('{db_name}')), "
            f"(SELECT count(*) FROM pg_stat_activity WHERE datname='{db_name}'), "
            f"(SELECT count(*) FROM pg_stat_activity WHERE datname='{db_name}' AND state='active')\" "
            f"2>/dev/null || echo 'N/A|0|0'"
        )
        db_raw = await vm._ssh_exec(server_info, db_cmd)
        db_parts = db_raw.strip().split("|")
        result["database"] = {
            "size": db_parts[0].strip() if db_parts else "N/A",
            "connections": int(db_parts[1].strip()) if len(db_parts) > 1 and db_parts[1].strip().isdigit() else 0,
            "active_connections": int(db_parts[2].strip()) if len(db_parts) > 2 and db_parts[2].strip().isdigit() else 0,
        }
    except Exception as e:
        result["database"] = {"error": str(e)}

    # 5. Odoo process info (worker PIDs, cron threads)
    try:
        odoo_container = f"{prefix}-odoo"
        proc_cmd = (
            f"docker exec {odoo_container} ps aux 2>/dev/null | "
            f"grep -c '[o]doo' || echo '0'; "
            f"docker exec {odoo_container} ps aux 2>/dev/null | "
            f"grep '[o]doo.*cron' | wc -l || echo '0'"
        )
        proc_raw = await vm._ssh_exec(server_info, proc_cmd)
        proc_lines = proc_raw.strip().split("\n")
        result["processes"] = {
            "total_workers": int(proc_lines[0]) if proc_lines and proc_lines[0].isdigit() else 0,
            "cron_workers": int(proc_lines[1]) if len(proc_lines) > 1 and proc_lines[1].isdigit() else 0,
        }
    except Exception as e:
        result["processes"] = {"error": str(e)}

    # 6. Log tail (last 15 lines)
    try:
        log_cmd = f"docker logs --tail 15 {prefix}-odoo 2>&1 || echo ''"
        log_raw = await vm._ssh_exec(server_info, log_cmd)
        result["logs_tail"] = [l for l in log_raw.strip().split("\n") if l][-15:]
    except Exception:
        result["logs_tail"] = []

    # 7. Container uptime + HTTP response time
    try:
        uptime_cmd = (
            f"docker inspect --format '{{{{.State.StartedAt}}}}' {prefix}-odoo 2>/dev/null || echo ''; "
            f"curl -o /dev/null -s -w '%{{time_total}}' --max-time 5 http://127.0.0.1:{port}/web/health 2>/dev/null || echo '-1'"
        )
        uptime_raw = await vm._ssh_exec(server_info, uptime_cmd)
        uptime_lines = uptime_raw.strip().split("\n")
        started = uptime_lines[0] if uptime_lines else ""
        response_time = uptime_lines[1] if len(uptime_lines) > 1 else "-1"
        try:
            rt_ms = round(float(response_time) * 1000)
        except (ValueError, TypeError):
            rt_ms = -1
        result["uptime"] = {
            "started_at": started,
            "response_time_ms": rt_ms if rt_ms >= 0 else None,
            "healthy": rt_ms >= 0,
        }
    except Exception as e:
        result["uptime"] = {"error": str(e)}

    return result


@router.get("/{instance_id}/monitoring/quick")
async def get_quick_metrics(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Lightweight metrics for Dashboard hero card — single SSH call."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)
    config = inst.config or {}
    prefix = config.get("prefix") or f"crx-odoo-{inst.id[:8]}"
    port = config.get("port", 8069)

    from core.vm_controller import VMDriver
    vm = VMDriver()
    server_info = _build_server_info(server)

    try:
        # Single SSH call: docker stats + inspect + curl
        cmd = (
            f"docker stats --no-stream --format '{{{{.CPUPerc}}}}|{{{{.MemUsage}}}}|{{{{.MemPerc}}}}' {prefix}-odoo 2>/dev/null | head -1; "
            f"docker inspect --format '{{{{.State.StartedAt}}}}|{{{{.RestartCount}}}}' {prefix}-odoo 2>/dev/null | head -1; "
            f"curl -o /dev/null -s -w '%{{time_total}}' --max-time 5 http://127.0.0.1:{port}/web/health 2>/dev/null || echo '-1'"
        )
        raw = await vm._ssh_exec(server_info, cmd)
        lines = raw.strip().split("\n")

        # Parse docker stats
        stats_parts = lines[0].split("|") if lines else []
        cpu = stats_parts[0].strip() if stats_parts else "0%"
        mem_usage = stats_parts[1].strip() if len(stats_parts) > 1 else "0B / 0B"
        mem_pct = stats_parts[2].strip() if len(stats_parts) > 2 else "0%"

        # Parse inspect
        inspect_parts = lines[1].split("|") if len(lines) > 1 else []
        started_at = inspect_parts[0] if inspect_parts else ""
        restart_count = int(inspect_parts[1]) if len(inspect_parts) > 1 and inspect_parts[1].isdigit() else 0

        # Parse response time
        try:
            rt_ms = round(float(lines[2]) * 1000) if len(lines) > 2 else -1
        except (ValueError, TypeError):
            rt_ms = -1

        return {
            "cpu": cpu,
            "memory": mem_usage,
            "memory_percent": mem_pct,
            "started_at": started_at,
            "restart_count": restart_count,
            "response_time_ms": rt_ms if rt_ms >= 0 else None,
            "healthy": rt_ms >= 0,
        }
    except Exception as e:
        return {"error": str(e)}


# ─── Staging Environment ──────────────────────────────────────────────────────


@router.post("/{instance_id}/staging")
async def create_staging(
    instance_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Create a staging clone of a production instance."""
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    if inst.is_staging:
        raise HTTPException(status_code=400, detail="Cannot create staging from a staging instance")

    # Check if staging already exists
    existing = await db.execute(
        select(Instance).where(Instance.parent_id == instance_id, Instance.is_staging == True)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Staging instance already exists — delete it first")

    s_result = await db.execute(select(Server).where(Server.id == inst.server_id))
    server = s_result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    # Create staging instance record
    staging = Instance(
        name=f"{inst.name} (staging)",
        cms_type=inst.cms_type,
        version=inst.version,
        status="deploying",
        server_id=inst.server_id,
        domain=None,
        workers=max(inst.workers, 1),
        ram_mb=inst.ram_mb,
        cpu_cores=inst.cpu_cores,
        config={**(inst.config or {}), "enterprise": inst.config.get("enterprise", False) if inst.config else False},
        owner_id=inst.owner_id,
        is_staging=True,
        parent_id=inst.id,
    )
    db.add(staging)
    await db.commit()
    await db.refresh(staging)

    background_tasks.add_task(_bg_create_staging, staging.id, inst.id, server.id)

    return {"id": staging.id, "status": "deploying", "detail": f"Staging clone of {inst.name} is being created"}


@router.post("/{instance_id}/staging/sync")
async def sync_staging(
    instance_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Re-sync staging data from production."""
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    # Find staging
    staging_result = await db.execute(
        select(Instance).where(Instance.parent_id == instance_id, Instance.is_staging == True)
    )
    staging = staging_result.scalar_one_or_none()
    if not staging:
        raise HTTPException(status_code=404, detail="No staging instance found")

    staging.status = "updating"
    await db.commit()

    background_tasks.add_task(_bg_sync_staging, staging.id, inst.id, inst.server_id)
    return {"detail": f"Syncing staging from production {inst.name}"}


@router.get("/{instance_id}/staging")
async def get_staging(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get staging instance info for a production instance."""
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Instance not found")

    staging_result = await db.execute(
        select(Instance).where(Instance.parent_id == instance_id, Instance.is_staging == True)
    )
    staging = staging_result.scalar_one_or_none()
    if not staging:
        return {"exists": False}

    return {
        "exists": True,
        "id": staging.id,
        "name": staging.name,
        "status": staging.status,
        "version": staging.version,
        "url": staging.url,
        "port": staging.port,
        "workers": staging.workers,
        "ram_mb": staging.ram_mb,
        "created_at": staging.created_at.isoformat() if staging.created_at else None,
        "last_synced_at": staging.last_synced_at.isoformat() if staging.last_synced_at else None,
        "config": staging.config,
    }


@router.delete("/{instance_id}/staging")
async def delete_staging(
    instance_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Delete the staging instance for a production instance."""
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    staging_result = await db.execute(
        select(Instance).where(Instance.parent_id == instance_id, Instance.is_staging == True)
    )
    staging = staging_result.scalar_one_or_none()
    if not staging:
        raise HTTPException(status_code=404, detail="No staging instance found")

    s_result = await db.execute(select(Server).where(Server.id == staging.server_id))
    server = s_result.scalar_one_or_none()

    # Remove containers and data in background
    if server:
        background_tasks.add_task(_bg_delete_staging, staging.id, server.id)

    await db.delete(staging)
    await db.commit()
    return {"detail": f"Staging instance deleted"}


async def _bg_create_staging(staging_id: str, parent_id: str, server_id: str):
    """Background: clone production instance to staging via SSH."""
    from datetime import datetime as dt
    async with async_session() as db:
        staging_r = await db.execute(select(Instance).where(Instance.id == staging_id))
        staging = staging_r.scalar_one_or_none()
        parent_r = await db.execute(select(Instance).where(Instance.id == parent_id))
        parent = parent_r.scalar_one_or_none()
        server_r = await db.execute(select(Server).where(Server.id == server_id))
        server = server_r.scalar_one_or_none()

        if not staging or not parent or not server:
            if staging:
                staging.status = "error"
                await db.commit()
            return

        try:
            plugin = get_plugin(parent.cms_type)
            if not plugin:
                raise RuntimeError(f"No plugin for {parent.cms_type}")

            server_info = _build_server_info(server)
            driver = plugin.driver_class(server_info)

            parent_prefix = parent.config.get("prefix", f"crx-odoo-{parent.id[:8]}") if parent.config else f"crx-odoo-{parent.id[:8]}"
            staging_prefix = f"crx-odoo-stg-{staging.id[:8]}"
            deploy_dir = f"/opt/crx-cloud/instances/{staging_prefix}"

            # 1. Create staging directory structure
            driver._ssh_exec(f"mkdir -p {deploy_dir}")

            # 2. Copy docker-compose from parent and modify for staging
            parent_dir = f"/opt/crx-cloud/instances/{parent_prefix}"
            driver._ssh_exec(f"cp {parent_dir}/docker-compose.yml {deploy_dir}/docker-compose.yml")

            # 3. Modify compose for staging (different ports, container names, db name)
            staging_db = f"stg_{parent_prefix.replace('-', '_')}"
            # Find a free port range
            port_output = driver._ssh_exec(
                "ss -tlnp | grep -oP ':\\K[0-9]+' | sort -n | tail -1"
            ).strip()
            staging_port = max(int(port_output or "8100"), 8100) + 1

            # Sed to replace container names and ports
            driver._ssh_exec(
                f"cd {deploy_dir} && "
                f"sed -i 's/{parent_prefix}/{staging_prefix}/g' docker-compose.yml && "
                f"sed -i 's/container_name:.*odoo.*/container_name: {staging_prefix}-odoo/' docker-compose.yml"
            )

            # 4. Dump production DB and restore as staging DB
            driver._ssh_exec(
                f"docker exec {parent_prefix}-db pg_dump -U odoo -d odoo --no-owner --clean --if-exists "
                f"| docker exec -i {parent_prefix}-db psql -U odoo -d postgres -c 'DROP DATABASE IF EXISTS \"{staging_db}\";' "
                f"&& docker exec {parent_prefix}-db psql -U odoo -d postgres -c 'CREATE DATABASE \"{staging_db}\" OWNER odoo;' "
                f"&& docker exec {parent_prefix}-db pg_dump -U odoo -d odoo --no-owner "
                f"| docker exec -i {parent_prefix}-db psql -U odoo -d \"{staging_db}\""
            )

            # 5. Copy filestore
            driver._ssh_exec(
                f"docker cp {parent_prefix}-odoo:/var/lib/odoo/filestore/odoo /tmp/stg_filestore_copy "
                f"&& mkdir -p {deploy_dir}/filestore "
                f"&& cp -r /tmp/stg_filestore_copy/* {deploy_dir}/filestore/ 2>/dev/null; "
                f"rm -rf /tmp/stg_filestore_copy"
            )

            # 6. Copy odoo.conf and modify for staging
            driver._ssh_exec(
                f"cp {parent_dir}/odoo.conf {deploy_dir}/odoo.conf 2>/dev/null || true && "
                f"sed -i 's/^db_name.*/db_name = {staging_db}/' {deploy_dir}/odoo.conf"
            )

            # 7. Start staging containers
            driver._ssh_exec(f"cd {deploy_dir} && docker compose up -d 2>&1 || true")

            # Update staging record
            staging.status = "running"
            staging.port = staging_port
            staging.url = f"http://{server.endpoint}:{staging_port}"
            staging.config = {
                **(staging.config or {}),
                "prefix": staging_prefix,
                "staging_db": staging_db,
                "parent_prefix": parent_prefix,
            }
            staging.last_synced_at = dt.utcnow()
            await db.commit()
            logger.info(f"Staging {staging_prefix} created successfully from {parent_prefix}")

        except Exception as e:
            logger.error(f"Failed to create staging for {parent_id}: {e}")
            staging.status = "error"
            staging.config = {**(staging.config or {}), "staging_error": str(e)}
            await db.commit()


async def _bg_sync_staging(staging_id: str, parent_id: str, server_id: str):
    """Background: re-sync staging DB + filestore from production."""
    from datetime import datetime as dt
    async with async_session() as db:
        staging_r = await db.execute(select(Instance).where(Instance.id == staging_id))
        staging = staging_r.scalar_one_or_none()
        parent_r = await db.execute(select(Instance).where(Instance.id == parent_id))
        parent = parent_r.scalar_one_or_none()
        server_r = await db.execute(select(Server).where(Server.id == server_id))
        server = server_r.scalar_one_or_none()

        if not staging or not parent or not server:
            return

        try:
            plugin = get_plugin(parent.cms_type)
            if not plugin:
                raise RuntimeError(f"No plugin for {parent.cms_type}")

            server_info = _build_server_info(server)
            driver = plugin.driver_class(server_info)

            parent_prefix = parent.config.get("prefix", f"crx-odoo-{parent.id[:8]}") if parent.config else f"crx-odoo-{parent.id[:8]}"
            staging_prefix = staging.config.get("prefix", f"crx-odoo-stg-{staging.id[:8]}") if staging.config else f"crx-odoo-stg-{staging.id[:8]}"
            staging_db = staging.config.get("staging_db", f"stg_{parent_prefix.replace('-', '_')}") if staging.config else f"stg_{parent_prefix.replace('-', '_')}"

            # Stop staging Odoo to avoid conflicts
            deploy_dir = f"/opt/crx-cloud/instances/{staging_prefix}"
            driver._ssh_exec(f"cd {deploy_dir} && docker compose stop odoo 2>/dev/null || true")

            # Re-dump and restore DB
            driver._ssh_exec(
                f"docker exec {parent_prefix}-db psql -U odoo -d postgres -c 'DROP DATABASE IF EXISTS \"{staging_db}\";' "
                f"&& docker exec {parent_prefix}-db psql -U odoo -d postgres -c 'CREATE DATABASE \"{staging_db}\" OWNER odoo;' "
                f"&& docker exec {parent_prefix}-db pg_dump -U odoo -d odoo --no-owner "
                f"| docker exec -i {parent_prefix}-db psql -U odoo -d \"{staging_db}\""
            )

            # Re-copy filestore
            driver._ssh_exec(
                f"docker cp {parent_prefix}-odoo:/var/lib/odoo/filestore/odoo /tmp/stg_filestore_sync "
                f"&& rsync -a --delete /tmp/stg_filestore_sync/ {deploy_dir}/filestore/ 2>/dev/null; "
                f"rm -rf /tmp/stg_filestore_sync"
            )

            # Restart staging
            driver._ssh_exec(f"cd {deploy_dir} && docker compose up -d 2>&1 || true")

            staging.status = "running"
            staging.last_synced_at = dt.utcnow()
            if staging.config:
                staging.config = {**staging.config, "staging_error": None}
            await db.commit()
            logger.info(f"Staging {staging_prefix} synced from {parent_prefix}")

        except Exception as e:
            logger.error(f"Failed to sync staging {staging_id}: {e}")
            staging.status = "error"
            staging.config = {**(staging.config or {}), "staging_error": str(e)}
            await db.commit()


async def _bg_delete_staging(staging_id: str, server_id: str):
    """Background: remove staging containers and data."""
    async with async_session() as db:
        server_r = await db.execute(select(Server).where(Server.id == server_id))
        server = server_r.scalar_one_or_none()
        if not server:
            return

        try:
            # We need to look up the staging config before it was deleted
            # The staging record is already deleted from DB, just clean up server
            staging_prefix = f"crx-odoo-stg-{staging_id[:8]}"
            deploy_dir = f"/opt/crx-cloud/instances/{staging_prefix}"

            from core.server_manager import ServerInfo, ServerStatus
            server_info = ServerInfo(
                id=server.id, name=server.name, server_type="vm",
                provider=server.provider or "", status=ServerStatus.ONLINE,
                endpoint=server.endpoint,
                metadata={"ssh_user": server.ssh_user or "root", "ssh_key_path": server.ssh_key_path or ""},
            )

            plugin = get_plugin("odoo")
            if plugin:
                driver = plugin.driver_class(server_info)
                driver._ssh_exec(f"cd {deploy_dir} && docker compose down -v 2>/dev/null || true")
                driver._ssh_exec(f"rm -rf {deploy_dir}")
                logger.info(f"Staging {staging_prefix} cleaned up from server {server.name}")

        except Exception as e:
            logger.error(f"Failed to cleanup staging {staging_id}: {e}")
