"""CRX Cloud configuration."""

import os

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_env: str = "dev"
    app_name: str = "CRX Cloud"
    api_host: str = "0.0.0.0"
    api_port: int = 8080
    secret_key: str = "change-me-in-production"
    database_url: str = "postgresql+asyncpg://crxcloud:crxcloud@localhost:5432/crxcloud"

    # JWT / Session
    jwt_secret: str = os.getenv("JWT_SECRET", "change-me-in-production-jwt")
    session_ttl_hours: int = 24
    token_ttl_minutes: int = 60

    # Cookie — secure=False in dev so cookies work on http://localhost
    cookie_name: str = "crx_cloud_session"
    cookie_secure: bool = os.getenv("APP_ENV", "dev") != "dev"
    cookie_samesite: str = "lax" if os.getenv("APP_ENV", "dev") == "dev" else "strict"

    # Telegram
    telegram_bot_token: str = ""
    telegram_bot_username: str = ""
    telegram_owner_id: int = 0

    # CRX Team bridge
    crx_team_api_url: str = "http://localhost:8000"
    crx_team_api_key: str = ""

    # CORS
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:3001"]

    # Domain
    domain: str = os.getenv("CLOUD_DOMAIN", "cloud.crx.team")

    # Cloud Providers
    hetzner_api_token: str = ""
    digitalocean_api_token: str = ""
    vultr_api_key: str = ""
    linode_api_token: str = ""

    # Cloudflare
    cloudflare_api_token: str = ""
    cloudflare_zone_id: str = ""

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
