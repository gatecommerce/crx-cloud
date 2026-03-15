"""Server management endpoints — wizard-friendly connect flow.

Inspired by RunCloud/Ploi: user provides IP + root password,
platform auto-injects SSH key and provisions Docker.
"""

import re
import shlex
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from loguru import logger

from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db
from core.k8s_controller import KubernetesDriver
from core.vm_controller import VMDriver
from core.server_manager import ServerInfo, ServerType
from core.ssh_keys import get_public_key, get_private_key_path

router = APIRouter()

_drivers = {"kubernetes": KubernetesDriver(), "vm": VMDriver()}


def _to_server_info(srv: Server) -> ServerInfo:
    return ServerInfo(
        id=srv.id, name=srv.name,
        server_type=ServerType(srv.server_type), provider=srv.provider,
        endpoint=srv.endpoint,
        metadata={
            "kubeconfig_path": srv.kubeconfig or "",
            "namespace": srv.namespace or "default",
            "ssh_user": srv.ssh_user or "root",
            "ssh_key_path": srv.ssh_key_path or get_private_key_path(),
            **(srv.meta or {}),
        },
    )


# --- Platform SSH Key ---

class SSHKeyResponse(BaseModel):
    public_key: str


@router.get("/ssh-key", response_model=SSHKeyResponse)
async def get_platform_ssh_key(user: dict = Depends(get_current_user)):
    """Return platform's public SSH key for manual server setup."""
    return SSHKeyResponse(public_key=get_public_key())


# --- Test Connection ---

class TestConnectionRequest(BaseModel):
    endpoint: str
    ssh_user: str = "root"
    password: str | None = None
    server_type: str = "vm"


class TestConnectionResponse(BaseModel):
    connected: bool
    hostname: str = ""
    error: str = ""


@router.post("/test-connection", response_model=TestConnectionResponse)
async def test_connection(
    body: TestConnectionRequest,
    user: dict = Depends(get_current_user),
):
    """Test SSH connection to a server before adding it."""
    if body.server_type == "kubernetes":
        return TestConnectionResponse(connected=False, error="K8s test not yet implemented")

    info = ServerInfo(
        id="test", name="test", server_type=ServerType.VM,
        provider="test", endpoint=body.endpoint,
        metadata={"ssh_user": body.ssh_user},
    )
    driver: VMDriver = _drivers["vm"]
    try:
        if body.password:
            result = await driver._ssh_exec(info, "hostname", password=body.password)
        else:
            result = await driver._ssh_exec(info, "hostname")
        return TestConnectionResponse(connected=True, hostname=result)
    except Exception as e:
        return TestConnectionResponse(connected=False, error=str(e))


# --- Security Pre-Check (existing server threat scan) ---

class PrecheckRequest(BaseModel):
    endpoint: str
    ssh_user: str = "root"
    password: str | None = None


@router.post("/precheck")
async def security_precheck(
    body: PrecheckRequest,
    user: dict = Depends(get_current_user),
):
    """Deep security scan on an existing server BEFORE provisioning.

    Detects rootkits, crypto miners, suspicious processes, unauthorized
    SSH keys, malicious cron jobs, tampered binaries, rogue users.
    """
    info = ServerInfo(
        id="precheck", name="precheck", server_type=ServerType.VM,
        provider="precheck", endpoint=body.endpoint,
        metadata={"ssh_user": body.ssh_user},
    )
    driver: VMDriver = _drivers["vm"]

    # First ensure we can connect
    try:
        if body.password:
            await driver._ssh_exec(info, "hostname", password=body.password)
        else:
            await driver._ssh_exec(info, "hostname")
    except Exception as e:
        return {"safe": False, "risk_level": "unknown", "threats": [],
                "error": f"Cannot connect: {e}", "system_info": {}}

    # Run the deep scan
    result = await driver.security_precheck(info)
    return result


# --- Sanitize (clean threats before provisioning) ---

class SanitizeRequest(BaseModel):
    endpoint: str
    ssh_user: str = "root"
    password: str | None = None
    threats: list[dict] = []


@router.post("/sanitize")
async def sanitize_server(
    body: SanitizeRequest,
    user: dict = Depends(get_current_user),
):
    """Sanitize a server — remove detected threats before provisioning.

    Does NOT format or reinstall the OS. Surgically removes malware,
    backdoor users, suspicious cron jobs, and mining processes.
    """
    info = ServerInfo(
        id="sanitize", name="sanitize", server_type=ServerType.VM,
        provider="sanitize", endpoint=body.endpoint,
        metadata={"ssh_user": body.ssh_user},
    )
    driver: VMDriver = _drivers["vm"]
    result = await driver.sanitize(info, body.threats)
    return result


# --- Connect Server (wizard endpoint) ---

class ConnectServerRequest(BaseModel):
    name: str
    server_type: str = "vm"
    provider: str = "hetzner"
    endpoint: str
    ssh_user: str = "root"
    password: str | None = None
    region: str | None = None
    kubeconfig: str | None = None
    namespace: str = "default"


class ServerSpecs(BaseModel):
    cpu_cores: int = 0
    cpu_model: str = ""
    ram_mb: int = 0
    disk_gb: int = 0
    disk_used_gb: int = 0
    os: str = ""
    kernel: str = ""
    arch: str = ""


class ServerResponse(BaseModel):
    id: str
    name: str
    server_type: str
    provider: str
    status: str
    endpoint: str
    region: str | None = None
    instances_count: int = 0
    precheck: dict | None = None
    specs: ServerSpecs | None = None
    provider_plan: str | None = None


@router.post("", response_model=ServerResponse, status_code=201)
async def connect_server(
    body: ConnectServerRequest,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Connect a new server. If password provided, auto-injects SSH key."""
    driver = _drivers.get(body.server_type)
    if not driver:
        raise HTTPException(status_code=400, detail=f"Unknown server type: {body.server_type}")

    srv = Server(
        name=body.name, server_type=body.server_type, provider=body.provider,
        endpoint=body.endpoint, region=body.region, ssh_user=body.ssh_user,
        ssh_key_path=get_private_key_path(),
        kubeconfig=body.kubeconfig, namespace=body.namespace,
        status="provisioning", owner_id=user["telegram_id"],
    )
    info = _to_server_info(srv)

    # If password: inject platform SSH key first
    if body.password and body.server_type == "vm":
        key_ok = await driver.inject_ssh_key(info, body.password)
        if not key_ok:
            srv.status = "error"
            srv.meta = {"error": "Failed to inject SSH key. Check password and server access."}
            db.add(srv)
            await db.commit()
            await db.refresh(srv)
            return ServerResponse(
                id=srv.id, name=srv.name, server_type=srv.server_type,
                provider=srv.provider, status=srv.status, endpoint=srv.endpoint,
                region=srv.region,
            )

    # Test key-based connection
    connected = await driver.connect(info)
    if connected:
        srv.status = "online"
        bg.add_task(_provision_server_bg, srv.id, info)
    else:
        srv.status = "error"
        srv.meta = {"error": "SSH key connection failed. Add the platform key to authorized_keys."}

    db.add(srv)
    await db.commit()
    await db.refresh(srv)

    return ServerResponse(
        id=srv.id, name=srv.name, server_type=srv.server_type,
        provider=srv.provider, status=srv.status, endpoint=srv.endpoint,
        region=srv.region,
    )


async def _fetch_server_specs(driver: VMDriver, info: ServerInfo) -> dict:
    """Fetch hardware specs from a server via SSH."""
    try:
        raw = await driver._ssh_exec(
            info,
            "echo CPU_CORES=$(nproc) && "
            "echo CPU_MODEL=$(lscpu 2>/dev/null | grep 'Model name' | sed 's/.*: *//' || echo unknown) && "
            "echo RAM_MB=$(free -m | awk '/Mem:/{print $2}') && "
            "echo DISK_GB=$(df -BG / | awk 'NR==2{gsub(/G/,\"\",$2); print $2}') && "
            "echo DISK_USED_GB=$(df -BG / | awk 'NR==2{gsub(/G/,\"\",$3); print $3}') && "
            "echo OS=$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"' || uname -s) && "
            "echo KERNEL=$(uname -r) && "
            "echo ARCH=$(uname -m)"
        )
        specs = {}
        for line in raw.strip().split("\n"):
            if "=" in line:
                key, val = line.split("=", 1)
                specs[key.strip()] = val.strip()
        return {
            "cpu_cores": int(specs.get("CPU_CORES", 0)),
            "cpu_model": specs.get("CPU_MODEL", "unknown"),
            "ram_mb": int(specs.get("RAM_MB", 0)),
            "disk_gb": int(specs.get("DISK_GB", 0)),
            "disk_used_gb": int(specs.get("DISK_USED_GB", 0)),
            "os": specs.get("OS", "unknown"),
            "kernel": specs.get("KERNEL", ""),
            "arch": specs.get("ARCH", ""),
        }
    except Exception as e:
        logger.warning(f"Failed to fetch server specs: {e}")
        return {}


async def _provision_server_bg(server_id: str, info: ServerInfo):
    """Background task: provision server (install Docker, create dirs) + fetch specs."""
    from core.database import async_session

    driver: VMDriver = _drivers["vm"]
    try:
        result = await driver.provision(info)
        # Fetch hardware specs
        specs = await _fetch_server_specs(driver, info)
        async with async_session() as db:
            srv = await db.get(Server, server_id)
            if srv:
                srv.meta = {
                    **(srv.meta or {}),
                    "provisioned": result["success"],
                    "provision_details": result,
                    "specs": specs,
                }
                if not result["success"]:
                    srv.status = "error"
                await db.commit()
    except Exception as e:
        logger.error(f"Background provision failed for {server_id}: {e}")


# --- List ---

@router.get("", response_model=list[ServerResponse])
async def list_servers(
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Server).options(selectinload(Server.instances))
        .where(Server.owner_id == user["telegram_id"])
    )
    servers = result.scalars().all()
    # Auto-fetch specs for online servers that don't have them yet
    for s in servers:
        if s.status == "online" and not (s.meta or {}).get("specs") and s.server_type == "vm":
            bg.add_task(_fetch_and_store_specs, s.id, _to_server_info(s))
    return [
        ServerResponse(
            id=s.id, name=s.name, server_type=s.server_type,
            provider=s.provider, status=s.status, endpoint=s.endpoint,
            region=s.region, instances_count=len(s.instances),
            specs=ServerSpecs(**(s.meta or {}).get("specs", {})) if (s.meta or {}).get("specs") else None,
            provider_plan=(s.meta or {}).get("provider_plan"),
        )
        for s in servers
    ]


async def _fetch_and_store_specs(server_id: str, info: ServerInfo):
    """Background: fetch specs and store in meta."""
    from core.database import async_session
    driver: VMDriver = _drivers["vm"]
    specs = await _fetch_server_specs(driver, info)
    if specs:
        async with async_session() as db:
            srv = await db.get(Server, server_id)
            if srv:
                srv.meta = {**(srv.meta or {}), "specs": specs}
                await db.commit()


# --- Get ---

@router.get("/{server_id}", response_model=ServerResponse)
async def get_server(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Server).options(selectinload(Server.instances))
        .where(Server.id == server_id, Server.owner_id == user["telegram_id"])
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    return ServerResponse(
        id=srv.id, name=srv.name, server_type=srv.server_type,
        provider=srv.provider, status=srv.status, endpoint=srv.endpoint,
        region=srv.region, instances_count=len(srv.instances),
        specs=ServerSpecs(**(srv.meta or {}).get("specs", {})) if (srv.meta or {}).get("specs") else None,
        provider_plan=(srv.meta or {}).get("provider_plan"),
    )


# --- Specs (auto-fetch if missing) ---

@router.post("/{server_id}/refresh-specs")
async def refresh_server_specs(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Re-fetch hardware specs from server via SSH."""
    srv = await db.get(Server, server_id)
    if not srv or srv.owner_id != user["telegram_id"]:
        raise HTTPException(status_code=404, detail="Server not found")
    info = _to_server_info(srv)
    driver: VMDriver = _drivers["vm"]
    specs = await _fetch_server_specs(driver, info)
    if specs:
        srv.meta = {**(srv.meta or {}), "specs": specs}
        await db.commit()
    return {"specs": specs}


# --- Metrics ---

@router.get("/{server_id}/metrics")
async def get_server_metrics(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Server).where(Server.id == server_id, Server.owner_id == user["telegram_id"])
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")

    driver = _drivers.get(srv.server_type)
    info = _to_server_info(srv)
    metrics = await driver.get_metrics(info)
    return {"server_id": srv.id, "name": srv.name, **metrics}


# --- Security Audit ---

@router.get("/{server_id}/security")
async def get_security_audit(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Run a security audit on the server."""
    result = await db.execute(
        select(Server).where(Server.id == server_id, Server.owner_id == user["telegram_id"])
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    if srv.server_type != "vm":
        raise HTTPException(status_code=400, detail="Security audit only available for VM servers")

    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)
    audit = await driver.security_audit(info)
    return {"server_id": srv.id, "name": srv.name, **audit}


# --- Pending Updates ---

@router.get("/{server_id}/updates")
async def get_pending_updates(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Check for pending OS updates on the server."""
    result = await db.execute(
        select(Server).where(Server.id == server_id, Server.owner_id == user["telegram_id"])
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")

    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)
    updates = await driver.get_pending_updates(info)
    return {"server_id": srv.id, "name": srv.name, **updates}


# --- Reboot ---

@router.post("/{server_id}/reboot")
async def reboot_server(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Schedule a graceful server reboot."""
    result = await db.execute(
        select(Server).where(Server.id == server_id, Server.owner_id == user["telegram_id"])
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")

    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)
    ok = await driver.reboot(info)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to schedule reboot")
    return {"detail": "Reboot scheduled in 1 minute", "server_id": srv.id}


# --- Delete ---

@router.delete("/{server_id}")
async def remove_server(
    server_id: str,
    destroy_cloud: bool = False,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Server).where(Server.id == server_id, Server.owner_id == user["telegram_id"])
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")

    cloud_deleted = False
    # If user opted to also destroy on the cloud provider
    provider_id = (srv.meta or {}).get("provider_id")
    if destroy_cloud and provider_id and srv.provider:
        try:
            from core.cloud_providers.hetzner import HetznerClient
            from core.cloud_providers.digitalocean import DigitalOceanClient
            from core.cloud_providers.vultr import VultrClient
            from core.cloud_providers.linode import LinodeClient
            from core.config import settings

            if srv.provider == "hetzner" and settings.hetzner_api_token:
                client = HetznerClient(settings.hetzner_api_token)
                await client.delete_server(int(provider_id))
                cloud_deleted = True
            elif srv.provider == "digitalocean" and settings.digitalocean_api_token:
                client = DigitalOceanClient(settings.digitalocean_api_token)
                await client.delete_droplet(int(provider_id))
                cloud_deleted = True
            elif srv.provider == "vultr" and settings.vultr_api_key:
                client = VultrClient(settings.vultr_api_key)
                await client.delete_instance(provider_id)
                cloud_deleted = True
            elif srv.provider == "linode" and settings.linode_api_token:
                client = LinodeClient(settings.linode_api_token)
                await client.delete_linode(int(provider_id))
                cloud_deleted = True
            if cloud_deleted:
                logger.info(f"Deleted {srv.provider} server {provider_id}")
        except Exception as e:
            logger.warning(f"Failed to delete cloud server {provider_id} on {srv.provider}: {e}")

    await db.delete(srv)
    await db.commit()
    detail = "Server removed from dashboard"
    if cloud_deleted:
        detail += f" and destroyed on {srv.provider.title()}"
    elif destroy_cloud and provider_id:
        detail += f" (warning: cloud deletion on {srv.provider} may have failed)"
    return {"detail": detail}


# ---------------------------------------------------------------------------
# Helper: fetch owned VM server or raise
# ---------------------------------------------------------------------------

async def _get_owned_vm_server(
    server_id: str, db: AsyncSession, user: dict,
) -> Server:
    """Return an owned VM server or raise 404/400."""
    result = await db.execute(
        select(Server).where(
            Server.id == server_id, Server.owner_id == user["telegram_id"],
        )
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    if srv.server_type != "vm":
        raise HTTPException(
            status_code=400, detail="This operation is only available for VM servers",
        )
    return srv


# =====================================================================
# 1. Enhanced Metrics (detailed)
# =====================================================================

class DetailedCPU(BaseModel):
    cores: int = 0
    model: str = ""
    frequency_mhz: float = 0
    load_avg_1: float = 0
    load_avg_5: float = 0
    load_avg_15: float = 0
    per_core_percent: list[float] = []


class DetailedMemory(BaseModel):
    total_mb: int = 0
    used_mb: int = 0
    free_mb: int = 0
    cached_mb: int = 0
    buffers_mb: int = 0
    swap_total_mb: int = 0
    swap_used_mb: int = 0
    ram_percent: float = 0
    swap_percent: float = 0


class DiskPartition(BaseModel):
    filesystem: str = ""
    mount: str = ""
    size_gb: float = 0
    used_gb: float = 0
    available_gb: float = 0
    percent: float = 0


class DetailedDisk(BaseModel):
    partitions: list[DiskPartition] = []
    io_read_mb: float = 0
    io_write_mb: float = 0


class NetworkInterface(BaseModel):
    name: str = ""
    rx_bytes: int = 0
    tx_bytes: int = 0
    rx_mb: float = 0
    tx_mb: float = 0


class DetailedNetwork(BaseModel):
    interfaces: list[NetworkInterface] = []


class DockerSummary(BaseModel):
    running: int = 0
    total: int = 0


class SystemInfo(BaseModel):
    hostname: str = ""
    kernel: str = ""
    uptime_seconds: int = 0
    processes: int = 0


class DetailedMetricsResponse(BaseModel):
    server_id: str
    cpu: DetailedCPU
    memory: DetailedMemory
    disk: DetailedDisk
    network: DetailedNetwork
    docker: DockerSummary
    system: SystemInfo


@router.get("/{server_id}/metrics/detailed", response_model=DetailedMetricsResponse)
async def get_detailed_metrics(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Return comprehensive server metrics."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "echo '===CORES==='; nproc 2>/dev/null || echo 0; "
        "echo '===MODEL==='; lscpu 2>/dev/null | grep '^Model name' | head -1 | sed 's/.*: *//' || true; "
        "echo '===FREQ==='; lscpu 2>/dev/null | grep 'CPU MHz' | head -1 | sed 's/.*: *//' || true; "
        "echo '===LOADAVG==='; cat /proc/loadavg 2>/dev/null || echo '0 0 0'; "
        "echo '===PERCPU==='; "
        "grep 'cpu[0-9]' /proc/stat > /tmp/.cpustat1 2>/dev/null; sleep 1; grep 'cpu[0-9]' /proc/stat > /tmp/.cpustat2 2>/dev/null; "
        "paste /tmp/.cpustat1 /tmp/.cpustat2 | awk '{t1=$2+$3+$4+$5+$6+$7+$8+$9+$10; i1=$5+$6; t2=$13+$14+$15+$16+$17+$18+$19+$20+$21; i2=$16+$17; dt=t2-t1; di=i2-i1; if(dt>0) printf \"%.1f\\n\", (1-di/dt)*100; else print \"0.0\"}' || true; "
        "rm -f /tmp/.cpustat1 /tmp/.cpustat2 2>/dev/null; "
        "echo '===MEM==='; free -m 2>/dev/null | awk '/Mem:/{print $2,$3,$4,$6,$7} /Swap:/{print $2,$3}' || echo '0 0 0 0 0'; "
        "echo '===DISK==='; df -BG --output=source,target,size,used,avail,pcent -x tmpfs -x devtmpfs 2>/dev/null | tail -n +2 || true; "
        "echo '===DISKIO==='; cat /proc/diskstats 2>/dev/null | awk '$3~/^(sd|vd|nvme)[a-z]+$/{read+=$6; write+=$10} END{printf \"%.1f %.1f\\n\", read*512/1048576, write*512/1048576}' || echo '0 0'; "
        "echo '===NET==='; cat /proc/net/dev 2>/dev/null | tail -n +3 | awk '{gsub(/:/, \"\"); printf \"%s %s %s\\n\", $1, $2, $10}' || true; "
        "echo '===DOCKER==='; docker ps -q 2>/dev/null | wc -l || echo 0; docker ps -aq 2>/dev/null | wc -l || echo 0; "
        "echo '===SYS==='; hostname 2>/dev/null || echo unknown; uname -r 2>/dev/null || echo unknown; "
        "awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0; "
        "ls -d /proc/[0-9]* 2>/dev/null | wc -l || echo 0"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=30)
    except Exception as e:
        logger.error(f"Failed to get detailed metrics for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    lines = raw.strip().split("\n")
    sections: dict[str, list[str]] = {}
    current = ""
    for line in lines:
        if line.startswith("===") and line.endswith("==="):
            current = line.strip("=")
            sections[current] = []
        elif current:
            sections[current].append(line)

    # CPU — each field in its own section to avoid line-count ambiguity
    cores_lines = sections.get("CORES", [])
    cores = int(cores_lines[0]) if cores_lines else 0
    model_lines = sections.get("MODEL", [])
    cpu_model = model_lines[0] if model_lines else ""
    freq_lines = sections.get("FREQ", [])
    try:
        cpu_freq = float(freq_lines[0]) if freq_lines and freq_lines[0] else 0
    except ValueError:
        cpu_freq = 0
    loadavg_lines = sections.get("LOADAVG", [])
    loadavg_parts = loadavg_lines[0].split() if loadavg_lines else []
    load1 = float(loadavg_parts[0]) if loadavg_parts else 0
    load5 = float(loadavg_parts[1]) if len(loadavg_parts) > 1 else 0
    load15 = float(loadavg_parts[2]) if len(loadavg_parts) > 2 else 0

    per_core = []
    for pc in sections.get("PERCPU", []):
        try:
            per_core.append(float(pc))
        except ValueError:
            pass

    # Memory
    mem_lines = sections.get("MEM", [])
    mem_parts = mem_lines[0].split() if mem_lines else []
    swap_parts = mem_lines[1].split() if len(mem_lines) > 1 else []
    total_mb = int(mem_parts[0]) if mem_parts else 0
    used_mb = int(mem_parts[1]) if len(mem_parts) > 1 else 0
    free_mb = int(mem_parts[2]) if len(mem_parts) > 2 else 0
    cached_mb = int(mem_parts[3]) if len(mem_parts) > 3 else 0
    buffers_mb = int(mem_parts[4]) if len(mem_parts) > 4 else 0
    swap_total = int(swap_parts[0]) if swap_parts else 0
    swap_used = int(swap_parts[1]) if len(swap_parts) > 1 else 0

    # Disk
    partitions = []
    for dl in sections.get("DISK", []):
        parts = dl.split()
        if len(parts) >= 6:
            partitions.append(DiskPartition(
                filesystem=parts[0], mount=parts[1],
                size_gb=float(parts[2].rstrip("G") or 0),
                used_gb=float(parts[3].rstrip("G") or 0),
                available_gb=float(parts[4].rstrip("G") or 0),
                percent=float(parts[5].rstrip("%") or 0),
            ))
    dio = sections.get("DISKIO", [])
    dio_parts = dio[0].split() if dio else []
    io_read = float(dio_parts[0]) if dio_parts else 0
    io_write = float(dio_parts[1]) if len(dio_parts) > 1 else 0

    # Network
    interfaces = []
    for nl in sections.get("NET", []):
        parts = nl.split()
        if len(parts) >= 3:
            rx = int(parts[1])
            tx = int(parts[2])
            interfaces.append(NetworkInterface(
                name=parts[0], rx_bytes=rx, tx_bytes=tx,
                rx_mb=round(rx / 1048576, 2), tx_mb=round(tx / 1048576, 2),
            ))

    # Docker
    docker_lines = sections.get("DOCKER", [])
    docker_running = int(docker_lines[0]) if docker_lines else 0
    docker_total = int(docker_lines[1]) if len(docker_lines) > 1 else 0

    # System
    sys_lines = sections.get("SYS", [])
    hostname = sys_lines[0] if sys_lines else ""
    kernel = sys_lines[1] if len(sys_lines) > 1 else ""
    uptime_s = int(sys_lines[2]) if len(sys_lines) > 2 else 0
    procs = int(sys_lines[3]) if len(sys_lines) > 3 else 0

    return DetailedMetricsResponse(
        server_id=srv.id,
        cpu=DetailedCPU(
            cores=cores, model=cpu_model, frequency_mhz=cpu_freq,
            load_avg_1=load1, load_avg_5=load5, load_avg_15=load15,
            per_core_percent=per_core,
        ),
        memory=DetailedMemory(
            total_mb=total_mb, used_mb=used_mb, free_mb=free_mb,
            cached_mb=cached_mb, buffers_mb=buffers_mb,
            swap_total_mb=swap_total, swap_used_mb=swap_used,
            ram_percent=round(used_mb / total_mb * 100, 1) if total_mb else 0,
            swap_percent=round(swap_used / swap_total * 100, 1) if swap_total else 0,
        ),
        disk=DetailedDisk(partitions=partitions, io_read_mb=io_read, io_write_mb=io_write),
        network=DetailedNetwork(interfaces=interfaces),
        docker=DockerSummary(running=docker_running, total=docker_total),
        system=SystemInfo(
            hostname=hostname, kernel=kernel,
            uptime_seconds=uptime_s, processes=procs,
        ),
    )


# =====================================================================
# 2. Services Management
# =====================================================================

_MANAGED_SERVICES = [
    "docker", "nginx", "postgresql", "redis-server", "fail2ban",
    "ufw", "cron", "ssh", "unattended-upgrades", "memcached",
]

_SERVICE_ACTION_ALLOWLIST = {"start", "stop", "restart", "enable", "disable"}


class ServiceStatus(BaseModel):
    name: str
    active: str = "unknown"
    enabled: str = "unknown"
    version: str = ""
    installed: bool = True


class ServiceActionRequest(BaseModel):
    action: str


@router.get("/{server_id}/services", response_model=list[ServiceStatus])
async def list_services(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List managed services with status on the server."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    checks = " && ".join(
        f"echo '---{svc}---' && "
        f"systemctl is-active {svc} 2>/dev/null || echo inactive && "
        f"systemctl is-enabled {svc} 2>/dev/null || echo disabled && "
        f"({svc} --version 2>/dev/null || {svc} -v 2>/dev/null || echo unknown) | head -1"
        for svc in _MANAGED_SERVICES
    )

    try:
        raw = await driver._ssh_exec(info, checks, timeout=30)
    except Exception as e:
        logger.error(f"Failed to list services for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    services = []
    blocks = raw.split("---")
    # blocks: ['', 'docker', '\nactive\nenabled\n...', 'nginx', '\n...', ...]
    i = 1
    while i < len(blocks) - 1:
        name = blocks[i].strip()
        data_lines = blocks[i + 1].strip().split("\n")
        active = data_lines[0].strip() if data_lines else "unknown"
        enabled = data_lines[1].strip() if len(data_lines) > 1 else "unknown"
        version = data_lines[2].strip() if len(data_lines) > 2 else ""

        # Service is not installed if inactive + version is missing/not-found/unknown
        not_installed = active != "active" and version in ("not-found", "unknown", "")
        services.append(ServiceStatus(
            name=name, active=active, enabled=enabled, version=version,
            installed=not not_installed,
        ))
        i += 2

    # Sort: installed first, then alphabetically
    services.sort(key=lambda s: (not s.installed, s.name))
    return services


@router.post("/{server_id}/services/{service_name}/action")
async def service_action(
    server_id: str,
    service_name: str,
    body: ServiceActionRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Perform an action on a managed service (start/stop/restart/enable/disable)."""
    if service_name not in _MANAGED_SERVICES:
        raise HTTPException(
            status_code=400,
            detail=f"Service '{service_name}' not in allowlist: {_MANAGED_SERVICES}",
        )
    if body.action not in _SERVICE_ACTION_ALLOWLIST:
        raise HTTPException(
            status_code=400,
            detail=f"Action '{body.action}' not allowed. Use: {sorted(_SERVICE_ACTION_ALLOWLIST)}",
        )

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        result = await driver._ssh_exec(
            info, f"systemctl {body.action} {service_name} && systemctl is-active {service_name} 2>/dev/null || true",
        )
    except Exception as e:
        logger.error(f"Service action failed for {service_name}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {
        "service": service_name,
        "action": body.action,
        "result": result.strip(),
    }


# =====================================================================
# 3. Firewall (UFW)
# =====================================================================

class FirewallRule(BaseModel):
    number: int = 0
    to: str = ""
    action: str = ""
    from_addr: str = ""
    comment: str = ""
    raw: str = ""


class FirewallStatus(BaseModel):
    enabled: bool = False
    default_policy: str = ""
    rules: list[FirewallRule] = []


class FirewallAddRequest(BaseModel):
    port: int
    protocol: str = "tcp"
    source: str | None = None
    action: str = "allow"
    comment: str | None = None


class FirewallToggleRequest(BaseModel):
    enabled: bool


@router.get("/{server_id}/firewall", response_model=FirewallStatus)
async def get_firewall(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get UFW firewall status and rules."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        raw = await driver._ssh_exec(info, "ufw status numbered 2>/dev/null && echo '===DEFAULT===' && ufw status verbose 2>/dev/null | grep 'Default:'")
    except Exception as e:
        logger.error(f"Failed to get firewall status for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    lines = raw.strip().split("\n")
    enabled = False
    default_policy = ""
    rules: list[FirewallRule] = []

    for line in lines:
        if line.startswith("Status:"):
            enabled = "active" in line.lower()
        elif "Default:" in line:
            default_policy = line.split("Default:")[-1].strip()
        elif line.strip().startswith("["):
            # Parse: [ 1] 22/tcp ALLOW IN Anywhere  # SSH
            import re
            m = re.match(
                r"\[\s*(\d+)\]\s+(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(?:IN\s+)?(.+?)(?:\s+#\s*(.*))?$",
                line.strip(),
            )
            if m:
                rules.append(FirewallRule(
                    number=int(m.group(1)),
                    to=m.group(2).strip(),
                    action=m.group(3).strip(),
                    from_addr=m.group(4).strip(),
                    comment=m.group(5).strip() if m.group(5) else "",
                    raw=line.strip(),
                ))

    return FirewallStatus(enabled=enabled, default_policy=default_policy, rules=rules)


@router.post("/{server_id}/firewall")
async def add_firewall_rule(
    server_id: str,
    body: FirewallAddRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Add a UFW firewall rule."""
    if body.protocol not in ("tcp", "udp", "any"):
        raise HTTPException(status_code=400, detail="Protocol must be tcp, udp, or any")
    if body.action not in ("allow", "deny"):
        raise HTTPException(status_code=400, detail="Action must be allow or deny")
    if not (1 <= body.port <= 65535):
        raise HTTPException(status_code=400, detail="Port must be between 1 and 65535")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    source = body.source or "any"
    proto_part = f" proto {body.protocol}" if body.protocol != "any" else ""
    comment_part = f" comment '{body.comment}'" if body.comment else ""
    cmd = f"ufw {body.action} from {source} to any port {body.port}{proto_part}{comment_part}"

    try:
        result = await driver._ssh_exec(info, cmd)
    except Exception as e:
        logger.error(f"Failed to add firewall rule for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": "Firewall rule added", "output": result.strip()}


@router.delete("/{server_id}/firewall/{rule_number}")
async def delete_firewall_rule(
    server_id: str,
    rule_number: int,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Delete a UFW firewall rule by number."""
    if rule_number < 1:
        raise HTTPException(status_code=400, detail="Rule number must be >= 1")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        result = await driver._ssh_exec(info, f"echo y | ufw delete {rule_number}")
    except Exception as e:
        logger.error(f"Failed to delete firewall rule {rule_number} for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": f"Firewall rule {rule_number} deleted", "output": result.strip()}


@router.post("/{server_id}/firewall/toggle")
async def toggle_firewall(
    server_id: str,
    body: FirewallToggleRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Enable or disable UFW firewall."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = "echo y | ufw enable" if body.enabled else "ufw disable"
    try:
        result = await driver._ssh_exec(info, cmd)
    except Exception as e:
        logger.error(f"Failed to toggle firewall for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"enabled": body.enabled, "output": result.strip()}


# =====================================================================
# 4. Cron Jobs
# =====================================================================

class CronJob(BaseModel):
    schedule: str = ""
    command: str = ""
    line_number: int = 0
    source: str = "user"


class CronAddRequest(BaseModel):
    schedule: str
    command: str


@router.get("/{server_id}/cron", response_model=list[CronJob])
async def list_cron_jobs(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List all cron jobs (user + system /etc/cron.d/)."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        raw = await driver._ssh_exec(
            info,
            "echo '===USER===' && crontab -l 2>/dev/null || true && "
            "echo '===SYSTEM===' && cat /etc/cron.d/* 2>/dev/null || true",
        )
    except Exception as e:
        logger.error(f"Failed to list cron jobs for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    jobs: list[CronJob] = []
    sections: dict[str, list[str]] = {}
    current = ""
    for line in raw.strip().split("\n"):
        if line.startswith("===") and line.endswith("==="):
            current = line.strip("=")
            sections[current] = []
        elif current:
            sections[current].append(line)

    # User crontab
    for idx, line in enumerate(sections.get("USER", []), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split(None, 5)
        if len(parts) >= 6:
            jobs.append(CronJob(
                schedule=" ".join(parts[:5]),
                command=parts[5],
                line_number=idx,
                source="user",
            ))

    # System cron.d
    for idx, line in enumerate(sections.get("SYSTEM", []), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split(None, 6)
        if len(parts) >= 7:
            # System cron has user field at position 5
            jobs.append(CronJob(
                schedule=" ".join(parts[:5]),
                command=f"({parts[5]}) {parts[6]}",
                line_number=idx,
                source="system",
            ))

    return jobs


@router.post("/{server_id}/cron", status_code=201)
async def add_cron_job(
    server_id: str,
    body: CronAddRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Add a new cron job to root's crontab."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    # Sanitize: no shell injection via schedule/command
    for ch in (";", "|", "`", "$(",):
        if ch in body.schedule:
            raise HTTPException(status_code=400, detail=f"Invalid character in schedule: {ch}")

    cron_line = f"{body.schedule} {body.command}"
    cmd = f'(crontab -l 2>/dev/null; echo "{cron_line}") | crontab -'

    try:
        result = await driver._ssh_exec(info, cmd)
    except Exception as e:
        logger.error(f"Failed to add cron job for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": "Cron job added", "cron_line": cron_line, "output": result.strip()}


@router.delete("/{server_id}/cron/{line_number}")
async def delete_cron_job(
    server_id: str,
    line_number: int,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Remove a specific line from root's crontab."""
    if line_number < 1:
        raise HTTPException(status_code=400, detail="Line number must be >= 1")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = f"crontab -l 2>/dev/null | sed '{line_number}d' | crontab -"
    try:
        result = await driver._ssh_exec(info, cmd)
    except Exception as e:
        logger.error(f"Failed to delete cron line {line_number} for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": f"Cron line {line_number} removed", "output": result.strip()}


# =====================================================================
# 5. Server Logs
# =====================================================================

_LOG_TYPE_MAP = {
    "syslog": "/var/log/syslog",
    "auth": "/var/log/auth.log",
    "nginx_access": "/var/log/nginx/access.log",
    "nginx_error": "/var/log/nginx/error.log",
    "fail2ban": "/var/log/fail2ban.log",
    "docker": "__journalctl_docker__",
    "postgresql": "/var/log/postgresql/*.log",
    "kern": "/var/log/kern.log",
}


class LogsResponse(BaseModel):
    type: str
    lines: list[str]
    total_lines: int = 0


@router.get("/{server_id}/logs", response_model=LogsResponse)
async def get_server_logs(
    server_id: str,
    type: str = "syslog",
    lines: int = 100,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Retrieve server logs by type."""
    if type not in _LOG_TYPE_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Log type '{type}' not supported. Use: {list(_LOG_TYPE_MAP.keys())}",
        )
    if lines < 1 or lines > 1000:
        raise HTTPException(status_code=400, detail="Lines must be between 1 and 1000")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    log_path = _LOG_TYPE_MAP[type]
    if log_path == "__journalctl_docker__":
        cmd = f"journalctl -u docker --no-pager -n {lines} 2>/dev/null || echo 'No docker journal'"
        count_cmd = "journalctl -u docker --no-pager 2>/dev/null | wc -l"
    elif "*" in log_path:
        # Glob pattern (postgresql)
        cmd = f"tail -n {lines} {log_path} 2>/dev/null || echo 'Log not found'"
        count_cmd = f"wc -l {log_path} 2>/dev/null | tail -1 | awk '{{print $1}}'"
    else:
        cmd = f"tail -n {lines} {log_path} 2>/dev/null || echo 'Log not found'"
        count_cmd = f"wc -l < {log_path} 2>/dev/null || echo 0"

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=30)
        total_raw = await driver._ssh_exec(info, count_cmd, timeout=10)
    except Exception as e:
        logger.error(f"Failed to get logs for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    log_lines = raw.strip().split("\n") if raw.strip() else []
    try:
        total = int(total_raw.strip())
    except ValueError:
        total = len(log_lines)

    return LogsResponse(type=type, lines=log_lines, total_lines=total)


# =====================================================================
# 6. Processes
# =====================================================================

class ProcessInfo(BaseModel):
    user: str = ""
    pid: int = 0
    cpu: float = 0
    mem: float = 0
    vsz: int = 0
    rss: int = 0
    tty: str = ""
    stat: str = ""
    start: str = ""
    time: str = ""
    command: str = ""


class ProcessListResponse(BaseModel):
    processes: list[ProcessInfo] = []
    load_average: str = ""
    total_processes: int = 0


class KillRequest(BaseModel):
    signal: str = "TERM"


@router.get("/{server_id}/processes", response_model=ProcessListResponse)
async def list_processes(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List top processes sorted by CPU usage."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        raw = await driver._ssh_exec(
            info,
            "echo '===LOAD===' && cat /proc/loadavg && "
            "echo '===COUNT===' && ls -d /proc/[0-9]* 2>/dev/null | wc -l && "
            "echo '===PS===' && ps aux --sort=-%cpu | head -31",
            timeout=15,
        )
    except Exception as e:
        logger.error(f"Failed to list processes for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    sections: dict[str, list[str]] = {}
    current = ""
    for line in raw.strip().split("\n"):
        if line.startswith("===") and line.endswith("==="):
            current = line.strip("=")
            sections[current] = []
        elif current:
            sections[current].append(line)

    load_avg = sections.get("LOAD", [""])[0].strip()
    try:
        total = int(sections.get("COUNT", ["0"])[0].strip())
    except ValueError:
        total = 0

    processes = []
    ps_lines = sections.get("PS", [])
    for line in ps_lines[1:]:  # skip header
        parts = line.split(None, 10)
        if len(parts) >= 11:
            try:
                processes.append(ProcessInfo(
                    user=parts[0], pid=int(parts[1]),
                    cpu=float(parts[2]), mem=float(parts[3]),
                    vsz=int(parts[4]), rss=int(parts[5]),
                    tty=parts[6], stat=parts[7],
                    start=parts[8], time=parts[9],
                    command=parts[10],
                ))
            except (ValueError, IndexError):
                continue

    return ProcessListResponse(
        processes=processes, load_average=load_avg, total_processes=total,
    )


@router.post("/{server_id}/processes/{pid}/kill")
async def kill_process(
    server_id: str,
    pid: int,
    body: KillRequest = KillRequest(),
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Kill a process by PID."""
    if body.signal not in ("TERM", "KILL"):
        raise HTTPException(status_code=400, detail="Signal must be TERM or KILL")
    if pid < 1:
        raise HTTPException(status_code=400, detail="PID must be a positive integer")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        result = await driver._ssh_exec(info, f"kill -{body.signal} {pid}")
    except Exception as e:
        logger.error(f"Failed to kill process {pid} on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": f"Signal {body.signal} sent to PID {pid}", "output": result.strip()}


# =====================================================================
# 7. SSH Keys Management
# =====================================================================

class SSHKeyEntry(BaseModel):
    index: int
    type: str = ""
    key_fingerprint: str = ""
    comment: str = ""
    full_key: str = ""


class SSHKeyAddRequest(BaseModel):
    public_key: str


@router.get("/{server_id}/ssh-keys", response_model=list[SSHKeyEntry])
async def list_ssh_keys(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List authorized SSH keys on the server."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        raw = await driver._ssh_exec(
            info, "cat /root/.ssh/authorized_keys 2>/dev/null || echo ''",
        )
    except Exception as e:
        logger.error(f"Failed to list SSH keys for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    keys = []
    for idx, line in enumerate(raw.strip().split("\n"), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 2)
        key_type = parts[0] if parts else ""
        key_data = parts[1] if len(parts) > 1 else ""
        comment = parts[2] if len(parts) > 2 else ""
        fingerprint = key_data[-20:] if key_data else ""
        keys.append(SSHKeyEntry(
            index=idx, type=key_type, key_fingerprint=fingerprint,
            comment=comment, full_key=line,
        ))

    return keys


@router.post("/{server_id}/ssh-keys", status_code=201)
async def add_ssh_key(
    server_id: str,
    body: SSHKeyAddRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Add a public SSH key to authorized_keys."""
    key = body.public_key.strip()
    if not key.startswith(("ssh-", "ecdsa-", "sk-")):
        raise HTTPException(status_code=400, detail="Invalid SSH public key format")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    # Escape single quotes in the key
    safe_key = key.replace("'", "'\\''")
    cmd = f"echo '{safe_key}' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"

    try:
        await driver._ssh_exec(info, cmd)
    except Exception as e:
        logger.error(f"Failed to add SSH key for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": "SSH key added"}


@router.delete("/{server_id}/ssh-keys/{index}")
async def delete_ssh_key(
    server_id: str,
    index: int,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Remove an SSH key by line index from authorized_keys."""
    if index < 1:
        raise HTTPException(status_code=400, detail="Index must be >= 1")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = f"sed -i '{index}d' /root/.ssh/authorized_keys"
    try:
        await driver._ssh_exec(info, cmd)
    except Exception as e:
        logger.error(f"Failed to delete SSH key {index} for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": f"SSH key at line {index} removed"}


# =====================================================================
# 8. PostgreSQL Management
# =====================================================================

_PG_CONFIG_ALLOWLIST = {
    "max_connections", "shared_buffers", "effective_cache_size", "work_mem",
    "maintenance_work_mem", "wal_buffers", "checkpoint_completion_target",
    "max_wal_size", "min_wal_size", "max_worker_processes",
    "max_parallel_workers", "random_page_cost", "effective_io_concurrency",
    "default_statistics_target", "huge_pages", "idle_session_timeout",
}


class PGDatabase(BaseModel):
    name: str
    size_bytes: int = 0
    size_human: str = ""


class PGConfigParam(BaseModel):
    name: str
    setting: str = ""
    unit: str = ""
    description: str = ""
    category: str = ""


class PGConfigUpdateRequest(BaseModel):
    params: dict[str, str]


class PGDatabaseStats(BaseModel):
    name: str
    size_bytes: int = 0
    size_human: str = ""
    table_count: int = 0
    active_connections: int = 0
    cache_hit_ratio: float = 0


@router.get("/{server_id}/databases", response_model=list[PGDatabase])
async def list_databases(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List PostgreSQL databases on the server."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "sudo -u postgres psql -t -A -c "
        "\"SELECT datname, pg_database_size(datname), "
        "pg_size_pretty(pg_database_size(datname)) "
        "FROM pg_database WHERE datistemplate=false ORDER BY datname\" 2>/dev/null"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Failed to list databases for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    databases = []
    for line in raw.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) >= 3:
            databases.append(PGDatabase(
                name=parts[0].strip(),
                size_bytes=int(parts[1].strip()) if parts[1].strip().isdigit() else 0,
                size_human=parts[2].strip(),
            ))

    return databases


@router.get("/{server_id}/postgres-config", response_model=list[PGConfigParam])
async def get_postgres_config(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get key PostgreSQL configuration parameters."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    params_list = "','".join(sorted(_PG_CONFIG_ALLOWLIST))
    cmd = (
        f"sudo -u postgres psql -t -A -c "
        f"\"SELECT name, setting, COALESCE(unit,''), short_desc, category "
        f"FROM pg_settings WHERE name IN ('{params_list}') ORDER BY name\" 2>/dev/null"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Failed to get postgres config for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    params = []
    for line in raw.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) >= 5:
            params.append(PGConfigParam(
                name=parts[0].strip(),
                setting=parts[1].strip(),
                unit=parts[2].strip(),
                description=parts[3].strip(),
                category=parts[4].strip(),
            ))

    return params


@router.patch("/{server_id}/postgres-config")
async def update_postgres_config(
    server_id: str,
    body: PGConfigUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update PostgreSQL configuration parameters."""
    # Validate all param names
    invalid = set(body.params.keys()) - _PG_CONFIG_ALLOWLIST
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"Parameters not in allowlist: {sorted(invalid)}",
        )

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    alter_cmds = " ".join(
        f"ALTER SYSTEM SET {name} = '{value}';"
        for name, value in body.params.items()
    )
    cmd = (
        f"sudo -u postgres psql -c \"{alter_cmds} SELECT pg_reload_conf();\" 2>/dev/null"
    )

    try:
        result = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Failed to update postgres config for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {
        "detail": "PostgreSQL configuration updated and reloaded",
        "params_updated": list(body.params.keys()),
        "output": result.strip(),
    }


@router.get("/{server_id}/databases/{db_name}/stats", response_model=PGDatabaseStats)
async def get_database_stats(
    server_id: str,
    db_name: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get detailed statistics for a specific PostgreSQL database."""
    # Validate db_name - only alphanumeric, underscore, hyphen
    import re
    if not re.match(r"^[a-zA-Z0-9_-]+$", db_name):
        raise HTTPException(status_code=400, detail="Invalid database name")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        f"sudo -u postgres psql -t -A -d {db_name} -c \""
        f"SELECT pg_database_size('{db_name}'), "
        f"pg_size_pretty(pg_database_size('{db_name}')), "
        f"(SELECT count(*) FROM information_schema.tables WHERE table_schema='public'), "
        f"(SELECT count(*) FROM pg_stat_activity WHERE datname='{db_name}'), "
        f"COALESCE((SELECT round(sum(heap_blks_hit)*100.0/NULLIF(sum(heap_blks_hit)+sum(heap_blks_read),0),2) FROM pg_statio_user_tables), 0)"
        f"\" 2>/dev/null"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Failed to get db stats for {db_name} on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    parts = raw.strip().split("|")
    return PGDatabaseStats(
        name=db_name,
        size_bytes=int(parts[0]) if parts and parts[0].strip().isdigit() else 0,
        size_human=parts[1].strip() if len(parts) > 1 else "",
        table_count=int(parts[2]) if len(parts) > 2 and parts[2].strip().isdigit() else 0,
        active_connections=int(parts[3]) if len(parts) > 3 and parts[3].strip().isdigit() else 0,
        cache_hit_ratio=float(parts[4]) if len(parts) > 4 else 0,
    )


# =====================================================================
# 9. Activity Log
# =====================================================================

class ActivityEntry(BaseModel):
    timestamp: str = ""
    type: str = ""
    message: str = ""
    source: str = ""


class ActivityResponse(BaseModel):
    entries: list[ActivityEntry] = []


@router.get("/{server_id}/activity", response_model=ActivityResponse)
async def get_server_activity(
    server_id: str,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get server activity/audit log from journalctl and auth.log."""
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="Limit must be between 1 and 500")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        f"echo '===JOURNAL===' && "
        f"journalctl --no-pager -n {limit} -o short-iso 2>/dev/null | tail -n {limit} && "
        f"echo '===AUTH===' && "
        f"grep -i 'accepted\\|failed\\|session opened\\|session closed' /var/log/auth.log 2>/dev/null | tail -n {min(limit, 30)}"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=30)
    except Exception as e:
        logger.error(f"Failed to get activity for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    entries: list[ActivityEntry] = []
    sections: dict[str, list[str]] = {}
    current = ""
    for line in raw.strip().split("\n"):
        if line.startswith("===") and line.endswith("==="):
            current = line.strip("=")
            sections[current] = []
        elif current:
            sections[current].append(line)

    for line in sections.get("JOURNAL", []):
        parts = line.split(None, 3)
        if len(parts) >= 4:
            entries.append(ActivityEntry(
                timestamp=parts[0],
                type="system",
                message=parts[3] if len(parts) > 3 else "",
                source=parts[2].rstrip(":") if len(parts) > 2 else "",
            ))

    for line in sections.get("AUTH", []):
        parts = line.split(None, 5)
        ts = " ".join(parts[:3]) if len(parts) >= 3 else ""
        msg = parts[5] if len(parts) > 5 else line
        auth_type = "ssh_login"
        if "failed" in line.lower():
            auth_type = "ssh_failed"
        elif "session closed" in line.lower():
            auth_type = "session_closed"
        elif "session opened" in line.lower():
            auth_type = "session_opened"
        entries.append(ActivityEntry(
            timestamp=ts, type=auth_type, message=msg, source="auth.log",
        ))

    return ActivityResponse(entries=entries)


# =====================================================================
# 10. Server Settings Update
# =====================================================================

class ServerSettingsUpdate(BaseModel):
    name: str | None = None
    region: str | None = None
    ssh_port: int | None = None
    auto_os_updates: bool | None = None
    geoip: bool | None = None


@router.patch("/{server_id}/settings")
async def update_server_settings(
    server_id: str,
    body: ServerSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update server settings (DB + optional SSH-based changes)."""
    result = await db.execute(
        select(Server).where(
            Server.id == server_id, Server.owner_id == user["telegram_id"],
        )
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")

    changes: list[str] = []

    # DB-only updates
    if body.name is not None:
        srv.name = body.name
        changes.append("name")
    if body.region is not None:
        srv.region = body.region
        changes.append("region")
    if body.ssh_port is not None:
        if not (1 <= body.ssh_port <= 65535):
            raise HTTPException(status_code=400, detail="SSH port must be 1-65535")
        srv.meta = {**(srv.meta or {}), "ssh_port": body.ssh_port}
        changes.append("ssh_port")

    # SSH-based updates (VM only)
    if srv.server_type == "vm" and (body.auto_os_updates is not None or body.geoip is not None):
        driver: VMDriver = _drivers["vm"]
        info = _to_server_info(srv)

        if body.auto_os_updates is not None:
            try:
                if body.auto_os_updates:
                    cmd = "apt-get install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades"
                else:
                    cmd = "systemctl stop unattended-upgrades && systemctl disable unattended-upgrades"
                await driver._ssh_exec(info, cmd, timeout=60)
                changes.append("auto_os_updates")
            except Exception as e:
                logger.error(f"Failed to toggle auto updates for {server_id}: {e}")

        if body.geoip is not None:
            try:
                if body.geoip:
                    cmd = "apt-get install -y geoip-database geoip-bin"
                else:
                    cmd = "apt-get remove -y geoip-database geoip-bin"
                await driver._ssh_exec(info, cmd, timeout=60)
                changes.append("geoip")
            except Exception as e:
                logger.error(f"Failed to toggle geoip for {server_id}: {e}")

    await db.commit()
    return {"detail": "Settings updated", "changes": changes}


# =====================================================================
# 11. Uptime Check
# =====================================================================

class RebootEntry(BaseModel):
    timestamp: str = ""
    details: str = ""


class UptimeResponse(BaseModel):
    uptime_text: str = ""
    uptime_seconds: int = 0
    last_boot: str = ""
    reboot_history: list[RebootEntry] = []


@router.get("/{server_id}/uptime", response_model=UptimeResponse)
async def get_uptime(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get server uptime details and reboot history."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        raw = await driver._ssh_exec(
            info,
            "echo '===UPTIME===' && uptime && "
            "echo '===SECONDS===' && awk '{print int($1)}' /proc/uptime && "
            "echo '===BOOT===' && who -b 2>/dev/null | awk '{print $3, $4}' && "
            "echo '===REBOOTS===' && last reboot 2>/dev/null | head -5",
            timeout=15,
        )
    except Exception as e:
        logger.error(f"Failed to get uptime for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    sections: dict[str, list[str]] = {}
    current = ""
    for line in raw.strip().split("\n"):
        if line.startswith("===") and line.endswith("==="):
            current = line.strip("=")
            sections[current] = []
        elif current:
            sections[current].append(line)

    uptime_text = sections.get("UPTIME", [""])[0].strip()
    try:
        uptime_secs = int(sections.get("SECONDS", ["0"])[0].strip())
    except ValueError:
        uptime_secs = 0
    last_boot = sections.get("BOOT", [""])[0].strip()

    reboots = []
    for line in sections.get("REBOOTS", []):
        stripped = line.strip()
        if stripped and not stripped.startswith("wtmp"):
            parts = stripped.split(None, 2)
            ts = parts[2] if len(parts) > 2 else ""
            reboots.append(RebootEntry(timestamp=ts, details=stripped))

    return UptimeResponse(
        uptime_text=uptime_text,
        uptime_seconds=uptime_secs,
        last_boot=last_boot,
        reboot_history=reboots,
    )


# ─── Hardware Upgrade ──────────────────────────────────────────────

class UpgradePlan(BaseModel):
    id: int | str = ""
    name: str
    cores: int
    memory_gb: float
    disk_gb: int
    disk_type: str = "NVMe"
    price_monthly: float = 0
    price_hourly: float = 0
    cpu_type: str = "shared"
    plan_category: str = ""
    is_current: bool = False
    is_upgrade: bool = False


class UpgradePlansResponse(BaseModel):
    current_plan: str
    provider: str
    plans: list[UpgradePlan]


class ResizeRequest(BaseModel):
    target_plan: str
    upgrade_disk: bool = True


class ResizeResponse(BaseModel):
    success: bool
    message: str


@router.get("/{server_id}/upgrade-plans", response_model=UpgradePlansResponse)
async def get_upgrade_plans(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List available hardware upgrade plans for a server."""
    from core.cloud_providers.hetzner import HetznerClient
    from core.cloud_providers.digitalocean import DigitalOceanClient
    from core.cloud_providers.vultr import VultrClient
    from core.cloud_providers.linode import LinodeClient
    from core.config import settings as app_settings

    srv = await _get_owned_vm_server(server_id, db, user)
    provider = srv.provider
    current_plan = (srv.meta or {}).get("provider_plan", "")

    plans: list[UpgradePlan] = []

    try:
        if provider == "hetzner" and app_settings.hetzner_api_token:
            client = HetznerClient(app_settings.hetzner_api_token)
            raw = await client.list_server_types()
            for p in raw:
                specs = (srv.meta or {}).get("specs", {})
                is_current = p["name"] == current_plan
                is_upgrade = (p["cores"] > specs.get("cpu_cores", 0) or
                              p["memory_gb"] > specs.get("ram_mb", 0) / 1024)
                plans.append(UpgradePlan(
                    id=p["id"], name=p["name"], cores=p["cores"],
                    memory_gb=p["memory_gb"], disk_gb=p["disk_gb"],
                    disk_type=p.get("disk_type", "NVMe"),
                    price_monthly=p["price_monthly"], price_hourly=p["price_hourly"],
                    cpu_type=p.get("cpu_type", "shared"),
                    plan_category=p.get("plan_category", ""),
                    is_current=is_current, is_upgrade=is_upgrade and not is_current,
                ))
        elif provider == "digitalocean" and app_settings.digitalocean_api_token:
            client = DigitalOceanClient(app_settings.digitalocean_api_token)
            raw = await client.list_sizes()
            specs = (srv.meta or {}).get("specs", {})
            for p in raw:
                is_current = p["name"] == current_plan
                is_upgrade = (p["cores"] > specs.get("cpu_cores", 0) or
                              p["memory_gb"] > specs.get("ram_mb", 0) / 1024)
                plans.append(UpgradePlan(
                    id=p.get("id", ""), name=p["name"], cores=p["cores"],
                    memory_gb=p["memory_gb"], disk_gb=p["disk_gb"],
                    price_monthly=p.get("price_monthly", 0),
                    is_current=is_current, is_upgrade=is_upgrade and not is_current,
                ))
        else:
            raise HTTPException(status_code=400, detail=f"Upgrade plans not available for provider: {provider}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch upgrade plans for {server_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch upgrade plans")

    return UpgradePlansResponse(current_plan=current_plan, provider=provider, plans=plans)


@router.post("/{server_id}/resize", response_model=ResizeResponse)
async def resize_server(
    server_id: str,
    body: ResizeRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Resize a cloud server to a new plan. Requires server power-off."""
    from core.cloud_providers.hetzner import HetznerClient
    from core.config import settings as app_settings

    srv = await _get_owned_vm_server(server_id, db, user)
    provider = srv.provider
    provider_id = (srv.meta or {}).get("provider_id")

    if not provider_id:
        raise HTTPException(status_code=400, detail="Server has no cloud provider ID — manual servers cannot be resized")

    try:
        if provider == "hetzner" and app_settings.hetzner_api_token:
            client = HetznerClient(app_settings.hetzner_api_token)
            # Power off first
            await client.power_off_server(int(provider_id))
            import asyncio
            await asyncio.sleep(5)
            # Resize
            await client.resize_server(int(provider_id), body.target_plan, body.upgrade_disk)
            # Wait and power on
            await asyncio.sleep(10)
            await client.power_on_server(int(provider_id))
            # Update meta
            srv.meta = {**(srv.meta or {}), "provider_plan": body.target_plan}
            await db.commit()
            return ResizeResponse(success=True, message=f"Server resized to {body.target_plan}. It will be back online shortly.")
        else:
            raise HTTPException(status_code=400, detail=f"Resize not supported for provider: {provider}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to resize server {server_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Resize failed: {str(e)}")


# =====================================================================
# Fail2ban Management
# =====================================================================

_IP_RE = re.compile(r"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$")
_DOMAIN_RE = re.compile(
    r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$"
)
_JAIL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_ip(ip: str) -> str:
    ip = ip.strip()
    if not _IP_RE.match(ip):
        raise HTTPException(status_code=422, detail=f"Invalid IP address: {ip}")
    return ip


def _validate_domain(domain: str) -> str:
    domain = domain.strip()
    if not _DOMAIN_RE.match(domain) or len(domain) > 253:
        raise HTTPException(status_code=422, detail=f"Invalid domain name: {domain}")
    return domain


def _validate_jail_name(jail: str) -> str:
    jail = jail.strip()
    if not _JAIL_NAME_RE.match(jail) or len(jail) > 64:
        raise HTTPException(status_code=422, detail=f"Invalid jail name: {jail}")
    return jail


class Fail2banJail(BaseModel):
    name: str
    currently_failed: int = 0
    total_failed: int = 0
    currently_banned: int = 0
    total_banned: int = 0
    banned_ips: list[str] = Field(default_factory=list)
    filter_file: str = ""
    findtime: str = ""
    bantime: str = ""
    maxretry: int = 0


class Fail2banStatus(BaseModel):
    active: bool
    jails: list[Fail2banJail] = Field(default_factory=list)


def _parse_fail2ban_output(raw: str) -> Fail2banStatus:
    """Parse the combined fail2ban SSH output into structured data."""
    if "NOT_RUNNING" in raw and "===JAILS===" not in raw:
        return Fail2banStatus(active=False, jails=[])

    sections: dict[str, str] = {}
    for section_name in ("STATUS", "JAILS", "CONFIG"):
        marker = f"==={section_name}==="
        if marker in raw:
            start = raw.index(marker) + len(marker)
            # Find the next section marker or end
            end = len(raw)
            for other in ("STATUS", "JAILS", "CONFIG"):
                other_marker = f"==={other}==="
                if other != section_name and other_marker in raw[start:]:
                    candidate = start + raw[start:].index(other_marker)
                    if candidate < end:
                        end = candidate
            sections[section_name] = raw[start:end].strip()

    status_text = sections.get("STATUS", "")
    active = "NOT_RUNNING" not in status_text

    if not active:
        return Fail2banStatus(active=False, jails=[])

    # Parse individual jails from JAILS section
    jails_text = sections.get("JAILS", "")
    jails: list[Fail2banJail] = []

    jail_blocks = jails_text.split("---")
    # Pattern: ['', 'jail_name', '\n...status output...', 'jail_name2', ...]
    i = 1
    while i < len(jail_blocks):
        jail_name = jail_blocks[i].strip()
        if not jail_name:
            i += 1
            continue
        jail_data = jail_blocks[i + 1].strip() if i + 1 < len(jail_blocks) else ""
        i += 2

        currently_failed = 0
        total_failed = 0
        currently_banned = 0
        total_banned = 0
        banned_ips: list[str] = []
        filter_file = ""

        for line in jail_data.split("\n"):
            line = line.strip()
            if "Currently failed:" in line:
                try:
                    currently_failed = int(line.split("Currently failed:")[-1].strip())
                except ValueError:
                    pass
            elif "Total failed:" in line:
                try:
                    total_failed = int(line.split("Total failed:")[-1].strip())
                except ValueError:
                    pass
            elif "Currently banned:" in line:
                try:
                    currently_banned = int(line.split("Currently banned:")[-1].strip())
                except ValueError:
                    pass
            elif "Total banned:" in line:
                try:
                    total_banned = int(line.split("Total banned:")[-1].strip())
                except ValueError:
                    pass
            elif "Banned IP list:" in line:
                ip_list = line.split("Banned IP list:")[-1].strip()
                if ip_list:
                    banned_ips = [ip.strip() for ip in ip_list.split() if ip.strip()]
            elif "File list:" in line:
                filter_file = line.split("File list:")[-1].strip()

        jails.append(Fail2banJail(
            name=jail_name,
            currently_failed=currently_failed,
            total_failed=total_failed,
            currently_banned=currently_banned,
            total_banned=total_banned,
            banned_ips=banned_ips,
            filter_file=filter_file,
        ))

    return Fail2banStatus(active=active, jails=jails)


@router.get("/{server_id}/fail2ban", response_model=Fail2banStatus)
async def get_fail2ban_status(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get fail2ban status and jail details."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "echo '===STATUS==='; fail2ban-client status 2>/dev/null || echo 'NOT_RUNNING'; "
        "echo '===JAILS==='; for jail in $(fail2ban-client status 2>/dev/null | "
        "grep 'Jail list:' | sed 's/.*://;s/,/ /g'); do "
        "echo \"---$jail---\"; fail2ban-client status $jail 2>/dev/null; done; "
        "echo '===CONFIG==='; grep -vE '^\\s*(#|$)' /etc/fail2ban/jail.local 2>/dev/null || "
        "grep -vE '^\\s*(#|$)' /etc/fail2ban/jail.conf 2>/dev/null | head -50"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=30)
    except Exception as e:
        logger.error(f"Failed to get fail2ban status for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return _parse_fail2ban_output(raw)


class Fail2banIpAction(BaseModel):
    ip: str


@router.post("/{server_id}/fail2ban/{jail}/unban")
async def fail2ban_unban_ip(
    server_id: str,
    jail: str,
    body: Fail2banIpAction,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Unban an IP address from a specific fail2ban jail."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    ip = _validate_ip(body.ip)
    jail = _validate_jail_name(jail)

    cmd = f"fail2ban-client set {shlex.quote(jail)} unbanip {shlex.quote(ip)}"

    try:
        result = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Failed to unban {ip} from {jail} on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"success": True, "message": f"IP {ip} unbanned from jail {jail}", "output": result.strip()}


@router.post("/{server_id}/fail2ban/{jail}/ban")
async def fail2ban_ban_ip(
    server_id: str,
    jail: str,
    body: Fail2banIpAction,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Ban an IP address in a specific fail2ban jail."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    ip = _validate_ip(body.ip)
    jail = _validate_jail_name(jail)

    cmd = f"fail2ban-client set {shlex.quote(jail)} banip {shlex.quote(ip)}"

    try:
        result = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Failed to ban {ip} in {jail} on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"success": True, "message": f"IP {ip} banned in jail {jail}", "output": result.strip()}


class Fail2banToggle(BaseModel):
    enabled: bool


@router.post("/{server_id}/fail2ban/toggle")
async def fail2ban_toggle(
    server_id: str,
    body: Fail2banToggle,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Enable or disable fail2ban service."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    if body.enabled:
        cmd = "systemctl start fail2ban && systemctl enable fail2ban && echo 'OK'"
    else:
        cmd = "systemctl stop fail2ban && systemctl disable fail2ban && echo 'OK'"

    try:
        result = await driver._ssh_exec(info, cmd, timeout=30)
    except Exception as e:
        action = "enable" if body.enabled else "disable"
        logger.error(f"Failed to {action} fail2ban on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    action = "enabled" if body.enabled else "disabled"
    return {"success": True, "message": f"Fail2ban {action} successfully", "output": result.strip()}


# =====================================================================
# SSL / Let's Encrypt Management
# =====================================================================

class SslCertificate(BaseModel):
    domain: str
    issuer: str = "Let's Encrypt"
    expiry_date: str = ""
    days_remaining: int = 0
    auto_renew: bool = True
    status: str = "valid"  # "valid", "expiring_soon", "expired"


class SslStatus(BaseModel):
    certbot_installed: bool
    certificates: list[SslCertificate] = Field(default_factory=list)
    auto_renewal_active: bool = False


def _parse_ssl_output(raw: str) -> SslStatus:
    """Parse the combined SSL/certbot SSH output into structured data."""
    if "CERTBOT_NOT_FOUND" in raw:
        return SslStatus(certbot_installed=False, certificates=[], auto_renewal_active=False)

    sections: dict[str, str] = {}
    for section_name in ("CERTS", "NGINX_SSL", "EXPIRY"):
        marker = f"==={section_name}==="
        if marker in raw:
            start = raw.index(marker) + len(marker)
            end = len(raw)
            for other in ("CERTS", "NGINX_SSL", "EXPIRY"):
                other_marker = f"==={other}==="
                if other != section_name and other_marker in raw[start:]:
                    candidate = start + raw[start:].index(other_marker)
                    if candidate < end:
                        end = candidate
            sections[section_name] = raw[start:end].strip()

    # Parse expiry dates from the EXPIRY section (most reliable)
    expiry_section = sections.get("EXPIRY", "")
    cert_map: dict[str, SslCertificate] = {}

    now = datetime.now(timezone.utc)

    # Parse from EXPIRY section: ---domain--- \n notAfter=...
    expiry_blocks = expiry_section.split("---")
    i = 1
    while i < len(expiry_blocks):
        domain = expiry_blocks[i].strip()
        if not domain:
            i += 1
            continue
        expiry_data = expiry_blocks[i + 1].strip() if i + 1 < len(expiry_blocks) else ""
        i += 2

        expiry_date = ""
        days_remaining = 0
        status = "valid"

        for line in expiry_data.split("\n"):
            line = line.strip()
            if line.startswith("notAfter="):
                date_str = line.replace("notAfter=", "").strip()
                expiry_date = date_str
                # Parse the date to calculate days remaining
                # OpenSSL format: "Mar 15 12:00:00 2026 GMT"
                try:
                    expiry_dt = datetime.strptime(date_str, "%b %d %H:%M:%S %Y %Z")
                    expiry_dt = expiry_dt.replace(tzinfo=timezone.utc)
                    delta = expiry_dt - now
                    days_remaining = max(0, delta.days)
                    if days_remaining <= 0:
                        status = "expired"
                    elif days_remaining <= 30:
                        status = "expiring_soon"
                    else:
                        status = "valid"
                except (ValueError, TypeError):
                    pass

        cert_map[domain] = SslCertificate(
            domain=domain,
            expiry_date=expiry_date,
            days_remaining=days_remaining,
            status=status,
        )

    # Also parse from CERTS section (certbot certificates output)
    certs_section = sections.get("CERTS", "")
    current_domain = ""
    for line in certs_section.split("\n"):
        line = line.strip()
        if line.startswith("Certificate Name:"):
            current_domain = line.split(":", 1)[-1].strip()
        elif line.startswith("Domains:") and current_domain:
            domains_str = line.split(":", 1)[-1].strip()
            # If this domain is not already in our map, add it
            if current_domain not in cert_map:
                cert_map[current_domain] = SslCertificate(domain=current_domain)
        elif line.startswith("Expiry Date:") and current_domain and current_domain in cert_map:
            # "Expiry Date: 2026-06-13 (VALID: 89 days)"
            parts = line.split(":", 1)[-1].strip()
            cert_map[current_domain].expiry_date = parts
            if "VALID:" in parts:
                try:
                    days_str = parts.split("VALID:")[1].strip().split()[0]
                    cert_map[current_domain].days_remaining = int(days_str)
                    cert_map[current_domain].status = (
                        "expiring_soon" if int(days_str) <= 30 else "valid"
                    )
                except (ValueError, IndexError):
                    pass
            elif "EXPIRED" in parts.upper():
                cert_map[current_domain].status = "expired"
                cert_map[current_domain].days_remaining = 0

    # Check if auto-renewal timer is active (certbot sets up a systemd timer)
    auto_renewal = "certbot.timer" in raw or "renewal" in certs_section.lower()

    return SslStatus(
        certbot_installed=True,
        certificates=list(cert_map.values()),
        auto_renewal_active=auto_renewal,
    )


@router.get("/{server_id}/ssl", response_model=SslStatus)
async def get_ssl_status(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List all SSL certificates on the server."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "echo '===CERTS==='; "
        "certbot certificates 2>/dev/null || echo 'CERTBOT_NOT_FOUND'; "
        "echo '===NGINX_SSL==='; "
        "grep -rl 'ssl_certificate' /etc/nginx/sites-enabled/ 2>/dev/null | "
        "while read f; do echo \"---$f---\"; grep -E 'server_name|ssl_certificate' \"$f\" 2>/dev/null; done; "
        "echo '===EXPIRY==='; "
        "for cert in /etc/letsencrypt/live/*/fullchain.pem; do "
        "echo \"---$(dirname $cert | xargs basename)---\"; "
        "openssl x509 -enddate -noout -in \"$cert\" 2>/dev/null; done"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=30)
    except Exception as e:
        logger.error(f"Failed to get SSL status for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return _parse_ssl_output(raw)


class SslIssueRequest(BaseModel):
    domain: str
    webroot: str = "/var/www/html"
    email: str


@router.post("/{server_id}/ssl/issue")
async def ssl_issue_certificate(
    server_id: str,
    body: SslIssueRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Issue a new Let's Encrypt certificate via certbot."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    domain = _validate_domain(body.domain)
    # Validate email loosely
    email = body.email.strip()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email) or len(email) > 254:
        raise HTTPException(status_code=422, detail=f"Invalid email address: {email}")

    cmd = (
        f"certbot certonly --nginx -d {shlex.quote(domain)} "
        f"--non-interactive --agree-tos --email {shlex.quote(email)} 2>&1"
    )

    try:
        result = await driver._ssh_exec(info, cmd, timeout=120)
    except Exception as e:
        logger.error(f"Failed to issue SSL for {domain} on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    success = "successfully" in result.lower() or "congratulations" in result.lower()
    return {
        "success": success,
        "domain": domain,
        "message": "Certificate issued successfully" if success else "Certificate issuance may have failed — check output",
        "output": result.strip(),
    }


@router.post("/{server_id}/ssl/renew")
async def ssl_renew_certificates(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Force renew all Let's Encrypt certificates."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = "certbot renew --force-renewal 2>&1"

    try:
        result = await driver._ssh_exec(info, cmd, timeout=120)
    except Exception as e:
        logger.error(f"Failed to renew SSL on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"success": True, "message": "Certificate renewal completed", "output": result.strip()}


@router.delete("/{server_id}/ssl/{domain}")
async def ssl_revoke_certificate(
    server_id: str,
    domain: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Revoke and delete a Let's Encrypt certificate."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    domain = _validate_domain(domain)

    cmd = f"certbot revoke --cert-name {shlex.quote(domain)} --delete-after-revoke --non-interactive 2>&1"

    try:
        result = await driver._ssh_exec(info, cmd, timeout=60)
    except Exception as e:
        logger.error(f"Failed to revoke SSL for {domain} on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    success = "congratulations" in result.lower() or "revoked" in result.lower()
    return {
        "success": success,
        "domain": domain,
        "message": f"Certificate for {domain} revoked and deleted" if success else "Revocation may have failed — check output",
        "output": result.strip(),
    }


@router.post("/{server_id}/ssl/install-certbot")
async def ssl_install_certbot(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Install certbot and nginx plugin on the server."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = "apt-get update -qq && apt-get install -y certbot python3-certbot-nginx 2>&1"

    try:
        result = await driver._ssh_exec(info, cmd, timeout=120)
    except Exception as e:
        logger.error(f"Failed to install certbot on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    success = "is already the newest version" in result or "newly installed" in result.lower() or "setting up certbot" in result.lower()
    return {
        "success": success,
        "message": "Certbot installed successfully" if success else "Installation may have encountered issues — check output",
        "output": result.strip(),
    }


# =====================================================================
# 16. Nginx Sites Management
# =====================================================================

class NginxSite(BaseModel):
    name: str = ""
    enabled: bool = False
    config_file: str = ""
    domains: list[str] = []
    ssl: bool = False
    root: str = ""

class NginxSiteConfig(BaseModel):
    config: str = ""

@router.get("/{server_id}/nginx/sites", response_model=list[NginxSite])
async def list_nginx_sites(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List all Nginx virtual hosts (sites-available vs sites-enabled)."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "for f in /etc/nginx/sites-available/*; do "
        "  name=$(basename \"$f\"); "
        "  enabled='false'; "
        "  [ -L \"/etc/nginx/sites-enabled/$name\" ] && enabled='true'; "
        "  domains=$(grep -oP 'server_name\\s+\\K[^;]+' \"$f\" 2>/dev/null | head -1 || echo ''); "
        "  ssl=$(grep -c 'ssl_certificate' \"$f\" 2>/dev/null || echo 0); "
        "  root=$(grep -oP 'root\\s+\\K[^;]+' \"$f\" 2>/dev/null | head -1 || echo ''); "
        "  echo \"===SITE===$name||$enabled||$domains||$ssl||$root\"; "
        "done 2>/dev/null || echo 'NO_NGINX'"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Failed to list nginx sites for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    if "NO_NGINX" in raw:
        return []

    sites = []
    for line in raw.strip().split("\n"):
        if "===SITE===" not in line:
            continue
        parts = line.split("===SITE===")[1].split("||")
        if len(parts) < 5:
            continue
        name = parts[0].strip()
        enabled = parts[1].strip() == "true"
        domains = [d.strip() for d in parts[2].strip().split() if d.strip() and d.strip() != "_"]
        ssl = int(parts[3].strip()) > 0
        root = parts[4].strip()
        sites.append(NginxSite(name=name, enabled=enabled, config_file=f"/etc/nginx/sites-available/{name}", domains=domains, ssl=ssl, root=root))

    return sites


@router.get("/{server_id}/nginx/sites/{site_name}/config")
async def get_nginx_site_config(
    server_id: str,
    site_name: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get the Nginx configuration file content for a site."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    safe_name = shlex.quote(site_name)
    cmd = f"cat /etc/nginx/sites-available/{safe_name} 2>/dev/null || echo 'FILE_NOT_FOUND'"

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=10)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    if raw.strip() == "FILE_NOT_FOUND":
        raise HTTPException(status_code=404, detail=f"Site config '{site_name}' not found")

    return {"name": site_name, "config": raw}


@router.post("/{server_id}/nginx/sites/{site_name}/toggle")
async def toggle_nginx_site(
    server_id: str,
    site_name: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Enable or disable an Nginx site (symlink toggle + nginx reload)."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    safe_name = shlex.quote(site_name)
    check_cmd = f"[ -L /etc/nginx/sites-enabled/{safe_name} ] && echo ENABLED || echo DISABLED"

    try:
        status = (await driver._ssh_exec(info, check_cmd, timeout=5)).strip()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    if status == "ENABLED":
        cmd = f"rm /etc/nginx/sites-enabled/{safe_name} && nginx -t 2>&1 && systemctl reload nginx"
        action = "disabled"
    else:
        cmd = f"ln -sf /etc/nginx/sites-available/{safe_name} /etc/nginx/sites-enabled/{safe_name} && nginx -t 2>&1 && systemctl reload nginx"
        action = "enabled"

    try:
        result = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"site": site_name, "action": action, "output": result.strip()}


@router.post("/{server_id}/nginx/test")
async def test_nginx_config(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Test Nginx configuration syntax (nginx -t)."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    try:
        result = await driver._ssh_exec(info, "nginx -t 2>&1", timeout=10)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    success = "syntax is ok" in result.lower() and "test is successful" in result.lower()
    return {"success": success, "output": result.strip()}


# =====================================================================
# 17. Docker Container Management
# =====================================================================

class DockerContainer(BaseModel):
    container_id: str = ""
    name: str = ""
    image: str = ""
    status: str = ""
    state: str = ""
    ports: str = ""
    created: str = ""
    size: str = ""
    cpu_percent: str = "0.00%"
    mem_usage: str = ""
    mem_percent: str = "0.00%"
    net_io: str = ""
    block_io: str = ""


class DockerActionRequest(BaseModel):
    action: str  # start, stop, restart, pause, unpause


_DOCKER_ACTION_ALLOWLIST = {"start", "stop", "restart", "pause", "unpause"}


@router.get("/{server_id}/docker/containers", response_model=list[DockerContainer])
async def list_docker_containers(
    server_id: str,
    all: bool = True,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List Docker containers with resource usage stats."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    all_flag = "-a" if all else ""
    # Use short IDs (no --no-trunc) so ps and stats IDs match.
    # Avoid {{.Size}} — requires -s flag and is slow on large hosts.
    list_cmd = (
        f"docker ps {all_flag} --format "
        "'{{.ID}}||{{.Names}}||{{.Image}}||{{.Status}}||{{.State}}||{{.Ports}}||{{.CreatedAt}}'"
        " 2>/dev/null || echo 'NO_DOCKER'"
    )
    stats_cmd = (
        "docker stats --no-stream --format "
        "'{{.ID}}||{{.CPUPerc}}||{{.MemUsage}}||{{.MemPerc}}||{{.NetIO}}||{{.BlockIO}}'"
        " 2>/dev/null || true"
    )

    try:
        combined = await driver._ssh_exec(
            info, f"{list_cmd} && echo '===STATS===' && {stats_cmd}", timeout=60,
        )
    except Exception as e:
        logger.error(f"Failed to list docker containers for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    parts = combined.split("===STATS===")
    raw_list = parts[0]
    raw_stats = parts[1] if len(parts) > 1 else ""

    if "NO_DOCKER" in raw_list:
        return []

    # Parse stats into lookup dict
    stats_map = {}
    for line in raw_stats.strip().split("\n"):
        parts = line.split("||")
        if len(parts) >= 6:
            stats_map[parts[0].strip()[:12]] = {
                "cpu_percent": parts[1].strip(),
                "mem_usage": parts[2].strip(),
                "mem_percent": parts[3].strip(),
                "net_io": parts[4].strip(),
                "block_io": parts[5].strip(),
            }

    containers = []
    for line in raw_list.strip().split("\n"):
        if not line.strip() or "||" not in line:
            continue
        cols = line.split("||")
        if len(cols) < 5:
            continue
        cid = cols[0].strip()[:12]
        stats = stats_map.get(cid, {})
        containers.append(DockerContainer(
            container_id=cid,
            name=cols[1].strip() if len(cols) > 1 else "",
            image=cols[2].strip() if len(cols) > 2 else "",
            status=cols[3].strip() if len(cols) > 3 else "",
            state=cols[4].strip() if len(cols) > 4 else "",
            ports=cols[5].strip() if len(cols) > 5 else "",
            created=cols[6].strip() if len(cols) > 6 else "",
            cpu_percent=stats.get("cpu_percent", "0.00%"),
            mem_usage=stats.get("mem_usage", ""),
            mem_percent=stats.get("mem_percent", "0.00%"),
            net_io=stats.get("net_io", ""),
            block_io=stats.get("block_io", ""),
        ))

    return containers


@router.post("/{server_id}/docker/containers/{container_id}/action")
async def docker_container_action(
    server_id: str,
    container_id: str,
    body: DockerActionRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Perform action on a Docker container (start/stop/restart/pause/unpause)."""
    if body.action not in _DOCKER_ACTION_ALLOWLIST:
        raise HTTPException(status_code=400, detail=f"Action '{body.action}' not allowed. Use: {sorted(_DOCKER_ACTION_ALLOWLIST)}")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    safe_id = shlex.quote(container_id)
    try:
        result = await driver._ssh_exec(info, f"docker {body.action} {safe_id} 2>&1", timeout=30)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"container": container_id, "action": body.action, "result": result.strip()}


@router.get("/{server_id}/docker/containers/{container_id}/logs")
async def docker_container_logs(
    server_id: str,
    container_id: str,
    lines: int = 100,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get logs from a Docker container."""
    if lines < 1 or lines > 5000:
        raise HTTPException(status_code=400, detail="Lines must be between 1 and 5000")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    safe_id = shlex.quote(container_id)
    try:
        result = await driver._ssh_exec(info, f"docker logs --tail {lines} {safe_id} 2>&1", timeout=30)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    log_lines = result.strip().split("\n") if result.strip() else []
    return {"container": container_id, "lines": log_lines, "total_lines": len(log_lines)}


# =====================================================================
# 18. SSH Hardening
# =====================================================================

class SSHHardeningStatus(BaseModel):
    password_auth: bool = True
    root_login: str = "yes"
    permit_empty_passwords: bool = True
    max_auth_tries: int = 6
    x11_forwarding: bool = True
    allow_tcp_forwarding: bool = True
    ssh_port: int = 22
    protocol_version: str = ""
    login_grace_time: str = ""
    client_alive_interval: int = 0
    client_alive_count_max: int = 3


class SSHHardeningUpdate(BaseModel):
    password_auth: bool | None = None
    root_login: str | None = None  # "yes", "no", "prohibit-password"
    permit_empty_passwords: bool | None = None
    max_auth_tries: int | None = None
    x11_forwarding: bool | None = None
    allow_tcp_forwarding: bool | None = None
    client_alive_interval: int | None = None
    client_alive_count_max: int | None = None


@router.get("/{server_id}/ssh/hardening", response_model=SSHHardeningStatus)
async def get_ssh_hardening(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get SSH daemon hardening configuration."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "sshd -T 2>/dev/null | grep -E "
        "'(passwordauthentication|permitrootlogin|permitemptypasswords|maxauthtries|"
        "x11forwarding|allowtcpforwarding|port|clientaliveinterval|clientalivecountmax|"
        "logingracetime)' || "
        "grep -E '^\\s*(PasswordAuthentication|PermitRootLogin|PermitEmptyPasswords|MaxAuthTries|"
        "X11Forwarding|AllowTcpForwarding|Port|ClientAliveInterval|ClientAliveCountMax|"
        "LoginGraceTime)' /etc/ssh/sshd_config 2>/dev/null"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=10)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    status = SSHHardeningStatus()
    for line in raw.strip().split("\n"):
        parts = line.strip().lower().split()
        if len(parts) < 2:
            continue
        key, val = parts[0], parts[1]
        if key == "passwordauthentication":
            status.password_auth = val == "yes"
        elif key == "permitrootlogin":
            status.root_login = val
        elif key == "permitemptypasswords":
            status.permit_empty_passwords = val == "yes"
        elif key == "maxauthtries":
            try:
                status.max_auth_tries = int(val)
            except ValueError:
                pass
        elif key == "x11forwarding":
            status.x11_forwarding = val == "yes"
        elif key == "allowtcpforwarding":
            status.allow_tcp_forwarding = val == "yes"
        elif key == "port":
            try:
                status.ssh_port = int(val)
            except ValueError:
                pass
        elif key == "clientaliveinterval":
            try:
                status.client_alive_interval = int(val)
            except ValueError:
                pass
        elif key == "clientalivecountmax":
            try:
                status.client_alive_count_max = int(val)
            except ValueError:
                pass
        elif key == "logingracetime":
            status.login_grace_time = val

    return status


@router.patch("/{server_id}/ssh/hardening")
async def update_ssh_hardening(
    server_id: str,
    body: SSHHardeningUpdate,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update SSH daemon hardening configuration."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    changes = []
    sshd_updates = []

    if body.password_auth is not None:
        val = "yes" if body.password_auth else "no"
        sshd_updates.append(f"PasswordAuthentication {val}")
        changes.append(f"PasswordAuthentication={val}")

    if body.root_login is not None:
        if body.root_login not in ("yes", "no", "prohibit-password", "without-password"):
            raise HTTPException(status_code=400, detail="root_login must be yes, no, or prohibit-password")
        sshd_updates.append(f"PermitRootLogin {body.root_login}")
        changes.append(f"PermitRootLogin={body.root_login}")

    if body.permit_empty_passwords is not None:
        val = "yes" if body.permit_empty_passwords else "no"
        sshd_updates.append(f"PermitEmptyPasswords {val}")
        changes.append(f"PermitEmptyPasswords={val}")

    if body.max_auth_tries is not None:
        if not (1 <= body.max_auth_tries <= 20):
            raise HTTPException(status_code=400, detail="max_auth_tries must be 1-20")
        sshd_updates.append(f"MaxAuthTries {body.max_auth_tries}")
        changes.append(f"MaxAuthTries={body.max_auth_tries}")

    if body.x11_forwarding is not None:
        val = "yes" if body.x11_forwarding else "no"
        sshd_updates.append(f"X11Forwarding {val}")
        changes.append(f"X11Forwarding={val}")

    if body.allow_tcp_forwarding is not None:
        val = "yes" if body.allow_tcp_forwarding else "no"
        sshd_updates.append(f"AllowTcpForwarding {val}")
        changes.append(f"AllowTcpForwarding={val}")

    if body.client_alive_interval is not None:
        if not (0 <= body.client_alive_interval <= 3600):
            raise HTTPException(status_code=400, detail="client_alive_interval must be 0-3600")
        sshd_updates.append(f"ClientAliveInterval {body.client_alive_interval}")
        changes.append(f"ClientAliveInterval={body.client_alive_interval}")

    if body.client_alive_count_max is not None:
        if not (0 <= body.client_alive_count_max <= 10):
            raise HTTPException(status_code=400, detail="client_alive_count_max must be 0-10")
        sshd_updates.append(f"ClientAliveCountMax {body.client_alive_count_max}")
        changes.append(f"ClientAliveCountMax={body.client_alive_count_max}")

    if not sshd_updates:
        return {"detail": "No changes", "changes": []}

    # Build sed commands to update sshd_config
    sed_cmds = []
    for update in sshd_updates:
        key = update.split()[0]
        sed_cmds.append(
            f"grep -q '^\\s*{key}' /etc/ssh/sshd_config && "
            f"sed -i 's/^\\s*#*\\s*{key}\\s.*/{update}/' /etc/ssh/sshd_config || "
            f"echo '{update}' >> /etc/ssh/sshd_config"
        )

    # Also handle commented-out lines
    full_cmd = " && ".join(sed_cmds) + " && sshd -t 2>&1 && systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null"

    try:
        result = await driver._ssh_exec(info, full_cmd, timeout=15)
    except Exception as e:
        logger.error(f"Failed to update SSH hardening for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": "SSH hardening updated", "changes": changes, "output": result.strip()}


# =====================================================================
# 19. Swap Management
# =====================================================================

class SwapInfo(BaseModel):
    total_mb: int = 0
    used_mb: int = 0
    free_mb: int = 0
    percent: float = 0.0
    swappiness: int = 60
    swap_files: list[dict] = []


class SwapCreateRequest(BaseModel):
    size_mb: int = Field(ge=256, le=65536)


class SwapSwappinessRequest(BaseModel):
    value: int = Field(ge=0, le=100)


@router.get("/{server_id}/swap", response_model=SwapInfo)
async def get_swap_info(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get swap usage and configuration."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "free -m | grep Swap && echo '===SWAPPINESS===' && "
        "cat /proc/sys/vm/swappiness && echo '===SWAPFILES===' && "
        "swapon --show=NAME,TYPE,SIZE,USED 2>/dev/null || cat /proc/swaps"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=10)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    result = SwapInfo()
    parts = raw.split("===SWAPPINESS===")
    if len(parts) >= 1:
        swap_line = parts[0].strip().split("\n")
        for line in swap_line:
            if "Swap:" in line:
                vals = line.split()
                if len(vals) >= 4:
                    result.total_mb = int(vals[1])
                    result.used_mb = int(vals[2])
                    result.free_mb = int(vals[3])
                    result.percent = round(result.used_mb / result.total_mb * 100, 1) if result.total_mb > 0 else 0

    if len(parts) >= 2:
        remaining = parts[1].split("===SWAPFILES===")
        try:
            result.swappiness = int(remaining[0].strip())
        except ValueError:
            pass
        if len(remaining) >= 2:
            for line in remaining[1].strip().split("\n"):
                if line.startswith("NAME") or line.startswith("Filename"):
                    continue
                cols = line.split()
                if len(cols) >= 3:
                    result.swap_files.append({"name": cols[0], "type": cols[1], "size": cols[2], "used": cols[3] if len(cols) > 3 else "0"})

    return result


@router.post("/{server_id}/swap/create")
async def create_swap(
    server_id: str,
    body: SwapCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Create a swap file on the server."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    size_mb = body.size_mb
    cmd = (
        f"fallocate -l {size_mb}M /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count={size_mb} && "
        "chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && "
        "grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab && "
        "echo 'SWAP_CREATED'"
    )

    try:
        result = await driver._ssh_exec(info, cmd, timeout=120)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    success = "SWAP_CREATED" in result
    return {"success": success, "size_mb": size_mb, "message": f"Swap file of {size_mb}MB created" if success else "Swap creation may have failed", "output": result.strip()}


@router.delete("/{server_id}/swap")
async def remove_swap(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Remove the swap file from the server."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "swapoff /swapfile 2>/dev/null; "
        "rm -f /swapfile; "
        "sed -i '/\\/swapfile/d' /etc/fstab; "
        "echo 'SWAP_REMOVED'"
    )

    try:
        result = await driver._ssh_exec(info, cmd, timeout=30)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"success": "SWAP_REMOVED" in result, "message": "Swap file removed", "output": result.strip()}


@router.patch("/{server_id}/swap/swappiness")
async def update_swappiness(
    server_id: str,
    body: SwapSwappinessRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update vm.swappiness value (0-100)."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        f"sysctl vm.swappiness={body.value} && "
        f"grep -q 'vm.swappiness' /etc/sysctl.conf && "
        f"sed -i 's/vm.swappiness=.*/vm.swappiness={body.value}/' /etc/sysctl.conf || "
        f"echo 'vm.swappiness={body.value}' >> /etc/sysctl.conf"
    )

    try:
        await driver._ssh_exec(info, cmd, timeout=10)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {"detail": f"Swappiness set to {body.value}", "value": body.value}


# =====================================================================
# 20. Quick Actions (Enterprise Server Maintenance)
# =====================================================================

class QuickActionRequest(BaseModel):
    action: str


_QUICK_ACTIONS = {
    "clear_ram_cache": {
        "cmd": "sync && echo 3 > /proc/sys/vm/drop_caches && echo 'RAM cache cleared'",
        "label": "Clear RAM Cache",
        "description": "Drop filesystem caches to free up memory",
        "danger": False,
    },
    "clear_journal_logs": {
        "cmd": "journalctl --vacuum-time=3d 2>&1 && echo 'Journal logs cleaned'",
        "label": "Clean Journal Logs",
        "description": "Remove systemd journal logs older than 3 days",
        "danger": False,
    },
    "clear_tmp": {
        "cmd": "find /tmp -type f -atime +7 -delete 2>/dev/null; find /var/tmp -type f -atime +7 -delete 2>/dev/null; echo 'Temp files cleaned'",
        "label": "Clean Temp Files",
        "description": "Remove temp files older than 7 days",
        "danger": False,
    },
    "clear_apt_cache": {
        "cmd": "apt-get clean 2>&1 && apt-get autoremove -y 2>&1 && echo 'APT cache cleaned'",
        "label": "Clean APT Cache",
        "description": "Remove cached packages and unused dependencies",
        "danger": False,
    },
    "docker_prune": {
        "cmd": "docker system prune -f --volumes 2>&1 && echo 'Docker pruned'",
        "label": "Docker System Prune",
        "description": "Remove unused containers, networks, images, and volumes",
        "danger": True,
    },
    "docker_prune_images": {
        "cmd": "docker image prune -a -f 2>&1 && echo 'Unused images removed'",
        "label": "Docker Image Prune",
        "description": "Remove all unused Docker images",
        "danger": True,
    },
    "restart_all_services": {
        "cmd": "for svc in nginx postgresql redis-server memcached; do systemctl restart $svc 2>/dev/null && echo \"Restarted $svc\" || true; done",
        "label": "Restart All Services",
        "description": "Restart nginx, postgresql, redis, memcached",
        "danger": True,
    },
    "flush_dns": {
        "cmd": "systemd-resolve --flush-caches 2>/dev/null || resolvectl flush-caches 2>/dev/null; echo 'DNS cache flushed'",
        "label": "Flush DNS Cache",
        "description": "Clear the system DNS resolver cache",
        "danger": False,
    },
    "rotate_logs": {
        "cmd": "logrotate -f /etc/logrotate.conf 2>&1 && echo 'Logs rotated'",
        "label": "Force Log Rotation",
        "description": "Force immediate log rotation",
        "danger": False,
    },
    "sync_time": {
        "cmd": "timedatectl set-ntp true 2>/dev/null; systemctl restart systemd-timesyncd 2>/dev/null; chronyc makestep 2>/dev/null || ntpdate pool.ntp.org 2>/dev/null; echo 'Time synced'",
        "label": "Sync System Time",
        "description": "Force NTP time synchronization",
        "danger": False,
    },
}


@router.get("/{server_id}/quick-actions")
async def list_quick_actions(
    server_id: str,
    user: dict = Depends(get_current_user),
):
    """List available server quick actions."""
    return [
        {"id": k, "label": v["label"], "description": v["description"], "danger": v["danger"]}
        for k, v in _QUICK_ACTIONS.items()
    ]


@router.post("/{server_id}/quick-actions")
async def execute_quick_action(
    server_id: str,
    body: QuickActionRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Execute a predefined server maintenance action."""
    if body.action not in _QUICK_ACTIONS:
        raise HTTPException(status_code=400, detail=f"Unknown action '{body.action}'. Available: {list(_QUICK_ACTIONS.keys())}")

    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    action_def = _QUICK_ACTIONS[body.action]

    try:
        result = await driver._ssh_exec(info, action_def["cmd"], timeout=120)
    except Exception as e:
        logger.error(f"Quick action '{body.action}' failed on {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    return {
        "action": body.action,
        "label": action_def["label"],
        "success": True,
        "output": result.strip(),
    }


# =====================================================================
# 21. Network Connections & Open Ports
# =====================================================================

class NetworkConnection(BaseModel):
    protocol: str = ""
    local_address: str = ""
    foreign_address: str = ""
    state: str = ""
    pid: int | None = None
    program: str = ""


class OpenPort(BaseModel):
    port: int = 0
    protocol: str = ""
    service: str = ""
    pid: int | None = None
    state: str = ""


class NetworkOverview(BaseModel):
    total_connections: int = 0
    established: int = 0
    listening: int = 0
    time_wait: int = 0
    close_wait: int = 0
    connections: list[NetworkConnection] = []
    open_ports: list[OpenPort] = []
    bandwidth: dict = {}


@router.get("/{server_id}/network", response_model=NetworkOverview)
async def get_network_overview(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get network connections overview, open ports, and bandwidth stats."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "echo '===CONNECTIONS===' && "
        "ss -tunap 2>/dev/null | head -200 && "
        "echo '===PORTS===' && "
        "ss -tlnp 2>/dev/null && "
        "echo '===STATS===' && "
        "ss -s 2>/dev/null && "
        "echo '===BANDWIDTH===' && "
        "cat /proc/net/dev 2>/dev/null | grep -v 'lo:' | tail -5"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    result = NetworkOverview()
    sections = raw.split("===")

    # Parse connections
    for section in sections:
        if section.startswith("CONNECTIONS"):
            lines = section.replace("CONNECTIONS", "").strip().split("\n")
            for line in lines[1:]:  # skip header
                cols = line.split()
                if len(cols) >= 5:
                    state = cols[1] if len(cols) > 5 else ""
                    local = cols[4] if len(cols) > 5 else cols[3]
                    foreign = cols[5] if len(cols) > 5 else cols[4]
                    program = cols[-1] if "users:" in line else ""
                    pid = None
                    if "pid=" in line:
                        pid_match = re.search(r'pid=(\d+)', line)
                        if pid_match:
                            pid = int(pid_match.group(1))
                    result.connections.append(NetworkConnection(
                        protocol=cols[0], local_address=local,
                        foreign_address=foreign, state=state,
                        pid=pid, program=program,
                    ))

        elif section.startswith("PORTS"):
            lines = section.replace("PORTS", "").strip().split("\n")
            for line in lines[1:]:
                cols = line.split()
                if len(cols) >= 5:
                    local = cols[4] if len(cols) > 4 else cols[3]
                    port_str = local.rsplit(":", 1)[-1] if ":" in local else "0"
                    try:
                        port = int(port_str)
                    except ValueError:
                        port = 0
                    program = cols[-1] if "users:" in line else ""
                    pid = None
                    if "pid=" in line:
                        pid_match = re.search(r'pid=(\d+)', line)
                        if pid_match:
                            pid = int(pid_match.group(1))
                    result.open_ports.append(OpenPort(
                        port=port, protocol=cols[0], service=program,
                        pid=pid, state="LISTEN",
                    ))

        elif section.startswith("STATS"):
            stats_text = section.replace("STATS", "").strip()
            for line in stats_text.split("\n"):
                if "estab" in line:
                    nums = re.findall(r'(\d+)', line)
                    if len(nums) >= 2:
                        result.established = int(nums[-1])
                if "timewait" in line.lower() or "time-wait" in line.lower():
                    nums = re.findall(r'(\d+)', line)
                    if nums:
                        result.time_wait = int(nums[0])

    result.total_connections = len(result.connections)
    result.listening = len(result.open_ports)

    return result


# =====================================================================
# 22. Resource Forecasting (Disk/RAM Depletion Prediction)
# =====================================================================

class ResourceForecast(BaseModel):
    resource: str = ""
    current_percent: float = 0
    current_used: str = ""
    current_total: str = ""
    trend: str = ""  # "increasing", "stable", "decreasing"
    days_until_full: int | None = None  # None = not predictable
    severity: str = "ok"  # ok, info, warning, critical
    recommendation: str = ""


class ForecastResponse(BaseModel):
    forecasts: list[ResourceForecast] = []
    disk_growth_mb_per_day: float | None = None
    generated_at: str = ""


@router.get("/{server_id}/forecast", response_model=ForecastResponse)
async def get_resource_forecast(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Predict resource depletion based on current usage trends."""
    srv = await _get_owned_vm_server(server_id, db, user)
    driver: VMDriver = _drivers["vm"]
    info = _to_server_info(srv)

    cmd = (
        "echo '===DISK===' && df -BM / | tail -1 && "
        "echo '===MEM===' && free -m | grep Mem && "
        "echo '===SWAP===' && free -m | grep Swap && "
        "echo '===DISKGROWTH===' && "
        "if [ -f /var/log/sysstat/sa$(date -d 'yesterday' +%d) ]; then "
        "  sar -d -f /var/log/sysstat/sa$(date -d 'yesterday' +%d) 2>/dev/null | tail -3; "
        "else echo 'NO_SAR'; fi && "
        "echo '===INODES===' && df -i / | tail -1 && "
        "echo '===LOGSIZE===' && du -sm /var/log 2>/dev/null | awk '{print $1}' && "
        "echo '===DOCKERSIZE===' && docker system df 2>/dev/null | grep -v 'TYPE' || echo 'NO_DOCKER'"
    )

    try:
        raw = await driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    forecasts = []
    disk_growth = None

    sections = raw.split("===")
    disk_used = 0
    disk_total = 0
    disk_pct = 0.0
    mem_used = 0
    mem_total = 0
    mem_pct = 0.0
    swap_used = 0
    swap_total = 0
    log_size = 0
    inode_pct = 0.0

    for section in sections:
        if section.startswith("DISK"):
            parts = section.replace("DISK", "").strip().split()
            if len(parts) >= 5:
                try:
                    disk_total = int(parts[1].replace("M", ""))
                    disk_used = int(parts[2].replace("M", ""))
                    disk_pct = float(parts[4].replace("%", ""))
                except (ValueError, IndexError):
                    pass
        elif section.startswith("MEM"):
            parts = section.replace("MEM", "").strip().split()
            if len(parts) >= 4:
                try:
                    mem_total = int(parts[1])
                    mem_used = int(parts[2])
                    mem_pct = round(mem_used / mem_total * 100, 1) if mem_total else 0
                except (ValueError, IndexError):
                    pass
        elif section.startswith("SWAP"):
            parts = section.replace("SWAP", "").strip().split()
            if len(parts) >= 4:
                try:
                    swap_total = int(parts[1])
                    swap_used = int(parts[2])
                except (ValueError, IndexError):
                    pass
        elif section.startswith("INODES"):
            parts = section.replace("INODES", "").strip().split()
            if len(parts) >= 5:
                try:
                    inode_pct = float(parts[4].replace("%", ""))
                except (ValueError, IndexError):
                    pass
        elif section.startswith("LOGSIZE"):
            try:
                log_size = int(section.replace("LOGSIZE", "").strip().split("\n")[0])
            except ValueError:
                pass

    # Disk forecast
    disk_free_mb = disk_total - disk_used if disk_total > 0 else 0
    disk_severity = "ok"
    disk_days = None
    disk_recommendation = ""

    if disk_pct >= 95:
        disk_severity = "critical"
        disk_recommendation = "Disk critically full! Run disk cleanup immediately. Consider upgrading disk."
    elif disk_pct >= 85:
        disk_severity = "warning"
        disk_recommendation = "Disk usage high. Clean old logs, Docker images, and temp files."
    elif disk_pct >= 70:
        disk_severity = "info"
        disk_recommendation = "Disk usage moderate. Monitor growth and schedule cleanup."

    # Estimate days until full based on log size growth heuristic
    if log_size > 0 and disk_free_mb > 0:
        # Rough estimate: logs grow ~50% per day
        estimated_daily_growth_mb = max(log_size * 0.02, 10)  # Conservative estimate
        disk_days = int(disk_free_mb / estimated_daily_growth_mb) if estimated_daily_growth_mb > 0 else None
        disk_growth = estimated_daily_growth_mb
        if disk_days is not None and disk_days < 7:
            disk_severity = "critical" if disk_days < 3 else "warning"
            disk_recommendation = f"At current growth rate, disk will be full in ~{disk_days} days. Take action now."

    forecasts.append(ResourceForecast(
        resource="disk",
        current_percent=disk_pct,
        current_used=f"{disk_used}M",
        current_total=f"{disk_total}M",
        trend="increasing" if disk_pct > 50 else "stable",
        days_until_full=disk_days,
        severity=disk_severity,
        recommendation=disk_recommendation or "Disk usage healthy.",
    ))

    # Memory forecast
    mem_severity = "ok"
    mem_recommendation = ""
    if mem_pct >= 95:
        mem_severity = "critical"
        mem_recommendation = "Memory critically full! Investigate high-memory processes. Consider adding swap or upgrading."
    elif mem_pct >= 85:
        mem_severity = "warning"
        mem_recommendation = "Memory usage high. Check for memory leaks. Consider adding swap."
    elif mem_pct >= 70:
        mem_severity = "info"
        mem_recommendation = "Memory usage moderate. Monitor for spikes."

    forecasts.append(ResourceForecast(
        resource="memory",
        current_percent=mem_pct,
        current_used=f"{mem_used}M",
        current_total=f"{mem_total}M",
        trend="stable",
        severity=mem_severity,
        recommendation=mem_recommendation or "Memory usage healthy.",
    ))

    # Swap forecast
    if swap_total > 0:
        swap_pct = round(swap_used / swap_total * 100, 1)
        swap_severity = "ok"
        swap_recommendation = ""
        if swap_pct >= 80:
            swap_severity = "warning"
            swap_recommendation = "High swap usage indicates memory pressure. Consider upgrading RAM."
        elif swap_pct >= 50:
            swap_severity = "info"
            swap_recommendation = "Moderate swap usage. System may benefit from more RAM."

        forecasts.append(ResourceForecast(
            resource="swap",
            current_percent=swap_pct,
            current_used=f"{swap_used}M",
            current_total=f"{swap_total}M",
            trend="stable",
            severity=swap_severity,
            recommendation=swap_recommendation or "Swap usage normal.",
        ))

    # Inodes forecast
    if inode_pct > 0:
        inode_severity = "ok"
        inode_recommendation = ""
        if inode_pct >= 90:
            inode_severity = "critical"
            inode_recommendation = "Inodes almost exhausted! Remove small files (sessions, cache, logs)."
        elif inode_pct >= 75:
            inode_severity = "warning"
            inode_recommendation = "Inode usage high. Check for excessive small files."

        forecasts.append(ResourceForecast(
            resource="inodes",
            current_percent=inode_pct,
            current_used="",
            current_total="",
            trend="stable",
            severity=inode_severity,
            recommendation=inode_recommendation or "Inode usage healthy.",
        ))

    return ForecastResponse(
        forecasts=forecasts,
        disk_growth_mb_per_day=disk_growth,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )
