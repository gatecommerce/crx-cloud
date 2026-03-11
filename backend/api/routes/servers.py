"""Server management endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db
from core.k8s_controller import KubernetesDriver
from core.vm_controller import VMDriver
from core.server_manager import ServerInfo, ServerType

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
            "ssh_key_path": srv.ssh_key_path or "",
            **(srv.meta or {}),
        },
    )


class ServerCreate(BaseModel):
    name: str
    server_type: str
    provider: str
    endpoint: str
    region: str | None = None
    ssh_user: str | None = None
    ssh_key_path: str | None = None
    kubeconfig: str | None = None
    namespace: str | None = "default"


class ServerResponse(BaseModel):
    id: str
    name: str
    server_type: str
    provider: str
    status: str
    endpoint: str
    region: str | None = None
    instances_count: int = 0


@router.get("/", response_model=list[ServerResponse])
async def list_servers(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Server).options(selectinload(Server.instances)).where(Server.owner_id == user["telegram_id"])
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


@router.post("/", response_model=ServerResponse)
async def add_server(
    body: ServerCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    srv = Server(
        name=body.name, server_type=body.server_type, provider=body.provider,
        endpoint=body.endpoint, region=body.region, ssh_user=body.ssh_user,
        ssh_key_path=body.ssh_key_path, kubeconfig=body.kubeconfig,
        namespace=body.namespace, status="provisioning", owner_id=user["telegram_id"],
    )
    driver = _drivers.get(body.server_type)
    if not driver:
        raise HTTPException(status_code=400, detail=f"Unknown server type: {body.server_type}")

    info = _to_server_info(srv)
    connected = await driver.connect(info)
    srv.status = "online" if connected else "error"

    db.add(srv)
    await db.commit()
    await db.refresh(srv)

    return ServerResponse(
        id=srv.id, name=srv.name, server_type=srv.server_type,
        provider=srv.provider, status=srv.status, endpoint=srv.endpoint,
        region=srv.region,
    )


@router.get("/{server_id}", response_model=ServerResponse)
async def get_server(
    server_id: str,
    request: Request,
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


@router.get("/{server_id}/metrics")
async def get_server_metrics(
    server_id: str,
    request: Request,
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


@router.delete("/{server_id}")
async def remove_server(
    server_id: str,
    request: Request,
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
