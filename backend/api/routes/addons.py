"""Git addons management endpoints for Odoo instances."""

import logging
import secrets
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy.orm.attributes import flag_modified

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
    try:
        async with async_session() as db:
            result = await db.execute(select(Instance).where(Instance.id == instance_id))
            inst = result.scalar_one_or_none()
            if not inst:
                logger.warning(f"bg_clone: instance {instance_id} not found")
                return
            srv_result = await db.execute(select(Server).where(Server.id == server_id))
            server = srv_result.scalar_one_or_none()
            if not server:
                logger.warning(f"bg_clone: server {server_id} not found")
                return

            config = dict(inst.config or {})
            addon = _find_addon(config, addon_id)
            if not addon:
                logger.warning(f"bg_clone: addon {addon_id} not found in config")
                return

            plugin = get_plugin(inst.cms_type)
            if not plugin:
                addon["status"] = "error"
                addon["error"] = f"No plugin for {inst.cms_type}"
                inst.config = config
                flag_modified(inst, "config")
                await db.commit()
                return

            try:
                addon["status"] = "cloning"
                inst.config = config
                flag_modified(inst, "config")
                await db.commit()
                await db.refresh(inst)
                config = dict(inst.config or {})
                addon = _find_addon(config, addon_id)

                cms = _db_to_cms_instance(inst, server)
                # Use clone_url (may contain PAT) for actual git clone
                clone_url = addon.get("clone_url") or addon["url"]
                logger.info(f"bg_clone: cloning {addon['url']}@{addon['branch']} for {instance_id}")
                clone_result = await plugin.clone_addon(
                    cms, addon_id, clone_url, addon["branch"]
                )

                addon["current_commit"] = clone_result.get("commit", "")
                addon["modules"] = clone_result.get("modules", [])
                addon["status"] = "installed"
                addon["error"] = ""

                # Update compose to mount the new addon dir
                inst.config = config
                flag_modified(inst, "config")
                await db.commit()
                await db.refresh(inst)

                # Regenerate compose + restart to pick up new addon path
                cms = _db_to_cms_instance(inst, server)
                await plugin.update_compose(cms, config)

                # Update module list in Odoo
                try:
                    await plugin.update_module_list(cms)
                except Exception as mu_err:
                    logger.warning(f"bg_clone: update_module_list failed (non-fatal): {mu_err}")

                logger.info(f"Git addon {addon_id} cloned for instance {instance_id}")

            except Exception as e:
                logger.error(f"Git addon clone failed for {addon_id}: {e}", exc_info=True)
                # Re-read config in case it changed
                await db.refresh(inst)
                config = dict(inst.config or {})
                addon = _find_addon(config, addon_id)
                if addon:
                    addon["status"] = "error"
                    addon["error"] = str(e)
                    inst.config = config
                    flag_modified(inst, "config")
                    await db.commit()

    except Exception as outer_err:
        logger.error(f"bg_clone OUTER error for addon {addon_id}: {outer_err}", exc_info=True)
        # Last resort: try to mark as error
        try:
            async with async_session() as db2:
                result = await db2.execute(select(Instance).where(Instance.id == instance_id))
                inst = result.scalar_one_or_none()
                if inst:
                    config = dict(inst.config or {})
                    addon = _find_addon(config, addon_id)
                    if addon:
                        addon["status"] = "error"
                        addon["error"] = f"Background task failed: {outer_err}"
                        inst.config = config
                        flag_modified(inst, "config")
                        await db2.commit()
        except Exception:
            logger.error(f"bg_clone: even error recovery failed for {addon_id}")


async def _bg_update_addon(instance_id: str, server_id: str, addon_id: str):
    """Background: pull latest changes for a git addon."""
    try:
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
                    modules = await plugin.scan_addon_modules(cms, addon_id)
                    addon["modules"] = modules

                    if addon.get("auto_install_requirements"):
                        try:
                            await plugin.install_addon_requirements(cms, addon_id)
                        except Exception as e:
                            logger.warning(f"Failed to install requirements for {addon_id}: {e}")

                    if addon.get("auto_upgrade_modules"):
                        try:
                            await plugin.update_module_list(cms)
                        except Exception as e:
                            logger.warning(f"Failed to upgrade modules for {addon_id}: {e}")

                addon["status"] = "installed"
                addon["error"] = ""
                inst.config = config
                flag_modified(inst, "config")
                await db.commit()

                logger.info(
                    f"Git addon {addon_id} updated: {old_commit[:8]}..{addon['current_commit'][:8]}"
                )

            except Exception as e:
                logger.error(f"Git addon update failed for {addon_id}: {e}", exc_info=True)
                # Rollback: reset to old commit
                if old_commit:
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
                    flag_modified(inst, "config")
                    await db.commit()

    except Exception as outer_err:
        logger.error(f"bg_update OUTER error for addon {addon_id}: {outer_err}", exc_info=True)


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

    # Git addons + Marketplace modules — never expose clone_url (may contain PAT)
    for ga in _get_git_addons(config):
        addon_type = ga.get("type", "git")
        if addon_type == "marketplace":
            addons.append({
                "type": "marketplace",
                "id": ga.get("id", ""),
                "name": ga.get("module_name", ""),
                "display_name": ga.get("module_name", "").replace("_", " ").title(),
                "repo_name": ga.get("repo_name", ""),
                "url": ga.get("url", ""),
                "branch": ga.get("branch", ""),
                "status": ga.get("status", "pending"),
                "current_commit": ga.get("current_commit", ""),
                "modules": ga.get("modules", []),
                "error": ga.get("error", ""),
                "added_at": ga.get("added_at", ""),
                "auto_update": ga.get("auto_update", False),
                "auto_install_requirements": ga.get("auto_install_requirements", False),
                "auto_upgrade_modules": ga.get("auto_upgrade_modules", False),
                "can_update": ga.get("status") == "installed",
                "can_delete": ga.get("status") != "cloning",
            })
        else:
            addons.append({
                "type": "git",
                "id": ga.get("id", ""),
                "name": ga.get("url", "").rstrip("/").rsplit("/", 1)[-1].replace(".git", ""),
                "url": ga.get("url", ""),
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

    # Auto-inject GitHub OAuth token if user has one and no explicit PAT given
    if not access_token and "github.com" in url:
        from api.routes.github_oauth import get_github_token_for_user
        gh_token = await get_github_token_for_user(user["telegram_id"])
        if gh_token:
            access_token = gh_token

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
    flag_modified(inst, "config")
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
    flag_modified(inst, "config")
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
    flag_modified(inst, "config")
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
    flag_modified(inst, "config")
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


# ---------------------------------------------------------------------------
# Marketplace — browse individual OCA modules, install via sparse checkout
# ---------------------------------------------------------------------------

class MarketplaceInstall(BaseModel):
    repo_url: str       # e.g. "https://github.com/OCA/web.git"
    module_name: str    # e.g. "web_responsive"
    branch: str = ""    # defaults to instance.version


async def _bg_marketplace_install(
    instance_id: str, server_id: str, addon_id: str,
    repo_url: str, module_name: str, branch: str,
):
    """Background: sparse-clone a single module from a repo."""
    try:
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
                flag_modified(inst, "config")
                await db.commit()
                return

            try:
                addon["status"] = "cloning"
                inst.config = config
                flag_modified(inst, "config")
                await db.commit()
                await db.refresh(inst)
                config = dict(inst.config or {})
                addon = _find_addon(config, addon_id)

                cms = _db_to_cms_instance(inst, server)
                logger.info(f"Marketplace install: {module_name} from {repo_url}@{branch}")
                clone_result = await plugin.clone_addon_sparse(
                    cms, addon_id, repo_url, branch, module_name
                )

                addon["current_commit"] = clone_result.get("commit", "")
                addon["modules"] = clone_result.get("modules", [])
                addon["status"] = "installed"
                addon["error"] = ""

                inst.config = config
                flag_modified(inst, "config")
                await db.commit()
                await db.refresh(inst)

                # Regenerate compose + restart
                cms = _db_to_cms_instance(inst, server)
                await plugin.update_compose(cms, config)

                try:
                    await plugin.update_module_list(cms)
                except Exception as e:
                    logger.warning(f"Marketplace: update_module_list failed (non-fatal): {e}")

                logger.info(f"Marketplace module {module_name} installed for {instance_id}")

            except Exception as e:
                logger.error(f"Marketplace install failed for {module_name}: {e}", exc_info=True)
                await db.refresh(inst)
                config = dict(inst.config or {})
                addon = _find_addon(config, addon_id)
                if addon:
                    addon["status"] = "error"
                    addon["error"] = str(e)
                    inst.config = config
                    flag_modified(inst, "config")
                    await db.commit()

    except Exception as outer_err:
        logger.error(f"Marketplace OUTER error for {module_name}: {outer_err}", exc_info=True)
        try:
            async with async_session() as db2:
                result = await db2.execute(select(Instance).where(Instance.id == instance_id))
                inst = result.scalar_one_or_none()
                if inst:
                    config = dict(inst.config or {})
                    addon = _find_addon(config, addon_id)
                    if addon:
                        addon["status"] = "error"
                        addon["error"] = f"Background task failed: {outer_err}"
                        inst.config = config
                        flag_modified(inst, "config")
                        await db2.commit()
        except Exception:
            pass


@router.get("/{instance_id}/marketplace")
async def get_marketplace(
    instance_id: str,
    search: str = "",
    category: str = "",
    source: str = "",
    page: int = 1,
    per_page: int = 24,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
    request: Request = None,
):
    """Browse available modules from multiple sources (OCA, Cybrosys, Odoo Mates, Odoo)."""
    from core.marketplace import marketplace_service
    from api.routes.github_oauth import get_github_token

    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    branch = inst.version  # e.g. "17.0", "18.0"
    gh_token = get_github_token(request) if request else None

    data = await marketplace_service.search_modules(
        branch=branch,
        search=search,
        category=category,
        source=source,
        page=page,
        per_page=per_page,
        user_token=gh_token,
    )

    # Mark already-installed modules
    config = inst.config or {}
    installed_modules = set()
    for ga in _get_git_addons(config):
        if ga.get("type") == "marketplace" and ga.get("status") in ("installed", "cloning", "pending"):
            installed_modules.add(ga.get("module_name", ""))
        # Also check full-repo addons' modules
        for mod in ga.get("modules", []):
            installed_modules.add(mod.get("technical_name", ""))

    for mod in data.get("modules", []):
        mod["installed"] = mod["technical_name"] in installed_modules

    return data


@router.post("/{instance_id}/marketplace/install", status_code=201)
async def install_marketplace_module(
    instance_id: str,
    body: MarketplaceInstall,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Install a single module from OCA marketplace via sparse checkout."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    if inst.status not in ("running", "stopped"):
        raise HTTPException(status_code=400, detail="Instance must be running or stopped")

    branch = body.branch or inst.version
    module_name = body.module_name.strip()
    repo_url = body.repo_url.strip()

    if not module_name or not repo_url:
        raise HTTPException(status_code=400, detail="repo_url and module_name are required")

    # Check not already installed
    config = dict(inst.config or {})
    for ga in _get_git_addons(config):
        if ga.get("type") == "marketplace" and ga.get("module_name") == module_name:
            raise HTTPException(status_code=409, detail=f"Module {module_name} is already installed")

    addon_id = f"mp-{module_name[:20]}-{uuid.uuid4().hex[:6]}"
    now = datetime.now(timezone.utc).isoformat()

    # Extract repo name from URL
    repo_name = repo_url.rstrip("/").rsplit("/", 1)[-1].replace(".git", "")

    addon_entry = {
        "id": addon_id,
        "type": "marketplace",
        "url": repo_url,
        "repo_name": repo_name,
        "module_name": module_name,
        "branch": branch,
        "auto_update": False,
        "auto_install_requirements": False,
        "auto_upgrade_modules": False,
        "current_commit": "",
        "status": "pending",
        "error": "",
        "added_at": now,
        "modules": [],
    }

    git_addons = list(config.get("git_addons", []))
    git_addons.append(addon_entry)
    config["git_addons"] = git_addons
    inst.config = config
    flag_modified(inst, "config")
    await db.commit()
    await db.refresh(inst)

    background_tasks.add_task(
        _bg_marketplace_install,
        inst.id, server.id, addon_id,
        repo_url, module_name, branch,
    )

    return {"detail": f"Module {module_name} queued for installation", "addon_id": addon_id}


@router.delete("/{instance_id}/marketplace/{addon_id}")
async def uninstall_marketplace_module(
    instance_id: str,
    addon_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Remove a marketplace-installed module."""
    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    config = dict(inst.config or {})
    git_addons = _get_git_addons(config)
    addon = None
    for ga in git_addons:
        if ga.get("id") == addon_id and ga.get("type") == "marketplace":
            addon = ga
            break
    if not addon:
        raise HTTPException(status_code=404, detail="Marketplace module not found")

    if addon.get("status") == "cloning":
        raise HTTPException(status_code=400, detail="Cannot remove while installing")

    config["git_addons"] = [ga for ga in git_addons if ga.get("id") != addon_id]
    inst.config = config
    flag_modified(inst, "config")
    await db.commit()

    background_tasks.add_task(_bg_remove_addon, inst.id, server.id, addon_id)

    return {"detail": f"Module {addon.get('module_name', addon_id)} removal started"}


@router.post("/{instance_id}/marketplace/rebuild")
async def rebuild_marketplace_index(
    instance_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Force rebuild the marketplace index for this instance's Odoo version."""
    from core.marketplace import marketplace_service

    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    branch = inst.version
    if marketplace_service.is_building(branch):
        return {"detail": f"Index for {branch} is already being built", "building": True}

    async def _bg_rebuild():
        try:
            await marketplace_service.rebuild_index(branch)
        except Exception as e:
            logger.error(f"Marketplace index rebuild failed: {e}")

    background_tasks.add_task(_bg_rebuild)
    return {"detail": f"Rebuilding marketplace index for {branch}", "building": True}


class UploadToGithub(BaseModel):
    repo_name: str
    description: str = ""


@router.post("/{instance_id}/addons/upload-to-github")
async def upload_addons_to_github(
    instance_id: str,
    body: UploadToGithub,
    background_tasks: BackgroundTasks,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Create a private GitHub repo and push instance addons to it."""
    from api.routes.github_oauth import get_github_token

    gh_token = get_github_token(request)
    if not gh_token:
        raise HTTPException(status_code=401, detail="GitHub not connected")

    inst, server = await _get_instance_and_server(instance_id, user["telegram_id"], db)

    repo_name = body.repo_name.strip()
    if not repo_name:
        raise HTTPException(status_code=400, detail="Repository name is required")

    # Create private repo via GitHub API
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.github.com/user/repos",
            headers={
                "Authorization": f"token {gh_token}",
                "Accept": "application/vnd.github.v3+json",
            },
            json={
                "name": repo_name,
                "description": body.description or f"Odoo addons managed by CRX Cloud",
                "private": True,
                "auto_init": True,
            },
        )
        if resp.status_code == 422:
            detail = resp.json().get("errors", [{}])[0].get("message", "Repository already exists")
            raise HTTPException(status_code=409, detail=detail)
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=resp.status_code, detail="Failed to create GitHub repository")

        repo_data = resp.json()
        clone_url = repo_data.get("clone_url", "")
        full_name = repo_data.get("full_name", "")
        html_url = repo_data.get("html_url", "")

    # Add as a git addon so it appears in the addons list
    config = dict(inst.config or {})
    addon_id = f"gh-{repo_name[:20]}-{uuid.uuid4().hex[:6]}"
    now = datetime.now(timezone.utc).isoformat()

    addon_entry = {
        "id": addon_id,
        "type": "git",
        "url": clone_url,
        "repo_name": repo_name,
        "branch": inst.version or "main",
        "auto_update": True,
        "auto_install_requirements": False,
        "auto_upgrade_modules": False,
        "current_commit": "",
        "status": "installed",
        "error": "",
        "added_at": now,
        "modules": [],
        "github_managed": True,
    }

    git_addons = list(config.get("git_addons", []))
    git_addons.append(addon_entry)
    config["git_addons"] = git_addons
    inst.config = config
    flag_modified(inst, "config")
    await db.commit()

    return {
        "detail": f"Repository {full_name} created",
        "addon_id": addon_id,
        "repo_url": html_url,
        "clone_url": clone_url,
        "full_name": full_name,
    }
