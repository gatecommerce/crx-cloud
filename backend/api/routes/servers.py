"""Server management endpoints — wizard-friendly connect flow.

Inspired by RunCloud/Ploi: user provides IP + root password,
platform auto-injects SSH key and provisions Docker.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
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


async def _provision_server_bg(server_id: str, info: ServerInfo):
    """Background task: provision server (install Docker, create dirs)."""
    from core.database import async_session

    driver: VMDriver = _drivers["vm"]
    try:
        result = await driver.provision(info)
        async with async_session() as db:
            srv = await db.get(Server, server_id)
            if srv:
                srv.meta = {
                    **(srv.meta or {}),
                    "provisioned": result["success"],
                    "provision_details": result,
                }
                if not result["success"]:
                    srv.status = "error"
                await db.commit()
    except Exception as e:
        logger.error(f"Background provision failed for {server_id}: {e}")


# --- List ---

@router.get("", response_model=list[ServerResponse])
async def list_servers(
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Server).options(selectinload(Server.instances))
        .where(Server.owner_id == user["telegram_id"])
    )
    servers = result.scalars().all()
    return [
        ServerResponse(
            id=s.id, name=s.name, server_type=s.server_type,
            provider=s.provider, status=s.status, endpoint=s.endpoint,
            region=s.region, instances_count=len(s.instances),
        )
        for s in servers
    ]


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
    )


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
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Server).where(Server.id == server_id, Server.owner_id == user["telegram_id"])
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    await db.delete(srv)
    await db.commit()
    return {"detail": "Server removed"}
