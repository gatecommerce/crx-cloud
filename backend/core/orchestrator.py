"""Instance orchestrator — bridges API routes to CMS plugin drivers.

Handles async deployment, lifecycle operations, and converts between
DB models and plugin dataclasses.
"""

import asyncio
import time
from typing import Optional

from loguru import logger
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import async_session

from api.models.instance import Instance
from api.models.server import Server
from api.models.backup import Backup
from plugins.base import CMSPlugin, CMSInstance
from plugins.odoo.driver import OdooPlugin
from core.dns_manager import create_subdomain, remove_subdomain, generate_subdomain
from core.nginx_manager import setup_nginx, remove_nginx, NginxConfig

# Registry of available CMS plugins
_plugins: dict[str, CMSPlugin] = {
    "odoo": OdooPlugin(),
}


def get_plugin(cms_type: str) -> Optional[CMSPlugin]:
    """Get plugin driver for a CMS type."""
    return _plugins.get(cms_type)


def _server_info_from_db(server: Server):
    """Build a ServerInfo for plugin drivers from DB Server model."""
    from core.server_manager import ServerInfo, ServerStatus
    return ServerInfo(
        id=server.id, name=server.name, server_type="vm",
        provider=server.provider or "", status=ServerStatus.ONLINE,
        endpoint=server.endpoint,
        metadata={"ssh_user": server.ssh_user or "root", "ssh_key_path": server.ssh_key_path or ""},
    )


def _db_to_cms_instance(inst: Instance, server: Server) -> CMSInstance:
    """Convert DB Instance + Server to CMSInstance dataclass for plugin drivers."""
    config = dict(inst.config or {})
    # Inject server connection info needed by drivers
    config["endpoint"] = server.endpoint
    config["ssh_metadata"] = {
        "ssh_user": server.ssh_user or "root",
        "ssh_key_path": server.ssh_key_path or "",
    }
    return CMSInstance(
        id=inst.id,
        cms_type=inst.cms_type,
        version=inst.version,
        name=inst.name,
        server_id=inst.server_id,
        domain=inst.domain or "",
        url=inst.url or "",
        status=inst.status,
        config=config,
    )


def _next_port(existing_instances: list[Instance], base: int = 8069) -> int:
    """Find next available port for a new instance on the same server."""
    used = set()
    for inst in existing_instances:
        cfg = inst.config or {}
        if "port" in cfg:
            used.add(cfg["port"])
    port = base
    while port in used:
        port += 10  # Each Odoo instance uses port and port+3
    return port


async def deploy_instance(inst: Instance, server: Server, db: AsyncSession) -> None:
    """Deploy an instance asynchronously via the appropriate CMS plugin.

    Updates DB status: deploying -> running | error.
    Called as a background task after the API returns 201.
    """
    inst_name = inst.name  # Cache before any commit
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        inst.status = "error"
        inst.config = {**(inst.config or {}), "error": f"No plugin for {inst.cms_type}"}
        await db.commit()
        return

    try:
        # Get sibling instances on same server for port allocation
        result = await db.execute(
            select(Instance).where(
                Instance.server_id == server.id,
                Instance.id != inst.id,
            )
        )
        siblings = list(result.scalars().all())
        port = _next_port(siblings)

        # Build deploy config — merge instance config so driver gets
        # admin_password, db_name, language, country, edition, etc.
        deploy_config = {
            **(inst.config or {}),
            "name": inst.name,
            "version": inst.version,
            "port": port,
            "workers": inst.workers,
            "ram_mb": inst.ram_mb,
            "cpu_cores": inst.cpu_cores,
            "endpoint": server.endpoint,
            "ssh_metadata": {
                "ssh_user": server.ssh_user or "root",
                "ssh_key_path": server.ssh_key_path or "",
            },
        }

        # Pass DB instance ID so plugin uses the same ID for prefix/deploy_dir
        deploy_config["instance_id"] = inst.id

        # If enterprise edition, sync addons to server BEFORE deploy
        if deploy_config.get("edition") == "enterprise":
            from pathlib import Path

            ent_version = deploy_config.get("version", "19.0")
            enterprise_dir = Path("data/enterprise") / ent_version
            package_file = None
            for f in enterprise_dir.iterdir() if enterprise_dir.exists() else []:
                if f.suffix in (".gz", ".tgz", ".zip") or f.name.endswith(".tar.gz"):
                    package_file = f
                    break

            if package_file:
                server_info = _server_info_from_db(server)
                logger.info(f"Syncing enterprise addons v{ent_version} to {server.name} before deploy")
                ok = await plugin.sync_enterprise_addons(server_info, ent_version, str(package_file))
                if not ok:
                    logger.warning(f"Enterprise addons sync failed — deploying without enterprise modules")
                    deploy_config["edition"] = "community"
            else:
                logger.warning(f"No enterprise package for v{ent_version} — deploying as community")
                deploy_config["edition"] = "community"

        logger.info(f"Deploying {inst.cms_type} instance {inst_name} on {server.name}:{port}")
        cms_instance = await plugin.deploy(server.id, deploy_config)

        # Update DB with deploy results
        inst.status = "running"
        inst.url = cms_instance.url
        inst.config = {
            **(inst.config or {}),
            **cms_instance.config,
            "port": port,
        }
        await db.commit()
        await db.refresh(inst)
        logger.info(f"Instance {inst_name} deployed successfully: {inst.url}")

        # Configure DNS + Nginx reverse proxy if domain is set
        if inst.domain:
            # Create Cloudflare DNS A record
            try:
                subdomain = inst.domain.replace(".site.crx.team", "")
                await create_subdomain(subdomain, server.endpoint)
                logger.info(f"DNS record created: {inst.domain} -> {server.endpoint}")
            except Exception as e:
                logger.warning(f"DNS creation failed for {inst.domain}: {e}")

            try:
                nginx_ok = await setup_nginx(
                    host=server.endpoint,
                    ssh_user=server.ssh_user or "root",
                    ssh_key_path=server.ssh_key_path or "",
                    config=NginxConfig(
                        domain=inst.domain,
                        upstream_port=port,
                        instance_name=inst.name,
                        ssl=True,
                    ),
                )
                if nginx_ok:
                    inst.url = f"https://{inst.domain}"
                    await db.commit()
                    logger.info(f"Nginx + SSL configured for {inst.domain}")
                else:
                    # Nginx failed but DNS is set — use http with domain:port
                    inst.url = f"http://{inst.domain}:{port}"
                    await db.commit()
                    logger.warning(f"Nginx failed for {inst.domain}, using direct port")
            except Exception as e:
                inst.url = f"http://{inst.domain}:{port}"
                await db.commit()
                logger.warning(f"Nginx setup error for {inst.domain}: {e}")

    except Exception as e:
        logger.error(f"Deploy failed for {inst_name}: {e}")
        try:
            await db.refresh(inst)
        except Exception:
            pass
        inst.status = "error"
        inst.config = {**(inst.config or {}), "error": str(e)}
        await db.commit()


async def restart_instance(inst: Instance, server: Server) -> bool:
    """Restart an instance via its CMS plugin."""
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        return False
    cms = _db_to_cms_instance(inst, server)
    return await plugin.restart(cms)


async def stop_instance(inst: Instance, server: Server) -> bool:
    """Stop an instance via its CMS plugin."""
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        return False
    cms = _db_to_cms_instance(inst, server)
    return await plugin.stop(cms)


async def start_instance(inst: Instance, server: Server) -> bool:
    """Start an instance via its CMS plugin."""
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        return False
    cms = _db_to_cms_instance(inst, server)
    return await plugin.start(cms)


async def remove_instance(inst: Instance, server: Server) -> bool:
    """Remove an instance from the server via its CMS plugin."""
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        return False
    cms = _db_to_cms_instance(inst, server)
    result = await plugin.remove(cms)

    # Cleanup DNS + Nginx config
    if inst.domain:
        try:
            subdomain = inst.domain.replace(".site.crx.team", "")
            await remove_subdomain(subdomain)
        except Exception as e:
            logger.warning(f"DNS cleanup failed for {inst.domain}: {e}")

        try:
            await remove_nginx(
                host=server.endpoint,
                ssh_user=server.ssh_user or "root",
                ssh_key_path=server.ssh_key_path or "",
                instance_name=inst.name,
            )
        except Exception as e:
            logger.warning(f"Nginx cleanup failed for {inst.name}: {e}")

    return result


async def _update_progress(backup: Backup, db: AsyncSession, step: str, detail: str = "") -> None:
    """Update backup progress in DB so the frontend can poll it."""
    backup.progress = {"step": step, "detail": detail}
    try:
        await db.commit()
    except Exception:
        # Don't let a progress-update failure poison the session
        await db.rollback()
        logger.warning(f"Backup {backup.id}: progress update failed at step={step}")


# Global set of backup IDs that have been cancelled — checked between steps
_cancelled_backups: set[str] = set()


def mark_backup_cancelled(backup_id: str) -> None:
    """Signal a running backup to stop at the next step boundary."""
    _cancelled_backups.add(backup_id)


async def _check_cancelled(backup: Backup, inst: Instance, db: AsyncSession, server_info, vm, backup_dir: str | None) -> bool:
    """Check if backup was cancelled. If so, clean up and return True."""
    if str(backup.id) not in _cancelled_backups:
        return False

    _cancelled_backups.discard(str(backup.id))
    logger.info(f"Backup {backup.id} cancelled by user — aborting")

    # Kill any running pg_dump on the server (best-effort)
    if server_info and vm:
        try:
            await vm._ssh_exec(server_info, "pkill -f 'pg_dump' || true", timeout=10)
        except Exception:
            pass
        # Clean up partial backup directory
        if backup_dir:
            try:
                await vm._ssh_exec(server_info, f"rm -rf {backup_dir}", timeout=15)
            except Exception:
                pass

    from datetime import datetime, timezone
    backup.status = "failed"
    backup.error_message = "Cancelled by user"
    backup.completed_at = datetime.utcnow()
    backup.duration_seconds = int(time.time() - backup._start_time) if hasattr(backup, '_start_time') else 0
    backup.progress = {"step": "failed", "detail": "cancelled"}
    inst.status = "running"
    await db.commit()
    return True


async def backup_instance(inst: Instance, server: Server, backup: Backup, db: AsyncSession) -> None:
    """Create a backup asynchronously with step-by-step progress tracking.

    Hot backup: the instance keeps running (pg_dump is non-blocking for Odoo/PostgreSQL).
    Progress steps: preparing → db_dump → filestore → finalizing → completed/failed.
    Supports cancellation between steps via _cancelled_backups set.
    """
    from core.vm_controller import VMDriver
    from datetime import datetime, timezone

    plugin = get_plugin(inst.cms_type)
    if not plugin:
        backup.status = "failed"
        await db.commit()
        return

    start = time.time()
    backup._start_time = start  # stash for _check_cancelled
    backup_dir = None
    server_info = None
    vm = None

    try:
        backup.status = "in_progress"
        inst.status = "backing_up"
        await _update_progress(backup, db, "preparing")

        cms = _db_to_cms_instance(inst, server)
        server_info = _server_info_from_db(server)
        vm = VMDriver()

        # --- Odoo: phased backup with progress ---
        if inst.cms_type == "odoo":
            prefix = cms.config.get("prefix", "")
            db_name = cms.config.get("db_name", "postgres")
            ssh_meta = cms.config.get("ssh_metadata", {})
            server_conn = plugin._server_info(inst.server_id, cms.config.get("endpoint", ""), ssh_meta)

            import uuid as _uuid
            backup_id_short = _uuid.uuid4().hex[:12]
            backup_dir = f"/opt/crx-cloud/backups/{prefix}/{backup_id_short}"

            # Step 1: create directory
            await vm._ssh_exec(server_info, f"mkdir -p {backup_dir}", timeout=30)

            if await _check_cancelled(backup, inst, db, server_info, vm, backup_dir):
                return

            # Step 2: database dump (hot — PostgreSQL MVCC ensures consistency)
            await _update_progress(backup, db, "db_dump", f"pg_dump {db_name}")
            await vm._ssh_exec(
                server_info,
                f"docker exec {prefix}-db pg_dump -U odoo -Fc {db_name} > {backup_dir}/db.dump",
                timeout=3600,
            )

            if await _check_cancelled(backup, inst, db, server_info, vm, backup_dir):
                return

            # Step 3: filestore copy (optional)
            if backup.include_filestore:
                await _update_progress(backup, db, "filestore", "docker cp filestore")
                await vm._ssh_exec(
                    server_info,
                    f"docker cp {prefix}-odoo:/var/lib/odoo/filestore/{db_name} {backup_dir}/filestore 2>/dev/null || true",
                    timeout=3600,
                )
            else:
                logger.info(f"Backup {backup.id}: filestore skipped (include_filestore=False)")

            if await _check_cancelled(backup, inst, db, server_info, vm, backup_dir):
                return

            storage_path = backup_dir
        else:
            # Other CMS: single-step via plugin (no granular progress)
            await _update_progress(backup, db, "db_dump")
            storage_path = await plugin.backup(cms)

        # Step 4: finalizing — get size
        await _update_progress(backup, db, "finalizing", "calculating size")
        elapsed = int(time.time() - start)

        if storage_path:
            backup.status = "completed"
            backup.storage_path = storage_path
            backup.duration_seconds = elapsed

            try:
                size_out = await vm._ssh_exec(
                    server_info,
                    f"du -sb {storage_path} 2>/dev/null | cut -f1",
                    timeout=15,
                )
                size_bytes = int(size_out.strip())
                backup.size_mb = max(1, size_bytes // (1024 * 1024))
            except Exception as e:
                logger.warning(f"Backup {backup.id}: could not get size: {e}")
                backup.size_mb = None

            backup.progress = {"step": "completed"}
            logger.info(f"Backup {backup.id} completed in {elapsed}s: {storage_path}")
        else:
            backup.status = "failed"
            backup.error_message = "Plugin returned empty path"
            backup.progress = {"step": "failed", "detail": "empty path"}
            logger.error(f"Backup {backup.id} returned empty path")

        inst.status = "running"
        backup.completed_at = datetime.utcnow()
        try:
            await db.commit()
        except Exception as commit_err:
            logger.error(f"Backup {backup.id}: final commit failed: {commit_err}")
            # Session may be poisoned — use fresh session to persist result
            try:
                await db.rollback()
            except Exception:
                pass
            async with async_session() as fresh_db:
                await fresh_db.execute(
                    update(Backup).where(Backup.id == backup.id).values(
                        status=backup.status,
                        storage_path=backup.storage_path,
                        size_mb=backup.size_mb,
                        duration_seconds=backup.duration_seconds,
                        progress=backup.progress,
                        completed_at=backup.completed_at,
                        error_message=backup.error_message,
                    )
                )
                await fresh_db.execute(
                    update(Instance).where(Instance.id == inst.id).values(status="running")
                )
                await fresh_db.commit()
                logger.info(f"Backup {backup.id}: saved via fresh session fallback")

    except Exception as e:
        logger.error(f"Backup {backup.id} failed: {e}")
        try:
            await db.rollback()  # clear any PendingRollbackError
        except Exception:
            pass
        backup.status = "failed"
        backup.error_message = str(e)[:2000]
        backup.progress = {"step": "failed", "detail": str(e)[:200]}
        backup.duration_seconds = int(time.time() - start)
        inst.status = "running"
        try:
            await db.commit()
        except Exception as commit_err:
            logger.error(f"Backup {backup.id}: recovery commit also failed: {commit_err}")
            # Last resort: use a fresh session to update the status
            try:
                async with async_session() as fresh_db:
                    await fresh_db.execute(
                        update(Backup).where(Backup.id == backup.id).values(
                            status="failed", error_message=str(e)[:2000],
                            progress={"step": "failed", "detail": str(e)[:200]},
                        )
                    )
                    await fresh_db.execute(
                        update(Instance).where(Instance.id == inst.id).values(status="running")
                    )
                    await fresh_db.commit()
            except Exception as last_err:
                logger.error(f"Backup {backup.id}: fresh session fallback also failed: {last_err}")
    finally:
        _cancelled_backups.discard(str(backup.id))


async def restore_instance(inst: Instance, server: Server, backup: Backup, include_filestore: bool = True) -> bool:
    """Restore an instance from a backup via the CMS plugin."""
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        return False
    cms = _db_to_cms_instance(inst, server)
    return await plugin.restore(cms, backup.storage_path or backup.id, include_filestore=include_filestore)


async def health_check_instance(inst: Instance, server: Server) -> dict:
    """Check health of an instance via its CMS plugin."""
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        return {"status": "error", "error": f"No plugin for {inst.cms_type}"}
    cms = _db_to_cms_instance(inst, server)
    return await plugin.health_check(cms)


async def update_instance_settings(inst: Instance, server: Server, db: AsyncSession, settings: dict) -> None:
    """Apply settings changes (enterprise, auto_ssl) to a running instance.

    Called as a background task after the API returns the updated instance.
    """
    # Cache values before any commit (SQLAlchemy expires ORM attrs after commit)
    inst_id = inst.id
    inst_name = inst.name
    inst_version = inst.version or "19.0"
    inst_cms_type = inst.cms_type

    plugin = get_plugin(inst_cms_type)
    if not plugin:
        logger.error(f"No plugin for {inst_cms_type} — cannot update settings")
        return

    async def _refresh():
        """Refresh instance from DB after commit to avoid expired attrs."""
        await db.refresh(inst)

    async def _update_config(updates: dict):
        """Safely merge updates into inst.config and commit."""
        await _refresh()
        inst.config = {**(inst.config or {}), **updates}
        await db.commit()

    try:
        # Enterprise edition toggle
        if "enterprise" in settings and settings["enterprise"]:
            from pathlib import Path

            enterprise_dir = Path("data/enterprise") / inst_version
            package_file = None
            for f in enterprise_dir.iterdir() if enterprise_dir.exists() else []:
                if f.suffix in (".gz", ".tgz", ".zip") or f.name.endswith(".tar.gz"):
                    package_file = f
                    break

            if not package_file:
                logger.error(f"No enterprise package found for v{inst_version}")
                await _update_config({"enterprise_error": f"No package for v{inst_version}"})
                return

            # Lock instance — prevent other operations
            inst.status = "upgrading"
            await _update_config({"enterprise_progress": "Uploading enterprise addons to server..."})
            logger.info(f"Starting enterprise activation for {inst_name}")

            try:
                server_info = _server_info_from_db(server)
                await _refresh()
                cms = _db_to_cms_instance(inst, server)

                # Step 1: Upload + extract enterprise addons on server
                await _update_config({"enterprise_progress": "Extracting enterprise addons on server..."})
                logger.info(f"Syncing enterprise addons for {inst_name} v{inst_version}")

                ok = await plugin.sync_enterprise_addons(server_info, inst_version, str(package_file))
                if not ok:
                    raise RuntimeError("Failed to sync enterprise addons to server")

                # Step 2: Enable enterprise (update compose, restart, install web_enterprise)
                await _update_config({"enterprise_progress": "Activating enterprise modules..."})
                logger.info(f"Enabling enterprise for {inst_name}")

                # Rebuild cms with fresh state
                await _refresh()
                cms = _db_to_cms_instance(inst, server)
                ok = await plugin.enable_enterprise(cms)
                if not ok:
                    raise RuntimeError("Failed to enable enterprise on instance")

                # Read revision_date from meta.json
                enterprise_revision = ""
                try:
                    import json as _json
                    meta_path = Path("data/enterprise") / inst_version / "meta.json"
                    if meta_path.exists():
                        meta = _json.loads(meta_path.read_text())
                        enterprise_revision = meta.get("revision_date", "")
                except Exception:
                    pass

                # Success — set status AFTER _update_config's refresh, not before
                await _update_config({
                    "enterprise": True,
                    "edition": "enterprise",
                    "enterprise_progress": None,
                    "enterprise_error": None,
                    "enterprise_revision_date": enterprise_revision,
                })
                inst.status = "running"
                await db.commit()
                logger.info(f"Enterprise enabled for {inst_name}")

            except Exception as e:
                logger.error(f"Enterprise activation failed for {inst_name}: {e}")
                try:
                    await _refresh()
                except Exception:
                    pass
                await _update_config({"enterprise": False, "enterprise_error": str(e), "enterprise_progress": None})
                inst.status = "running"
                await db.commit()
                return

        elif "enterprise" in settings and not settings["enterprise"]:
            # Disable enterprise — revert to community compose
            inst.status = "upgrading"
            await _update_config({
                "enterprise_progress": "Disabling enterprise modules...",
                "enterprise_error": None,
            })
            logger.info(f"Disabling enterprise for {inst_name}")

            try:
                await _refresh()
                cms = _db_to_cms_instance(inst, server)
                ok = await plugin.update_compose(cms, {"enterprise": False, "edition": "community"})
                await _update_config({
                    "enterprise": False,
                    "edition": "community",
                    "enterprise_progress": None,
                    "enterprise_error": None,
                })
                inst.status = "running"
                await db.commit()
                logger.info(f"Enterprise disabled for {inst_name}")
            except Exception as e:
                logger.error(f"Enterprise disable failed for {inst_name}: {e}")
                await _update_config({
                    "enterprise_progress": None,
                    "enterprise_error": str(e),
                })
                inst.status = "running"
                await db.commit()

        # SSL toggle
        if "auto_ssl" in settings:
            await _refresh()
            if inst.domain:
                port = (inst.config or {}).get("port", 8069)
                if settings["auto_ssl"]:
                    nginx_ok = await setup_nginx(
                        host=server.endpoint,
                        ssh_user=server.ssh_user or "root",
                        ssh_key_path=server.ssh_key_path or "",
                        config=NginxConfig(
                            domain=inst.domain,
                            upstream_port=port,
                            instance_name=inst.name,
                            ssl=True,
                        ),
                    )
                    if nginx_ok:
                        inst.url = f"https://{inst.domain}"
                        logger.info(f"SSL enabled for {inst.domain}")
                    else:
                        logger.warning(f"SSL setup failed for {inst.domain}")
                else:
                    nginx_ok = await setup_nginx(
                        host=server.endpoint,
                        ssh_user=server.ssh_user or "root",
                        ssh_key_path=server.ssh_key_path or "",
                        config=NginxConfig(
                            domain=inst.domain,
                            upstream_port=port,
                            instance_name=inst.name,
                            ssl=False,
                        ),
                    )
                    if nginx_ok:
                        inst.url = f"http://{inst.domain}"
                        logger.info(f"SSL disabled for {inst.domain}")

        # Merge settings into config
        await _update_config(settings)

    except Exception as e:
        logger.error(f"Failed to update settings for {inst_name}: {e}")
        try:
            await _refresh()
            inst.config = {**(inst.config or {}), "settings_error": str(e)}
            await db.commit()
        except Exception as e2:
            logger.error(f"Failed to save error state for {inst_name}: {e2}")


async def update_instance_domain(inst: Instance, server: Server, db: AsyncSession, domain_data: dict) -> None:
    """Apply domain changes (domain, aliases, http_redirect) to a running instance.

    Called as a background task after the API returns the updated instance.
    """
    inst_name = inst.name  # Cache before any commit
    try:
        old_domain = inst.domain
        new_domain = domain_data.get("domain") or inst.domain
        aliases = domain_data.get("aliases", [])
        port = (inst.config or {}).get("port", 8069)

        # Remove old DNS + Nginx if domain changed
        if old_domain and new_domain != old_domain:
            try:
                old_subdomain = old_domain.replace(".site.crx.team", "")
                await remove_subdomain(old_subdomain)
                logger.info(f"Removed DNS for old domain: {old_domain}")
            except Exception as e:
                logger.warning(f"DNS cleanup failed for {old_domain}: {e}")

            try:
                await remove_nginx(
                    host=server.endpoint,
                    ssh_user=server.ssh_user or "root",
                    ssh_key_path=server.ssh_key_path or "",
                    instance_name=inst.name,
                )
                logger.info(f"Removed Nginx for old domain: {old_domain}")
            except Exception as e:
                logger.warning(f"Nginx cleanup failed for {old_domain}: {e}")

        # Setup new DNS + Nginx
        if new_domain:
            try:
                subdomain = new_domain.replace(".site.crx.team", "")
                await create_subdomain(subdomain, server.endpoint)
                logger.info(f"DNS record created: {new_domain} -> {server.endpoint}")
            except Exception as e:
                logger.warning(f"DNS creation failed for {new_domain}: {e}")

            ssl_enabled = (inst.config or {}).get("auto_ssl", True)
            try:
                nginx_ok = await setup_nginx(
                    host=server.endpoint,
                    ssh_user=server.ssh_user or "root",
                    ssh_key_path=server.ssh_key_path or "",
                    config=NginxConfig(
                        domain=new_domain,
                        upstream_port=port,
                        instance_name=inst.name,
                        ssl=ssl_enabled,
                        aliases=aliases,
                    ),
                )
                if nginx_ok:
                    scheme = "https" if ssl_enabled else "http"
                    inst.url = f"{scheme}://{new_domain}"
                    logger.info(f"Nginx configured for {new_domain} (aliases: {aliases})")
                else:
                    inst.url = f"http://{new_domain}:{port}"
                    logger.warning(f"Nginx failed for {new_domain}, using direct port")
            except Exception as e:
                inst.url = f"http://{new_domain}:{port}"
                logger.warning(f"Nginx setup error for {new_domain}: {e}")

        # Update instance record
        inst.domain = new_domain
        inst.config = {
            **(inst.config or {}),
            "aliases": aliases,
            "http_redirect": domain_data.get("http_redirect", True),
        }
        await db.commit()
        logger.info(f"Domain updated for {inst_name}: {old_domain} -> {new_domain}")

    except Exception as e:
        logger.error(f"Failed to update domain for {inst_name}: {e}")
        try:
            await db.refresh(inst)
            inst.config = {**(inst.config or {}), "domain_error": str(e)}
            await db.commit()
        except Exception as e2:
            logger.error(f"Failed to save domain error state for {inst_name}: {e2}")


async def get_instance_logs(inst: Instance, server: Server, lines: int = 100) -> str:
    """Get recent logs from an instance container."""
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        return ""

    cms = _db_to_cms_instance(inst, server)
    prefix = cms.config.get("prefix", "")
    if not prefix:
        return ""

    try:
        from core.vm_controller import VMDriver
        from core.server_manager import ServerInfo, ServerStatus
        vm = VMDriver()
        server_info = ServerInfo(
            id=server.id, name=server.name, server_type="vm",
            provider=server.provider or "", status=ServerStatus.ONLINE,
            endpoint=server.endpoint,
            metadata={"ssh_user": server.ssh_user or "root", "ssh_key_path": server.ssh_key_path or ""},
        )
        result = await vm._ssh_exec(server_info, f"docker logs {prefix}-odoo --tail {lines} 2>&1")
        return result
    except Exception as e:
        return f"Error fetching logs: {e}"
