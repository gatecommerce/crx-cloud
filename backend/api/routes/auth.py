"""Authentication routes — Telegram token + WebApp + session management."""

from fastapi import APIRouter, Request, Response, HTTPException, status
from pydantic import BaseModel
from loguru import logger

from core.config import settings
from core.auth import (
    validate_one_time_token,
    verify_webapp_data,
    create_session_jwt,
    decode_session_jwt,
    create_one_time_token,
)

router = APIRouter()


class TokenRequest(BaseModel):
    token: str


class WebAppRequest(BaseModel):
    init_data: str


class AuthResult(BaseModel):
    ok: bool
    redirect: str = ""


class SessionInfo(BaseModel):
    telegram_id: int
    name: str
    is_admin: bool
    lang: str


def _set_cookie(response: Response, jwt_token: str) -> None:
    """Set HttpOnly session cookie."""
    response.set_cookie(
        key=settings.cookie_name,
        value=jwt_token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        max_age=settings.session_ttl_hours * 3600,
        path="/",
    )


@router.post("/token", response_model=AuthResult)
async def validate_token(body: TokenRequest, response: Response):
    """Validate one-time Telegram token and create session.

    Called when user clicks the link from Telegram bot.
    """
    payload = validate_one_time_token(body.token)
    if not payload:
        logger.warning("Invalid or expired token")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_token")

    jwt_token = create_session_jwt(
        telegram_id=payload["telegram_id"],
        name=payload["name"],
        is_admin=payload["is_admin"],
        language=payload["language"],
    )
    _set_cookie(response, jwt_token)

    logger.info(f"Session created via token for telegram_id={payload['telegram_id']}")
    return AuthResult(ok=True, redirect="/")


@router.post("/webapp", response_model=AuthResult)
async def validate_webapp(body: WebAppRequest, response: Response):
    """Validate Telegram WebApp initData and create session.

    Called when panel is opened as Telegram Mini App.
    """
    user = verify_webapp_data(body.init_data)
    if not user:
        logger.warning("Invalid WebApp initData")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_webapp")

    # Check if user is the owner (admin)
    is_admin = user["telegram_id"] == settings.telegram_owner_id

    jwt_token = create_session_jwt(
        telegram_id=user["telegram_id"],
        name=user["name"],
        is_admin=is_admin,
        language=user["language"],
    )
    _set_cookie(response, jwt_token)

    logger.info(f"Session created via WebApp for telegram_id={user['telegram_id']}")
    return AuthResult(ok=True, redirect="/")


@router.get("/session", response_model=SessionInfo)
async def get_session(request: Request):
    """Get current session info."""
    token = request.cookies.get(settings.cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="no_session")

    payload = decode_session_jwt(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_session")

    return SessionInfo(
        telegram_id=int(payload["sub"]),
        name=payload.get("name", ""),
        is_admin=payload.get("is_admin", False),
        lang=payload.get("lang", "it"),
    )


@router.post("/refresh", response_model=AuthResult)
async def refresh_session(request: Request, response: Response):
    """Refresh session JWT."""
    token = request.cookies.get(settings.cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="no_session")

    payload = decode_session_jwt(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_session")

    new_jwt = create_session_jwt(
        telegram_id=int(payload["sub"]),
        name=payload.get("name", ""),
        is_admin=payload.get("is_admin", False),
        language=payload.get("lang", "it"),
    )
    _set_cookie(response, new_jwt)

    return AuthResult(ok=True)


@router.post("/logout")
async def logout(response: Response):
    """Clear session cookie."""
    response.delete_cookie(
        key=settings.cookie_name,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
    )
    return {"ok": True}


# --- Dev-only: generate test token ---
@router.post("/dev-token", response_model=AuthResult)
async def dev_token(response: Response):
    """DEV ONLY: Create a test session for the owner. Disabled in prod."""
    if settings.app_env != "dev":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    jwt_token = create_session_jwt(
        telegram_id=settings.telegram_owner_id or 999999,
        name="Dev Admin",
        is_admin=True,
        language="it",
    )
    _set_cookie(response, jwt_token)
    return AuthResult(ok=True, redirect="/")
