"""WebSocket endpoint for real-time log streaming.

Architecture:
  Client ←→ WebSocket ←→ SSH channel ←→ docker logs -f

Supports bidirectional commands:
  Client → Server: {action: "pause|resume|container|filter|history"}
  Server → Client: {type: "log|stats|error|connected|history"}
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.instance import Instance
from api.models.server import Server
from core.auth import decode_session_jwt
from core.database import async_session
from core.log_parser import LogEntry, LogLevel, parse_lines, detect_level

logger = logging.getLogger(__name__)

router = APIRouter()

# Maximum buffer size per connection (lines kept in server memory)
MAX_BUFFER_SIZE = 10_000
# SSH read chunk size
READ_CHUNK_SIZE = 4096
# Stats broadcast interval (seconds)
STATS_INTERVAL = 5.0


class LogStreamSession:
    """Manages a single WebSocket log streaming session."""

    def __init__(self, websocket: WebSocket, instance: Instance, server: Server):
        self.ws = websocket
        self.instance = instance
        self.server = server
        self.buffer: list[LogEntry] = []
        self.paused = False
        self.active = True
        self.container = self._default_container()
        self.connected_at = time.time()
        self.total_lines = 0
        self.stats = {level.value: 0 for level in LogLevel}
        self._pending_while_paused: list[LogEntry] = []

    def _default_container(self) -> str:
        config = self.instance.config or {}
        prefix = config.get("prefix", "")
        return f"{prefix}-odoo" if prefix else ""

    def available_containers(self) -> list[str]:
        config = self.instance.config or {}
        prefix = config.get("prefix", "")
        if not prefix:
            return []
        return [
            f"{prefix}-odoo",
            f"{prefix}-nginx",
            f"{prefix}-db",
        ]

    def update_stats(self, entries: list[LogEntry]):
        for e in entries:
            self.stats[e.level.value] = self.stats.get(e.level.value, 0) + 1
            self.total_lines += 1

    def add_to_buffer(self, entries: list[LogEntry]):
        self.buffer.extend(entries)
        if len(self.buffer) > MAX_BUFFER_SIZE:
            self.buffer = self.buffer[-MAX_BUFFER_SIZE:]


async def _get_ssh_info(server: Server):
    """Build ServerInfo for SSH connection."""
    from core.server_manager import ServerInfo, ServerStatus
    return ServerInfo(
        id=server.id, name=server.name, server_type="vm",
        provider=server.provider or "", status=ServerStatus.ONLINE,
        endpoint=server.endpoint,
        metadata={
            "ssh_user": server.ssh_user or "root",
            "ssh_key_path": server.ssh_key_path or "",
        },
    )


async def _stream_docker_logs(
    session: LogStreamSession,
    initial_lines: int = 200,
):
    """Stream docker logs via SSH and send parsed entries over WebSocket.

    Uses `docker logs -f --tail N` for continuous streaming.
    Falls back to polling if streaming channel fails.
    """
    from core.vm_controller import VMDriver

    vm = VMDriver()
    server_info = await _get_ssh_info(session.server)
    client = None

    try:
        # Get SSH client (runs in thread pool)
        loop = asyncio.get_event_loop()
        client = await loop.run_in_executor(
            None, vm._get_ssh_client, server_info
        )

        container = session.container
        cmd = f"docker logs {container} --tail {initial_lines} -f --timestamps 2>&1"

        # Execute with streaming channel
        _, stdout, stderr = client.exec_command(cmd, get_pty=False)
        channel = stdout.channel
        channel.settimeout(0.5)

        line_buffer = ""
        line_counter = 1
        last_stats_time = time.time()

        while session.active:
            try:
                # Non-blocking read from SSH channel
                if channel.recv_ready():
                    chunk = channel.recv(READ_CHUNK_SIZE).decode("utf-8", errors="replace")
                    line_buffer += chunk

                    # Process complete lines
                    while "\n" in line_buffer:
                        line, line_buffer = line_buffer.split("\n", 1)
                        line = line.rstrip("\r")
                        if not line.strip():
                            continue

                        entries = parse_lines(
                            [line],
                            container=container,
                            start_line=line_counter,
                        )
                        line_counter += 1

                        if entries:
                            session.update_stats(entries)
                            session.add_to_buffer(entries)

                            if not session.paused:
                                # Send log entries
                                await session.ws.send_json({
                                    "type": "log",
                                    "entries": [e.to_dict() for e in entries],
                                })
                            else:
                                session._pending_while_paused.extend(entries)

                elif channel.recv_stderr_ready():
                    # Read stderr but still stream it
                    chunk = channel.recv_stderr(READ_CHUNK_SIZE).decode("utf-8", errors="replace")
                    line_buffer += chunk
                else:
                    # No data available — small sleep to prevent CPU spinning
                    await asyncio.sleep(0.1)

                # Check if channel closed
                if channel.closed or channel.exit_status_ready():
                    logger.info(f"SSH channel closed for {container}")
                    break

                # Periodic stats broadcast
                now = time.time()
                if now - last_stats_time >= STATS_INTERVAL:
                    await _send_stats(session)
                    last_stats_time = now

            except asyncio.CancelledError:
                break
            except Exception as e:
                if session.active:
                    logger.warning(f"Stream read error: {e}")
                    await asyncio.sleep(0.5)

    except Exception as e:
        logger.error(f"SSH streaming failed for {session.container}: {e}")
        if session.active:
            try:
                await session.ws.send_json({
                    "type": "error",
                    "message": f"SSH connection failed: {str(e)}",
                })
            except Exception:
                pass
    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass


async def _send_stats(session: LogStreamSession):
    """Send aggregated stats to client."""
    try:
        elapsed = int(time.time() - session.connected_at)
        await session.ws.send_json({
            "type": "stats",
            "stats": session.stats,
            "total_lines": session.total_lines,
            "buffer_size": len(session.buffer),
            "connected_seconds": elapsed,
            "paused": session.paused,
        })
    except Exception:
        pass


async def _send_history(session: LogStreamSession, count: int = 500):
    """Send buffered history to client (e.g., after reconnect or container switch)."""
    entries = session.buffer[-count:] if session.buffer else []
    try:
        await session.ws.send_json({
            "type": "history",
            "entries": [e.to_dict() for e in entries],
            "total_buffered": len(session.buffer),
        })
    except Exception:
        pass


async def _handle_client_command(session: LogStreamSession, data: dict) -> Optional[asyncio.Task]:
    """Process commands from WebSocket client. Returns a new stream task if container changed."""
    action = data.get("action", "")

    if action == "pause":
        session.paused = True
        await session.ws.send_json({"type": "paused", "pending": len(session._pending_while_paused)})

    elif action == "resume":
        session.paused = False
        # Flush pending entries
        if session._pending_while_paused:
            await session.ws.send_json({
                "type": "log",
                "entries": [e.to_dict() for e in session._pending_while_paused],
            })
            session._pending_while_paused.clear()
        await session.ws.send_json({"type": "resumed"})

    elif action == "container":
        new_container = data.get("name", "")
        available = session.available_containers()
        if new_container and (new_container in available or not available):
            session.container = new_container
            session.buffer.clear()
            session.stats = {level.value: 0 for level in LogLevel}
            session.total_lines = 0
            session._pending_while_paused.clear()
            await session.ws.send_json({
                "type": "container_changed",
                "container": new_container,
                "available": available,
            })
            # Signal caller to restart stream
            return True  # type: ignore
        else:
            await session.ws.send_json({
                "type": "error",
                "message": f"Container '{new_container}' not available. Available: {available}",
            })

    elif action == "history":
        count = data.get("count", 500)
        await _send_history(session, count)

    elif action == "stats":
        await _send_stats(session)

    elif action == "clear":
        session.buffer.clear()
        session.stats = {level.value: 0 for level in LogLevel}
        session.total_lines = 0
        session._pending_while_paused.clear()
        await session.ws.send_json({"type": "cleared"})

    return None


async def _authenticate_ws(websocket: WebSocket) -> Optional[dict]:
    """Authenticate WebSocket connection using session cookie.

    Returns a dict compatible with get_current_user output:
    {telegram_id, name, is_admin, lang}.
    """
    from core.config import settings as app_settings

    cookies = websocket.cookies
    token = cookies.get(app_settings.cookie_name)
    if not token:
        # Try query param as fallback
        token = websocket.query_params.get("token")
    if not token:
        return None
    try:
        payload = decode_session_jwt(token)
        if not payload:
            return None
        return {
            "telegram_id": payload["sub"],
            "name": payload.get("name", ""),
            "is_admin": payload.get("is_admin", False),
            "lang": payload.get("lang", "it"),
        }
    except Exception:
        return None


@router.websocket("/ws/instances/{instance_id}/logs")
async def websocket_log_stream(
    websocket: WebSocket,
    instance_id: str,
    lines: int = 200,
):
    """WebSocket endpoint for real-time log streaming.

    Connection flow:
    1. Authenticate via session cookie
    2. Validate instance ownership
    3. Send initial connection info (available containers, etc.)
    4. Start streaming docker logs via SSH
    5. Handle bidirectional commands (pause, resume, container switch, etc.)
    """
    await websocket.accept()

    # --- Authentication ---
    user = await _authenticate_ws(websocket)
    if not user:
        await websocket.send_json({"type": "error", "message": "Authentication failed"})
        await websocket.close(code=4001, reason="Unauthorized")
        return

    # --- Load instance + server ---
    async with async_session() as db:
        result = await db.execute(
            select(Instance).where(
                Instance.id == instance_id,
                Instance.owner_id == user["telegram_id"],
            )
        )
        inst = result.scalar_one_or_none()
        if not inst:
            await websocket.send_json({"type": "error", "message": "Instance not found"})
            await websocket.close(code=4004, reason="Not found")
            return

        srv_result = await db.execute(select(Server).where(Server.id == inst.server_id))
        server = srv_result.scalar_one_or_none()
        if not server:
            await websocket.send_json({"type": "error", "message": "Server not found"})
            await websocket.close(code=4004, reason="Not found")
            return

        # Create session
        session = LogStreamSession(websocket, inst, server)

    # --- Send connection info ---
    await websocket.send_json({
        "type": "connected",
        "instance_id": instance_id,
        "instance_name": inst.name,
        "container": session.container,
        "available_containers": session.available_containers(),
        "initial_lines": lines,
    })

    # --- Start streaming ---
    stream_task: Optional[asyncio.Task] = asyncio.create_task(
        _stream_docker_logs(session, initial_lines=lines)
    )

    try:
        while True:
            try:
                raw = await websocket.receive_text()
                data = json.loads(raw)
                needs_restart = await _handle_client_command(session, data)

                if needs_restart:
                    # Cancel current stream and start new one
                    if stream_task:
                        stream_task.cancel()
                        try:
                            await stream_task
                        except (asyncio.CancelledError, Exception):
                            pass
                    stream_task = asyncio.create_task(
                        _stream_docker_logs(session, initial_lines=lines)
                    )

            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON"})

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for instance {instance_id}")
    except Exception as e:
        logger.error(f"WebSocket error for instance {instance_id}: {e}")
    finally:
        session.active = False
        if stream_task:
            stream_task.cancel()
            try:
                await stream_task
            except (asyncio.CancelledError, Exception):
                pass
