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

# Registry of available CMS plugins
_plugins: dict[str, CMSPlugin] = {
    "odoo": OdooPlugin(),
}


def get_plugin(cms_type: str) -> Optional[CMSPlugin]:
    """Get plugin driver for a CMS type."""
    return _plugins.get(cms_type)


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

        # Build deploy config
        deploy_config = {
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

        logger.info(f"Deploying {inst.cms_type} instance {inst.name} on {server.name}:{port}")
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
        logger.info(f"Instance {inst.name} deployed successfully: {inst.url}")

    except Exception as e:
        logger.error(f"Deploy failed for {inst.name}: {e}")
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
    return await plugin.remove(cms)


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
