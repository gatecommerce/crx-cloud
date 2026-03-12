"""CRX Cloud — AI-Powered Multi-CMS Hosting Panel API."""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from api.routes import servers, instances, backups, plugins, health, vito, auth, cloud_providers
from core.config import settings
from core.database import init_db


async def _wait_for_db(max_retries: int = 15, delay: float = 2.0):
    """Wait for PostgreSQL to be ready before creating tables."""
    for attempt in range(1, max_retries + 1):
        try:
            await init_db()
            logger.info(f"Database ready (attempt {attempt})")
            return
        except Exception as e:
            if attempt == max_retries:
                logger.error(f"Database not ready after {max_retries} attempts: {e}")
                raise
            logger.warning(f"DB not ready (attempt {attempt}/{max_retries}), retrying in {delay}s...")
            await asyncio.sleep(delay)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown events."""
    if settings.app_env == "dev":
        await _wait_for_db()
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
app.include_router(cloud_providers.router, prefix="/api/v1/cloud", tags=["cloud-providers"])
