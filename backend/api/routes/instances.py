"""CMS instance management endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class InstanceCreate(BaseModel):
    server_id: str
    cms_type: str  # odoo, wordpress, prestashop, woocommerce
    version: str
    name: str
    domain: str = ""
    config: dict = {}


class InstanceResponse(BaseModel):
    id: str
    server_id: str
    cms_type: str
    version: str
    name: str
    domain: str
    status: str
    url: str = ""


@router.get("/")
async def list_instances():
    """List all CMS instances across all servers."""
    # TODO: fetch from DB
    return []


@router.post("/", response_model=InstanceResponse)
async def create_instance(instance: InstanceCreate):
    """Deploy a new CMS instance on a server."""
    # TODO: validate server, call CMS plugin driver.deploy()
    raise HTTPException(status_code=501, detail="Not implemented yet")


@router.get("/{instance_id}")
async def get_instance(instance_id: str):
    """Get instance details, status, and CMS-specific info."""
    # TODO: fetch from DB + plugin-specific data
    raise HTTPException(status_code=501, detail="Not implemented yet")


@router.post("/{instance_id}/restart")
async def restart_instance(instance_id: str):
    """Restart a CMS instance."""
    raise HTTPException(status_code=501, detail="Not implemented yet")


@router.post("/{instance_id}/scale")
async def scale_instance(instance_id: str, replicas: int = 1):
    """Scale instance workers (K8s only)."""
    raise HTTPException(status_code=501, detail="Not implemented yet")


@router.delete("/{instance_id}")
async def delete_instance(instance_id: str):
    """Remove a CMS instance."""
    raise HTTPException(status_code=501, detail="Not implemented yet")
