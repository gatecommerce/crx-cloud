"""Vito (CRX Team AI) bridge endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import httpx

from core.config import settings

router = APIRouter()


class VitoMessage(BaseModel):
    message: str
    context: dict = {}  # server_id, instance_id, etc.


class VitoResponse(BaseModel):
    reply: str
    actions_taken: list[str] = []
    suggestions: list[str] = []


@router.post("/chat", response_model=VitoResponse)
async def chat_with_vito(msg: VitoMessage):
    """Send a message to Vito (CRX Team) and get AI-powered response."""
    if not settings.crx_team_api_url:
        raise HTTPException(status_code=503, detail="CRX Team not configured")

    # TODO: forward to CRX Team API with cloud context
    # The context includes which server/instance the user is looking at,
    # so Vito can take actions on the right target
    return VitoResponse(
        reply="Vito bridge not yet connected. Configure CRX_TEAM_API_URL.",
        actions_taken=[],
        suggestions=["Configure CRX Team API connection"],
    )
