"""Server management endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class ServerCreate(BaseModel):
    name: str
    server_type: str  # kubernetes | vm
    provider: str  # azure, aws, hetzner, custom
    endpoint: str
    credentials: dict = {}


class ServerResponse(BaseModel):
    id: str
    name: str
    server_type: str
    provider: str
    status: str
    endpoint: str
    cpu_cores: int = 0
    ram_mb: int = 0
    disk_gb: int = 0


@router.get("/")
async def list_servers():
    """List all connected servers."""
    # TODO: fetch from DB
    return []


@router.post("/", response_model=ServerResponse)
async def add_server(server: ServerCreate):
    """Connect a new server (K8s cluster or VM)."""
    # TODO: validate connection, save to DB
    raise HTTPException(status_code=501, detail="Not implemented yet")


@router.get("/{server_id}")
async def get_server(server_id: str):
    """Get server details and metrics."""
    # TODO: fetch from DB + live metrics
    raise HTTPException(status_code=501, detail="Not implemented yet")


@router.get("/{server_id}/metrics")
async def get_server_metrics(server_id: str):
    """Get real-time server metrics (CPU, RAM, disk)."""
    # TODO: query via driver
    raise HTTPException(status_code=501, detail="Not implemented yet")


@router.delete("/{server_id}")
async def remove_server(server_id: str):
    """Disconnect a server."""
    # TODO: remove from DB
    raise HTTPException(status_code=501, detail="Not implemented yet")
