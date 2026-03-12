"""Git addons management endpoints for Odoo instances."""

import logging
import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.instance import Instance
from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db, async_session
from core.orchestrator import get_plugin, _server_info_from_db, _db_to_cms_instance

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# OCA Catalog — popular repos
# ---------------------------------------------------------------------------
OCA_CATALOG = [
    {"name": "web", "url": "https://github.com/OCA/web.git", "description": "Web addons", "category": "Technical"},
    {"name": "server-tools", "url": "https://github.com/OCA/server-tools.git", "description": "Server tools", "category": "Technical"},
    {"name": "account-financial-tools", "url": "https://github.com/OCA/account-financial-tools.git", "description": "Financial tools", "category": "Accounting"},
    {"name": "account-financial-reporting", "url": "https://github.com/OCA/account-financial-reporting.git", "description": "Financial reporting", "category": "Accounting"},
    {"name": "sale-workflow", "url": "https://github.com/OCA/sale-workflow.git", "description": "Sale workflow extensions", "category": "Sales"},
    {"name": "purchase-workflow", "url": "https://github.com/OCA/purchase-workflow.git", "description": "Purchase workflow", "category": "Purchase"},
    {"name": "stock-logistics-warehouse", "url": "https://github.com/OCA/stock-logistics-warehouse.git", "description": "Warehouse logistics", "category": "Inventory"},
    {"name": "stock-logistics-workflow", "url": "https://github.com/OCA/stock-logistics-workflow.git", "description": "Logistics workflow", "category": "Inventory"},
    {"name": "manufacture", "url": "https://github.com/OCA/manufacture.git", "description": "Manufacturing extensions", "category": "Manufacturing"},
    {"name": "hr", "url": "https://github.com/OCA/hr.git", "description": "Human Resources", "category": "HR"},
    {"name": "social", "url": "https://github.com/OCA/social.git", "description": "Social & messaging", "category": "Communication"},
    {"name": "e-commerce", "url": "https://github.com/OCA/e-commerce.git", "description": "E-commerce extensions", "category": "Website"},
    {"name": "website", "url": "https://github.com/OCA/website.git", "description": "Website builder tools", "category": "Website"},
    {"name": "reporting-engine", "url": "https://github.com/OCA/reporting-engine.git", "description": "Report engines (xlsx, py3o)", "category": "Reporting"},
    {"name": "connector", "url": "https://github.com/OCA/connector.git", "description": "Integration framework", "category": "Integration"},
    {"name": "rest-framework", "url": "https://github.com/OCA/rest-framework.git", "description": "REST API framework", "category": "Technical"},
    {"name": "l10n-italy", "url": "https://github.com/OCA/l10n-italy.git", "description": "Italian localization", "category": "Localization"},
    {"name": "partner-contact", "url": "https://github.com/OCA/partner-contact.git", "description": "Partner & contact management", "category": "CRM"},
    {"name": "crm", "url": "https://github.com/OCA/crm.git", "description": "CRM extensions", "category": "CRM"},
    {"name": "project", "url": "https://github.com/OCA/project.git", "description": "Project management", "category": "Project"},
]


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class GitAddonCreate(BaseModel):
    url: str
    branch: str = ""
    copy_method: str = "all"  # "all" or "specific"
    specific_addons: list[str] = []
    access_token: str = ""  # PAT for private repos (GitHub, GitLab, Bitbucket)


class GitAddonSettingsUpdate(BaseModel):
    auto_update: bool | None = None
    auto_install_requirements: bool | None = None
    auto_upgrade_modules: bool | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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


def _get_git_addons(config: dict) -> list[dict]:
    """Return git_addons list from instance config, defaulting to empty list."""
    return config.get("git_addons", [])


def _find_addon(config: dict, addon_id: str) -> dict | None:
    """Find a git addon by ID in instance config."""
    for addon in _get_git_addons(config):
        if addon.get("id") == addon_id:
            return addon
    return None


# ---------------------------------------------------------------------------
# Background tasks
# ---------------------------------------------------------------------------

async def _bg_clone_addon(instance_id: str, server_id: str, addon_id: str):
    """Background: clone git repo on remote server, scan modules, update status."""
    async with async_session() as db:
        result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = result.scalar_one_or_none()
        if not inst:
            return
        srv_result = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            return

        config = dict(inst.config or {})
        addon = _find_addon(config, addon_id)
        if not addon:
            return

        plugin = get_plugin(inst.cms_type)
        if not plugin:
            addon["status"] = "error"
            addon["error"] = f"No plugin for {inst.cms_type}"
            inst.config = config
            await db.commit()
            return

        try:
            addon["status"] = "cloning"
            inst.config = config
            await db.commit()
            await db.refresh(inst)
            config = dict(inst.config or {})
            addon = _find_addon(config, addon_id)

            cms = _db_to_cms_instance(inst, server)
            # Use clone_url (may contain PAT) for actual git clone
            clone_url = addon.get("clone_url") or addon["url"]
            clone_result = await plugin.clone_addon(
                cms, addon_id, clone_url, addon["branch"]
            )

            addon["current_commit"] = clone_result.get("commit", "")
            addon["modules"] = clone_result.get("modules", [])
            addon["status"] = "installed"
            addon["error"] = ""

            # Update compose to mount the new addon dir
            inst.config = config
            await db.commit()
            await db.refresh(inst)

            # Regenerate compose + restart to pick up new addon path
            cms = _db_to_cms_instance(inst, server)
            await plugin.update_compose(cms, config)

            # Update module list in Odoo
            await plugin.update_module_list(cms)

            logger.info(f"Git addon {addon_id} cloned for instance {instance_id}")

        except Exception as e:
            logger.error(f"Git addon clone failed for {addon_id}: {e}")
            # Re-read config in case it changed
            await db.refresh(inst)
            config = dict(inst.config or {})
            addon = _find_addon(config, addon_id)
            if addon:
                addon["status"] = "error"
                addon["error"] = str(e)
                inst.config = config
                await db.commit()


async def _bg_update_addon(instance_id: str, server_id: str, addon_id: str):
    """Background: pull latest changes for a git addon."""
    async with async_session() as db:
        result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = result.scalar_one_or_none()
        if not inst:
            return
        srv_result = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            return

        config = dict(inst.config or {})
        addon = _find_addon(config, addon_id)
        if not addon:
            return

        plugin = get_plugin(inst.cms_type)
        if not plugin:
            return

        old_commit = addon.get("current_commit", "")

        try:
            cms = _db_to_cms_instance(inst, server)
            pull_result = await plugin.pull_addon(cms, addon_id, addon["branch"])

            addon["current_commit"] = pull_result.get("new_commit", old_commit)

            if pull_result.get("changed", False):
                # Re-scan modules
                modules = await plugin.scan_addon_modules(cms, addon_id)
                addon["modules"] = modules

                # Install requirements if auto-enabled
                if addon.get("auto_install_requirements"):
                    try:
                        await plugin.install_addon_requirements(cms, addon_id)
                    except Exception as e:
                        logger.warning(f"Failed to install requirements for {addon_id}: {e}")

                # Upgrade modules if auto-enabled
                if addon.get("auto_upgrade_modules"):
                    try:
                        await plugin.update_module_list(cms)
                    except Exception as e:
                        logger.warning(f"Failed to upgrade modules for {addon_id}: {e}")

            addon["status"] = "installed"
            addon["error"] = ""
            inst.config = config
            await db.commit()

            logger.info(
                f"Git addon {addon_id} updated: {old_commit[:8]}..{addon['current_commit'][:8]}"
            )

        except Exception as e:
            logger.error(f"Git addon update failed for {addon_id}: {e}")
            # Rollback: reset to old commit
            try:
                server_info = _server_info_from_db(server)
                prefix = config.get("prefix", "")
                from core.vm_controller import VMDriver
                vm = VMDriver()
                addon_dir = f"/opt/crx-cloud/instances/{prefix}/addons/{addon_id}"
                await vm._ssh_exec(
                    server_info,
                    f"git -C {addon_dir} reset --hard {old_commit}"
                )
                logger.info(f"Rolled back addon {addon_id} to {old_commit[:8]}")
            except Exception as rb_err:
                logger.error(f"Rollback failed for addon {addon_id}: {rb_err}")

            await db.refresh(inst)
            config = dict(inst.config or {})
            addon = _find_addon(config, addon_id)
            if addon:
                addon["status"] = "error"
                addon["error"] = str(e)
                inst.config = config
                await db.commit()


async def _bg_remove_addon(instance_id: str, server_id: str, addon_id: str):
    """Background: remove addon directory from server and update compose."""
    async with async_session() as db:
        result = await db.execute(select(Instance).where(Instance.id == instance_id))
        inst = result.scalar_one_or_none()
        if not inst:
            return
        srv_result = await db.execute(select(Server).where(Server.id == server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            return

        plugin = get_plugin(inst.cms_type)
        if not plugin:
            return

        try:
            cms = _db_to_cms_instance(inst, server)
            await plugin.remove_addon(cms, addon_id)

            # Regenerate compose without this addon + restart
            await db.refresh(inst)
            config = dict(inst.config or {})
            cms = _db_to_cms_instance(inst, server)
            await plugin.update_compose(cms, config)

            logger.info(f"Git addon {addon_id} removed from instance {instance_id}")

        except Exception as e:
            logger.error(f"Git addon removal failed for {addon_id}: {e}")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/{instance_id}/addons")
async def list_addons(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List all addons — enterprise (file) + git addons."""
    from pathlib import Path

    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    addons = []
    config = inst.config or {}

    # Enterprise addon (type: "file")
    if config.get("enterprise"):
        is_upgrading = inst.status == "upgrading"
        installed_revision = config.get("enterprise_revision_date", "")
        available_revision = ""
        try:
            meta_path = Path(__file__).resolve().parents[2] / "data" / "enterprise" / inst.version / "meta.json"
            if meta_path.exists():
                import json as _json
                meta = _json.loads(meta_path.read_text())
                available_revision = meta.get("revision_date", "")
        except Exception:
            pass

        update_available = bool(
            available_revision and installed_revision and available_revision > installed_revision
        )
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

    # Git addons — never expose clone_url (may contain PAT)
    for ga in _get_git_addons(config):
        addons.append({
            "type": "git",
            "id": ga.get("id", ""),
            "name": ga.get("url", "").rstrip("/").rsplit("/", 1)[-1].replace(".git", ""),
            "url": ga.get("url", ""),  # Display URL only, no token
            "branch": ga.get("branch", ""),
            "status": ga.get("status", "pending"),
            "current_commit": ga.get("current_commit", ""),
            "has_token": ga.get("has_token", False),
            "auto_update": ga.get("auto_update", False),
            "auto_install_requirements": ga.get("auto_install_requirements", False),
            "auto_upgrade_modules": ga.get("auto_upgrade_modules", False),
            "copy_method": ga.get("copy_method", "all"),
            "specific_addons": ga.get("specific_addons", []),
            "modules": ga.get("modules", []),
            "error": ga.get("error", ""),
            "added_at": ga.get("added_at", ""),
            "can_update": ga.get("status") == "installed",
            "can_delete": ga.get("status") != "cloning",
        })

    return addons


@router.post("/{instance_id}/addons/git", status_code=201)
async def add_git_addon(
    instance_id: str,
    body: GitAddonCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Add a git addon repository. Triggers background clone."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    if inst.status not in ("running", "stopped"):
        raise HTTPException(status_code=400, detail="Instance must be running or stopped")

    # Auto-detect branch from instance version if not provided
    branch = body.branch or inst.version

    # Validate URL format
    url = body.url.strip()
    if not (url.startswith("https://") or url.startswith("git@") or url.startswith("http://")):
        raise HTTPException(status_code=400, detail="URL must start with https://, http://, or git@")

    # Build clone URL with token for private repos
    access_token = body.access_token.strip() if body.access_token else ""
    clone_url = url
    if access_token and url.startswith("https://"):
        # Insert token into URL: https://TOKEN@github.com/org/repo.git
        clone_url = url.replace("https://", f"https://{access_token}@", 1)

    addon_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()

    addon_entry = {
        "id": addon_id,
        "type": "git",
        "url": url,  # Display URL (no token)
        "clone_url": clone_url,  # Actual clone URL (may contain token)
        "has_token": bool(access_token),
        "branch": branch,
        "auto_update": False,
        "auto_install_requirements": False,
        "auto_upgrade_modules": False,
        "copy_method": body.copy_method,
        "specific_addons": body.specific_addons,
        "current_commit": "",
        "status": "pending",
        "error": "",
        "added_at": now,
        "modules": [],
    }

    config = dict(inst.config or {})
    git_addons = list(config.get("git_addons", []))
    git_addons.append(addon_entry)
    config["git_addons"] = git_addons

    # Generate webhook secret if not present
    if "webhook_secret" not in config:
        config["webhook_secret"] = secrets.token_urlsafe(24)

    inst.config = config
    await db.commit()
    await db.refresh(inst)

    background_tasks.add_task(_bg_clone_addon, inst.id, server.id, addon_id)

    return {
        "detail": f"Git addon queued for cloning",
        "addon_id": addon_id,
        "webhook_url": f"/api/v1/instances/{instance_id}/addons/webhook/{config['webhook_secret']}",
    }


@router.patch("/{instance_id}/addons/git/{addon_id}/settings")
async def update_git_addon_settings(
    instance_id: str,
    addon_id: str,
    body: GitAddonSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update git addon settings (auto_update, auto_install_requirements, auto_upgrade_modules)."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    config = dict(inst.config or {})
    addon = _find_addon(config, addon_id)
    if not addon:
        raise HTTPException(status_code=404, detail="Git addon not found")

    if body.auto_update is not None:
        addon["auto_update"] = body.auto_update
    if body.auto_install_requirements is not None:
        addon["auto_install_requirements"] = body.auto_install_requirements
    if body.auto_upgrade_modules is not None:
        addon["auto_upgrade_modules"] = body.auto_upgrade_modules

    inst.config = config
    await db.commit()

    return {"detail": "Addon settings updated", "addon_id": addon_id}


@router.post("/{instance_id}/addons/git/{addon_id}/update")
async def update_git_addon(
    instance_id: str,
    addon_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Pull latest changes for a git addon."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    config = dict(inst.config or {})
    addon = _find_addon(config, addon_id)
    if not addon:
        raise HTTPException(status_code=404, detail="Git addon not found")

    if addon.get("status") not in ("installed", "error"):
        raise HTTPException(status_code=400, detail="Addon must be installed or in error state")

    previous_commit = addon.get("current_commit", "")
    background_tasks.add_task(_bg_update_addon, inst.id, server.id, addon_id)

    return {
        "detail": "Addon update started",
        "addon_id": addon_id,
        "previous_commit": previous_commit,
    }


@router.delete("/{instance_id}/addons/git/{addon_id}")
async def delete_git_addon(
    instance_id: str,
    addon_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Remove a git addon."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    config = dict(inst.config or {})
    git_addons = _get_git_addons(config)
    addon = None
    for ga in git_addons:
        if ga.get("id") == addon_id:
            addon = ga
            break
    if not addon:
        raise HTTPException(status_code=404, detail="Git addon not found")

    if addon.get("status") == "cloning":
        raise HTTPException(status_code=400, detail="Cannot remove addon while cloning")

    # Remove from config immediately
    config["git_addons"] = [ga for ga in git_addons if ga.get("id") != addon_id]
    inst.config = config
    await db.commit()

    # Remove files from server in background
    background_tasks.add_task(_bg_remove_addon, inst.id, server.id, addon_id)

    return {"detail": f"Git addon {addon_id} removal started"}


@router.get("/{instance_id}/addons/git/{addon_id}/modules")
async def list_addon_modules(
    instance_id: str,
    addon_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Scan and return __manifest__.py modules in a git addon."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    config = dict(inst.config or {})
    addon = _find_addon(config, addon_id)
    if not addon:
        raise HTTPException(status_code=404, detail="Git addon not found")

    if addon.get("status") != "installed":
        raise HTTPException(status_code=400, detail="Addon must be installed to scan modules")

    plugin = get_plugin(inst.cms_type)
    if not plugin:
        raise HTTPException(status_code=500, detail=f"No plugin for {inst.cms_type}")

    cms = _db_to_cms_instance(inst, server)
    modules = await plugin.scan_addon_modules(cms, addon_id)

    # Update cached modules in config
    addon["modules"] = modules
    inst.config = config
    await db.commit()

    return {"addon_id": addon_id, "modules": modules}


@router.get("/{instance_id}/addons/check-conflicts")
async def check_addon_conflicts(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Check for module name conflicts across all git addons."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    config = inst.config or {}
    git_addons = _get_git_addons(config)
    installed = [ga for ga in git_addons if ga.get("status") == "installed"]

    if not installed:
        return {"conflicts": [], "total_modules": 0}

    # Collect all module technical names across addons
    module_map: dict[str, list[str]] = {}  # module_name -> [addon_ids]
    for ga in installed:
        addon_name = ga.get("url", "").rstrip("/").rsplit("/", 1)[-1].replace(".git", "")
        for mod in ga.get("modules", []):
            tech_name = mod.get("technical_name", "")
            if tech_name:
                module_map.setdefault(tech_name, []).append(addon_name)

    # Find duplicates
    conflicts = []
    for module_name, sources in module_map.items():
        if len(sources) > 1:
            conflicts.append({
                "module": module_name,
                "found_in": sources,
            })

    total = sum(len(ga.get("modules", [])) for ga in installed)
    return {"conflicts": conflicts, "total_modules": total}


@router.get("/{instance_id}/addons/check-compatibility")
async def check_addon_compatibility(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Check version compatibility of all git addons vs instance Odoo version."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    config = inst.config or {}
    git_addons = _get_git_addons(config)
    instance_version = inst.version  # e.g. "17.0"

    results = []
    for ga in git_addons:
        if ga.get("status") != "installed":
            continue

        addon_name = ga.get("url", "").rstrip("/").rsplit("/", 1)[-1].replace(".git", "")
        incompatible_modules = []
        compatible_modules = []
        unknown_modules = []

        for mod in ga.get("modules", []):
            mod_version = mod.get("version", "")
            tech_name = mod.get("technical_name", "")
            installable = mod.get("installable", True)

            if not installable:
                continue

            if not mod_version:
                unknown_modules.append(tech_name)
                continue

            # Odoo module versions are typically "{odoo_version}.x.y.z"
            if mod_version.startswith(instance_version + "."):
                compatible_modules.append(tech_name)
            else:
                incompatible_modules.append({
                    "module": tech_name,
                    "module_version": mod_version,
                    "expected_prefix": instance_version,
                })

        results.append({
            "addon": addon_name,
            "addon_id": ga.get("id", ""),
            "branch": ga.get("branch", ""),
            "compatible_count": len(compatible_modules),
            "incompatible": incompatible_modules,
            "unknown_version": unknown_modules,
        })

    return {
        "instance_version": instance_version,
        "addons": results,
    }


@router.get("/oca-catalog")
async def get_oca_catalog():
    """Return OCA popular repos catalog."""
    return OCA_CATALOG


@router.post("/{instance_id}/addons/webhook/{secret}")
async def addon_webhook(
    instance_id: str,
    secret: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Webhook endpoint for auto-deploy from GitHub/GitLab push events.

    No auth required — uses webhook secret for verification.
    """
    result = await db.execute(select(Instance).where(Instance.id == instance_id))
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    config = inst.config or {}
    stored_secret = config.get("webhook_secret", "")

    if not stored_secret or secret != stored_secret:
        raise HTTPException(status_code=403, detail="Invalid webhook secret")

    srv_result = await db.execute(select(Server).where(Server.id == inst.server_id))
    server = srv_result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    # Find all addons with auto_update enabled
    git_addons = _get_git_addons(config)
    updated = []
    for ga in git_addons:
        if ga.get("auto_update") and ga.get("status") == "installed":
            background_tasks.add_task(_bg_update_addon, inst.id, server.id, ga["id"])
            updated.append(ga["id"])

    return {"detail": f"Webhook received, updating {len(updated)} addon(s)", "updated": updated}
