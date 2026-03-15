"""GitHub OAuth — DB-backed token storage (works through any reverse proxy)."""

import logging
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Depends, Request, Query
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth import get_current_user
from core.config import settings
from core.database import get_db, async_session

logger = logging.getLogger(__name__)

router = APIRouter()

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"

# Scopes: repo (private repos read/write) — needed to clone private repos
SCOPES = "repo"


# ---------------------------------------------------------------------------
# DB helpers — dedicated github_tokens table (user may not exist in users)
# ---------------------------------------------------------------------------
_table_ensured = False


async def _ensure_table(db: AsyncSession):
    global _table_ensured
    if _table_ensured:
        return
    try:
        await db.execute(text("""
            CREATE TABLE IF NOT EXISTS github_tokens (
                user_id VARCHAR(64) PRIMARY KEY,
                token VARCHAR(255) NOT NULL DEFAULT '',
                created_at TIMESTAMP DEFAULT NOW()
            )
        """))
        await db.commit()
        _table_ensured = True
    except Exception:
        await db.rollback()


async def _get_gh_token(user_id: str, db: AsyncSession) -> str:
    await _ensure_table(db)
    result = await db.execute(
        text("SELECT token FROM github_tokens WHERE user_id = :uid"),
        {"uid": user_id},
    )
    row = result.first()
    return (row[0] or "") if row else ""


async def _set_gh_token(user_id: str, token: str, db: AsyncSession):
    await _ensure_table(db)
    await db.execute(text("""
        INSERT INTO github_tokens (user_id, token) VALUES (:uid, :tok)
        ON CONFLICT (user_id) DO UPDATE SET token = :tok
    """), {"uid": user_id, "tok": token})
    await db.commit()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
import time as _time

# Cache: user_id -> (timestamp, GitHubStatus)
_status_cache: dict[str, tuple[float, "GitHubStatus"]] = {}
_STATUS_TTL = 300  # 5 minutes


class GitHubStatus(BaseModel):
    connected: bool
    username: str = ""
    avatar_url: str = ""


@router.get("/github/status", response_model=GitHubStatus)
async def github_status(
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Check if user has a GitHub token stored."""
    uid = user["telegram_id"]

    # Check cache first
    if uid in _status_cache:
        ts, cached = _status_cache[uid]
        if _time.time() - ts < _STATUS_TTL:
            return cached

    await _ensure_table(db)
    gh_token = await _get_gh_token(uid, db)
    if not gh_token:
        result = GitHubStatus(connected=False)
        _status_cache[uid] = (_time.time(), result)
        return result

    # Validate token is still valid
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                GITHUB_USER_URL,
                headers={"Authorization": f"token {gh_token}", "Accept": "application/vnd.github.v3+json"},
            )
            if resp.status_code == 200:
                data = resp.json()
                result = GitHubStatus(
                    connected=True,
                    username=data.get("login", ""),
                    avatar_url=data.get("avatar_url", ""),
                )
                _status_cache[uid] = (_time.time(), result)
                return result
    except Exception:
        pass

    return GitHubStatus(connected=False)


@router.get("/github/authorize")
async def github_authorize(
    user: dict = Depends(get_current_user),
    return_to: str = "",
):
    """Return GitHub OAuth authorization URL."""
    if not settings.github_oauth_client_id:
        raise HTTPException(status_code=503, detail="GitHub OAuth not configured")

    base = f"https://{settings.domain}" if settings.app_env != "dev" else "http://localhost:3001"
    redirect_uri = f"{base}/api/v1/settings/github/callback"

    # Encode user_id + return URL in state so callback knows who to store for
    state = f"{user['telegram_id']}|{return_to or ''}"

    url = (
        f"{GITHUB_AUTHORIZE_URL}"
        f"?client_id={settings.github_oauth_client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&scope={SCOPES}"
        f"&state={state}"
    )
    return {"authorize_url": url}


@router.get("/github/callback")
async def github_callback(
    code: str,
    state: str = "",
    db: AsyncSession = Depends(get_db),
):
    """Handle GitHub OAuth callback — exchange code for token, store in DB."""
    if not settings.github_oauth_client_id or not settings.github_oauth_client_secret:
        raise HTTPException(status_code=503, detail="GitHub OAuth not configured")

    # Parse state: "user_id|return_path"
    parts = state.split("|", 1)
    user_id = parts[0] if parts else ""
    return_path = parts[1] if len(parts) > 1 else ""

    # Exchange code for access token
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            GITHUB_TOKEN_URL,
            json={
                "client_id": settings.github_oauth_client_id,
                "client_secret": settings.github_oauth_client_secret,
                "code": code,
            },
            headers={"Accept": "application/json"},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=400, detail="GitHub token exchange failed")

        data = resp.json()
        access_token = data.get("access_token")
        if not access_token:
            error = data.get("error_description", data.get("error", "unknown"))
            raise HTTPException(status_code=400, detail=f"GitHub OAuth error: {error}")

    # Store token in DB
    await _ensure_table(db)
    if user_id:
        await _set_gh_token(user_id, access_token, db)
        logger.info(f"GitHub token stored for user {user_id}")
        _status_cache.pop(user_id, None)  # invalidate cache

    # Redirect back to where the user was (or instances list)
    base = f"https://{settings.domain}" if settings.app_env != "dev" else "http://localhost:3001"
    redirect_url = f"{base}{return_path}" if return_path else f"{base}/instances"
    redirect_url += ("&" if "?" in redirect_url else "?") + "github=connected"

    from starlette.responses import RedirectResponse
    return RedirectResponse(url=redirect_url)


@router.post("/github/disconnect")
async def github_disconnect(
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove stored GitHub token."""
    _status_cache.pop(user["telegram_id"], None)  # invalidate cache
    await _ensure_table(db)
    await _set_gh_token(user["telegram_id"], "", db)
    return {"ok": True}


@router.get("/github/repos")
async def github_repos(
    search: str = "",
    page: int = 1,
    per_page: int = 30,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List user's GitHub repos (including private ones) for the Add from GitHub flow."""
    await _ensure_table(db)
    gh_token = await _get_gh_token(user["telegram_id"], db)
    if not gh_token:
        raise HTTPException(status_code=401, detail="GitHub not connected")

    headers = {"Authorization": f"token {gh_token}", "Accept": "application/vnd.github.v3+json"}

    async with httpx.AsyncClient(timeout=15) as client:
        if search:
            resp = await client.get(
                "https://api.github.com/search/repositories",
                params={"q": f"{search} in:name fork:true user:@me", "per_page": per_page, "page": page, "sort": "updated"},
                headers=headers,
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="GitHub API error")
            data = resp.json()
            repos = data.get("items", [])
            total = data.get("total_count", 0)
        else:
            resp = await client.get(
                "https://api.github.com/user/repos",
                params={"per_page": per_page, "page": page, "sort": "updated", "affiliation": "owner,collaborator,organization_member"},
                headers=headers,
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="GitHub API error")
            repos = resp.json()
            total = len(repos) + (per_page * page if len(repos) == per_page else 0)

    return {
        "repos": [
            {
                "full_name": r.get("full_name", ""),
                "name": r.get("name", ""),
                "clone_url": r.get("clone_url", ""),
                "private": r.get("private", False),
                "description": r.get("description", "") or "",
                "default_branch": r.get("default_branch", "main"),
                "updated_at": r.get("updated_at", ""),
                "language": r.get("language", ""),
                "owner_avatar": r.get("owner", {}).get("avatar_url", ""),
            }
            for r in repos
        ],
        "total": total,
        "page": page,
    }


@router.get("/github/repos/{owner}/{repo}/branches")
async def github_branches(
    owner: str,
    repo: str,
    user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List branches for a specific GitHub repo."""
    await _ensure_table(db)
    gh_token = await _get_gh_token(user["telegram_id"], db)
    if not gh_token:
        raise HTTPException(status_code=401, detail="GitHub not connected")

    headers = {"Authorization": f"token {gh_token}", "Accept": "application/vnd.github.v3+json"}

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/branches",
            params={"per_page": 100},
            headers=headers,
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="GitHub API error")
        branches = resp.json()

    return {
        "branches": [
            {"name": b.get("name", ""), "protected": b.get("protected", False)}
            for b in branches
        ]
    }


async def get_github_token_for_user(user_id: str) -> str | None:
    """Helper to get GitHub token from DB (used by other routes)."""
    async with async_session() as db:
        await _ensure_table(db)
        token = await _get_gh_token(user_id, db)
        return token or None


def get_github_token(request: Request) -> str | None:
    """Legacy helper — checks cookie for backwards compat, but DB is primary."""
    return request.cookies.get("crx_github_token") or None
