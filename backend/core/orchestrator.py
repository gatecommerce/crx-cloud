"""Instance orchestrator — bridges API routes to CMS plugin drivers.

Handles async deployment, lifecycle operations, and converts between
DB models and plugin dataclasses.
"""

import asyncio
from typing import Optional

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
            "endpoint": server.endpoint,
            "ssh_metadata": {
                "ssh_user": server.ssh_user or "root",
                "ssh_key_path": server.ssh_key_path or "",
            },
        }

        # Pass DB instance ID so plugin uses the same ID for prefix/deploy_dir
        deploy_config["instance_id"] = inst.id

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


async def backup_instance(inst: Instance, server: Server, backup: Backup, db: AsyncSession) -> None:
    """Create a backup asynchronously via the CMS plugin.

    Updates Backup status: pending -> in_progress -> completed | failed.
    """
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        backup.status = "failed"
        await db.commit()
        return

    try:
        backup.status = "in_progress"
        await db.commit()

        cms = _db_to_cms_instance(inst, server)
        storage_path = await plugin.backup(cms)

        if storage_path:
            backup.status = "completed"
            backup.storage_path = storage_path
            # Get size (approximate)
            logger.info(f"Backup {backup.id} completed: {storage_path}")
        else:
            backup.status = "failed"
            logger.error(f"Backup {backup.id} returned empty path")

        await db.commit()

    except Exception as e:
        logger.error(f"Backup {backup.id} failed: {e}")
        backup.status = "failed"
        await db.commit()


async def restore_instance(inst: Instance, server: Server, backup: Backup) -> bool:
    """Restore an instance from a backup via the CMS plugin."""
    plugin = get_plugin(inst.cms_type)
    if not plugin:
        return False
    cms = _db_to_cms_instance(inst, server)
    return await plugin.restore(cms, backup.storage_path or backup.id)


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
            await _refresh()
            cms = _db_to_cms_instance(inst, server)
            ok = await plugin.update_compose(cms, {"enterprise": False})
            logger.info(f"Enterprise disabled for {inst_name}")

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
