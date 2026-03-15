"""Database Explorer API — secure PostgreSQL access for Odoo instances.

Provides table browsing, record CRUD, SQL console, statistics,
index analysis, data export, and Odoo-specific quick actions.
All operations go through SSH + Docker exec (no exposed DB ports).
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.instance import Instance
from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db
from core.db_explorer import DbExplorer, QueryMode
from core.orchestrator import _server_info_from_db

logger = logging.getLogger(__name__)
router = APIRouter()
explorer = DbExplorer()


# ── Pydantic Models ──────────────────────────────────────────────────

class TableResponse(BaseModel):
    name: str
    label: str
    row_count: int
    size_bytes: int
    size_pretty: str
    category: str
    is_system: bool
    has_primary_key: bool


class ColumnResponse(BaseModel):
    name: str
    data_type: str
    is_nullable: bool
    is_primary_key: bool
    default_value: str | None = None
    max_length: int | None = None
    foreign_key: dict | None = None
    odoo_field_type: str | None = None
    odoo_label: str | None = None


class RecordRequest(BaseModel):
    page: int = 1
    page_size: int = 50
    order_by: str = "id"
    order_dir: str = "DESC"
    search: str = ""
    filters: dict[str, str] = {}


class RecordUpdateRequest(BaseModel):
    updates: dict[str, Any]


class RecordInsertRequest(BaseModel):
    values: dict[str, Any]


class QueryRequest(BaseModel):
    sql: str
    max_rows: int = 500


class QueryResponse(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    total_count: int
    execution_time_ms: float
    query: str
    mode: str
    affected_rows: int = 0
    error: str | None = None
    warnings: list[str] = []


class DbStatsResponse(BaseModel):
    db_name: str
    db_size: str
    total_tables: int
    total_rows: int
    largest_tables: list[dict]
    active_connections: int
    pg_version: str
    cache_hit_ratio: float


class IndexResponse(BaseModel):
    name: str
    table: str
    columns: list[str]
    is_unique: bool
    is_primary: bool
    size_pretty: str
    index_scans: int
    suggestion: str | None = None


class ResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=8)


class ToggleUserRequest(BaseModel):
    user_id: int
    active: bool


# ── Helpers ──────────────────────────────────────────────────────────

async def _get_instance_and_server(
    instance_id: str, db: AsyncSession, user: dict,
) -> tuple[Instance, Server]:
    """Verify ownership and return instance + server."""
    result = await db.execute(
        select(Instance).where(
            Instance.id == instance_id,
            Instance.owner_id == user["telegram_id"],
        )
    )
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    if inst.status != "running":
        raise HTTPException(
            status_code=400,
            detail=f"Instance must be running to access database (current: {inst.status})",
        )

    s_result = await db.execute(select(Server).where(Server.id == inst.server_id))
    server = s_result.scalar_one_or_none()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    return inst, server


# ── Table Endpoints ──────────────────────────────────────────────────

@router.get("/{instance_id}/tables", response_model=list[TableResponse])
async def list_tables(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List all database tables with metadata."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    try:
        tables = await explorer.list_tables(server_info, inst.config or {})
        return [
            TableResponse(
                name=t.name, label=t.label, row_count=t.row_count,
                size_bytes=t.size_bytes, size_pretty=t.size_pretty,
                category=t.category, is_system=t.is_system,
                has_primary_key=t.has_primary_key,
            )
            for t in tables
        ]
    except Exception as e:
        logger.error(f"list_tables failed for {instance_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{instance_id}/tables/{table}/columns", response_model=list[ColumnResponse])
async def get_columns(
    instance_id: str,
    table: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get column details for a table, enriched with Odoo metadata."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    try:
        columns = await explorer.get_columns(server_info, inst.config or {}, table)
        return [
            ColumnResponse(
                name=c.name, data_type=c.data_type, is_nullable=c.is_nullable,
                is_primary_key=c.is_primary_key, default_value=c.default_value,
                max_length=c.max_length, foreign_key=c.foreign_key,
                odoo_field_type=c.odoo_field_type, odoo_label=c.odoo_label,
            )
            for c in columns
        ]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"get_columns failed for {instance_id}/{table}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Record Endpoints ─────────────────────────────────────────────────

@router.post("/{instance_id}/tables/{table}/records", response_model=QueryResponse)
async def get_records(
    instance_id: str,
    table: str,
    body: RecordRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get paginated records from a table."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    try:
        result = await explorer.get_records(
            server_info, inst.config or {}, table,
            page=body.page, page_size=body.page_size,
            order_by=body.order_by, order_dir=body.order_dir,
            search=body.search, filters=body.filters or None,
        )
        return _to_query_response(result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"get_records failed for {instance_id}/{table}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{instance_id}/tables/{table}/records/{record_id}", response_model=QueryResponse)
async def update_record(
    instance_id: str,
    table: str,
    record_id: int,
    body: RecordUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update a single record by primary key."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.update_record(
        server_info, inst.config or {}, table, record_id, body.updates,
    )
    if result.error:
        raise HTTPException(status_code=400, detail=result.error)
    return _to_query_response(result)


@router.put("/{instance_id}/tables/{table}/records", response_model=QueryResponse)
async def insert_record(
    instance_id: str,
    table: str,
    body: RecordInsertRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Insert a new record into a table."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.insert_record(
        server_info, inst.config or {}, table, body.values,
    )
    if result.error:
        raise HTTPException(status_code=400, detail=result.error)
    return _to_query_response(result)


@router.delete("/{instance_id}/tables/{table}/records/{record_id}", response_model=QueryResponse)
async def delete_record(
    instance_id: str,
    table: str,
    record_id: int,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Delete a single record by primary key."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.delete_record(
        server_info, inst.config or {}, table, record_id,
    )
    if result.error:
        raise HTTPException(status_code=400, detail=result.error)
    return _to_query_response(result)


# ── SQL Console ──────────────────────────────────────────────────────

@router.post("/{instance_id}/query", response_model=QueryResponse)
async def execute_query(
    instance_id: str,
    body: QueryRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Execute a raw SQL query with safety checks."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    if not body.sql.strip():
        raise HTTPException(status_code=400, detail="Empty query")

    result = await explorer.execute_query(
        server_info, inst.config or {}, body.sql, max_rows=body.max_rows,
    )

    if result.error:
        raise HTTPException(status_code=400, detail=result.error)

    return _to_query_response(result)


# ── Statistics & Analysis ────────────────────────────────────────────

@router.get("/{instance_id}/stats", response_model=DbStatsResponse)
async def get_stats(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get comprehensive database statistics."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    try:
        stats = await explorer.get_stats(server_info, inst.config or {})
        return DbStatsResponse(
            db_name=stats.db_name, db_size=stats.db_size,
            total_tables=stats.total_tables, total_rows=stats.total_rows,
            largest_tables=stats.largest_tables,
            active_connections=stats.active_connections,
            pg_version=stats.pg_version,
            cache_hit_ratio=stats.cache_hit_ratio,
        )
    except Exception as e:
        logger.error(f"get_stats failed for {instance_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{instance_id}/tables/{table}/indexes", response_model=list[IndexResponse])
async def get_indexes(
    instance_id: str,
    table: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get index information with usage stats and optimization suggestions."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    try:
        indexes = await explorer.get_indexes(server_info, inst.config or {}, table)
        return [
            IndexResponse(
                name=idx.name, table=idx.table, columns=idx.columns,
                is_unique=idx.is_unique, is_primary=idx.is_primary,
                size_pretty=idx.size_pretty, index_scans=idx.index_scans,
                suggestion=idx.suggestion,
            )
            for idx in indexes
        ]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"get_indexes failed for {instance_id}/{table}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Export ───────────────────────────────────────────────────────────

@router.get("/{instance_id}/tables/{table}/export")
async def export_table(
    instance_id: str,
    table: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Export table data as CSV download."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    try:
        csv_data = await explorer.export_csv(server_info, inst.config or {}, table)
        return Response(
            content=csv_data,
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{table}.csv"'},
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"export_table failed for {instance_id}/{table}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Quick Actions (Odoo-specific) ────────────────────────────────────

@router.post("/{instance_id}/actions/reset-password", response_model=QueryResponse)
async def reset_admin_password(
    instance_id: str,
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Reset Odoo admin user password."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.reset_admin_password(
        server_info, inst.config or {}, body.new_password,
    )
    if result.error:
        raise HTTPException(status_code=500, detail=result.error)
    return _to_query_response(result)


@router.post("/{instance_id}/actions/cleanup-sessions", response_model=QueryResponse)
async def cleanup_sessions(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Clean up expired HTTP sessions."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.cleanup_sessions(server_info, inst.config or {})
    return _to_query_response(result)


@router.post("/{instance_id}/actions/cleanup-attachments", response_model=QueryResponse)
async def cleanup_attachments(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Find orphaned attachments."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.cleanup_orphan_attachments(server_info, inst.config or {})
    return _to_query_response(result)


@router.get("/{instance_id}/actions/users", response_model=QueryResponse)
async def get_active_users(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List active Odoo users with last login info."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.get_active_users(server_info, inst.config or {})
    return _to_query_response(result)


@router.get("/{instance_id}/actions/modules", response_model=QueryResponse)
async def get_installed_modules(
    instance_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """List installed Odoo modules."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.get_installed_modules(server_info, inst.config or {})
    return _to_query_response(result)


@router.post("/{instance_id}/actions/toggle-user", response_model=QueryResponse)
async def toggle_user(
    instance_id: str,
    body: ToggleUserRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Enable or disable an Odoo user."""
    inst, server = await _get_instance_and_server(instance_id, db, user)
    server_info = _server_info_from_db(server)

    result = await explorer.toggle_user(
        server_info, inst.config or {}, body.user_id, body.active,
    )
    if result.error:
        raise HTTPException(status_code=400, detail=result.error)
    return _to_query_response(result)


# ── Response helpers ─────────────────────────────────────────────────

def _to_query_response(result) -> QueryResponse:
    return QueryResponse(
        columns=result.columns,
        rows=result.rows,
        row_count=result.row_count,
        total_count=result.total_count,
        execution_time_ms=result.execution_time_ms,
        query=result.query,
        mode=result.mode.value if hasattr(result.mode, "value") else str(result.mode),
        affected_rows=result.affected_rows,
        error=result.error,
        warnings=result.warnings,
    )
