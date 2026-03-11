"""CMS instance management endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.instance import Instance
from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db

router = APIRouter()


class InstanceCreate(BaseModel):
    server_id: str
    cms_type: str
    version: str
    name: str
    domain: str = ""
    workers: int = 2
    ram_mb: int = 2048
    cpu_cores: int = 1
    config: dict = {}


class InstanceResponse(BaseModel):
    id: str
    server_id: str
    cms_type: str
    version: str
    name: str
    domain: str | None
    status: str
    url: str | None
    workers: int
    ram_mb: int
    cpu_cores: int


@router.get("/", response_model=list[InstanceResponse])
async def list_instances(
    server_id: str | None = None,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    query = select(Instance).where(Instance.owner_id == user["telegram_id"])
    if server_id:
        query = query.where(Instance.server_id == server_id)
    result = await db.execute(query)
    instances = result.scalars().all()
    return [
        InstanceResponse(
            id=i.id, server_id=i.server_id, cms_type=i.cms_type,
            version=i.version, name=i.name, domain=i.domain,
            status=i.status, url=i.url, workers=i.workers,
            ram_mb=i.ram_mb, cpu_cores=i.cpu_cores,
        )
        for i in instances
    ]


@router.post("/", response_model=InstanceResponse, status_code=201)
async def create_instance(
    body: InstanceCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    srv = await db.execute(
        select(Server).where(Server.id == body.server_id, Server.owner_id == user["telegram_id"])
    )
    if not srv.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Server not found")

    instance = Instance(
        name=body.name, cms_type=body.cms_type, version=body.version,
        server_id=body.server_id, domain=body.domain, status="deploying",
        workers=body.workers, ram_mb=body.ram_mb, cpu_cores=body.cpu_cores,
        config=body.config, owner_id=user["telegram_id"],
    )
    db.add(instance)
    await db.commit()
    await db.refresh(instance)

    return InstanceResponse(
        id=instance.id, server_id=instance.server_id, cms_type=instance.cms_type,
        version=instance.version, name=instance.name, domain=instance.domain,
        status=instance.status, url=instance.url, workers=instance.workers,
        ram_mb=instance.ram_mb, cpu_cores=instance.cpu_cores,
    )


@router.get("/{instance_id}", response_model=InstanceResponse)
async def get_instance(
    instance_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    return InstanceResponse(
        id=inst.id, server_id=inst.server_id, cms_type=inst.cms_type,
        version=inst.version, name=inst.name, domain=inst.domain,
        status=inst.status, url=inst.url, workers=inst.workers,
        ram_mb=inst.ram_mb, cpu_cores=inst.cpu_cores,
    )


@router.post("/{instance_id}/restart")
async def restart_instance(
    instance_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    return {"detail": f"Restart triggered for {inst.name}"}


@router.post("/{instance_id}/scale")
async def scale_instance(
    instance_id: str,
    workers: int = 2,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    inst.workers = workers
    await db.commit()
    return {"detail": f"Scaled {inst.name} to {workers} workers"}


@router.delete("/{instance_id}")
async def delete_instance(
    instance_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    result = await db.execute(
        select(Instance).where(Instance.id == instance_id, Instance.owner_id == user["telegram_id"])
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    await db.delete(inst)
    await db.commit()
    return {"detail": f"Instance {inst.name} removed"}
