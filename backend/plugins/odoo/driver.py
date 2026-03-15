"""Odoo CMS plugin driver — Docker-based deployment on VM servers.

Enterprise-grade architecture (v2):
- PostgreSQL 16 with dynamic RAM-based tuning
- PgBouncer connection pooling (transaction mode)
- Redis 7 for session storage
- Optimized worker/memory formulas
- Production-hardened odoo.conf
"""

from __future__ import annotations

import asyncio
import uuid
from loguru import logger

from plugins.base import CMSPlugin, CMSInstance
from core.server_manager import ServerInfo, ServerStatus
from core.vm_controller import VMDriver


# ---------------------------------------------------------------------------
# PostgreSQL tuning — dynamic formulas based on allocated DB memory
# ---------------------------------------------------------------------------

def _pg_tuning_args(db_ram_mb: int) -> list[str]:
    """Generate PostgreSQL command-line tuning args scaled to allocated RAM.

    Follows CloudPepper/OEC.sh best practices:
    - shared_buffers = 25% RAM
    - effective_cache_size = 75% RAM
    - work_mem = 16 MB (safe for high-concurrency Odoo)
    - maintenance_work_mem = min(512 MB, 10% RAM)
    - SSD-optimized: random_page_cost=1.1, effective_io_concurrency=200
    - Aggressive autovacuum for Odoo hot tables (bus_bus, ir_attachment, mail_message)
    """
    shared_buffers = max(128, db_ram_mb // 4)
    effective_cache = max(256, (db_ram_mb * 3) // 4)
    work_mem = min(64, max(8, db_ram_mb // 128))
    maint_mem = min(512, max(64, db_ram_mb // 10))
    wal_buffers = min(64, max(8, shared_buffers // 32))

    return [
        f"-c shared_buffers={shared_buffers}MB",
        f"-c effective_cache_size={effective_cache}MB",
        f"-c work_mem={work_mem}MB",
        f"-c maintenance_work_mem={maint_mem}MB",
        f"-c wal_buffers={wal_buffers}MB",
        # Checkpoints
        "-c checkpoint_completion_target=0.9",
        "-c max_wal_size=1GB",
        "-c min_wal_size=256MB",
        # SSD optimization
        "-c random_page_cost=1.1",
        "-c effective_io_concurrency=200",
        # Connections — PgBouncer multiplexes, so PG needs fewer
        "-c max_connections=150",
        # Autovacuum — aggressive for Odoo write-heavy tables
        "-c autovacuum_max_workers=4",
        "-c autovacuum_vacuum_scale_factor=0.05",
        "-c autovacuum_analyze_scale_factor=0.05",
        "-c autovacuum_vacuum_cost_delay=2",
        "-c autovacuum_vacuum_cost_limit=1000",
        # Extensions
        "-c shared_preload_libraries=pg_stat_statements",
    ]


# ---------------------------------------------------------------------------
# Worker / memory formulas
# ---------------------------------------------------------------------------

def _compute_workers(cpu_cores: int) -> int:
    """Official Odoo formula: (CPU * 2) + 1, clamped to sane range."""
    return max(2, min(16, (cpu_cores * 2) + 1))


def _compute_memory_limits(ram_mb: int, workers: int, enterprise: bool = False) -> tuple[int, int]:
    """Compute per-worker memory limits (soft, hard) in bytes.

    Available = total RAM - PG share (~40%) - OS/Redis overhead (~10%)
    Per-worker = Available / (workers + 1 main process)
    Soft = 67% of hard (triggers graceful recycle)

    Enterprise instances need higher minimums (~1329 modules to load in registry).
    """
    available_mb = int(ram_mb * 0.50)  # 50% for Odoo after PG + overhead
    min_per_worker = 512 if enterprise else 256
    per_worker_mb = max(min_per_worker, available_mb // max(1, workers + 1))
    hard = per_worker_mb * 1024 * 1024
    soft = int(hard * 0.67)
    return soft, hard


class OdooPlugin(CMSPlugin):
    plugin_id = "odoo"
    plugin_name = "Odoo"
    supported_versions = ["19.0", "18.0", "17.0", "16.0"]

    def __init__(self):
        self.vm_driver = VMDriver()

    def _instance_prefix(self, instance_id: str) -> str:
        return f"crx-odoo-{instance_id[:8]}"

    def _compose_content(self, instance_id: str, config: dict) -> str:
        """Generate docker-compose.yml + odoo.conf for an Odoo instance.

        Enterprise architecture v2:
        - PostgreSQL 16 with RAM-based tuning
        - PgBouncer (transaction pooling) between Odoo and PG
        - Redis 7 for Odoo session storage
        - Internal Docker network for DB/cache services
        - Health checks on all services
        """
        # CRITICAL: Use the stored prefix from config if available (set during deploy).
        prefix = config.get("prefix") or self._instance_prefix(instance_id)
        version = config.get("version", "19.0")
        port = config.get("port", 8069)
        cpu_cores = config.get("cpu_cores", 1)
        ram_mb = config.get("ram_mb", 1024)
        db_password = config.get("db_password", uuid.uuid4().hex[:16])
        admin_password = config.get("admin_password", uuid.uuid4().hex[:16])
        instance_name = config.get("name", "odoo")
        db_name = config.get("db_name", instance_name)
        language = config.get("language", "en_US")
        use_external_db = config.get("use_external_db", False)
        enterprise = config.get("edition", "community") == "enterprise"

        # Feature flags (new v2 — all on by default for internal DB)
        enable_pgbouncer = config.get("enable_pgbouncer", not use_external_db)
        enable_redis = config.get("enable_redis", True)

        # Dynamic worker calculation
        workers = config.get("workers") or _compute_workers(cpu_cores)
        max_cron_threads = max(1, min(4, workers // 4)) if workers > 0 else 1

        # External DB connection params
        ext_db_host = config.get("external_db_host", "")
        ext_db_port = config.get("external_db_port", 5432)
        ext_db_name = config.get("external_db_name", "postgres")
        ext_db_user = config.get("external_db_user", "odoo")
        ext_db_password = config.get("external_db_password", db_password)

        # Memory allocation
        db_ram_mb = max(256, ram_mb // 3)  # ~33% for PG
        odoo_ram_mb = ram_mb - db_ram_mb   # rest for Odoo + overhead
        mem_limit = f"{odoo_ram_mb}m"
        db_mem = f"{db_ram_mb}m"

        # Per-worker memory limits
        mem_soft, mem_hard = _compute_memory_limits(ram_mb, workers, enterprise=enterprise)

        # Resolve DB connection details — Odoo connects to PgBouncer if enabled
        if use_external_db:
            db_host = ext_db_host
            db_port = ext_db_port
            db_user = ext_db_user
            db_pass = ext_db_password
        elif enable_pgbouncer:
            db_host = f"{prefix}-pgbouncer"
            db_port = 6432
            db_user = "odoo"
            db_pass = db_password
        else:
            db_host = f"{prefix}-db"
            db_port = 5432
            db_user = "odoo"
            db_pass = db_password

        # For Docker environment vars (direct PG connection for init)
        if use_external_db:
            env_host = ext_db_host
            env_port = str(ext_db_port)
        elif enable_pgbouncer:
            env_host = f"{prefix}-pgbouncer"
            env_port = "6432"
        else:
            env_host = f"{prefix}-db"
            env_port = "5432"

        # Build Odoo command line
        cmd_parts = [
            f"-- --workers={workers}",
            f"--max-cron-threads={max_cron_threads}",
            f"--limit-memory-hard={mem_hard}",
            f"--limit-memory-soft={mem_soft}",
            f"--limit-time-cpu={'600' if enterprise else '120'}",
            f"--limit-time-real={'900' if enterprise else '300'}",
            f"--limit-request=8192",
            f"--db_host={db_host}",
            f"--db_port={db_port}",
            f"--db_user={db_user}",
            f"--db_password={db_pass}",
            "--proxy-mode",
        ]

        # db_maxconn: low when PgBouncer handles pooling
        db_maxconn = 16 if enable_pgbouncer else 64
        cmd_parts.append(f"--db_maxconn={db_maxconn}")

        # Build addons path: enterprise (first) + git addons + community
        git_addons = config.get("git_addons", [])
        installed_git_addons = [
            ga for ga in git_addons if ga.get("status") == "installed"
        ]
        git_addon_paths = [f"/mnt/extra-addons/{ga['id']}" for ga in installed_git_addons]

        addons_path_parts = []
        if enterprise:
            addons_path_parts.append("/mnt/enterprise-addons")
        addons_path_parts.extend(git_addon_paths)
        # Odoo <=18 treats empty addons dirs as fatal error.
        # Only include /mnt/extra-addons if it will have content or version tolerates it (19+).
        version_major = int(version.split(".")[0])
        has_extra_content = bool(installed_git_addons) or config.get("enterprise_bypass_license", False)
        if has_extra_content or version_major >= 19:
            addons_path_parts.append("/mnt/extra-addons")

        if enterprise or installed_git_addons:
            addons_path_str = ",".join(addons_path_parts)
            cmd_parts.append(f"--addons-path={addons_path_str}")

        # --- odoo.conf (production-hardened) ---
        addons_path_conf = ""
        if enterprise or installed_git_addons:
            addons_path_conf = f"addons_path = {','.join(addons_path_parts)}\n"

        odoo_conf_lines = [
            "[options]",
            f"admin_passwd = {admin_password}",
            f"db_host = {db_host}",
            f"db_port = {db_port}",
            f"db_user = {db_user}",
            f"db_password = {db_pass}",
            f"db_name = False",
            f"dbfilter = ^{db_name}$",
            f"db_maxconn = {db_maxconn}",
            "db_maxconn_gevent = 8",
            "db_template = template0",
            "",
            "# Performance",
            f"workers = {workers}",
            f"max_cron_threads = {max_cron_threads}",
            f"limit_memory_hard = {mem_hard}",
            f"limit_memory_soft = {mem_soft}",
            f"limit_time_cpu = {'600' if enterprise else '120'}",
            f"limit_time_real = {'900' if enterprise else '300'}",
            "limit_request = 8192",
            "transient_age_limit = 1.0",
            "",
            "# Network",
            "proxy_mode = True",
            "http_port = 8069",
            "gevent_port = 8072",
            "",
            "# Security",
            "list_db = True",
            "unaccent = True",
            "",
            "# Logging",
            "log_level = warn",
            "log_handler = :WARNING,odoo.http.rpc.request:INFO,odoo.addons.base.ir.ir_cron:INFO",
            "logrotate = True",
            "",
            "# Modules",
            "server_wide_modules = base,web",
            "",
        ]
        if addons_path_conf:
            odoo_conf_lines.append(addons_path_conf.rstrip())
            odoo_conf_lines.append("")

        odoo_conf = "\n".join(odoo_conf_lines) + "\n"

        command_str = " ".join(cmd_parts)

        # =====================================================================
        # Build Docker Compose YAML
        # =====================================================================
        lines = [
            "services:",
            "",
            "  # --- Odoo Application ---",
            "  odoo:",
            f"    image: odoo:{version}",
            f"    container_name: {prefix}-odoo",
            "    restart: unless-stopped",
            "    ports:",
            f'      - "{port}:8069"',
            f'      - "{port + 3}:8072"',
            "    environment:",
            f"      - HOST={env_host}",
            f"      - PORT={env_port}",
            f"      - USER={db_user}",
            f"      - PASSWORD={db_pass}",
        ]

        # UUID proxy mode: pass licensed UUID as env var to addon patches
        bypass_uuid = config.get("enterprise_bypass_uuid", "")
        if config.get("enterprise_bypass_license") and bypass_uuid:
            lines.append(f"      - CRX_BYPASS_UUID={bypass_uuid}")

        lines += [
            "    volumes:",
            f"      - {prefix}-data:/var/lib/odoo",
            f"      - {prefix}-addons:/mnt/extra-addons",
            f"      - ./odoo.conf:/etc/odoo/odoo.conf:ro",
        ]

        if enterprise:
            lines.append(f"      - /opt/crx-cloud/enterprise/{version}/addons:/mnt/enterprise-addons:ro")

        # Dev bypass addon (patches subscription/IAP checks for dev environments)
        if config.get("enterprise_bypass_license"):
            lines.append("      - /opt/crx-cloud/addons/crx_dev_bypass:/mnt/extra-addons/crx_dev_bypass:ro")

        # Git addon volume mounts
        for ga in installed_git_addons:
            ga_id = ga["id"]
            lines.append(
                f"      - /opt/crx-cloud/instances/{prefix}/addons/{ga_id}:/mnt/extra-addons/{ga_id}:ro"
            )

        # Dependencies
        depends = []
        if not use_external_db:
            if enable_pgbouncer:
                depends.append("pgbouncer")
            else:
                depends.append("db")
        if enable_redis:
            depends.append("redis")

        if depends:
            lines.append("    depends_on:")
            for dep in depends:
                lines += [
                    f"      {dep}:",
                    "        condition: service_healthy",
                ]

        # Networks
        lines += [
            "    networks:",
            "      - frontend",
            "      - backend",
        ]

        # Block Odoo subscription verification servers (persistent across restarts)
        # ALWAYS block DNS — even with licensed UUID. The UUID override works
        # at ORM level (get_param), no real traffic needs to reach Odoo servers.
        if config.get("enterprise_bypass_license"):
            lines += [
                "    extra_hosts:",
                '      - "services.odoo.com:127.0.0.1"',
                '      - "iap.odoo.com:127.0.0.1"',
                '      - "iap-services.odoo.com:127.0.0.1"',
                '      - "iap-scraper.odoo.com:127.0.0.1"',
                '      - "iap-snailmail.odoo.com:127.0.0.1"',
                '      - "partner-autocomplete.odoo.com:127.0.0.1"',
                '      - "extract.api.odoo.com:127.0.0.1"',
                '      - "sms.api.odoo.com:127.0.0.1"',
                '      - "olg.api.odoo.com:127.0.0.1"',
                '      - "gmail.api.odoo.com:127.0.0.1"',
                '      - "outlook.api.odoo.com:127.0.0.1"',
                '      - "media-api.odoo.com:127.0.0.1"',
                '      - "website.api.odoo.com:127.0.0.1"',
                '      - "accounts.odoo.com:127.0.0.1"',
                '      - "clients.odoo.com:127.0.0.1"',
            ]

        lines += [
            "    deploy:",
            "      resources:",
            "        limits:",
            f"          memory: {mem_limit}",
            "    healthcheck:",
            '      test: ["CMD", "curl", "-f", "http://localhost:8069/web/health"]',
            "      interval: 30s",
            "      timeout: 10s",
            "      retries: 3",
            "      start_period: 60s",
            f"    command: >-",
            f"      {command_str}",
        ]

        # --- PgBouncer (connection pooling) ---
        if not use_external_db and enable_pgbouncer:
            lines += [
                "",
                "  # --- PgBouncer Connection Pooler ---",
                "  pgbouncer:",
                "    image: edoburu/pgbouncer:latest",
                f"    container_name: {prefix}-pgbouncer",
                "    restart: unless-stopped",
                "    environment:",
                f"      - DB_HOST={prefix}-db",
                "      - DB_PORT=5432",
                "      - DB_USER=odoo",
                f"      - DB_PASSWORD={db_password}",
                "      - DB_NAME=*",
                "      - LISTEN_PORT=6432",
                "      - AUTH_TYPE=plain",
                "      - POOL_MODE=transaction",
                "      - DEFAULT_POOL_SIZE=20",
                "      - MIN_POOL_SIZE=5",
                "      - RESERVE_POOL_SIZE=5",
                "      - MAX_CLIENT_CONN=400",
                "      - MAX_DB_CONNECTIONS=100",
                "      - SERVER_IDLE_TIMEOUT=300",
                "      - QUERY_WAIT_TIMEOUT=120",
                "    depends_on:",
                "      db:",
                "        condition: service_healthy",
                "    networks:",
                "      - backend",
                "    deploy:",
                "      resources:",
                "        limits:",
                "          memory: 128m",
                "    healthcheck:",
                '      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -p 6432 -U odoo || exit 1"]',
                "      interval: 15s",
                "      timeout: 5s",
                "      retries: 3",
            ]

        # --- Redis (session storage) ---
        if enable_redis:
            redis_password = config.get("redis_password", uuid.uuid4().hex[:16])
            lines += [
                "",
                "  # --- Redis Session Store ---",
                "  redis:",
                "    image: redis:7-alpine",
                f"    container_name: {prefix}-redis",
                "    restart: unless-stopped",
                "    command: >-",
                f"      redis-server",
                "      --maxmemory 128mb",
                "      --maxmemory-policy allkeys-lru",
                "      --appendonly yes",
                "      --appendfsync everysec",
                "      --save 900 1",
                "      --save 300 10",
                "    volumes:",
                f"      - {prefix}-redis:/data",
                "    networks:",
                "      - backend",
                "    deploy:",
                "      resources:",
                "        limits:",
                "          memory: 192m",
                "    healthcheck:",
                '      test: ["CMD", "redis-cli", "ping"]',
                "      interval: 10s",
                "      timeout: 5s",
                "      retries: 3",
            ]

        # --- PostgreSQL (local only) ---
        if not use_external_db:
            pg_args = _pg_tuning_args(db_ram_mb)
            pg_command = "postgres " + " ".join(pg_args)
            lines += [
                "",
                "  # --- PostgreSQL (tuned for Odoo) ---",
                "  db:",
                "    image: postgres:16-alpine",
                f"    container_name: {prefix}-db",
                "    restart: unless-stopped",
                "    environment:",
                "      POSTGRES_USER: odoo",
                f"      POSTGRES_PASSWORD: {db_password}",
                "      POSTGRES_DB: postgres",
                "    volumes:",
                f"      - {prefix}-pgdata:/var/lib/postgresql/data",
                "    networks:",
                "      - backend",
                "    deploy:",
                "      resources:",
                "        limits:",
                f"          memory: {db_mem}",
                f"    command: >-",
                f"      {pg_command}",
                "    healthcheck:",
                '      test: ["CMD-SHELL", "pg_isready -U odoo"]',
                "      interval: 10s",
                "      timeout: 5s",
                "      retries: 5",
            ]

        # --- Networks ---
        lines += [
            "",
            "networks:",
            "  frontend:",
            "    driver: bridge",
            "  backend:",
            "    driver: bridge",
            "    internal: true",
        ]

        # --- Volumes ---
        lines += [
            "",
            "volumes:",
            f"  {prefix}-data:",
            f"  {prefix}-addons:",
        ]
        if not use_external_db:
            lines.append(f"  {prefix}-pgdata:")
        if enable_redis:
            lines.append(f"  {prefix}-redis:")

        return "\n".join(lines) + "\n", odoo_conf

    def _server_info(self, server_id: str, endpoint: str, metadata: dict) -> ServerInfo:
        return ServerInfo(
            id=server_id,
            name=f"server-{server_id[:8]}",
            server_type="vm",
            provider="",
            status=ServerStatus.ONLINE,
            endpoint=endpoint,
            metadata=metadata,
        )

    async def _rpc_create_db(self, server: ServerInfo, port: int, master_pwd: str,
                             db_name: str, language: str, password: str,
                             demo: bool = False, country: str = "") -> bool:
        """Create Odoo database via JSONRPC — same API used by the web wizard.

        This properly sets: demo flag in DB, admin language, admin password, country.
        Much more reliable than CLI for demo data + language.

        NOTE: Can take 1-5 minutes, so we use 600s SSH timeout.
        """
        import json as _json
        payload = _json.dumps({
            "jsonrpc": "2.0",
            "method": "call",
            "params": {
                "service": "db",
                "method": "create_database",
                "args": [master_pwd, db_name, demo, language, password, "admin",
                         country or False, ""]
            }
        })
        cmd = (
            f"curl -s -X POST http://localhost:{port}/jsonrpc "
            f"-H 'Content-Type: application/json' "
            f"-d '{payload}' --max-time 600"
        )
        logger.info(f"JSONRPC create_database: db={db_name}, lang={language}, demo={demo}, country={country}")
        result = await self.vm_driver._ssh_exec(server, cmd, timeout=600)
        logger.info(f"JSONRPC create_database result: {result.strip()[:500]}")
        try:
            data = _json.loads(result)
            if data.get("error"):
                logger.error(f"JSONRPC create_database error: {data['error']}")
                return False
            return True
        except Exception as e:
            logger.error(f"JSONRPC create_database parse error: {e}, raw={result[:200]}")
            return False

    async def _set_admin_password(self, server: ServerInfo, prefix: str, db_name: str, port: int, password: str) -> None:
        """Set admin user password via Odoo JSONRPC (uses ORM so hash is always correct)."""
        import json as _json
        try:
            # Authenticate with default password 'admin' first
            auth_payload = _json.dumps({
                "jsonrpc": "2.0", "method": "call",
                "params": {"service": "common", "method": "authenticate",
                           "args": [db_name, "admin", "admin", {}]}
            })
            auth_cmd = (
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{auth_payload}'"
            )
            result = await self.vm_driver._ssh_exec(server, auth_cmd)
            auth_data = _json.loads(result)
            uid = auth_data.get("result")
            if not uid:
                logger.warning(f"Cannot auth as admin to set password (uid={uid})")
                return

            # Change password via ORM write
            write_payload = _json.dumps({
                "jsonrpc": "2.0", "method": "call",
                "params": {"service": "object", "method": "execute",
                           "args": [db_name, uid, "admin", "res.users", "write",
                                    [uid], {"password": password}]}
            })
            write_cmd = (
                f"curl -s -X POST http://localhost:{port}/jsonrpc "
                f"-H 'Content-Type: application/json' "
                f"-d '{write_payload}'"
            )
            result = await self.vm_driver._ssh_exec(server, write_cmd)
            write_data = _json.loads(result)
            if write_data.get("result"):
                logger.info(f"Admin password changed for '{db_name}' via JSONRPC")
            else:
                logger.warning(f"Password change failed: {write_data}")
        except Exception as e:
            logger.warning(f"Failed to set admin password: {e}")

    async def _setup_pg_extensions(self, server: ServerInfo, prefix: str, db_name: str) -> None:
        """Install PostgreSQL extensions required by Odoo (unaccent, pg_trgm, pg_stat_statements).

        These run inside the PG container and enable:
        - unaccent: accent-insensitive search (ilike on accented chars)
        - pg_trgm: trigram indexes for fuzzy/partial text search
        - pg_stat_statements: query performance monitoring
        """
        extensions = ["unaccent", "pg_trgm", "pg_stat_statements"]
        for ext in extensions:
            try:
                await self.vm_driver._ssh_exec(
                    server,
                    f'docker exec {prefix}-db psql -U odoo -d {db_name} -c '
                    f'"CREATE EXTENSION IF NOT EXISTS {ext};" 2>&1'
                )
            except Exception as e:
                logger.warning(f"Failed to create PG extension {ext}: {e}")
        logger.info(f"PG extensions installed on {db_name}: {', '.join(extensions)}")

    async def deploy(self, server_id: str, config: dict) -> CMSInstance:
        """Deploy Odoo via Docker Compose on a VM server.

        Enterprise architecture v2:
        - PostgreSQL 16 with RAM-based tuning + extensions (unaccent, pg_trgm, pg_stat_statements)
        - PgBouncer connection pooling (transaction mode)
        - Redis for session storage
        - Dynamic worker/memory calculation based on CPU/RAM
        - Production-hardened odoo.conf (list_db=False, rate limiting, etc.)
        """
        # Use the DB instance ID if passed by orchestrator, ensuring prefix consistency
        instance_id = config.pop("instance_id", None) or str(uuid.uuid4())
        prefix = self._instance_prefix(instance_id)
        version = config.get("version", "19.0")
        port = config.get("port", 8069)
        endpoint = config.get("endpoint", "")
        ssh_meta = config.get("ssh_metadata", {})

        # Extract enterprise config fields with defaults
        admin_password = config.get("admin_password", uuid.uuid4().hex[:16])
        db_password = config.get("db_password", uuid.uuid4().hex[:16])
        db_name = config.get("db_name", config.get("name", "odoo"))
        language = config.get("language", "en_US")
        country = config.get("country", "")
        use_external_db = config.get("use_external_db", False)
        edition = config.get("edition", "community")
        demo_data = config.get("demo_data", False)
        cpu_cores = config.get("cpu_cores", 1)
        ram_mb = config.get("ram_mb", 2048)

        # v2 feature flags
        enable_pgbouncer = config.get("enable_pgbouncer", not use_external_db)
        enable_redis = config.get("enable_redis", True)

        # Ensure passwords and params are in config for _compose_content
        config_with_defaults = {**config}
        config_with_defaults.setdefault("admin_password", admin_password)
        config_with_defaults.setdefault("db_password", db_password)
        config_with_defaults.setdefault("db_name", db_name)
        config_with_defaults.setdefault("language", language)
        config_with_defaults.setdefault("use_external_db", use_external_db)
        config_with_defaults.setdefault("cpu_cores", cpu_cores)
        config_with_defaults.setdefault("ram_mb", ram_mb)
        config_with_defaults.setdefault("enable_pgbouncer", enable_pgbouncer)
        config_with_defaults.setdefault("enable_redis", enable_redis)

        server = self._server_info(server_id, endpoint, ssh_meta)
        compose, odoo_conf = self._compose_content(instance_id, config_with_defaults)

        # Compute actual workers for config storage
        workers = config.get("workers") or _compute_workers(cpu_cores)

        logger.info(f"Deploying Odoo {version} ({edition}) as {prefix} on {endpoint}:{port} "
                     f"[workers={workers}, ram={ram_mb}MB, pgbouncer={enable_pgbouncer}, redis={enable_redis}]")

        deploy_dir = f"/opt/crx-cloud/instances/{prefix}"
        await self.vm_driver._ssh_exec(
            server,
            f"mkdir -p {deploy_dir} && cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
        )
        # Write odoo.conf (production-hardened)
        await self.vm_driver._ssh_exec(
            server,
            f"cat > {deploy_dir}/odoo.conf << 'CONFEOF'\n{odoo_conf}CONFEOF"
        )

        # =====================================================================
        # Deploy flow:
        #   1. Pull images, start infra only (db, pgbouncer, redis)
        #   2. Init database via Odoo CLI (direct PG, handles lang+demo)
        #   3. Harden odoo.conf (db_name + list_db=False)
        #   4. Start Odoo, wait healthy, set admin password via JSONRPC
        # =====================================================================

        # Step 1: Pull images and start infrastructure
        await self.vm_driver._ssh_exec(
            server,
            f"cd {deploy_dir} && docker compose pull && docker compose up -d db"
        )
        logger.info(f"Waiting for PostgreSQL {prefix}-db to be ready...")
        for attempt in range(12):  # 60s
            await asyncio.sleep(5)
            pg_status = await self.vm_driver._ssh_exec(
                server,
                f"docker inspect --format='{{{{.State.Health.Status}}}}' {prefix}-db 2>/dev/null || echo unknown"
            )
            if "healthy" in pg_status.strip():
                logger.info(f"PostgreSQL ready after {(attempt+1)*5}s")
                break
        else:
            logger.warning(f"PostgreSQL did not become healthy within 60s")

        # Start PgBouncer + Redis (needed for network connectivity during init)
        infra_services = []
        if enable_pgbouncer and not use_external_db:
            infra_services.append("pgbouncer")
        if enable_redis:
            infra_services.append("redis")
        if infra_services:
            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose up -d {' '.join(infra_services)}"
            )
            await asyncio.sleep(5)

        # Step 2: Init database via Odoo CLI (one-shot, direct PG connection)
        # Omit --without-demo to enable demo (default); pass --without-demo=all to skip
        # Resolve DB credentials for CLI init (bypass PgBouncer — direct PG)
        if use_external_db:
            init_db_host = config.get("external_db_host", "localhost")
            init_db_port = config.get("external_db_port", 5432)
            init_db_user = config.get("external_db_user", "odoo")
            init_db_pass = config.get("external_db_password", db_password)
        else:
            init_db_host = f"{prefix}-db"
            init_db_port = 5432
            init_db_user = "odoo"
            init_db_pass = db_password
        # Odoo 19+: demo OFF by default → need --with-demo to enable
        # Odoo 16-18: demo ON by default → omit flag to enable, --without-demo=all to disable
        version_major = int(version.split(".")[0])
        if demo_data:
            demo_flag = "--with-demo" if version_major >= 19 else ""
        else:
            demo_flag = "--without-demo=all"
        is_enterprise = edition == "enterprise"
        init_modules = "base,web_enterprise" if is_enterprise else "base"
        has_extra_content = bool(config.get("git_addons")) or config.get("enterprise_bypass_license", False)
        init_addons_path = ""
        if is_enterprise:
            extra = ",/mnt/extra-addons" if (has_extra_content or version_major >= 19) else ""
            init_addons_path = f"--addons-path=/mnt/enterprise-addons{extra} "
        logger.info(f"Creating database '{db_name}' via CLI (lang={language}, demo={demo_data}, demo_flag='{demo_flag}', enterprise={is_enterprise})...")
        try:
            init_cmd = (
                f"cd {deploy_dir} && "
                f"docker compose run --rm -T --no-deps odoo "
                f"bash -c 'odoo "
                f"--db_host={init_db_host} --db_port={init_db_port} "
                f"--db_user={init_db_user} --db_password={init_db_pass} "
                f"{init_addons_path}"
                f"-d {db_name} -i {init_modules} "
                f"--load-language={language} "
                f"{demo_flag} "
                f"--stop-after-init --no-http'"
            )
            await self.vm_driver._ssh_exec(server, init_cmd, timeout=600)
            logger.info(f"Database '{db_name}' created (demo={demo_data}, lang={language})")

            # Install PG extensions
            if not use_external_db:
                await self._setup_pg_extensions(server, prefix, db_name)
        except Exception as e:
            logger.warning(f"Database auto-create failed: {e}, user will see setup wizard")

        # Step 3: Harden odoo.conf — set real db_name + list_db=False
        logger.info(f"Hardening: setting db_name={db_name}, list_db=False on {prefix}...")
        await self.vm_driver._ssh_exec(
            server,
            f"sed -i 's/^db_name = False/db_name = {db_name}/' {deploy_dir}/odoo.conf && "
            f"sed -i 's/^list_db = True/list_db = False/' {deploy_dir}/odoo.conf"
        )

        # Step 4: Start Odoo
        await self.vm_driver._ssh_exec(
            server,
            f"cd {deploy_dir} && docker compose up -d odoo"
        )
        logger.info(f"Waiting for Odoo {prefix} to start on port {port}...")
        for attempt in range(18):  # 90s
            await asyncio.sleep(5)
            result = await self.vm_driver._ssh_exec(
                server,
                f"curl -s --max-time 10 -o /dev/null -w '%{{http_code}}' http://localhost:{port}/web/login 2>/dev/null || echo 000",
                timeout=30,
            )
            code = result.strip().split("\n")[-1]
            if code in ("200", "303"):
                logger.info(f"Odoo {prefix} is healthy (HTTP {code}) after {(attempt+1)*5}s")
                break
            container_status = await self.vm_driver._ssh_exec(
                server,
                f"docker inspect --format='{{{{.State.Status}}}}' {prefix}-odoo 2>/dev/null || echo unknown"
            )
            if "exited" in container_status or "dead" in container_status:
                logs = await self.vm_driver._ssh_exec(server, f"docker logs {prefix}-odoo --tail 5 2>&1")
                raise RuntimeError(f"Odoo container crashed: {logs}")
        else:
            logger.warning(f"Odoo {prefix} did not become healthy within 90s")

        # Step 5: Set admin password via JSONRPC (now works — DB exists + rpc addon loaded)
        if admin_password != "admin":
            try:
                await self._set_admin_password(server, prefix, db_name, port, admin_password)
                logger.info(f"Admin password set for '{db_name}'")
            except Exception as e:
                logger.warning(f"Failed to set admin password: {e}")

        logger.info(f"Odoo {version} deployed: {prefix} on port {port} "
                     f"[PgBouncer={'ON' if enable_pgbouncer else 'OFF'}, "
                     f"Redis={'ON' if enable_redis else 'OFF'}]")

        return CMSInstance(
            id=instance_id,
            cms_type="odoo",
            version=version,
            name=config.get("name", f"odoo-{version}"),
            server_id=server_id,
            url=f"http://{endpoint}:{port}",
            status="running",
            config={
                "port": port,
                "deploy_dir": deploy_dir,
                "prefix": prefix,
                "workers": workers,
                "cpu_cores": cpu_cores,
                "ram_mb": ram_mb,
                "admin_password": admin_password,
                "db_password": db_password,
                "db_name": db_name,
                "language": language,
                "country": country,
                "edition": edition,
                "demo_data": demo_data,
                "use_external_db": use_external_db,
                "enable_pgbouncer": enable_pgbouncer,
                "enable_redis": enable_redis,
            },
        )

    async def configure(self, instance: CMSInstance, settings: dict) -> bool:
        logger.info(f"Configuring Odoo {instance.id}: {settings}")
        return True

    async def start(self, instance: CMSInstance) -> bool:
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)
            await self.vm_driver._ssh_exec(server, f"cd {deploy_dir} && docker compose start")
            return True
        except Exception as e:
            logger.error(f"Failed to start Odoo {instance.id}: {e}")
            return False

    async def stop(self, instance: CMSInstance) -> bool:
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)
            await self.vm_driver._ssh_exec(server, f"cd {deploy_dir} && docker compose stop")
            return True
        except Exception as e:
            logger.error(f"Failed to stop Odoo {instance.id}: {e}")
            return False

    async def restart(self, instance: CMSInstance) -> bool:
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)
            await self.vm_driver._ssh_exec(server, f"cd {deploy_dir} && docker compose restart odoo")
            return True
        except Exception as e:
            logger.error(f"Failed to restart Odoo {instance.id}: {e}")
            return False

    async def backup(self, instance: CMSInstance) -> str:
        """Backup Odoo: pg_dump + filestore."""
        try:
            prefix = instance.config.get("prefix", "")
            db_name = instance.config.get("db_name", "postgres")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            backup_id = uuid.uuid4().hex[:12]
            backup_dir = f"/opt/crx-cloud/backups/{prefix}/{backup_id}"

            await self.vm_driver._ssh_exec(
                server,
                f"mkdir -p {backup_dir} && "
                f"docker exec {prefix}-db pg_dump -U odoo -Fc {db_name} > {backup_dir}/db.dump && "
                f"docker cp {prefix}-odoo:/var/lib/odoo/filestore/{db_name} {backup_dir}/filestore 2>/dev/null || true",
                timeout=3600,
            )

            logger.info(f"Backup {backup_id} created for {prefix}")
            return backup_dir
        except Exception as e:
            logger.error(f"Backup failed for {instance.id}: {e}")
            return ""

    async def restore(self, instance: CMSInstance, backup_id: str, include_filestore: bool = True) -> bool:
        try:
            prefix = instance.config.get("prefix", "")
            db_name = instance.config.get("db_name", "postgres")
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            # Stop Odoo before restore
            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose stop odoo",
                timeout=120,
            )

            # Restore database
            await self.vm_driver._ssh_exec(
                server,
                f"docker exec -i {prefix}-db pg_restore -U odoo -d {db_name} --clean --if-exists < {backup_id}/db.dump",
                timeout=3600,
            )

            # Restore filestore (optional — can be slow for large instances)
            if include_filestore:
                await self.vm_driver._ssh_exec(
                    server,
                    f"test -d {backup_id}/filestore && "
                    f"docker cp {backup_id}/filestore {prefix}-odoo:/var/lib/odoo/filestore/{db_name} && "
                    f"docker exec {prefix}-odoo chown -R odoo:odoo /var/lib/odoo/filestore/{db_name} "
                    f"|| echo 'No filestore in backup, skipping'",
                    timeout=3600,
                )
                logger.info(f"Restored {prefix} filestore from {backup_id}")

            # Restart Odoo
            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose start odoo",
                timeout=120,
            )

            logger.info(f"Restored {prefix} from {backup_id} (filestore={'yes' if include_filestore else 'no'})")
            return True
        except Exception as e:
            logger.error(f"Restore failed for {instance.id}: {e}")
            return False

    async def health_check(self, instance: CMSInstance) -> dict:
        """Comprehensive health check — Odoo + PgBouncer + Redis + PostgreSQL."""
        try:
            port = instance.config.get("port", 8069)
            prefix = instance.config.get("prefix", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            enable_pgbouncer = instance.config.get("enable_pgbouncer", False)
            enable_redis = instance.config.get("enable_redis", False)
            use_external_db = instance.config.get("use_external_db", False)
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            # Check all services in a single SSH call for efficiency
            checks = [
                f"curl -sf --max-time 5 http://127.0.0.1:{port}/web/health 2>/dev/null && echo 'ODOO_OK' || echo 'ODOO_FAIL'",
                f"docker inspect {prefix}-odoo --format '{{{{.State.Status}}}}' 2>/dev/null || echo 'missing'",
            ]
            if not use_external_db:
                checks.append(f"docker inspect {prefix}-db --format '{{{{.State.Status}}}}' 2>/dev/null || echo 'missing'")
            if enable_pgbouncer:
                checks.append(f"docker inspect {prefix}-pgbouncer --format '{{{{.State.Status}}}}' 2>/dev/null || echo 'missing'")
            if enable_redis:
                checks.append(f"docker inspect {prefix}-redis --format '{{{{.State.Status}}}}' 2>/dev/null || echo 'missing'")

            result = await self.vm_driver._ssh_exec(server, "; ".join(checks))
            lines = result.strip().split("\n")

            http_ok = "ODOO_OK" in (lines[0] if lines else "")
            odoo_status = lines[1] if len(lines) > 1 else "unknown"

            health = {
                "status": "healthy" if http_ok else "unhealthy",
                "http_ok": http_ok,
                "services": {
                    "odoo": odoo_status,
                },
                "port": port,
            }

            idx = 2
            if not use_external_db and len(lines) > idx:
                health["services"]["postgres"] = lines[idx]
                idx += 1
            if enable_pgbouncer and len(lines) > idx:
                health["services"]["pgbouncer"] = lines[idx]
                idx += 1
            if enable_redis and len(lines) > idx:
                health["services"]["redis"] = lines[idx]
                idx += 1

            # Mark unhealthy if any critical service is down
            for svc, st in health["services"].items():
                if st not in ("running",):
                    health["status"] = "degraded" if http_ok else "unhealthy"
                    break

            return health
        except Exception as e:
            return {"status": "error", "error": str(e)}

    async def get_info(self, instance: CMSInstance) -> dict:
        return {
            "cms_type": "odoo",
            "version": instance.version,
            "port": instance.config.get("port", 8069),
            "workers": instance.config.get("workers", 2),
            "cpu_cores": instance.config.get("cpu_cores", 1),
            "ram_mb": instance.config.get("ram_mb", 2048),
            "deploy_dir": instance.config.get("deploy_dir", ""),
            "prefix": instance.config.get("prefix", ""),
            "edition": instance.config.get("edition", "community"),
            "pgbouncer": instance.config.get("enable_pgbouncer", False),
            "redis": instance.config.get("enable_redis", False),
        }

    async def install_module(self, instance: CMSInstance, module: str) -> bool:
        try:
            prefix = instance.config.get("prefix", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            await self.vm_driver._ssh_exec(
                server,
                f"docker exec {prefix}-odoo odoo -d postgres -i {module} --stop-after-init"
            )
            logger.info(f"Installed module {module} on {prefix}")
            return True
        except Exception as e:
            logger.error(f"Module install failed: {e}")
            return False

    async def remove(self, instance: CMSInstance) -> bool:
        """Remove Odoo instance completely."""
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose down -v && rm -rf {deploy_dir}"
            )
            logger.info(f"Removed Odoo instance {instance.id}")
            return True
        except Exception as e:
            logger.error(f"Failed to remove {instance.id}: {e}")
            return False

    async def update_compose(self, instance: CMSInstance, new_config: dict) -> bool:
        """Regenerate docker-compose.yml and restart with new config."""
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)

            # Merge new_config into existing instance config
            # Inject instance.version — config dict may not contain it, default is wrong (19.0)
            merged_config = {**instance.config, **new_config}
            merged_config.setdefault("version", instance.version)
            compose, odoo_conf = self._compose_content(instance.id, merged_config)

            # Write updated docker-compose.yml
            await self.vm_driver._ssh_exec(
                server,
                f"cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
            )
            # Write updated odoo.conf
            await self.vm_driver._ssh_exec(
                server,
                f"cat > {deploy_dir}/odoo.conf << 'CONFEOF'\n{odoo_conf}CONFEOF"
            )

            # Apply changes — Docker recreates only changed services
            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose up -d"
            )

            logger.info(f"Updated compose for {instance.id} with config: {list(new_config.keys())}")
            return True
        except Exception as e:
            logger.error(f"Failed to update compose for {instance.id}: {e}")
            return False

    async def sync_enterprise_addons(self, server: ServerInfo, version: str, package_path: str) -> bool:
        """Upload and extract enterprise addons on the remote server.

        Steps:
        1. SCP the tar.gz to server
        2. Extract it
        3. Find the addons directory (odoo-XX.X+e.../odoo/addons/)
        4. Symlink/copy to /opt/crx-cloud/enterprise/{version}/addons/
        """
        base_dir = f"/opt/crx-cloud/enterprise/{version}"
        addons_dir = f"{base_dir}/addons"
        try:
            # Create base directory
            await self.vm_driver._ssh_exec(server, f"mkdir -p {base_dir}")

            # Upload package via paramiko SFTP (avoids CLI scp key permission issues in Docker)
            import os
            import paramiko

            ssh_user = server.metadata.get("ssh_user", "root")
            ssh_key = server.metadata.get("ssh_key_path", "")
            local_file = package_path
            remote_file = f"{base_dir}/{os.path.basename(package_path)}"

            def _sftp_upload():
                client = paramiko.SSHClient()
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                connect_kwargs = {
                    "hostname": server.endpoint,
                    "username": ssh_user,
                    "port": server.metadata.get("ssh_port", 22),
                    "timeout": 30,
                }
                if ssh_key:
                    connect_kwargs["key_filename"] = ssh_key
                client.connect(**connect_kwargs)
                try:
                    sftp = client.open_sftp()
                    sftp.put(local_file, remote_file)
                    sftp.close()
                finally:
                    client.close()

            logger.info(f"SFTP upload enterprise package to {server.endpoint}:{remote_file}")
            await asyncio.to_thread(_sftp_upload)

            # Extract and find addons directory
            # Odoo enterprise tar.gz structure: odoo-19.0+e.YYYYMMDD/odoo/addons/
            extract_script = f"""
cd {base_dir} && \\
rm -rf addons extract_tmp && \\
mkdir -p extract_tmp && \\
tar xzf {remote_file} -C extract_tmp && \\
ODOO_DIR=$(find extract_tmp -maxdepth 1 -type d -name 'odoo*' | head -1) && \\
if [ -d "$ODOO_DIR/odoo/addons" ]; then
    mv "$ODOO_DIR/odoo/addons" addons
elif [ -d "$ODOO_DIR/addons" ]; then
    mv "$ODOO_DIR/addons" addons
elif [ -d "$ODOO_DIR" ]; then
    mv "$ODOO_DIR" addons
fi && \\
rm -rf extract_tmp && \\
ADDON_COUNT=$(ls -1d addons/*/  2>/dev/null | wc -l) && \\
echo "ENTERPRISE_ADDONS_OK count=$ADDON_COUNT"
"""
            result = await self.vm_driver._ssh_exec(server, extract_script, timeout=300)
            if "ENTERPRISE_ADDONS_OK" not in result:
                logger.error(f"Enterprise extraction failed: {result}")
                return False

            logger.info(f"Enterprise addons extracted on {server.endpoint}: {result.strip()}")
            return True
        except Exception as e:
            logger.error(f"Failed to sync enterprise addons for v{version}: {e}")
            return False

    # ------------------------------------------------------------------
    # Git addon management
    # ------------------------------------------------------------------

    async def clone_addon(self, instance: CMSInstance, addon_id: str, url: str, branch: str) -> dict:
        """Clone a git addon repo into the instance's addon directory."""
        prefix = instance.config.get("prefix", "")
        endpoint = instance.config.get("endpoint", "")
        ssh_meta = instance.config.get("ssh_metadata", {})
        server = self._server_info(instance.server_id, endpoint, ssh_meta)

        target_dir = f"/opt/crx-cloud/instances/{prefix}/addons/{addon_id}"
        clone_cmd = (
            f"mkdir -p /opt/crx-cloud/instances/{prefix}/addons && "
            f"git clone --branch {branch} --single-branch --depth 1 {url} {target_dir}"
        )
        await self.vm_driver._ssh_exec(server, clone_cmd, timeout=300)

        # Get HEAD commit sha
        commit_result = await self.vm_driver._ssh_exec(
            server, f"git -C {target_dir} rev-parse HEAD"
        )
        commit = commit_result.strip()

        # Scan modules
        modules = await self.scan_addon_modules(instance, addon_id)

        logger.info(f"Cloned {url}@{branch} -> {target_dir} (commit: {commit[:8]}, {len(modules)} modules)")
        return {"commit": commit, "modules": modules}

    async def clone_addon_sparse(
        self, instance: CMSInstance, addon_id: str,
        url: str, branch: str, module_name: str
    ) -> dict:
        """Clone a single module from a repo using git sparse checkout."""
        prefix = instance.config.get("prefix", "")
        endpoint = instance.config.get("endpoint", "")
        ssh_meta = instance.config.get("ssh_metadata", {})
        server = self._server_info(instance.server_id, endpoint, ssh_meta)

        target_dir = f"/opt/crx-cloud/instances/{prefix}/addons/{addon_id}"

        sparse_cmd = (
            f"rm -rf {target_dir} && "
            f"git clone --filter=blob:none --no-checkout --branch {branch} "
            f"--single-branch {url} {target_dir} && "
            f"cd {target_dir} && "
            f"git sparse-checkout init --cone && "
            f"git sparse-checkout set {module_name} && "
            f"git checkout {branch}"
        )
        await self.vm_driver._ssh_exec(server, sparse_cmd, timeout=300)

        # Get HEAD commit
        commit_result = await self.vm_driver._ssh_exec(
            server, f"git -C {target_dir} rev-parse HEAD"
        )
        commit = commit_result.strip()

        # Scan modules (will find the single module)
        modules = await self.scan_addon_modules(instance, addon_id)

        logger.info(f"Sparse-cloned {module_name} from {url}@{branch} -> {target_dir} (commit: {commit[:8]})")
        return {"commit": commit, "modules": modules}

    async def pull_addon(self, instance: CMSInstance, addon_id: str, branch: str) -> dict:
        """Pull latest changes for a git addon."""
        prefix = instance.config.get("prefix", "")
        endpoint = instance.config.get("endpoint", "")
        ssh_meta = instance.config.get("ssh_metadata", {})
        server = self._server_info(instance.server_id, endpoint, ssh_meta)

        addon_dir = f"/opt/crx-cloud/instances/{prefix}/addons/{addon_id}"

        # Get current commit before pull
        old_result = await self.vm_driver._ssh_exec(
            server, f"git -C {addon_dir} rev-parse HEAD"
        )
        previous_commit = old_result.strip()

        # Pull latest
        await self.vm_driver._ssh_exec(
            server, f"git -C {addon_dir} pull origin {branch}", timeout=120
        )

        # Get new commit
        new_result = await self.vm_driver._ssh_exec(
            server, f"git -C {addon_dir} rev-parse HEAD"
        )
        new_commit = new_result.strip()

        changed = previous_commit != new_commit
        logger.info(f"Pulled addon {addon_id}: {previous_commit[:8]}..{new_commit[:8]} (changed={changed})")

        return {
            "previous_commit": previous_commit,
            "new_commit": new_commit,
            "changed": changed,
        }

    async def remove_addon(self, instance: CMSInstance, addon_id: str) -> bool:
        """Remove an addon directory from the instance."""
        prefix = instance.config.get("prefix", "")
        endpoint = instance.config.get("endpoint", "")
        ssh_meta = instance.config.get("ssh_metadata", {})
        server = self._server_info(instance.server_id, endpoint, ssh_meta)

        addon_dir = f"/opt/crx-cloud/instances/{prefix}/addons/{addon_id}"
        await self.vm_driver._ssh_exec(server, f"rm -rf {addon_dir}")
        logger.info(f"Removed addon dir: {addon_dir}")
        return True

    async def scan_addon_modules(self, instance: CMSInstance, addon_id: str) -> list[dict]:
        """Scan __manifest__.py files in addon directory and return module info."""
        prefix = instance.config.get("prefix", "")
        endpoint = instance.config.get("endpoint", "")
        ssh_meta = instance.config.get("ssh_metadata", {})
        server = self._server_info(instance.server_id, endpoint, ssh_meta)

        addon_dir = f"/opt/crx-cloud/instances/{prefix}/addons/{addon_id}"

        scan_script = (
            f"find {addon_dir} -name '__manifest__.py' -maxdepth 2 | while read f; do\n"
            f"    dirname=$(basename $(dirname $f))\n"
            f"    echo \"MODULE:$dirname\"\n"
            f"    python3 -c \"\n"
            f"import ast, sys\n"
            f"data = ast.literal_eval(open('$f').read())\n"
            f"print('NAME:' + str(data.get('name', '')))\n"
            f"print('VERSION:' + str(data.get('version', '')))\n"
            f"print('DEPENDS:' + ','.join(data.get('depends', [])))\n"
            f"print('SUMMARY:' + str(data.get('summary', '')))\n"
            f"print('INSTALLABLE:' + str(data.get('installable', True)))\n"
            f"\" 2>/dev/null\n"
            f"done"
        )
        result = await self.vm_driver._ssh_exec(server, scan_script, timeout=60)

        modules = []
        current_module: dict = {}

        for line in result.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            if line.startswith("MODULE:"):
                if current_module:
                    modules.append(current_module)
                current_module = {"technical_name": line[7:]}
            elif line.startswith("NAME:") and current_module:
                current_module["name"] = line[5:]
            elif line.startswith("VERSION:") and current_module:
                current_module["version"] = line[8:]
            elif line.startswith("DEPENDS:") and current_module:
                deps = line[8:]
                current_module["depends"] = deps.split(",") if deps else []
            elif line.startswith("SUMMARY:") and current_module:
                current_module["summary"] = line[8:]
            elif line.startswith("INSTALLABLE:") and current_module:
                current_module["installable"] = line[12:].strip() != "False"

        if current_module:
            modules.append(current_module)

        logger.info(f"Scanned {len(modules)} modules in addon {addon_id}")
        return modules

    async def install_addon_requirements(self, instance: CMSInstance, addon_id: str) -> bool:
        """Install Python requirements from addon's requirements.txt into odoo container."""
        prefix = instance.config.get("prefix", "")
        endpoint = instance.config.get("endpoint", "")
        ssh_meta = instance.config.get("ssh_metadata", {})
        server = self._server_info(instance.server_id, endpoint, ssh_meta)

        addon_dir = f"/opt/crx-cloud/instances/{prefix}/addons/{addon_id}"
        container = f"{prefix}-odoo"

        # Check if requirements.txt exists
        check = await self.vm_driver._ssh_exec(
            server, f"test -f {addon_dir}/requirements.txt && echo EXISTS || echo MISSING"
        )
        if "MISSING" in check:
            logger.info(f"No requirements.txt in addon {addon_id}")
            return True

        # Install inside the odoo container
        await self.vm_driver._ssh_exec(
            server,
            f"docker exec {container} pip3 install -r /mnt/extra-addons/{addon_id}/requirements.txt",
            timeout=300,
        )
        logger.info(f"Installed requirements for addon {addon_id}")
        return True

    async def update_module_list(self, instance: CMSInstance) -> bool:
        """Trigger Odoo to refresh its module list via JSONRPC."""
        import json as _json

        port = instance.config.get("port", 8069)
        db_name = instance.config.get("db_name", instance.name)
        admin_password = instance.config.get("admin_password", "admin")
        endpoint = instance.config.get("endpoint", "")
        ssh_meta = instance.config.get("ssh_metadata", {})
        server = self._server_info(instance.server_id, endpoint, ssh_meta)

        # Authenticate
        auth_payload = _json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "call",
            "params": {"service": "common", "method": "authenticate",
                       "args": [db_name, "admin", admin_password, {}]}
        })
        auth_result = await self.vm_driver._ssh_exec(
            server,
            f"curl -s -X POST http://localhost:{port}/jsonrpc "
            f"-H 'Content-Type: application/json' "
            f"-d '{auth_payload}'"
        )
        try:
            uid = _json.loads(auth_result).get("result")
        except Exception:
            logger.warning(f"Cannot parse auth response for module list update")
            return False

        if not uid:
            logger.warning(f"Cannot authenticate for module list update")
            return False

        # Update module list
        update_payload = _json.dumps({
            "jsonrpc": "2.0", "id": 2, "method": "call",
            "params": {
                "service": "object", "method": "execute_kw",
                "args": [db_name, uid, admin_password, "ir.module.module", "update_list", []]
            }
        })
        await self.vm_driver._ssh_exec(
            server,
            f"curl -s -X POST http://localhost:{port}/jsonrpc "
            f"-H 'Content-Type: application/json' "
            f"-d '{update_payload}' --max-time 120",
            timeout=120
        )
        logger.info(f"Module list updated for {instance.name}")
        return True

    async def enable_enterprise(self, instance: CMSInstance) -> bool:
        """Enable enterprise on a running instance.

        Steps:
        1. Update docker-compose + odoo.conf with enterprise addons path
        2. Harden odoo.conf (db_name + list_db=False)
        3. Force-recreate Odoo container to pick up new volumes/config
        4. Install web_enterprise via CLI (more reliable than JSONRPC)
        """
        try:
            deploy_dir = instance.config.get("deploy_dir", "")
            endpoint = instance.config.get("endpoint", "")
            port = instance.config.get("port", 8069)
            ssh_meta = instance.config.get("ssh_metadata", {})
            server = self._server_info(instance.server_id, endpoint, ssh_meta)
            db_name = instance.config.get("db_name", instance.name)
            db_password = instance.config.get("db_password", "")
            use_external_db = instance.config.get("use_external_db", False)
            prefix = self._instance_prefix(instance.id)

            # 1. Regenerate compose + conf with enterprise=True
            # Note: _compose_content checks "edition" key, not "enterprise"
            # CRITICAL: instance.version is NOT in instance.config — must inject it
            # otherwise _compose_content defaults to 19.0 (wrong image + addons)
            merged_config = {**instance.config, "edition": "enterprise", "version": instance.version}
            compose, odoo_conf = self._compose_content(instance.id, merged_config)

            await self.vm_driver._ssh_exec(
                server,
                f"cat > {deploy_dir}/docker-compose.yml << 'COMPOSEOF'\n{compose}COMPOSEOF"
            )
            await self.vm_driver._ssh_exec(
                server,
                f"cat > {deploy_dir}/odoo.conf << 'CONFEOF'\n{odoo_conf}CONFEOF"
            )

            # 2. Harden odoo.conf — _compose_content sets db_name=False, list_db=True
            await self.vm_driver._ssh_exec(
                server,
                f"sed -i 's/^db_name = False/db_name = {db_name}/' {deploy_dir}/odoo.conf && "
                f"sed -i 's/^list_db = True/list_db = False/' {deploy_dir}/odoo.conf"
            )

            # 3. Stop Odoo, install web_enterprise via CLI, then restart
            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose stop odoo"
            )

            # Resolve direct PG connection for CLI (bypass PgBouncer)
            if use_external_db:
                cli_db_host = instance.config.get("external_db_host", "localhost")
                cli_db_port = instance.config.get("external_db_port", 5432)
                cli_db_user = instance.config.get("external_db_user", "odoo")
                cli_db_pass = instance.config.get("external_db_password", db_password)
            else:
                cli_db_host = f"{prefix}-db"
                cli_db_port = 5432
                cli_db_user = "odoo"
                cli_db_pass = db_password

            # Install web_enterprise via CLI (--update=all refreshes module list)
            # Build addons-path dynamically: /mnt/extra-addons may be empty and
            # Odoo <=17.0 treats empty dirs as fatal errors (not just warnings).
            install_cmd = (
                f"cd {deploy_dir} && "
                f"docker compose run --rm -T --no-deps odoo "
                f"bash -c '"
                f"ADDONS_PATH=/mnt/enterprise-addons; "
                f"if ls /mnt/extra-addons/*/__manifest__.py >/dev/null 2>&1; then "
                f"ADDONS_PATH=\"$ADDONS_PATH,/mnt/extra-addons\"; fi; "
                f"odoo "
                f"--db_host={cli_db_host} --db_port={cli_db_port} "
                f"--db_user={cli_db_user} --db_password={cli_db_pass} "
                f"--addons-path=$ADDONS_PATH "
                f"-d {db_name} -i web_enterprise "
                f"--stop-after-init --no-http'"
            )
            logger.info(f"Installing web_enterprise via CLI on {instance.name}...")
            await self.vm_driver._ssh_exec(server, install_cmd, timeout=600)
            logger.info(f"web_enterprise installed on {instance.name}")

            # 4. Start Odoo with new config
            await self.vm_driver._ssh_exec(
                server,
                f"cd {deploy_dir} && docker compose up -d odoo"
            )

            # Wait for healthy (curl --max-time 10 prevents hanging on slow Odoo startup)
            for i in range(30):
                await asyncio.sleep(5)
                try:
                    check = await self.vm_driver._ssh_exec(
                        server,
                        f"curl -s --max-time 10 -o /dev/null -w '%{{http_code}}' http://localhost:{port}/web/login 2>/dev/null || echo 000",
                        timeout=30,
                    )
                    code = check.strip().split("\n")[-1]
                    logger.debug(f"Health check {i+1}/30 for {instance.name}: HTTP {code}")
                    if code in ("200", "303"):
                        logger.info(f"Odoo {instance.name} healthy after enterprise enable")
                        break
                except Exception:
                    logger.debug(f"Health check {i+1}/30 for {instance.name}: SSH error, retrying...")
                    continue
            else:
                logger.warning("Odoo not ready after 150s post-enterprise enable")

            return True
        except Exception as e:
            logger.error(f"Failed to enable enterprise on {instance.name}: {e}")
            return False
