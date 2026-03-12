"""Cloud provider API routes — unified multi-provider server creation.

Supports: Hetzner, DigitalOcean, Vultr, Linode.
Each provider has: plans, regions, create, list servers.
All responses use a normalized format for the frontend.
"""

import asyncio

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from api.models.server import Server
from core.auth import get_current_user
from core.config import settings
from core.database import get_db, async_session
from core.cloud_providers.hetzner import HetznerClient
from core.cloud_providers.digitalocean import DigitalOceanClient
from core.cloud_providers.vultr import VultrClient
from core.cloud_providers.linode import LinodeClient
from core.cloud_providers.cms_requirements import get_plan_recommendations, get_cms_list, get_workload_list, get_workload_recommendations
from core.ssh_keys import get_public_key, get_private_key_path
from core.vm_controller import VMDriver
from core.server_manager import ServerInfo, ServerType

router = APIRouter()
_vm_driver = VMDriver()

PROVIDERS = {
    "hetzner": {"name": "Hetzner Cloud", "currency": "EUR", "token_field": "hetzner_api_token"},
    "digitalocean": {"name": "DigitalOcean", "currency": "USD", "token_field": "digitalocean_api_token"},
    "vultr": {"name": "Vultr", "currency": "USD", "token_field": "vultr_api_key"},
    "linode": {"name": "Linode (Akamai)", "currency": "USD", "token_field": "linode_api_token"},
}


def _get_client(provider: str):
    """Get the appropriate cloud provider client."""
    info = PROVIDERS.get(provider)
    if not info:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    token = getattr(settings, info["token_field"], "")
    if not token:
        raise HTTPException(status_code=503, detail=f"{info['name']} API token not configured")
    if provider == "hetzner":
        return HetznerClient(token)
    if provider == "digitalocean":
        return DigitalOceanClient(token)
    if provider == "vultr":
        return VultrClient(token)
    if provider == "linode":
        return LinodeClient(token)


# ─── Available Providers ─────────────────────────────────────────────

class ProviderInfo(BaseModel):
    id: str
    name: str
    available: bool
    currency: str


@router.get("/available", response_model=list[ProviderInfo])
async def list_available_providers(user: dict = Depends(get_current_user)):
    """List which cloud providers are configured and available."""
    return [
        ProviderInfo(
            id=pid,
            name=info["name"],
            available=bool(getattr(settings, info["token_field"], "")),
            currency=info["currency"],
        )
        for pid, info in PROVIDERS.items()
    ]


# ─── CMS Requirements ────────────────────────────────────────────────

@router.get("/cms-requirements")
async def list_cms_requirements(user: dict = Depends(get_current_user)):
    """List all supported CMS with their server requirements."""
    return get_cms_list()


@router.get("/workload-tiers")
async def list_workload_tiers(user: dict = Depends(get_current_user)):
    """List available workload tiers (startup, medium, intensive)."""
    return get_workload_list()


# ─── Generic Plans (any provider) ────────────────────────────────────

@router.get("/{provider}/plans")
async def list_plans(provider: str, user: dict = Depends(get_current_user)):
    """List available plans for a provider with CMS recommendations."""
    client = _get_client(provider)

    if provider == "hetzner":
        plans = await client.list_server_types()
    elif provider == "digitalocean":
        plans = await client.list_sizes()
    elif provider == "vultr":
        plans = await client.list_plans()
    elif provider == "linode":
        plans = await client.list_types()
    else:
        return []

    # Enrich each plan with CMS recommendations + workload fit
    for plan in plans:
        memory_mb = plan.get("memory_mb", int(plan.get("memory_gb", 0) * 1024))
        cores = plan.get("cores", 0)
        disk_gb = plan.get("disk_gb", 0)
        plan["cms_recommendations"] = get_plan_recommendations(memory_mb, cores, disk_gb)

        # Pre-compute workload fit for all CMS x workload combinations
        workload_fit: dict[str, dict[str, dict]] = {}
        for cms_id in ["odoo-18", "odoo-17", "odoo-16", "odoo-15", "odoo-14",
                        "wordpress", "woocommerce", "prestashop", "magento"]:
            workload_fit[cms_id] = {}
            for wl in ["startup", "medium", "intensive"]:
                workload_fit[cms_id][wl] = get_workload_recommendations(
                    memory_mb, cores, disk_gb, cms_id, wl,
                )
        plan["workload_fit"] = workload_fit

    return plans


# ─── Generic Regions (any provider) ──────────────────────────────────

@router.get("/{provider}/regions")
async def list_regions(provider: str, user: dict = Depends(get_current_user)):
    """List datacenter regions for a provider."""
    client = _get_client(provider)

    if provider == "hetzner":
        return await client.list_locations()
    elif provider == "digitalocean":
        return await client.list_regions()
    elif provider == "vultr":
        return await client.list_regions()
    elif provider == "linode":
        return await client.list_regions()
    return []


# ─── Generic Existing Servers (any provider) ─────────────────────────

@router.get("/{provider}/servers")
async def list_provider_servers(provider: str, user: dict = Depends(get_current_user)):
    """List existing servers on a provider account."""
    client = _get_client(provider)

    if provider == "hetzner":
        return await client.list_servers()
    elif provider == "digitalocean":
        return await client.list_droplets()
    elif provider == "vultr":
        return await client.list_instances()
    elif provider == "linode":
        return await client.list_linodes()
    return []


# ─── Generic Server Creation ─────────────────────────────────────────

class CreateServerRequest(BaseModel):
    name: str
    plan: str
    region: str


class CreateServerResponse(BaseModel):
    id: str
    name: str
    status: str
    endpoint: str
    provider: str
    provider_id: str  # ID on the cloud provider side
    message: str


@router.post("/{provider}/create", response_model=CreateServerResponse, status_code=201)
async def create_server(
    provider: str,
    body: CreateServerRequest,
    bg: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Create a new server on any supported provider.

    1. Registers platform SSH key
    2. Creates server
    3. Waits for IP assignment
    4. Saves to DB and starts provisioning
    """
    client = _get_client(provider)
    pub_key = get_public_key()

    if provider == "hetzner":
        result = await _create_hetzner(client, body, pub_key)
    elif provider == "digitalocean":
        result = await _create_digitalocean(client, body, pub_key)
    elif provider == "vultr":
        result = await _create_vultr(client, body, pub_key)
    elif provider == "linode":
        result = await _create_linode(client, body, pub_key)
    else:
        raise HTTPException(status_code=400, detail=f"Create not supported for {provider}")

    provider_id = str(result["id"])
    ip = result["ip"]

    if not ip:
        raise HTTPException(
            status_code=500,
            detail="Server created but IP not assigned yet. Try importing it later.",
        )

    # Save to DB
    srv = Server(
        name=body.name,
        server_type="vm",
        provider=provider,
        endpoint=ip,
        region=body.region,
        ssh_user="root",
        ssh_key_path=get_private_key_path(),
        status="provisioning",
        owner_id=user["telegram_id"],
        meta={
            "provider_id": provider_id,
            "provider_plan": body.plan,
        },
    )
    db.add(srv)
    await db.commit()
    await db.refresh(srv)

    # Background: wait for server boot + provision Docker
    bg.add_task(_wait_and_provision, srv.id, ip)

    return CreateServerResponse(
        id=srv.id,
        name=srv.name,
        status="provisioning",
        endpoint=ip,
        provider=provider,
        provider_id=provider_id,
        message=f"Server {body.name} created at {ip}. Provisioning Docker...",
    )


# ─── Provider-Specific Creation Logic ────────────────────────────────

async def _create_hetzner(client: HetznerClient, body: CreateServerRequest, pub_key: str) -> dict:
    ssh_key_id = await client.ensure_ssh_key(pub_key)
    result = await client.create_server(
        name=body.name, server_type=body.plan, location=body.region, ssh_key_ids=[ssh_key_id],
    )
    # Poll for IP if not assigned
    if not result["ip"]:
        for _ in range(10):
            await asyncio.sleep(3)
            info = await client.get_server(result["id"])
            if info["ip"]:
                result["ip"] = info["ip"]
                break
    return result


async def _create_digitalocean(client: DigitalOceanClient, body: CreateServerRequest, pub_key: str) -> dict:
    ssh_key_id = await client.ensure_ssh_key(pub_key)
    result = await client.create_droplet(
        name=body.name, size=body.plan, region=body.region, ssh_key_ids=[ssh_key_id],
    )
    # Poll for IP
    if not result["ip"]:
        for _ in range(15):
            await asyncio.sleep(5)
            info = await client.get_droplet(result["id"])
            if info["ip"]:
                result["ip"] = info["ip"]
                break
    return result


async def _create_vultr(client: VultrClient, body: CreateServerRequest, pub_key: str) -> dict:
    ssh_key_id = await client.ensure_ssh_key(pub_key)
    result = await client.create_instance(
        name=body.name, plan=body.plan, region=body.region, ssh_key_ids=[ssh_key_id],
    )
    # Poll for IP (Vultr assigns 0.0.0.0 initially)
    if not result["ip"] or result["ip"] == "0.0.0.0":
        for _ in range(20):
            await asyncio.sleep(5)
            info = await client.get_instance(result["id"])
            if info["ip"] and info["ip"] != "0.0.0.0":
                result["ip"] = info["ip"]
                break
    return result


async def _create_linode(client: LinodeClient, body: CreateServerRequest, pub_key: str) -> dict:
    # Linode accepts the actual public key string, not an ID
    result = await client.create_linode(
        label=body.name, linode_type=body.plan, region=body.region, authorized_keys=[pub_key],
    )
    # Poll for IP
    if not result["ip"]:
        for _ in range(15):
            await asyncio.sleep(5)
            info = await client.get_linode(result["id"])
            if info["ip"]:
                result["ip"] = info["ip"]
                break
    return result


# ─── Background Provisioning ─────────────────────────────────────────

async def _wait_and_provision(server_id: str, ip: str):
    """Background: wait for server SSH to be ready, then provision Docker."""
    info = ServerInfo(
        id=server_id, name="provisioning", server_type=ServerType.VM,
        provider="cloud", endpoint=ip,
        metadata={"ssh_user": "root", "ssh_key_path": get_private_key_path()},
    )

    # Poll until SSH is available (server boot takes ~30-90s)
    connected = False
    for attempt in range(25):
        await asyncio.sleep(10)
        try:
            connected = await _vm_driver.connect(info)
            if connected:
                logger.info(f"Server {ip} SSH ready after {(attempt + 1) * 10}s")
                break
        except Exception:
            pass

    async with async_session() as db:
        srv = await db.get(Server, server_id)
        if not srv:
            return

        if not connected:
            srv.status = "error"
            srv.meta = {**(srv.meta or {}), "error": "Server created but SSH not reachable after 250s"}
            await db.commit()
            return

        # Provision (install Docker etc.)
        result = await _vm_driver.provision(info)
        srv.meta = {
            **(srv.meta or {}),
            "provisioned": result["success"],
            "provision_details": result,
        }
        srv.status = "online" if result["success"] else "error"
        await db.commit()
        logger.info(f"Server {ip} provisioned: {result['success']}")
