"""Instance Operations — Enterprise migration, cloning, and advanced backup.

Async engine that integrates with crx-cloud's plugin architecture,
SQLAlchemy models, and VMDriver SSH layer.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Optional

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.backup import Backup
from api.models.clone import Clone
from api.models.instance import Instance
from api.models.migration import Migration
from api.models.server import Server
from core.dns_manager import generate_subdomain, create_subdomain, remove_subdomain, SITE_DOMAIN
from core.nginx_manager import NginxConfig, setup_nginx, remove_nginx
from core.orchestrator import get_plugin, _db_to_cms_instance
from core.server_manager import ServerInfo, ServerStatus
from core.vm_controller import VMDriver

_vm = VMDriver()


# ======================================================================
# HELPERS
# ======================================================================

def _server_info(server: Server) -> ServerInfo:
    """Convert DB Server to ServerInfo for VMDriver."""
    return ServerInfo(
        id=server.id, name=server.name, server_type="vm",
        provider=server.provider or "", status=ServerStatus.ONLINE,
        endpoint=server.endpoint,
        metadata={
            "ssh_user": server.ssh_user or "root",
            "ssh_key_path": server.ssh_key_path or "",
        },
    )


async def _ssh(server: Server, cmd: str, timeout: int = 300) -> str:
    """Execute SSH command on a server."""
    info = _server_info(server)
    return await _vm._ssh_exec(info, cmd, timeout=timeout)


async def _resolve_prefix(instance: Instance, server: Server) -> str:
    """Resolve the Docker prefix for an instance.

    First checks instance config, then discovers via `docker ps` if the
    expected container doesn't exist (handles config mismatch).
    """
    config = instance.config or {}
    prefix = config.get("prefix", f"crx-odoo-{instance.id[:8]}")

    # Verify the container actually exists
    try:
        check = await _ssh(server, f"docker inspect {prefix}-odoo --format='ok' 2>/dev/null || echo missing", timeout=15)
        if "ok" in check:
            return prefix
    except Exception:
        pass

    # Container not found — discover via docker ps
    logger.warning(f"Container {prefix}-odoo not found, discovering actual prefix...")
    try:
        # Look for any crx-odoo container on this server
        result = await _ssh(
            server,
            "docker ps --format '{{.Names}}' | grep -E 'crx-odoo.*-odoo$' | head -5",
            timeout=15,
        )
        containers = [line.strip() for line in result.strip().split("\n") if line.strip()]
        if containers:
            # Try to match by instance name or ID
            instance_name = config.get("name", instance.name or "")
            for c in containers:
                # Container name pattern: {prefix}-odoo → prefix = everything before -odoo
                discovered_prefix = c.rsplit("-odoo", 1)[0]
                # Check if this prefix's DB has our database
                db_name = config.get("db_name", instance_name)
                if db_name:
                    db_check = await _ssh(
                        server,
                        f"docker exec {discovered_prefix}-db psql -U odoo -d postgres -tAc "
                        f"\"SELECT 1 FROM pg_database WHERE datname='{db_name}'\" 2>/dev/null || echo ''",
                        timeout=15,
                    )
                    if "1" in db_check:
                        logger.info(f"Discovered prefix {discovered_prefix} for instance {instance.id} (db={db_name})")
                        return discovered_prefix

            # Fallback: if only one container, use that
            if len(containers) == 1:
                discovered = containers[0].rsplit("-odoo", 1)[0]
                logger.info(f"Single container found, using prefix: {discovered}")
                return discovered
    except Exception as e:
        logger.warning(f"Container discovery failed: {e}")

    # Return original prefix as last resort
    return prefix


# ======================================================================
# MIGRATION — Cold (instance stopped)
# ======================================================================

async def migrate_instance(
    migration: Migration,
    source_inst: Instance,
    source_server: Server,
    target_server: Server,
    db: AsyncSession,
) -> None:
    """
    Execute a COLD migration: stop source → dump → transfer → restore → verify.

    Updates Migration status through each step.
    Source instance is STOPPED during migration for data consistency.
    """
    start = time.time()
    steps = []
    mig_id = migration.id
    config = source_inst.config or {}
    source_db_name = config.get("db_name", source_inst.name)
    target_db_name = migration.target_database or source_db_name
    prefix = config.get("prefix", f"crx-odoo-{source_inst.id[:8]}")
    deploy_dir = config.get("deploy_dir", f"/opt/crx-cloud/instances/{prefix}")
    pg_container = f"{prefix}-db"

    try:
        # Step 1: Pre-flight
        migration.status = "preflight"
        await db.commit()
        logger.info(f"Migration {mig_id}: pre-flight checks")

        # Check SSH on both servers
        for label, srv in [("source", source_server), ("target", target_server)]:
            try:
                await _ssh(srv, "echo OK", timeout=15)
                steps.append({"step": f"ssh_{label}", "ok": True})
            except Exception as e:
                steps.append({"step": f"ssh_{label}", "ok": False, "error": str(e)})
                raise RuntimeError(f"SSH to {label} server failed: {e}")

        # Verify source database exists
        try:
            db_check = await _ssh(
                source_server,
                f"docker exec {pg_container} psql -U odoo -d postgres -tAc "
                f"\"SELECT 1 FROM pg_database WHERE datname='{source_db_name}';\"",
                timeout=15,
            )
            if "1" not in db_check:
                steps.append({"step": "db_exists_check", "ok": False, "error": f"Database '{source_db_name}' not found"})
                raise RuntimeError(f"Source database '{source_db_name}' does not exist on server {source_server.name}")
            steps.append({"step": "db_exists_check", "ok": True})
        except RuntimeError:
            raise
        except Exception as e:
            steps.append({"step": "db_exists_check", "ok": False, "error": str(e)})
            raise RuntimeError(f"Cannot verify source database: {e}")

        # Get DB size
        try:
            size_out = await _ssh(
                source_server,
                f"docker exec {pg_container} psql -U odoo -d {source_db_name} -t -c "
                f"\"SELECT pg_database_size('{source_db_name}');\"",
                timeout=30,
            )
            db_size_bytes = int(size_out.strip())
            migration.source_db_size_mb = db_size_bytes // (1024 * 1024)
        except Exception:
            migration.source_db_size_mb = 0

        await db.commit()

        # Step 2: Pre-migration backup
        migration.status = "backing_up"
        await db.commit()
        logger.info(f"Migration {mig_id}: creating pre-migration backup")

        plugin = get_plugin(source_inst.cms_type)
        if plugin:
            cms = _db_to_cms_instance(source_inst, source_server)
            try:
                backup_path = await plugin.backup(cms)
                migration.pre_migration_backup_id = str(backup_path)[:500] if backup_path else None
                steps.append({"step": "pre_backup", "ok": True, "path": str(backup_path)})
            except Exception as e:
                steps.append({"step": "pre_backup", "ok": False, "error": str(e)})
                logger.warning(f"Pre-migration backup failed (continuing): {e}")

        try:
            await db.commit()
        except Exception as e:
            logger.warning(f"Migration {mig_id}: commit after backup step failed, rolling back: {e}")
            await db.rollback()
            # Re-fetch migration to get clean session state
            result = await db.execute(select(Migration).where(Migration.id == mig_id))
            migration = result.scalar_one()
            migration.pre_migration_backup_id = None

        # Step 3: Stop source
        migration.status = "stopping"
        await db.commit()
        logger.info(f"Migration {mig_id}: stopping source instance")

        await _ssh(source_server, f"docker compose -f {deploy_dir}/docker-compose.yml stop || docker stop {prefix}-odoo 2>/dev/null || true")
        source_inst.status = "stopped"
        await db.commit()
        await asyncio.sleep(3)
        steps.append({"step": "stop_source", "ok": True})

        # Step 4: Dump database
        migration.status = "dumping"
        await db.commit()
        remote_dir = f"/tmp/crx_migration_{mig_id[:8]}"
        await _ssh(source_server, f"mkdir -p {remote_dir}")

        logger.info(f"Migration {mig_id}: dumping database {source_db_name}")
        dump_cmd = (
            f"docker exec {pg_container} pg_dump -U odoo -d {source_db_name} "
            f"--format=custom --compress=9 > {remote_dir}/database.dump"
        )
        await _ssh(source_server, dump_cmd, timeout=3600)
        steps.append({"step": "dump_database", "ok": True})

        # Step 5: Archive filestore
        if migration.include_filestore:
            logger.info(f"Migration {mig_id}: archiving filestore")
            fs_cmd = (
                f"docker exec {prefix}-odoo tar -czf /tmp/filestore.tar.gz "
                f"-C /var/lib/odoo/filestore {source_db_name} 2>/dev/null && "
                f"docker cp {prefix}-odoo:/tmp/filestore.tar.gz {remote_dir}/filestore.tar.gz || true"
            )
            await _ssh(source_server, fs_cmd, timeout=3600)
            steps.append({"step": "archive_filestore", "ok": True})

        # Step 6: Transfer to target
        migration.status = "transferring"
        await db.commit()
        logger.info(f"Migration {mig_id}: transferring to target server")

        target_dir = f"/tmp/crx_migration_{mig_id[:8]}"
        target_host = target_server.endpoint
        target_user = target_server.ssh_user or "root"

        await _ssh(
            source_server,
            f"scp -o StrictHostKeyChecking=no -r {remote_dir}/* {target_user}@{target_host}:{target_dir}/",
            timeout=7200,
        )
        steps.append({"step": "transfer", "ok": True})

        # Step 7: Restore on target
        migration.status = "restoring"
        await db.commit()
        logger.info(f"Migration {mig_id}: restoring on target server")

        # We need an Odoo instance on target — deploy a fresh one, then replace its DB
        # For now, assume target already has PostgreSQL running
        # The target_instance will be created by the API route before calling this

        # Create DB on target
        target_prefix = f"crx-odoo-{target_server.id[:8]}"
        target_pg = f"{target_prefix}-db"

        # If target has docker postgres
        await _ssh(
            target_server,
            f"docker exec {target_pg} dropdb -U odoo --if-exists {target_db_name} 2>/dev/null; "
            f"docker exec {target_pg} createdb -U odoo {target_db_name}; "
            f"cat {target_dir}/database.dump | docker exec -i {target_pg} pg_restore -U odoo -d {target_db_name} --no-owner --no-privileges || true",
            timeout=7200,
        )
        steps.append({"step": "restore_database", "ok": True})

        # Restore filestore
        if migration.include_filestore:
            await _ssh(
                target_server,
                f"test -f {target_dir}/filestore.tar.gz && "
                f"docker exec {target_prefix}-odoo mkdir -p /var/lib/odoo/filestore && "
                f"docker cp {target_dir}/filestore.tar.gz {target_prefix}-odoo:/tmp/ && "
                f"docker exec {target_prefix}-odoo tar -xzf /tmp/filestore.tar.gz -C /var/lib/odoo/filestore || true",
                timeout=3600,
            )
            steps.append({"step": "restore_filestore", "ok": True})

        # Step 8: Verify
        migration.status = "verifying"
        await db.commit()
        logger.info(f"Migration {mig_id}: verifying target")

        await asyncio.sleep(10)
        try:
            health = await _ssh(
                target_server,
                f"curl -sf -o /dev/null -w '%{{http_code}}' http://localhost:8069/web/health --connect-timeout 15 || echo 000",
                timeout=30,
            )
            steps.append({"step": "health_check", "ok": "200" in health, "code": health.strip()})
        except Exception as e:
            steps.append({"step": "health_check", "ok": False, "error": str(e)})

        # Cleanup
        await _ssh(source_server, f"rm -rf {remote_dir}", timeout=30)
        await _ssh(target_server, f"rm -rf {target_dir}", timeout=30)

        # Done
        migration.status = "completed"
        migration.duration_seconds = int(time.time() - start)
        migration.steps_log = steps
        migration.completed_at = datetime.now(timezone.utc)
        await db.commit()

        logger.info(f"Migration {mig_id} completed in {migration.duration_seconds}s")

    except Exception as e:
        logger.error(f"Migration {mig_id} failed: {e}")
        migration.status = "failed"
        migration.error_message = str(e)[:2000]
        migration.duration_seconds = int(time.time() - start)
        migration.steps_log = steps
        await db.commit()

        # Try to restart source
        try:
            await _ssh(source_server, f"docker compose -f {deploy_dir}/docker-compose.yml up -d || docker start {prefix}-odoo 2>/dev/null || true")
            source_inst.status = "running"
            await db.commit()
        except Exception:
            pass


# ======================================================================
# MIGRATION ESTIMATION
# ======================================================================

async def estimate_migration(
    source_inst: Instance,
    source_server: Server,
    target_server: Server,
) -> dict:
    """Estimate migration duration and requirements."""
    prefix = (source_inst.config or {}).get("prefix", f"crx-odoo-{source_inst.id[:8]}")
    pg_container = f"{prefix}-db"
    db_name = (source_inst.config or {}).get("db_name", source_inst.name)

    db_size = 0
    fs_size = 0

    try:
        size_out = await _ssh(
            source_server,
            f"docker exec {pg_container} psql -U odoo -d {db_name} -t -c \"SELECT pg_database_size('{db_name}');\"",
            timeout=30,
        )
        db_size = int(size_out.strip())
    except Exception:
        pass

    try:
        fs_out = await _ssh(
            source_server,
            f"docker exec {prefix}-odoo du -sb /var/lib/odoo/filestore/{db_name} 2>/dev/null | cut -f1 || echo 0",
            timeout=60,
        )
        fs_size = int(fs_out.strip() or "0")
    except Exception:
        pass

    total = db_size + fs_size
    dump_time = max(60, db_size / (10 * 1024 * 1024))
    transfer_time = max(30, total / (5 * 1024 * 1024))
    restore_time = max(60, db_size / (8 * 1024 * 1024))
    total_time = dump_time + transfer_time + restore_time + 120

    # Target available space
    target_avail = 0
    try:
        avail_out = await _ssh(target_server, "df --output=avail / | tail -1 | tr -d ' '", timeout=10)
        target_avail = int(avail_out.strip()) * 1024
    except Exception:
        pass

    space_needed = total * 2.5

    def _human(size: int) -> str:
        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024:
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"

    return {
        "database_size": _human(db_size),
        "filestore_size": _human(fs_size),
        "total_size": _human(total),
        "estimated_minutes": round(total_time / 60, 1),
        "space_needed": _human(int(space_needed)),
        "space_available": _human(target_avail) if target_avail else "unknown",
        "space_sufficient": target_avail >= space_needed if target_avail else None,
    }


# ======================================================================
# CLONING — With Neutralization
# ======================================================================

# Odoo official neutralization SQL
NEUTRALIZE_SQL = """
-- CRX Odoo Neutralization — disable all external integrations
INSERT INTO ir_config_parameter (key, value, create_uid, create_date, write_uid, write_date)
VALUES ('database.is_neutralized', 'True', 1, NOW(), 1, NOW())
ON CONFLICT (key) DO UPDATE SET value = 'True', write_date = NOW();

UPDATE ir_cron SET active = false
WHERE id NOT IN (
    SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'autovacuum_job'
);

UPDATE ir_mail_server SET active = false;

INSERT INTO ir_mail_server (name, smtp_host, smtp_port, smtp_encryption, active, sequence, create_uid, create_date, write_uid, write_date)
VALUES ('CRX Mail Catcher (Neutralized)', 'localhost', 1025, 'none', true, 0, 1, NOW(), 1, NOW())
ON CONFLICT DO NOTHING;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_provider') THEN
        EXECUTE 'UPDATE payment_provider SET state = ''disabled'' WHERE state != ''disabled''';
    END IF;
END $$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'delivery_carrier') THEN
        EXECUTE 'UPDATE delivery_carrier SET active = false WHERE active = true';
    END IF;
END $$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'iap_account') THEN
        EXECUTE 'UPDATE iap_account SET account_token = ''NEUTRALIZED_'' || account_token WHERE account_token NOT LIKE ''NEUTRALIZED_%''';
    END IF;
END $$;

UPDATE ir_config_parameter SET value = '{base_url}' WHERE key = 'web.base.url';

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'fetchmail_server') THEN
        EXECUTE 'UPDATE fetchmail_server SET active = false';
    END IF;
END $$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'base_automation') THEN
        EXECUTE 'UPDATE base_automation SET active = false WHERE trigger = ''on_webhook''';
    END IF;
END $$;

INSERT INTO ir_config_parameter (key, value, create_uid, create_date, write_uid, write_date)
VALUES ('database.neutralized_date', NOW()::text, 1, NOW(), 1, NOW())
ON CONFLICT (key) DO UPDATE SET value = NOW()::text, write_date = NOW();
"""


async def clone_instance(
    clone: Clone,
    source_inst: Instance,
    server: Server,
    db: AsyncSession,
) -> None:
    """
    Clone an Odoo instance on the same server.

    Uses PostgreSQL template cloning (fastest method) + filestore copy.
    Applies neutralization if requested.
    Clone is created STOPPED (token safety).
    """
    start = time.time()
    prefix = await _resolve_prefix(source_inst, server)
    pg_container = f"{prefix}-db"
    source_db = (source_inst.config or {}).get("db_name", source_inst.name)
    clone_db = clone.clone_database or f"{source_db}_{clone.clone_type[:4]}_{datetime.now().strftime('%Y%m%d')}"
    clone.clone_database = clone_db

    try:
        clone.status = "cloning"
        await db.commit()
        logger.info(f"Clone {clone.id}: cloning {source_db} → {clone_db}")

        # Terminate connections and create clone via template
        await _ssh(
            server,
            f"docker exec {pg_container} psql -U odoo -d postgres -c "
            f"\"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{source_db}' AND pid<>pg_backend_pid();\" && "
            f"docker exec {pg_container} dropdb -U odoo --if-exists {clone_db} && "
            f"docker exec {pg_container} createdb -U odoo --template={source_db} {clone_db}",
            timeout=3600,
        )
        logger.info(f"Clone {clone.id}: database cloned via template")

        # Copy filestore
        await _ssh(
            server,
            f"docker exec {prefix}-odoo cp -a /var/lib/odoo/filestore/{source_db} /var/lib/odoo/filestore/{clone_db} 2>/dev/null || true",
            timeout=3600,
        )
        logger.info(f"Clone {clone.id}: filestore copied")

        # Neutralize
        if clone.neutralized:
            clone.status = "neutralizing"
            await db.commit()
            logger.info(f"Clone {clone.id}: neutralizing {clone_db}")

            # Pre-compute the subdomain URL for web.base.url neutralization
            subdomain = _clone_subdomain(source_inst, clone)
            base_url = clone.base_url or f"https://{subdomain}.{SITE_DOMAIN}"
            clone.base_url = base_url
            sql = NEUTRALIZE_SQL.format(base_url=base_url)

            # Write SQL to temp file and execute
            await _ssh(
                server,
                f"cat << 'NEUTRALIZE_EOF' > /tmp/neutralize_{clone_db}.sql\n{sql}\nNEUTRALIZE_EOF",
            )
            await _ssh(
                server,
                f"docker cp /tmp/neutralize_{clone_db}.sql {pg_container}:/tmp/neutralize.sql && "
                f"docker exec {pg_container} psql -U odoo -d {clone_db} -f /tmp/neutralize.sql && "
                f"rm -f /tmp/neutralize_{clone_db}.sql",
                timeout=120,
            )

            clone.neutralization_log = {
                "actions": [
                    "crons_disabled", "mail_servers_disabled", "mail_catcher_installed",
                    "payment_providers_disabled", "delivery_carriers_disabled",
                    "iap_tokens_neutralized", "fetchmail_disabled", "webhooks_disabled",
                    f"base_url_set:{base_url}", "neutralization_flag_set",
                ],
            }
            logger.info(f"Clone {clone.id}: neutralization complete")

        # Done — clone is STOPPED by default (token safety)
        clone.status = "ready"
        clone.is_active = False
        clone.duration_seconds = int(time.time() - start)
        await db.commit()

        logger.info(f"Clone {clone.id} created: {source_db} → {clone_db} in {clone.duration_seconds}s")

    except Exception as e:
        logger.error(f"Clone {clone.id} failed: {e}")
        clone.status = "failed"
        clone.error_message = str(e)[:2000]
        clone.duration_seconds = int(time.time() - start)
        await db.commit()


def _clone_subdomain(source_inst: Instance, clone: Clone) -> str:
    """Generate a subdomain for a clone based on the source instance.

    Pattern: {instance-slug}-{clone_type}.site.crx.team
    e.g. my-shop-staging.site.crx.team, my-shop-dev.site.crx.team
    """
    type_suffix = {
        "staging": "staging",
        "development": "dev",
        "testing": "test",
        "disaster_recovery": "dr",
    }.get(clone.clone_type, clone.clone_type[:4])

    base_name = source_inst.domain.split(".")[0] if source_inst.domain else source_inst.name
    raw = f"{base_name}-{type_suffix}"

    try:
        return generate_subdomain(raw)
    except ValueError:
        # Fallback: use clone ID fragment
        return f"clone-{clone.id[:8]}-{type_suffix}"


async def _setup_clone_domain(
    clone: Clone,
    source_inst: Instance,
    server: Server,
    clone_port: int,
) -> str:
    """Provision subdomain + DNS + Nginx + SSL for a clone.

    Returns the HTTPS URL (or HTTP fallback) for the clone.
    Non-blocking: DNS/Nginx failures fall back to IP:port.
    """
    subdomain = _clone_subdomain(source_inst, clone)
    fqdn = f"{subdomain}.{SITE_DOMAIN}"
    endpoint = server.endpoint or ""
    server_ip = endpoint.replace("http://", "").replace("https://", "").split(":")[0]
    fallback_url = f"http://{server_ip}:{clone_port}"

    try:
        # 1. Create Cloudflare DNS A record
        await create_subdomain(subdomain, server_ip)
        logger.info(f"Clone {clone.id}: DNS record created → {fqdn} → {server_ip}")

        # 2. Setup Nginx reverse proxy + SSL
        nginx_conf = NginxConfig(
            domain=fqdn,
            upstream_port=clone_port,
            instance_name=f"clone-{clone.id[:8]}",
            ssl=True,
            http_redirect=True,
        )
        ssh_user = server.ssh_user or "root"
        ssh_key = server.ssh_key_path or ""

        ok = await setup_nginx(server_ip, ssh_user, ssh_key, nginx_conf)
        if ok:
            logger.info(f"Clone {clone.id}: Nginx + SSL configured for {fqdn}")
            return f"https://{fqdn}"
        else:
            logger.warning(f"Clone {clone.id}: Nginx setup failed, falling back to IP:port")
            return fallback_url

    except Exception as e:
        logger.warning(f"Clone {clone.id}: domain setup failed ({e}), falling back to IP:port")
        return fallback_url


async def _teardown_clone_domain(
    clone: Clone,
    source_inst: Instance,
    server: Server,
) -> None:
    """Remove DNS record + Nginx config for a clone. Non-blocking."""
    subdomain = _clone_subdomain(source_inst, clone)
    endpoint = server.endpoint or ""
    server_ip = endpoint.replace("http://", "").replace("https://", "").split(":")[0]
    ssh_user = server.ssh_user or "root"
    ssh_key = server.ssh_key_path or ""

    try:
        await remove_nginx(server_ip, ssh_user, ssh_key, f"clone-{clone.id[:8]}")
        logger.info(f"Clone {clone.id}: Nginx config removed")
    except Exception as e:
        logger.warning(f"Clone {clone.id}: failed to remove Nginx config: {e}")

    try:
        await remove_subdomain(subdomain)
        logger.info(f"Clone {clone.id}: DNS record removed for {subdomain}.{SITE_DOMAIN}")
    except Exception as e:
        logger.warning(f"Clone {clone.id}: failed to remove DNS record: {e}")


async def start_clone_container(
    clone: Clone,
    source_inst: Instance,
    server: Server,
) -> str:
    """
    Start a dedicated Odoo container for the clone.
    Uses the SAME DB container but points to the clone database.
    Provisions a subdomain with HTTPS (DNS + Nginx + Let's Encrypt).
    Returns the URL where the clone is accessible.
    """
    config = source_inst.config or {}
    prefix = await _resolve_prefix(source_inst, server)
    source_port = config.get("port", 8069)
    version = config.get("version", "19.0")
    db_password = config.get("db_password", "odoo")
    clone_db = clone.clone_database
    clone_container = f"{prefix}-clone-{clone.id[:6]}"

    # Use port = source_port + 100 (simple offset)
    # e.g. source=8069 → clone=8169
    clone_port = source_port + 100

    try:
        # Remove any existing container with same name
        await _ssh(server, f"docker rm -f {clone_container} 2>/dev/null || true")

        # Get the Docker network from the source odoo container
        network_cmd = f"docker inspect {prefix}-odoo --format '{{{{range $key, $val := .NetworkSettings.Networks}}}}{{{{$key}}}}{{{{end}}}}' 2>/dev/null | head -1"
        network_result = await _ssh(server, network_cmd, timeout=30)
        network = network_result.strip() if network_result.strip() else f"{prefix}_default"

        run_cmd = (
            f"docker run -d "
            f"--name {clone_container} "
            f"--restart unless-stopped "
            f"--network {network} "
            f"-p {clone_port}:8069 "
            f"-e HOST={prefix}-db "
            f"-e PORT=5432 "
            f"-e USER=odoo "
            f"-e PASSWORD={db_password} "
            f"-v {prefix}-data:/var/lib/odoo "
            f"--memory {config.get('ram_mb', 1024)}m "
            f"odoo:{version} "
            f"-- --db_host={prefix}-db --db_port=5432 --db_user=odoo --db_password={db_password} "
            f"--database={clone_db} --dbfilter=^{clone_db}$ --proxy-mode --workers=1"
        )

        await _ssh(server, run_cmd, timeout=120)
        logger.info(f"Clone container {clone_container} started on port {clone_port}")

        # Provision subdomain + Nginx + SSL (falls back to IP:port if DNS/Nginx fail)
        base_url = await _setup_clone_domain(clone, source_inst, server, clone_port)

        return base_url
    except Exception as e:
        logger.error(f"Failed to start clone container: {e}")
        raise


async def stop_clone_container(
    clone: Clone,
    source_inst: Instance,
    server: Server,
) -> None:
    """Stop and remove the clone's dedicated Odoo container + teardown domain."""
    config = source_inst.config or {}
    prefix = config.get("prefix", f"crx-odoo-{source_inst.id[:8]}")
    clone_container = f"{prefix}-clone-{clone.id[:6]}"

    try:
        await _ssh(server, f"docker stop {clone_container} && docker rm {clone_container}", timeout=60)
        logger.info(f"Clone container {clone_container} stopped and removed")
    except Exception as e:
        logger.warning(f"Failed to stop clone container {clone_container}: {e}")
        await _ssh(server, f"docker rm -f {clone_container} 2>/dev/null || true", timeout=30)

    # Teardown DNS + Nginx (non-blocking)
    await _teardown_clone_domain(clone, source_inst, server)


async def destroy_clone(
    clone: Clone,
    server: Server,
    source_inst: Instance | None = None,
) -> bool:
    """Destroy a clone — drop database, remove filestore, stop clone container."""
    clone_db = clone.clone_database

    if not clone_db:
        return True  # Nothing to destroy

    # Resolve prefix: use source instance if available, fallback to discovery
    if source_inst:
        prefix = await _resolve_prefix(source_inst, server)
    else:
        prefix = f"crx-odoo-{clone.source_instance_id[:8]}"

    pg_container = f"{prefix}-db"
    clone_container = f"{prefix}-clone-{clone.id[:6]}"

    try:
        # Stop clone container if running
        await _ssh(server, f"docker rm -f {clone_container} 2>/dev/null || true", timeout=30)
        # Drop database and filestore
        await _ssh(
            server,
            f"docker exec {pg_container} psql -U odoo -d postgres -c "
            f"\"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{clone_db}' AND pid<>pg_backend_pid();\" 2>/dev/null; "
            f"docker exec {pg_container} dropdb -U odoo --if-exists {clone_db}; "
            f"docker exec {prefix}-odoo rm -rf /var/lib/odoo/filestore/{clone_db} 2>/dev/null || true",
            timeout=120,
        )
        # Teardown DNS + Nginx if source instance available
        if source_inst:
            await _teardown_clone_domain(clone, source_inst, server)

        logger.info(f"Clone {clone.id} destroyed: {clone_db}")
        return True
    except Exception as e:
        logger.error(f"Failed to destroy clone {clone.id}: {e}")
        return False


# ======================================================================
# BACKUP SCHEDULING
# ======================================================================

async def execute_scheduled_backup(
    schedule_id: str,
    db: AsyncSession,
) -> Optional[str]:
    """Execute a scheduled backup. Returns backup ID or None on failure."""
    from api.models.backup_schedule import BackupSchedule

    result = await db.execute(select(BackupSchedule).where(BackupSchedule.id == schedule_id))
    schedule = result.scalar_one_or_none()
    if not schedule or not schedule.enabled:
        return None

    inst_result = await db.execute(select(Instance).where(Instance.id == schedule.instance_id))
    inst = inst_result.scalar_one_or_none()
    if not inst:
        return None

    srv_result = await db.execute(select(Server).where(Server.id == inst.server_id))
    server = srv_result.scalar_one_or_none()
    if not server:
        return None

    # Create backup record
    backup = Backup(
        instance_id=inst.id,
        server_id=server.id,
        backup_type="scheduled",
        backup_format=schedule.backup_format or "zip",
        include_filestore=schedule.include_filestore,
        schedule_id=schedule.id,
        status="pending",
    )
    db.add(backup)
    await db.commit()
    await db.refresh(backup)

    # Execute via plugin
    from core.orchestrator import backup_instance
    await backup_instance(inst, server, backup, db)

    # Update schedule stats
    schedule.last_run_at = datetime.now(timezone.utc)
    schedule.last_status = backup.status
    schedule.last_size_mb = backup.size_mb
    schedule.total_runs += 1

    if backup.status == "completed":
        schedule.consecutive_failures = 0
    else:
        schedule.consecutive_failures += 1

    await db.commit()

    # Apply retention policy
    await _apply_retention(inst.id, schedule, db)

    return backup.id


async def _apply_retention(instance_id: str, schedule, db: AsyncSession):
    """Delete old backups beyond retention limits."""
    from api.models.backup_schedule import BackupSchedule

    result = await db.execute(
        select(Backup)
        .where(Backup.instance_id == instance_id, Backup.status == "completed")
        .order_by(Backup.created_at.desc())
    )
    backups = list(result.scalars().all())

    # Keep at least keep_daily + keep_weekly + keep_monthly backups
    max_keep = schedule.keep_daily + schedule.keep_weekly + schedule.keep_monthly
    if len(backups) <= max_keep:
        return

    # Simple strategy: keep the first max_keep, delete the rest
    to_delete = backups[max_keep:]
    for bkp in to_delete:
        # TODO: also delete from storage destination
        await db.delete(bkp)

    await db.commit()
    logger.info(f"Retention: deleted {len(to_delete)} old backups for instance {instance_id}")
