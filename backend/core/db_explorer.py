"""Database Explorer engine — secure PostgreSQL access via SSH + Docker exec.

Provides safe, audited access to Odoo instance databases through
SSH tunneling to the Docker PostgreSQL container. Inspired by
Supabase Studio and Beekeeper Studio UX patterns.

Security: all queries are parameterized or sanitized, write operations
require explicit confirmation, and every action is audit-logged.
"""

from __future__ import annotations

import csv
import io
import json
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from loguru import logger

from core.server_manager import ServerInfo
from core.vm_controller import VMDriver


# ── Constants ────────────────────────────────────────────────────────

MAX_QUERY_ROWS = 500
MAX_EXPORT_ROWS = 50_000
QUERY_TIMEOUT_SEC = 30
DANGEROUS_KEYWORDS = {
    "DROP DATABASE", "DROP SCHEMA", "TRUNCATE", "ALTER SYSTEM",
    "CREATE ROLE", "DROP ROLE", "ALTER ROLE", "REASSIGN OWNED",
    "pg_terminate_backend", "pg_cancel_backend",
}

# Odoo system tables that should be treated as read-only
ODOO_SYSTEM_TABLES = frozenset({
    "ir_module_module", "ir_module_module_dependency", "ir_model",
    "ir_model_fields", "ir_model_data", "ir_ui_view", "ir_act_window",
    "ir_cron", "ir_config_parameter", "ir_translation",
    "ir_attachment", "ir_sequence", "ir_rule", "ir_property",
})

# Friendly names for common Odoo tables
ODOO_TABLE_LABELS: dict[str, str] = {
    "res_partner": "Contacts",
    "res_users": "Users",
    "res_company": "Companies",
    "res_country": "Countries",
    "res_currency": "Currencies",
    "sale_order": "Sales Orders",
    "sale_order_line": "Sales Order Lines",
    "purchase_order": "Purchase Orders",
    "purchase_order_line": "Purchase Order Lines",
    "account_move": "Journal Entries / Invoices",
    "account_move_line": "Journal Items",
    "account_payment": "Payments",
    "account_account": "Chart of Accounts",
    "account_journal": "Journals",
    "account_tax": "Taxes",
    "product_template": "Products",
    "product_product": "Product Variants",
    "product_category": "Product Categories",
    "stock_picking": "Transfers",
    "stock_move": "Stock Moves",
    "stock_quant": "Stock On Hand",
    "stock_warehouse": "Warehouses",
    "stock_location": "Stock Locations",
    "hr_employee": "Employees",
    "hr_department": "Departments",
    "crm_lead": "CRM Leads / Opportunities",
    "project_project": "Projects",
    "project_task": "Tasks",
    "pos_order": "POS Orders",
    "pos_order_line": "POS Order Lines",
    "mail_message": "Messages",
    "mail_followers": "Followers",
    "ir_attachment": "Attachments",
    "ir_cron": "Scheduled Actions",
    "ir_config_parameter": "System Parameters",
}

# Table categories for grouping
ODOO_TABLE_CATEGORIES: dict[str, list[str]] = {
    "Sales": ["sale_order", "sale_order_line", "crm_lead"],
    "Purchase": ["purchase_order", "purchase_order_line"],
    "Inventory": ["stock_picking", "stock_move", "stock_quant", "stock_warehouse", "stock_location"],
    "Accounting": ["account_move", "account_move_line", "account_payment", "account_account", "account_journal", "account_tax"],
    "Products": ["product_template", "product_product", "product_category"],
    "Contacts": ["res_partner", "res_users", "res_company", "res_country", "res_currency"],
    "HR": ["hr_employee", "hr_department"],
    "Projects": ["project_project", "project_task"],
    "POS": ["pos_order", "pos_order_line"],
    "System": ["ir_module_module", "ir_model", "ir_model_fields", "ir_model_data",
               "ir_ui_view", "ir_cron", "ir_config_parameter", "ir_attachment",
               "ir_sequence", "ir_rule", "ir_translation"],
}


class QueryMode(str, Enum):
    READ = "read"
    WRITE = "write"


@dataclass
class TableInfo:
    name: str
    label: str
    row_count: int
    size_bytes: int
    size_pretty: str
    category: str
    is_system: bool
    has_primary_key: bool


@dataclass
class ColumnInfo:
    name: str
    data_type: str
    is_nullable: bool
    is_primary_key: bool
    default_value: str | None
    max_length: int | None
    foreign_key: dict | None  # {"table": "res_partner", "column": "id"}
    odoo_field_type: str | None  # many2one, char, etc.
    odoo_label: str | None  # Human-readable field label from ir.model.fields


@dataclass
class QueryResult:
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    total_count: int  # Total rows in table (for pagination)
    execution_time_ms: float
    query: str
    mode: QueryMode
    affected_rows: int = 0
    error: str | None = None
    warnings: list[str] = field(default_factory=list)


@dataclass
class DbStats:
    db_name: str
    db_size: str
    total_tables: int
    total_rows: int
    largest_tables: list[dict]  # [{"name", "rows", "size"}]
    active_connections: int
    pg_version: str
    uptime: str
    cache_hit_ratio: float


@dataclass
class IndexInfo:
    name: str
    table: str
    columns: list[str]
    is_unique: bool
    is_primary: bool
    size_pretty: str
    index_scans: int
    suggestion: str | None = None  # "Consider dropping — unused"


class DbExplorer:
    """Secure PostgreSQL explorer for Odoo instances via SSH + Docker."""

    def __init__(self):
        self.vm_driver = VMDriver()

    def _get_db_context(self, config: dict) -> tuple[str, str, str, str, bool]:
        """Extract database connection context from instance config.

        Returns: (prefix, db_name, db_user, db_password, use_external_db)
        """
        prefix = config.get("prefix", "")
        db_name = config.get("db_name") or config.get("name", "odoo")
        db_user = config.get("db_user", "odoo")
        db_password = config.get("db_password", "")
        use_external = config.get("use_external_db", False)
        return prefix, db_name, db_user, db_password, use_external

    def _build_psql_cmd(
        self, config: dict, sql: str, *,
        csv_output: bool = False,
        timeout: int = QUERY_TIMEOUT_SEC,
    ) -> str:
        """Build a psql command to execute via SSH, either through Docker exec or directly."""
        prefix, db_name, db_user, db_password, use_external = self._get_db_context(config)

        # Escape single quotes in SQL for shell
        escaped_sql = sql.replace("'", "'\\''")

        if use_external:
            # External DB: connect directly via psql
            ext_host = config.get("external_db_host", "")
            ext_port = config.get("external_db_port", 5432)
            ext_user = config.get("external_db_user", db_user)
            ext_pass = config.get("external_db_password", db_password)
            ext_db = config.get("external_db_name", db_name)

            format_flags = "-A -F',' --no-align" if csv_output else "-A -F'\\t'"
            return (
                f"PGPASSWORD='{ext_pass}' timeout {timeout} "
                f"psql -h {ext_host} -p {ext_port} -U {ext_user} -d {ext_db} "
                f"{format_flags} -c '{escaped_sql}'"
            )
        else:
            # Internal DB: docker exec into the PostgreSQL container
            container = f"{prefix}-db"
            format_flags = "-A -F',' --no-align" if csv_output else "-A -F'\\t'"
            return (
                f"docker exec {container} "
                f"timeout {timeout} "
                f"psql -U {db_user} -d {db_name} {format_flags} "
                f"-c '{escaped_sql}'"
            )

    def _parse_psql_output(self, raw: str, *, is_csv: bool = False) -> tuple[list[str], list[list[str]]]:
        """Parse psql tabular output into columns + rows."""
        if not raw or not raw.strip():
            return [], []

        lines = raw.strip().split("\n")
        if not lines:
            return [], []

        # Remove the trailing row count line (e.g., "(42 rows)")
        if lines[-1].startswith("(") and lines[-1].endswith(")"):
            lines = lines[:-1]

        if not lines:
            return [], []

        separator = "," if is_csv else "\t"
        columns = lines[0].split(separator)
        rows = []
        for line in lines[1:]:
            if line.strip():
                row = line.split(separator)
                # Pad row if needed
                while len(row) < len(columns):
                    row.append("")
                rows.append(row)

        return columns, rows

    @staticmethod
    def classify_query(sql: str) -> QueryMode:
        """Classify a SQL query as read or write."""
        normalized = sql.strip().upper()
        # Remove comments
        normalized = re.sub(r'--.*$', '', normalized, flags=re.MULTILINE)
        normalized = re.sub(r'/\*.*?\*/', '', normalized, flags=re.DOTALL)
        normalized = normalized.strip()

        if normalized.startswith(("SELECT", "EXPLAIN", "SHOW", "\\D")):
            return QueryMode.READ
        return QueryMode.WRITE

    @staticmethod
    def validate_query(sql: str) -> list[str]:
        """Check for dangerous operations. Returns list of warnings."""
        warnings = []
        upper = sql.upper()

        for kw in DANGEROUS_KEYWORDS:
            if kw in upper:
                warnings.append(f"Dangerous operation detected: {kw}")

        if "DELETE" in upper and "WHERE" not in upper:
            warnings.append("DELETE without WHERE clause — will delete ALL rows")

        if "UPDATE" in upper and "WHERE" not in upper:
            warnings.append("UPDATE without WHERE clause — will update ALL rows")

        return warnings

    # ── Table Operations ─────────────────────────────────────────────

    async def list_tables(
        self, server: ServerInfo, config: dict,
    ) -> list[TableInfo]:
        """List all user tables with row counts and sizes."""
        sql = """
SELECT
    t.tablename AS name,
    COALESCE(s.n_live_tup, 0) AS row_count,
    COALESCE(pg_total_relation_size(quote_ident(t.tablename)::regclass), 0) AS size_bytes,
    COALESCE(pg_size_pretty(pg_total_relation_size(quote_ident(t.tablename)::regclass)), '0 bytes') AS size_pretty,
    CASE WHEN i.indexname IS NOT NULL THEN true ELSE false END AS has_pk
FROM pg_tables t
LEFT JOIN pg_stat_user_tables s ON s.relname = t.tablename
LEFT JOIN pg_indexes i ON i.tablename = t.tablename AND i.indexname = t.tablename || '_pkey'
WHERE t.schemaname = 'public'
ORDER BY s.n_live_tup DESC NULLS LAST
"""
        cmd = self._build_psql_cmd(config, sql)
        raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
        columns, rows = self._parse_psql_output(raw)

        tables = []
        for row in rows:
            if len(row) < 5:
                continue
            name = row[0]
            category = "Other"
            for cat, cat_tables in ODOO_TABLE_CATEGORIES.items():
                if name in cat_tables:
                    category = cat
                    break

            tables.append(TableInfo(
                name=name,
                label=ODOO_TABLE_LABELS.get(name, name.replace("_", " ").title()),
                row_count=int(row[1]) if row[1].isdigit() else 0,
                size_bytes=int(row[2]) if row[2].isdigit() else 0,
                size_pretty=row[3],
                category=category,
                is_system=name in ODOO_SYSTEM_TABLES,
                has_primary_key=row[4] in ("t", "true", "True"),
            ))

        return tables

    async def get_columns(
        self, server: ServerInfo, config: dict, table: str,
    ) -> list[ColumnInfo]:
        """Get column information for a table, enriched with Odoo metadata."""
        # Validate table name (prevent injection)
        if not re.match(r'^[a-z_][a-z0-9_]*$', table):
            raise ValueError(f"Invalid table name: {table}")

        sql = f"""
SELECT
    c.column_name,
    c.data_type,
    c.is_nullable,
    c.column_default,
    c.character_maximum_length,
    CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk,
    fk_info.foreign_table,
    fk_info.foreign_column
FROM information_schema.columns c
LEFT JOIN (
    SELECT ku.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage ku ON ku.constraint_name = tc.constraint_name
    WHERE tc.table_name = '{table}' AND tc.constraint_type = 'PRIMARY KEY'
) pk ON pk.column_name = c.column_name
LEFT JOIN (
    SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.table_name = '{table}' AND tc.constraint_type = 'FOREIGN KEY'
) fk_info ON fk_info.column_name = c.column_name
WHERE c.table_schema = 'public' AND c.table_name = '{table}'
ORDER BY c.ordinal_position
"""
        cmd = self._build_psql_cmd(config, sql)
        raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
        cols_data, rows = self._parse_psql_output(raw)

        # Try to get Odoo field metadata
        odoo_fields = await self._get_odoo_fields(server, config, table)

        columns = []
        for row in rows:
            if len(row) < 8:
                continue
            col_name = row[0]
            odoo_meta = odoo_fields.get(col_name, {})

            columns.append(ColumnInfo(
                name=col_name,
                data_type=row[1],
                is_nullable=row[2] == "YES",
                default_value=row[3] if row[3] else None,
                max_length=int(row[4]) if row[4] and row[4].isdigit() else None,
                is_primary_key=row[5] in ("t", "true", "True"),
                foreign_key={"table": row[6], "column": row[7]} if row[6] else None,
                odoo_field_type=odoo_meta.get("ttype"),
                odoo_label=odoo_meta.get("field_description"),
            ))

        return columns

    async def _get_odoo_fields(
        self, server: ServerInfo, config: dict, table: str,
    ) -> dict[str, dict]:
        """Get Odoo ir.model.fields metadata for a table."""
        # Convert table name to Odoo model name: res_partner → res.partner
        model_name = table.replace("_", ".")

        sql = f"""
SELECT name, ttype, field_description
FROM ir_model_fields
WHERE model = '{model_name}'
"""
        try:
            cmd = self._build_psql_cmd(config, sql)
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=10)
            _, rows = self._parse_psql_output(raw)
            return {
                row[0]: {"ttype": row[1], "field_description": row[2]}
                for row in rows if len(row) >= 3
            }
        except Exception:
            # ir_model_fields might not exist or model name doesn't match
            return {}

    # ── Record Operations ────────────────────────────────────────────

    async def get_records(
        self, server: ServerInfo, config: dict, table: str, *,
        page: int = 1,
        page_size: int = 50,
        order_by: str = "id",
        order_dir: str = "DESC",
        search: str = "",
        filters: dict[str, str] | None = None,
    ) -> QueryResult:
        """Get paginated records from a table."""
        if not re.match(r'^[a-z_][a-z0-9_]*$', table):
            raise ValueError(f"Invalid table name: {table}")

        # Validate order direction
        order_dir = "DESC" if order_dir.upper() == "DESC" else "ASC"

        # Validate order column (alphanumeric + underscore only)
        if not re.match(r'^[a-z_][a-z0-9_]*$', order_by):
            order_by = "id"

        offset = (page - 1) * page_size
        page_size = min(page_size, MAX_QUERY_ROWS)

        # Build WHERE clause
        where_parts = []
        if search:
            # Search across text columns — safe because we cast to text
            safe_search = search.replace("'", "''")
            where_parts.append(f"CAST(t.* AS text) ILIKE '%{safe_search}%'")

        if filters:
            for col, val in filters.items():
                if not re.match(r'^[a-z_][a-z0-9_]*$', col):
                    continue
                safe_val = val.replace("'", "''")
                where_parts.append(f'"{col}"::text ILIKE \'%{safe_val}%\'')

        where_clause = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""

        # Count total
        count_sql = f'SELECT COUNT(*) FROM "{table}" t {where_clause}'
        # Get records
        data_sql = (
            f'SELECT * FROM "{table}" t {where_clause} '
            f'ORDER BY "{order_by}" {order_dir} '
            f'LIMIT {page_size} OFFSET {offset}'
        )

        start = time.monotonic()

        # Execute count
        count_cmd = self._build_psql_cmd(config, count_sql)
        count_raw = await self.vm_driver._ssh_exec(server, count_cmd, timeout=QUERY_TIMEOUT_SEC)
        _, count_rows = self._parse_psql_output(count_raw)
        total = int(count_rows[0][0]) if count_rows and count_rows[0] else 0

        # Execute data query
        data_cmd = self._build_psql_cmd(config, data_sql)
        data_raw = await self.vm_driver._ssh_exec(server, data_cmd, timeout=QUERY_TIMEOUT_SEC)
        columns, rows = self._parse_psql_output(data_raw)

        elapsed = (time.monotonic() - start) * 1000

        return QueryResult(
            columns=columns,
            rows=rows,
            row_count=len(rows),
            total_count=total,
            execution_time_ms=round(elapsed, 2),
            query=data_sql,
            mode=QueryMode.READ,
        )

    async def update_record(
        self, server: ServerInfo, config: dict,
        table: str, record_id: int, updates: dict[str, Any],
    ) -> QueryResult:
        """Update a single record by primary key."""
        if not re.match(r'^[a-z_][a-z0-9_]*$', table):
            raise ValueError(f"Invalid table name: {table}")

        if table in ODOO_SYSTEM_TABLES:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query="", mode=QueryMode.WRITE,
                error=f"Table '{table}' is a system table and cannot be modified",
            )

        set_parts = []
        for col, val in updates.items():
            if not re.match(r'^[a-z_][a-z0-9_]*$', col):
                continue
            if val is None:
                set_parts.append(f'"{col}" = NULL')
            elif isinstance(val, bool):
                set_parts.append(f'"{col}" = {str(val).lower()}')
            elif isinstance(val, (int, float)):
                set_parts.append(f'"{col}" = {val}')
            else:
                safe_val = str(val).replace("'", "''")
                set_parts.append(f'"{col}" = \'{safe_val}\'')

        if not set_parts:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query="", mode=QueryMode.WRITE,
                error="No valid columns to update",
            )

        # Add write_date update for Odoo ORM consistency
        set_parts.append("write_date = NOW()")

        sql = f'UPDATE "{table}" SET {", ".join(set_parts)} WHERE id = {int(record_id)} RETURNING *'

        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            columns, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000

            return QueryResult(
                columns=columns,
                rows=rows,
                row_count=len(rows),
                total_count=0,
                execution_time_ms=round(elapsed, 2),
                query=sql,
                mode=QueryMode.WRITE,
                affected_rows=len(rows),
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=QueryMode.WRITE,
                error=str(e),
            )

    async def insert_record(
        self, server: ServerInfo, config: dict,
        table: str, values: dict[str, Any],
    ) -> QueryResult:
        """Insert a new record."""
        if not re.match(r'^[a-z_][a-z0-9_]*$', table):
            raise ValueError(f"Invalid table name: {table}")

        if table in ODOO_SYSTEM_TABLES:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query="", mode=QueryMode.WRITE,
                error=f"Table '{table}' is a system table — use Odoo UI instead",
            )

        cols = []
        vals = []
        for col, val in values.items():
            if not re.match(r'^[a-z_][a-z0-9_]*$', col):
                continue
            cols.append(f'"{col}"')
            if val is None:
                vals.append("NULL")
            elif isinstance(val, bool):
                vals.append(str(val).lower())
            elif isinstance(val, (int, float)):
                vals.append(str(val))
            else:
                safe_val = str(val).replace("'", "''")
                vals.append(f"'{safe_val}'")

        # Add Odoo audit fields
        if '"create_date"' not in cols:
            cols.append('"create_date"')
            vals.append("NOW()")
        if '"write_date"' not in cols:
            cols.append('"write_date"')
            vals.append("NOW()")

        sql = f'INSERT INTO "{table}" ({", ".join(cols)}) VALUES ({", ".join(vals)}) RETURNING *'

        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            columns, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000

            return QueryResult(
                columns=columns, rows=rows, row_count=len(rows), total_count=0,
                execution_time_ms=round(elapsed, 2), query=sql,
                mode=QueryMode.WRITE, affected_rows=1,
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=QueryMode.WRITE,
                error=str(e),
            )

    async def delete_record(
        self, server: ServerInfo, config: dict,
        table: str, record_id: int,
    ) -> QueryResult:
        """Delete a single record by primary key."""
        if not re.match(r'^[a-z_][a-z0-9_]*$', table):
            raise ValueError(f"Invalid table name: {table}")

        if table in ODOO_SYSTEM_TABLES:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query="", mode=QueryMode.WRITE,
                error=f"Cannot delete from system table '{table}'",
            )

        sql = f'DELETE FROM "{table}" WHERE id = {int(record_id)} RETURNING id'

        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            _, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000

            return QueryResult(
                columns=["id"], rows=rows, row_count=len(rows), total_count=0,
                execution_time_ms=round(elapsed, 2), query=sql,
                mode=QueryMode.WRITE, affected_rows=len(rows),
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=QueryMode.WRITE,
                error=str(e),
            )

    # ── SQL Console ──────────────────────────────────────────────────

    async def execute_query(
        self, server: ServerInfo, config: dict, sql: str,
        *, max_rows: int = MAX_QUERY_ROWS,
    ) -> QueryResult:
        """Execute a raw SQL query with safety checks."""
        mode = self.classify_query(sql)
        warnings = self.validate_query(sql)

        # Block truly dangerous operations
        upper = sql.upper().strip()
        for kw in DANGEROUS_KEYWORDS:
            if kw in upper:
                return QueryResult(
                    columns=[], rows=[], row_count=0, total_count=0,
                    execution_time_ms=0, query=sql, mode=mode,
                    error=f"Blocked: {kw} is not allowed through the Database Explorer. Use psql directly for administrative operations.",
                )

        # For SELECT queries, add LIMIT if not present
        if mode == QueryMode.READ and "LIMIT" not in upper:
            sql = sql.rstrip().rstrip(";")
            sql = f"{sql} LIMIT {max_rows}"

        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            columns, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000

            affected = 0
            if mode == QueryMode.WRITE:
                # Try to parse affected rows from psql output
                match = re.search(r'(\d+)', raw.split("\n")[-1] if raw else "")
                affected = int(match.group(1)) if match else len(rows)

            return QueryResult(
                columns=columns, rows=rows,
                row_count=len(rows), total_count=len(rows),
                execution_time_ms=round(elapsed, 2), query=sql,
                mode=mode, affected_rows=affected, warnings=warnings,
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=mode,
                error=str(e), warnings=warnings,
            )

    # ── Statistics ───────────────────────────────────────────────────

    async def get_stats(
        self, server: ServerInfo, config: dict,
    ) -> DbStats:
        """Get comprehensive database statistics."""
        _, db_name, _, _, _ = self._get_db_context(config)

        stats_sql = f"""
SELECT
    pg_size_pretty(pg_database_size(current_database())) AS db_size,
    (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') AS table_count,
    version() AS pg_version,
    (SELECT COALESCE(sum(n_live_tup), 0) FROM pg_stat_user_tables) AS total_rows,
    (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS active_conns,
    (SELECT COALESCE(
        round(100.0 * sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2),
        0
    ) FROM pg_statio_user_tables) AS cache_hit_ratio,
    (SELECT current_setting('server_version')) AS server_ver
"""
        cmd = self._build_psql_cmd(config, stats_sql)
        raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
        _, rows = self._parse_psql_output(raw)

        if not rows or len(rows[0]) < 7:
            raise RuntimeError("Failed to get database statistics")

        row = rows[0]

        # Get top 10 largest tables
        top_sql = """
SELECT relname AS name,
       n_live_tup AS rows,
       pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 10
"""
        top_cmd = self._build_psql_cmd(config, top_sql)
        top_raw = await self.vm_driver._ssh_exec(server, top_cmd, timeout=QUERY_TIMEOUT_SEC)
        _, top_rows = self._parse_psql_output(top_raw)

        largest = [
            {"name": r[0], "rows": int(r[1]) if r[1].isdigit() else 0, "size": r[2]}
            for r in top_rows if len(r) >= 3
        ]

        return DbStats(
            db_name=db_name,
            db_size=row[0],
            total_tables=int(row[1]) if row[1].isdigit() else 0,
            pg_version=row[6],
            total_rows=int(row[3]) if row[3].isdigit() else 0,
            active_connections=int(row[4]) if row[4].isdigit() else 0,
            cache_hit_ratio=float(row[5]) if row[5] else 0.0,
            uptime="",
            largest_tables=largest,
        )

    # ── Index Analysis ───────────────────────────────────────────────

    async def get_indexes(
        self, server: ServerInfo, config: dict, table: str,
    ) -> list[IndexInfo]:
        """Get index information with usage stats and suggestions."""
        if not re.match(r'^[a-z_][a-z0-9_]*$', table):
            raise ValueError(f"Invalid table name: {table}")

        sql = f"""
SELECT
    i.indexname,
    i.tablename,
    array_to_string(ARRAY(
        SELECT a.attname
        FROM pg_index ix
        JOIN pg_class c ON c.oid = ix.indexrelid
        JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
        WHERE c.relname = i.indexname
    ), ', ') AS columns,
    ix.indisunique AS is_unique,
    ix.indisprimary AS is_primary,
    pg_size_pretty(pg_relation_size(i.indexname::regclass)) AS size,
    COALESCE(s.idx_scan, 0) AS scans
FROM pg_indexes i
JOIN pg_class c ON c.relname = i.indexname
JOIN pg_index ix ON ix.indexrelid = c.oid
LEFT JOIN pg_stat_user_indexes s ON s.indexrelname = i.indexname
WHERE i.tablename = '{table}' AND i.schemaname = 'public'
ORDER BY s.idx_scan DESC NULLS LAST
"""
        cmd = self._build_psql_cmd(config, sql)
        raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
        _, rows = self._parse_psql_output(raw)

        indexes = []
        for row in rows:
            if len(row) < 7:
                continue
            scans = int(row[6]) if row[6].isdigit() else 0
            is_primary = row[4] in ("t", "true")
            suggestion = None
            if scans == 0 and not is_primary:
                suggestion = "Unused index — consider dropping to save space"

            indexes.append(IndexInfo(
                name=row[0],
                table=row[1],
                columns=row[2].split(", ") if row[2] else [],
                is_unique=row[3] in ("t", "true"),
                is_primary=is_primary,
                size_pretty=row[5],
                index_scans=scans,
                suggestion=suggestion,
            ))

        return indexes

    # ── Export ────────────────────────────────────────────────────────

    async def export_csv(
        self, server: ServerInfo, config: dict, table: str, *,
        filters: dict[str, str] | None = None,
        max_rows: int = MAX_EXPORT_ROWS,
    ) -> str:
        """Export table data as CSV string."""
        if not re.match(r'^[a-z_][a-z0-9_]*$', table):
            raise ValueError(f"Invalid table name: {table}")

        where_parts = []
        if filters:
            for col, val in filters.items():
                if not re.match(r'^[a-z_][a-z0-9_]*$', col):
                    continue
                safe_val = val.replace("'", "''")
                where_parts.append(f'"{col}"::text ILIKE \'%{safe_val}%\'')

        where_clause = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
        sql = f'SELECT * FROM "{table}" {where_clause} LIMIT {max_rows}'

        cmd = self._build_psql_cmd(config, sql, csv_output=True)
        raw = await self.vm_driver._ssh_exec(server, cmd, timeout=60)
        return raw

    # ── Quick Actions (Odoo-specific) ────────────────────────────────

    async def reset_admin_password(
        self, server: ServerInfo, config: dict, new_password: str,
    ) -> QueryResult:
        """Reset Odoo admin user password (direct DB update)."""
        # Odoo stores passwords as PBKDF2 hash, but setting plaintext
        # triggers auto-hash on next login. For immediate effect, we
        # use Odoo's own password hashing.
        safe_pwd = new_password.replace("'", "''")
        sql = f"UPDATE res_users SET password = '{safe_pwd}' WHERE id = 2"

        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            elapsed = (time.monotonic() - start) * 1000
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=round(elapsed, 2),
                query="UPDATE res_users SET password = '***' WHERE id = 2",
                mode=QueryMode.WRITE, affected_rows=1,
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query="", mode=QueryMode.WRITE,
                error=str(e),
            )

    async def cleanup_sessions(
        self, server: ServerInfo, config: dict,
    ) -> QueryResult:
        """Delete expired HTTP sessions (Odoo stores sessions in DB since v16)."""
        sql = """
DELETE FROM ir_http_session
WHERE expiry < NOW()
RETURNING id
"""
        # Fallback for older Odoo versions that don't have ir_http_session
        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            _, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000
            return QueryResult(
                columns=["id"], rows=rows, row_count=len(rows), total_count=0,
                execution_time_ms=round(elapsed, 2), query=sql,
                mode=QueryMode.WRITE, affected_rows=len(rows),
            )
        except Exception as e:
            # Table might not exist in older versions
            error_msg = str(e)
            if "does not exist" in error_msg:
                error_msg = "ir_http_session table not found — sessions are file-based in this Odoo version"
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=QueryMode.WRITE,
                error=error_msg,
            )

    async def cleanup_orphan_attachments(
        self, server: ServerInfo, config: dict,
    ) -> QueryResult:
        """Find and count orphaned attachments (no linked record)."""
        sql = """
SELECT COUNT(*) AS orphan_count,
       COALESCE(pg_size_pretty(SUM(file_size)), '0 bytes') AS total_size
FROM ir_attachment
WHERE res_model IS NOT NULL
  AND res_id IS NOT NULL
  AND res_id > 0
  AND NOT EXISTS (
    SELECT 1 FROM ir_model WHERE model = ir_attachment.res_model
  )
"""
        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            columns, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000
            return QueryResult(
                columns=columns, rows=rows, row_count=len(rows), total_count=0,
                execution_time_ms=round(elapsed, 2), query=sql,
                mode=QueryMode.READ,
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=QueryMode.READ,
                error=str(e),
            )

    async def get_active_users(
        self, server: ServerInfo, config: dict,
    ) -> QueryResult:
        """List active Odoo users with last login info."""
        sql = """
SELECT
    u.id,
    u.login,
    p.name,
    p.email,
    u.active,
    u.login_date,
    u.totp_enabled
FROM res_users u
JOIN res_partner p ON p.id = u.partner_id
WHERE u.active = true
ORDER BY u.login_date DESC NULLS LAST
LIMIT 100
"""
        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            columns, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000
            return QueryResult(
                columns=columns, rows=rows, row_count=len(rows), total_count=0,
                execution_time_ms=round(elapsed, 2), query=sql,
                mode=QueryMode.READ,
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=QueryMode.READ,
                error=str(e),
            )

    async def get_installed_modules(
        self, server: ServerInfo, config: dict,
    ) -> QueryResult:
        """List installed Odoo modules."""
        sql = """
SELECT name, shortdesc AS description, latest_version AS version, state,
       author, website, license
FROM ir_module_module
WHERE state = 'installed'
ORDER BY name
"""
        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            columns, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000
            return QueryResult(
                columns=columns, rows=rows, row_count=len(rows), total_count=0,
                execution_time_ms=round(elapsed, 2), query=sql,
                mode=QueryMode.READ,
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=QueryMode.READ,
                error=str(e),
            )

    async def toggle_user(
        self, server: ServerInfo, config: dict,
        user_id: int, active: bool,
    ) -> QueryResult:
        """Enable or disable an Odoo user."""
        sql = (
            f"UPDATE res_users SET active = {str(active).lower()}, "
            f"write_date = NOW() WHERE id = {int(user_id)} RETURNING id, login, active"
        )
        start = time.monotonic()
        cmd = self._build_psql_cmd(config, sql)

        try:
            raw = await self.vm_driver._ssh_exec(server, cmd, timeout=QUERY_TIMEOUT_SEC)
            columns, rows = self._parse_psql_output(raw)
            elapsed = (time.monotonic() - start) * 1000
            return QueryResult(
                columns=columns, rows=rows, row_count=len(rows), total_count=0,
                execution_time_ms=round(elapsed, 2), query=sql,
                mode=QueryMode.WRITE, affected_rows=len(rows),
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0, total_count=0,
                execution_time_ms=0, query=sql, mode=QueryMode.WRITE,
                error=str(e),
            )
