"""Telegram-based authentication for CRX Cloud.

Flow:
1. User clicks "CRX Cloud" in Telegram bot → bot calls create_one_time_token()
2. Bot sends link: https://cloud.crx.team/auth?token=XXX
3. Frontend POSTs token → validate_one_time_token() → consume
4. create_session_jwt() → HttpOnly cookie set
5. Every request → decode_session_jwt() → verify user
6. WebApp flow: Telegram passes initData → verify_webapp_data() → same JWT

Same bot as crx-team (@crx_vito_bot), same token for prod and dev.
"""

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import parse_qs

from jose import JWTError, jwt
from loguru import logger

from core.config import settings

# --- One-time tokens (file-based, shared with Telegram bot) ---

_token_lock = threading.Lock()


def _get_token_dir() -> str:
    """Token storage directory."""
    d = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "tokens")
    os.makedirs(d, exist_ok=True)
    return d


def _get_token_file() -> str:
    return os.path.join(_get_token_dir(), "pending_tokens.json")


def _load_tokens() -> dict:
    try:
        with open(_get_token_file(), "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_tokens(tokens: dict) -> None:
    with open(_get_token_file(), "w", encoding="utf-8") as f:
        json.dump(tokens, f, ensure_ascii=False)


def create_one_time_token(
    telegram_id: int,
    name: str = "",
    is_admin: bool = False,
    language: str = "it",
) -> str:
    """Generate a one-time token for web/webapp access.

    Returns: URL-safe token (43 chars, 256-bit entropy).
    """
    token = secrets.token_urlsafe(32)
    with _token_lock:
        tokens = _load_tokens()
        tokens[token] = {
            "telegram_id": telegram_id,
            "name": name,
            "is_admin": is_admin,
            "language": language,
            "created_at": time.time(),
            "used": False,
        }
        _save_tokens(tokens)
    logger.info(f"Token created for telegram_id={telegram_id}")
    return token


def validate_one_time_token(token: str) -> Optional[dict]:
    """Validate and consume a one-time token.

    Returns token payload if valid, None if invalid/expired/used.
    """
    with _token_lock:
        tokens = _load_tokens()
        payload = tokens.get(token)
        if not payload:
            return None
        if payload["used"]:
            return None
        age = time.time() - payload["created_at"]
        if age > settings.token_ttl_minutes * 60:
            tokens.pop(token, None)
            _save_tokens(tokens)
            return None
        payload["used"] = True
        _save_tokens(tokens)
        return {
            "telegram_id": payload["telegram_id"],
            "name": payload["name"],
            "is_admin": payload["is_admin"],
            "language": payload["language"],
        }


def cleanup_expired_tokens() -> int:
    """Remove expired/used tokens."""
    now = time.time()
    ttl = settings.token_ttl_minutes * 60
    removed = 0
    with _token_lock:
        tokens = _load_tokens()
        to_remove = [
            k for k, v in tokens.items()
            if v["used"] or (now - v["created_at"]) > ttl
        ]
        for k in to_remove:
            tokens.pop(k, None)
            removed += 1
        if removed:
            _save_tokens(tokens)
    return removed


# --- Telegram WebApp initData verification ---

def verify_webapp_data(init_data: str) -> Optional[dict]:
    """Verify Telegram WebApp initData hash.

    See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

    Returns user dict if valid, None otherwise.
    """
    if not settings.telegram_bot_token:
        logger.error("TELEGRAM_BOT_TOKEN not set, cannot verify WebApp data")
        return None

    try:
        parsed = parse_qs(init_data, keep_blank_values=True)
        received_hash = parsed.get("hash", [""])[0]
        if not received_hash:
            return None

        # Build data-check-string (sorted key=value pairs, excluding hash)
        pairs = []
        for key, values in parsed.items():
            if key != "hash":
                pairs.append(f"{key}={values[0]}")
        data_check_string = "\n".join(sorted(pairs))

        # HMAC-SHA256 with secret_key derived from bot token
        secret_key = hmac.new(
            b"WebAppData",
            settings.telegram_bot_token.encode(),
            hashlib.sha256,
        ).digest()
        computed_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(computed_hash, received_hash):
            logger.warning("WebApp hash mismatch")
            return None

        # Check auth_date freshness (max 5 minutes)
        auth_date = int(parsed.get("auth_date", ["0"])[0])
        if time.time() - auth_date > 300:
            logger.warning("WebApp auth_date too old")
            return None

        # Extract user
        user_json = parsed.get("user", [""])[0]
        if not user_json:
            return None
        user = json.loads(user_json)
        return {
            "telegram_id": user.get("id"),
            "name": f"{user.get('first_name', '')} {user.get('last_name', '')}".strip(),
            "username": user.get("username", ""),
            "language": user.get("language_code", "it"),
        }
    except Exception as e:
        logger.error(f"WebApp verification failed: {e}")
        return None


# --- JWT Session ---

def create_session_jwt(
    telegram_id: int,
    name: str = "",
    is_admin: bool = False,
    language: str = "it",
) -> str:
    """Create a session JWT."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(hours=settings.session_ttl_hours)
    payload = {
        "sub": str(telegram_id),
        "name": name,
        "is_admin": is_admin,
        "lang": language,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_session_jwt(token: str) -> Optional[dict]:
    """Decode and validate a session JWT."""
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except JWTError:
        return None


# --- FastAPI Dependency ---

async def get_current_user(request) -> dict:
    """FastAPI dependency: extract user from HttpOnly cookie JWT.

    Returns dict with: telegram_id (str), name, is_admin, lang.
    Use as: user: dict = Depends(get_current_user)
    """
    from fastapi import HTTPException, status, Request

    if not isinstance(request, Request):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="no_session")

    token = request.cookies.get(settings.cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="no_session")

    payload = decode_session_jwt(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_session")

    return {
        "telegram_id": payload["sub"],
        "name": payload.get("name", ""),
        "is_admin": payload.get("is_admin", False),
        "lang": payload.get("lang", "it"),
    }
