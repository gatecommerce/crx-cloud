"""CRX Cloud configuration."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_env: str = "dev"
    app_name: str = "CRX Cloud"
    api_host: str = "0.0.0.0"
    api_port: int = 8080
    secret_key: str = "change-me-in-production"
    database_url: str = "postgresql+asyncpg://crxcloud:crxcloud@localhost:5432/crxcloud"

    # CRX Team bridge
    crx_team_api_url: str = "http://localhost:8000"
    crx_team_api_key: str = ""

    # CORS
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:3001"]

    # Cloudflare
    cloudflare_api_token: str = ""
    cloudflare_zone_id: str = ""

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
