"""CRX Cloud — AI-Powered Multi-CMS Hosting Panel API."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import servers, instances, backups, plugins, health, vito, auth
from core.config import settings
from core.database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown events."""
    if settings.app_env == "dev":
        await init_db()
    yield


app = FastAPI(
    title="CRX Cloud API",
    description="AI-Powered Multi-CMS Hosting Panel",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(health.router, tags=["health"])
app.include_router(servers.router, prefix="/api/v1/servers", tags=["servers"])
app.include_router(instances.router, prefix="/api/v1/instances", tags=["instances"])
app.include_router(backups.router, prefix="/api/v1/backups", tags=["backups"])
app.include_router(plugins.router, prefix="/api/v1/plugins", tags=["plugins"])
app.include_router(vito.router, prefix="/api/v1/vito", tags=["vito"])
