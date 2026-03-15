"""Enterprise log parser — structured log line extraction with severity detection.

Parses Docker container logs (Odoo, Nginx, PostgreSQL) into structured
LogEntry objects with severity classification, timestamp extraction,
traceback grouping, and logger/module detection.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from datetime import datetime
from enum import Enum
from typing import Optional


class LogLevel(str, Enum):
    CRITICAL = "critical"
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"
    DEBUG = "debug"
    TRACE = "trace"
    UNKNOWN = "unknown"


# --- Severity detection patterns (order matters: first match wins) ---

_LEVEL_PATTERNS: list[tuple[re.Pattern, LogLevel]] = [
    # Odoo-style: "2026-03-13 12:30:12,943 389664 CRITICAL ..."
    (re.compile(r"\b(?:CRITICAL|FATAL)\b", re.IGNORECASE), LogLevel.CRITICAL),
    (re.compile(r"\bERROR\b", re.IGNORECASE), LogLevel.ERROR),
    (re.compile(r"\b(?:WARNING|WARN)\b", re.IGNORECASE), LogLevel.WARNING),
    (re.compile(r"\bINFO\b", re.IGNORECASE), LogLevel.INFO),
    (re.compile(r"\bDEBUG\b", re.IGNORECASE), LogLevel.DEBUG),
    (re.compile(r"\bTRACE\b", re.IGNORECASE), LogLevel.TRACE),
    # Nginx access log (200-299 = info, 300-399 = info, 400-499 = warning, 500+ = error)
    (re.compile(r'" [5]\d{2} '), LogLevel.ERROR),
    (re.compile(r'" [4]\d{2} '), LogLevel.WARNING),
    # PostgreSQL patterns
    (re.compile(r"\bFATAL:\b"), LogLevel.CRITICAL),
    (re.compile(r"\bERROR:\b"), LogLevel.ERROR),
    (re.compile(r"\bWARNING:\b"), LogLevel.WARNING),
    (re.compile(r"\bLOG:\b"), LogLevel.INFO),
]

# Timestamp patterns
_TS_PATTERNS = [
    # Odoo: "2026-03-13 12:30:12,783"
    re.compile(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}[,\.]\d{3})"),
    # ISO 8601: "2026-03-13T12:30:12.783Z"
    re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"),
    # Nginx combined: "13/Mar/2026:12:30:12 +0000"
    re.compile(r"(\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2}\s*[+-]\d{4})"),
    # PostgreSQL: "2026-03-13 12:30:12 UTC"
    re.compile(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\w{2,4})"),
]

# Odoo logger extraction: "389664 dgcomputer.it odoo.modules.loading"
_ODOO_LOGGER = re.compile(
    r"\d+\s+\S+\s+(odoo\.\S+|openerp\.\S+|werkzeug)\s+"
)

# Traceback detection
_TRACEBACK_START = re.compile(r"^\s*Traceback \(most recent call last\):", re.IGNORECASE)
_TRACEBACK_CONT = re.compile(r"^\s+(File |.*Error:|.*Exception:|at )")
_PYTHON_INDENT = re.compile(r"^\s{2,}")

# SQL/Query detection
_SQL_PATTERN = re.compile(r"\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b", re.IGNORECASE)

# PID extraction
_PID_PATTERN = re.compile(r"(?:^|\s)(\d{3,7})\s")


@dataclass
class LogEntry:
    """A single parsed log line."""
    line_number: int
    raw: str
    level: LogLevel
    timestamp: Optional[str] = None
    logger_name: Optional[str] = None
    message: str = ""
    pid: Optional[int] = None
    database: Optional[str] = None
    is_traceback: bool = False
    traceback_group_id: Optional[int] = None
    is_sql: bool = False
    container: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["level"] = self.level.value
        return d


def detect_level(line: str) -> LogLevel:
    """Detect log severity from line content."""
    for pattern, level in _LEVEL_PATTERNS:
        if pattern.search(line):
            return level
    return LogLevel.UNKNOWN


def extract_timestamp(line: str) -> Optional[str]:
    """Extract the first timestamp found in a log line."""
    for pattern in _TS_PATTERNS:
        m = pattern.search(line)
        if m:
            return m.group(1)
    return None


def extract_logger(line: str) -> Optional[str]:
    """Extract Odoo/Python logger name."""
    m = _ODOO_LOGGER.search(line)
    return m.group(1) if m else None


def extract_pid(line: str) -> Optional[int]:
    """Extract process ID from log line."""
    m = _PID_PATTERN.search(line)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return None


def parse_lines(
    raw_lines: list[str],
    container: str = "",
    start_line: int = 1,
) -> list[LogEntry]:
    """Parse raw log lines into structured LogEntry objects.

    Handles traceback grouping: consecutive traceback lines are marked
    with the same traceback_group_id and is_traceback=True.
    """
    entries: list[LogEntry] = []
    traceback_group = 0
    in_traceback = False

    for i, raw in enumerate(raw_lines):
        line_num = start_line + i
        stripped = raw.rstrip()

        if not stripped:
            continue

        # --- Traceback detection ---
        if _TRACEBACK_START.match(stripped):
            in_traceback = True
            traceback_group += 1

        if in_traceback:
            if not (_TRACEBACK_START.match(stripped)
                    or _TRACEBACK_CONT.match(stripped)
                    or _PYTHON_INDENT.match(stripped)
                    or stripped.startswith("  ")):
                # Last line of traceback (the actual error message)
                entry = LogEntry(
                    line_number=line_num,
                    raw=stripped,
                    level=LogLevel.ERROR,
                    timestamp=extract_timestamp(stripped),
                    logger_name=extract_logger(stripped),
                    message=stripped,
                    pid=extract_pid(stripped),
                    is_traceback=True,
                    traceback_group_id=traceback_group,
                    container=container,
                    is_sql=bool(_SQL_PATTERN.search(stripped)),
                )
                entries.append(entry)
                in_traceback = False
                continue

            entry = LogEntry(
                line_number=line_num,
                raw=stripped,
                level=LogLevel.ERROR,
                timestamp=extract_timestamp(stripped),
                logger_name=extract_logger(stripped),
                message=stripped,
                pid=extract_pid(stripped),
                is_traceback=True,
                traceback_group_id=traceback_group,
                container=container,
            )
            entries.append(entry)
            continue

        # --- Normal line ---
        level = detect_level(stripped)
        entry = LogEntry(
            line_number=line_num,
            raw=stripped,
            level=level,
            timestamp=extract_timestamp(stripped),
            logger_name=extract_logger(stripped),
            message=stripped,
            pid=extract_pid(stripped),
            container=container,
            is_sql=bool(_SQL_PATTERN.search(stripped)),
        )
        entries.append(entry)

    return entries
