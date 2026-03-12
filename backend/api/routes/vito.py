"""Vito (CRX Team AI) bridge endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

import httpx
from loguru import logger

from core.auth import get_current_user
from core.config import settings

router = APIRouter()


class VitoMessage(BaseModel):
    message: str
    context: dict = {}


class VitoResponse(BaseModel):
    reply: str
    actions_taken: list[str] = []
    suggestions: list[str] = []


@router.post("/chat", response_model=VitoResponse)
async def chat_with_vito(
    msg: VitoMessage,
    user: dict = Depends(get_current_user),
):
    if not settings.crx_team_api_url:
        raise HTTPException(status_code=503, detail="CRX Team not configured")

    cloud_context = {
        "source": "crx-cloud-panel",
        "user_telegram_id": user["telegram_id"],
        "user_name": user["name"],
        **msg.context,
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{settings.crx_team_api_url}/api/v1/vice/chat",
                json={"message": msg.message, "context": cloud_context},
                headers={"Authorization": f"Bearer {settings.crx_team_api_key}"},
            )
            response.raise_for_status()
            data = response.json()

            return VitoResponse(
                reply=data.get("reply", data.get("response", "")),
                actions_taken=data.get("actions_taken", []),
                suggestions=data.get("suggestions", []),
            )
    except httpx.ConnectError:
        logger.warning("CRX Team API unreachable")
        return VitoResponse(
            reply="Vito non e' raggiungibile al momento. Verifica che CRX Team sia attivo.",
            suggestions=["Controlla che CRX Team sia in esecuzione"],
        )
    except httpx.HTTPStatusError as e:
        logger.error(f"CRX Team API error: {e.response.status_code}")
        return VitoResponse(
            reply=f"Errore dalla piattaforma AI (HTTP {e.response.status_code}). Riprova.",
            suggestions=["Riprova tra qualche secondo"],
        )
