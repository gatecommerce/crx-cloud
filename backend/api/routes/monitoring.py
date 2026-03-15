"""Server monitoring history & alerts — sar-based historical metrics + threshold alerting."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db
from core.vm_controller import VMDriver
from core.server_manager import ServerInfo, ServerType
from core.ssh_keys import get_private_key_path

router = APIRouter()
_driver = VMDriver()


# ── Helpers ──────────────────────────────────────────────────────────


async def _get_owned_server(
    server_id: str, db: AsyncSession, user: dict
) -> Server:
    result = await db.execute(
        select(Server).where(
            Server.id == server_id,
            Server.owner_id == str(user["telegram_id"]),
        )
    )
    srv = result.scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    return srv


def _to_server_info(srv: Server) -> ServerInfo:
    return ServerInfo(
        id=srv.id,
        name=srv.name,
        server_type=ServerType(srv.server_type),
        provider=srv.provider,
        endpoint=srv.endpoint,
        metadata={
            "ssh_user": srv.ssh_user or "root",
            "ssh_key_path": srv.ssh_key_path or get_private_key_path(),
            **(srv.meta or {}),
        },
    )


# ── Pydantic models ─────────────────────────────────────────────────


class Period(str, Enum):
    one_hour = "1h"
    six_hours = "6h"
    twenty_four_hours = "24h"
    seven_days = "7d"


class CPUPoint(BaseModel):
    time: str
    user: float
    system: float
    iowait: float
    idle: float


class MemoryPoint(BaseModel):
    time: str
    used_percent: float
    cached_mb: float
    buffer_mb: float


class DiskIOPoint(BaseModel):
    time: str
    read_mb_s: float
    write_mb_s: float


class NetworkPoint(BaseModel):
    time: str
    rx_kb_s: float
    tx_kb_s: float


class MetricsHistoryResponse(BaseModel):
    sar_available: bool
    period: str
    cpu: list[CPUPoint] = []
    memory: list[MemoryPoint] = []
    disk_io: list[DiskIOPoint] = []
    network: list[NetworkPoint] = []


class AlertThresholds(BaseModel):
    cpu_warning: float = 80
    cpu_critical: float = 95
    memory_warning: float = 80
    memory_critical: float = 95
    disk_warning: float = 80
    disk_critical: float = 90
    load_warning_multiplier: float = 2.0
    enabled: bool = False


class AlertItem(BaseModel):
    metric: str
    level: str  # "warning" | "critical"
    value: float
    threshold: float
    message: str


class AlertStatusResponse(BaseModel):
    alerts: list[AlertItem] = []
    overall_status: str = "ok"  # "ok" | "warning" | "critical"


class InstallSysstatResponse(BaseModel):
    success: bool
    detail: str


# ── Sar output parsers ──────────────────────────────────────────────


def _period_to_timedelta(period: str) -> timedelta:
    mapping = {"1h": timedelta(hours=1), "6h": timedelta(hours=6),
               "24h": timedelta(hours=24), "7d": timedelta(days=7)}
    return mapping.get(period, timedelta(hours=1))


def _parse_sar_cpu(raw: str) -> list[CPUPoint]:
    """Parse `sar -u` output into structured CPU points.

    Expected line format (after header):
      HH:MM:SS  [AM|PM]  %user  %nice  %system  %iowait  %steal  %idle
    Some systems omit AM/PM.
    """
    points: list[CPUPoint] = []
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("Linux") or line.startswith("Average"):
            continue
        # Skip column header lines
        if "%user" in line or "%idle" in line:
            continue
        parts = line.split()
        if len(parts) < 6:
            continue
        try:
            # Determine if AM/PM is present
            time_str = parts[0]
            offset = 0
            if len(parts) > 1 and parts[1] in ("AM", "PM"):
                time_str = f"{parts[0]} {parts[1]}"
                offset = 1
            user_val = float(parts[1 + offset])
            # nice = parts[2 + offset]
            system_val = float(parts[3 + offset])
            iowait_val = float(parts[4 + offset])
            # steal = parts[5 + offset]
            idle_val = float(parts[6 + offset])
            # Normalize time to HH:MM:SS
            display_time = time_str.split()[0]  # just HH:MM:SS
            points.append(CPUPoint(
                time=display_time, user=user_val, system=system_val,
                iowait=iowait_val, idle=idle_val,
            ))
        except (ValueError, IndexError):
            continue
    return points


def _parse_sar_memory(raw: str) -> list[MemoryPoint]:
    """Parse `sar -r` output into structured memory points.

    Expected line format:
      HH:MM:SS  [AM|PM]  kbmemfree  kbavail  kbmemused  %memused  kbbuffers  kbcached  ...
    """
    points: list[MemoryPoint] = []
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("Linux") or line.startswith("Average"):
            continue
        if "kbmemfree" in line or "%memused" in line:
            continue
        parts = line.split()
        if len(parts) < 7:
            continue
        try:
            offset = 0
            if len(parts) > 1 and parts[1] in ("AM", "PM"):
                offset = 1
            time_str = parts[0]
            # kbmemfree = parts[1 + offset]
            # kbavail   = parts[2 + offset]
            # kbmemused = parts[3 + offset]
            memused_pct = float(parts[4 + offset])
            kbbuffers = float(parts[5 + offset])
            kbcached = float(parts[6 + offset])
            points.append(MemoryPoint(
                time=time_str,
                used_percent=memused_pct,
                cached_mb=round(kbcached / 1024, 1),
                buffer_mb=round(kbbuffers / 1024, 1),
            ))
        except (ValueError, IndexError):
            continue
    return points


def _parse_sar_disk(raw: str) -> list[DiskIOPoint]:
    """Parse `sar -d` output into structured disk I/O points.

    Expected line format:
      HH:MM:SS  [AM|PM]  DEV  tps  rkB/s  wkB/s  ...
    We aggregate all devices per timestamp.
    """
    time_data: dict[str, dict] = {}
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("Linux") or line.startswith("Average"):
            continue
        if "DEV" in line and ("tps" in line or "rd_sec" in line or "rkB" in line):
            continue
        parts = line.split()
        if len(parts) < 6:
            continue
        try:
            offset = 0
            if len(parts) > 1 and parts[1] in ("AM", "PM"):
                offset = 1
            time_str = parts[0]
            # dev = parts[1 + offset]
            # tps = parts[2 + offset]
            rkb_s = float(parts[3 + offset])
            wkb_s = float(parts[4 + offset])
            if time_str not in time_data:
                time_data[time_str] = {"read": 0.0, "write": 0.0}
            time_data[time_str]["read"] += rkb_s
            time_data[time_str]["write"] += wkb_s
        except (ValueError, IndexError):
            continue

    return [
        DiskIOPoint(
            time=t,
            read_mb_s=round(d["read"] / 1024, 2),
            write_mb_s=round(d["write"] / 1024, 2),
        )
        for t, d in time_data.items()
    ]


def _parse_sar_network(raw: str) -> list[NetworkPoint]:
    """Parse `sar -n DEV` output into structured network points.

    Expected line format:
      HH:MM:SS  [AM|PM]  IFACE  rxpck/s  txpck/s  rxkB/s  txkB/s  ...
    We aggregate all interfaces per timestamp (excluding lo).
    """
    time_data: dict[str, dict] = {}
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("Linux") or line.startswith("Average"):
            continue
        if "IFACE" in line or "rxpck" in line:
            continue
        parts = line.split()
        if len(parts) < 7:
            continue
        try:
            offset = 0
            if len(parts) > 1 and parts[1] in ("AM", "PM"):
                offset = 1
            time_str = parts[0]
            iface = parts[1 + offset]
            if iface == "lo":
                continue
            # rxpck/s = parts[2 + offset]
            # txpck/s = parts[3 + offset]
            rxkb_s = float(parts[4 + offset])
            txkb_s = float(parts[5 + offset])
            if time_str not in time_data:
                time_data[time_str] = {"rx": 0.0, "tx": 0.0}
            time_data[time_str]["rx"] += rxkb_s
            time_data[time_str]["tx"] += txkb_s
        except (ValueError, IndexError):
            continue

    return [
        NetworkPoint(time=t, rx_kb_s=round(d["rx"], 1), tx_kb_s=round(d["tx"], 1))
        for t, d in time_data.items()
    ]


async def _snapshot_fallback(info: ServerInfo) -> MetricsHistoryResponse:
    """Single-point snapshot when sar is not available — uses /proc and standard tools."""
    now_str = datetime.now(timezone.utc).strftime("%H:%M:%S")

    cmd = (
        # CPU via 1-second /proc/stat delta
        "grep '^cpu ' /proc/stat > /tmp/.crx_cpu1 2>/dev/null; sleep 1; grep '^cpu ' /proc/stat > /tmp/.crx_cpu2 2>/dev/null; "
        "paste /tmp/.crx_cpu1 /tmp/.crx_cpu2 | awk '{"
        "  t1=$2+$3+$4+$5+$6+$7+$8+$9+$10; i1=$5+$6;"
        "  t2=$13+$14+$15+$16+$17+$18+$19+$20+$21; i2=$16+$17;"
        "  dt=t2-t1; di=i2-i1;"
        "  user=($13-$2)/dt*100; sys=($15-$4)/dt*100; iow=($16-$5)/dt*100; idle=di/dt*100;"
        "  printf \"CPU_USER=%.1f CPU_SYS=%.1f CPU_IOWAIT=%.1f CPU_IDLE=%.1f\\n\", user, sys, iow, idle"
        "}'; rm -f /tmp/.crx_cpu1 /tmp/.crx_cpu2 2>/dev/null; "
        # Memory
        "free -m | awk '/Mem:/{total=$2; used=$3; cached=$6; buffers=$5; printf \"MEM_PCT=%.1f MEM_CACHED=%d MEM_BUF=%d\\n\", used/total*100, cached, buffers}'; "
        # Disk I/O
        "cat /proc/diskstats 2>/dev/null | awk '$3~/^(sd|vd|nvme)[a-z]+$/{read+=$6; write+=$10} END{printf \"DISK_R=%.2f DISK_W=%.2f\\n\", read*512/1048576, write*512/1048576}'; "
        # Network
        "cat /proc/net/dev 2>/dev/null | tail -n +3 | awk '$1!~/lo:/{gsub(/:/, \"\"); rx+=$2; tx+=$10} END{printf \"NET_RX=%.1f NET_TX=%.1f\\n\", rx/1024, tx/1024}'"
    )
    try:
        raw = await _driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Snapshot fallback failed: {e}")
        return MetricsHistoryResponse(sar_available=False, period="snapshot")

    # Parse key=value pairs
    vals: dict[str, float] = {}
    for line in raw.strip().splitlines():
        for token in line.split():
            if "=" in token:
                k, v = token.split("=", 1)
                try:
                    vals[k] = float(v)
                except ValueError:
                    pass

    return MetricsHistoryResponse(
        sar_available=False,
        period="snapshot",
        cpu=[CPUPoint(
            time=now_str,
            user=vals.get("CPU_USER", 0),
            system=vals.get("CPU_SYS", 0),
            iowait=vals.get("CPU_IOWAIT", 0),
            idle=vals.get("CPU_IDLE", 100),
        )],
        memory=[MemoryPoint(
            time=now_str,
            used_percent=vals.get("MEM_PCT", 0),
            cached_mb=vals.get("MEM_CACHED", 0),
            buffer_mb=vals.get("MEM_BUF", 0),
        )],
        disk_io=[DiskIOPoint(
            time=now_str,
            read_mb_s=vals.get("DISK_R", 0),
            write_mb_s=vals.get("DISK_W", 0),
        )],
        network=[NetworkPoint(
            time=now_str,
            rx_kb_s=vals.get("NET_RX", 0),
            tx_kb_s=vals.get("NET_TX", 0),
        )],
    )


# ── Endpoints ────────────────────────────────────────────────────────


@router.get("/{server_id}/metrics/history", response_model=MetricsHistoryResponse)
async def get_metrics_history(
    server_id: str,
    period: Period = Query(Period.one_hour, description="History period"),
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Historical server metrics via sar (sysstat). Falls back to a single
    /proc snapshot if sar is not installed."""
    srv = await _get_owned_server(server_id, db, user)
    info = _to_server_info(srv)

    delta = _period_to_timedelta(period.value)
    now = datetime.now(timezone.utc)
    start = now - delta

    # For periods <= 24h, use -s/-e with today's data.
    # For 7d, use `sar -f` with daily log files (handled by sar automatically).
    if period == Period.seven_days:
        time_flags = ""  # sar without -s/-e reads all available data
    else:
        start_str = start.strftime("%H:%M:%S")
        end_str = now.strftime("%H:%M:%S")
        time_flags = f"-s {start_str} -e {end_str}"

    # Run all four sar commands in one SSH call to minimise round-trips
    cmd = (
        f"echo '===CPU==='; sar -u {time_flags} 2>/dev/null || echo 'NO_SAR'; "
        f"echo '===MEM==='; sar -r {time_flags} 2>/dev/null; "
        f"echo '===DISK==='; sar -d {time_flags} 2>/dev/null; "
        f"echo '===NET==='; sar -n DEV {time_flags} 2>/dev/null"
    )

    try:
        raw = await _driver._ssh_exec(info, cmd, timeout=30)
    except Exception as e:
        logger.error(f"SSH failed for metrics history {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    # Split into sections
    sections: dict[str, str] = {}
    current_key = ""
    current_lines: list[str] = []
    for line in raw.splitlines():
        if line.startswith("===") and line.endswith("==="):
            if current_key:
                sections[current_key] = "\n".join(current_lines)
            current_key = line.strip("=")
            current_lines = []
        else:
            current_lines.append(line)
    if current_key:
        sections[current_key] = "\n".join(current_lines)

    # Check if sar is available
    cpu_raw = sections.get("CPU", "")
    if "NO_SAR" in cpu_raw:
        logger.info(f"sar not available on {server_id}, falling back to snapshot")
        return await _snapshot_fallback(info)

    return MetricsHistoryResponse(
        sar_available=True,
        period=period.value,
        cpu=_parse_sar_cpu(cpu_raw),
        memory=_parse_sar_memory(sections.get("MEM", "")),
        disk_io=_parse_sar_disk(sections.get("DISK", "")),
        network=_parse_sar_network(sections.get("NET", "")),
    )


# ── Alert configuration ─────────────────────────────────────────────


_DEFAULT_THRESHOLDS = AlertThresholds()


@router.get("/{server_id}/alerts/config", response_model=AlertThresholds)
async def get_alert_config(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Return current alert thresholds for the server."""
    srv = await _get_owned_server(server_id, db, user)
    stored = (srv.meta or {}).get("alert_config")
    if stored:
        return AlertThresholds(**stored)
    return _DEFAULT_THRESHOLDS


@router.patch("/{server_id}/alerts/config", response_model=AlertThresholds)
async def update_alert_config(
    server_id: str,
    body: AlertThresholds,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update alert thresholds — persisted in server metadata."""
    srv = await _get_owned_server(server_id, db, user)
    meta = dict(srv.meta or {})
    meta["alert_config"] = body.model_dump()
    srv.meta = meta
    await db.commit()
    await db.refresh(srv)
    logger.info(f"Alert config updated for server {server_id}")
    return body


# ── Alert status ─────────────────────────────────────────────────────


@router.get("/{server_id}/alerts/status", response_model=AlertStatusResponse)
async def get_alert_status(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Snapshot current metrics and compare against configured thresholds."""
    srv = await _get_owned_server(server_id, db, user)
    info = _to_server_info(srv)

    # Load thresholds
    stored = (srv.meta or {}).get("alert_config")
    thresholds = AlertThresholds(**stored) if stored else _DEFAULT_THRESHOLDS

    # Grab current metrics in a single SSH call
    cmd = (
        # CPU — 1-second /proc/stat delta
        "grep '^cpu ' /proc/stat > /tmp/.crx_alert_cpu1; sleep 1; grep '^cpu ' /proc/stat > /tmp/.crx_alert_cpu2; "
        "paste /tmp/.crx_alert_cpu1 /tmp/.crx_alert_cpu2 | awk '{"
        "  t1=$2+$3+$4+$5+$6+$7+$8+$9+$10; i1=$5+$6;"
        "  t2=$13+$14+$15+$16+$17+$18+$19+$20+$21; i2=$16+$17;"
        "  dt=t2-t1; di=i2-i1;"
        "  if(dt>0) printf \"CPU=%.1f\\n\", (1-di/dt)*100; else print \"CPU=0.0\";"
        "}'; rm -f /tmp/.crx_alert_cpu1 /tmp/.crx_alert_cpu2; "
        # Memory
        "free -m | awk '/Mem:/{printf \"MEM=%.1f\\n\", $3/$2*100}'; "
        # Disk — worst partition
        "df -h --output=pcent -x tmpfs -x devtmpfs 2>/dev/null | tail -n +2 | sed 's/%//' | sort -rn | head -1 | awk '{printf \"DISK=%.1f\\n\", $1}'; "
        # Load average + cores
        "echo LOAD=$(awk '{print $1}' /proc/loadavg); "
        "echo CORES=$(nproc 2>/dev/null || echo 1)"
    )

    try:
        raw = await _driver._ssh_exec(info, cmd, timeout=15)
    except Exception as e:
        logger.error(f"Alert status SSH failed for {server_id}: {e}")
        raise HTTPException(status_code=502, detail=f"SSH command failed: {e}")

    # Parse values
    vals: dict[str, float] = {}
    for line in raw.strip().splitlines():
        for token in line.split():
            if "=" in token:
                k, v = token.split("=", 1)
                try:
                    vals[k] = float(v)
                except ValueError:
                    pass

    alerts: list[AlertItem] = []

    # CPU check
    cpu_val = vals.get("CPU", 0)
    if cpu_val >= thresholds.cpu_critical:
        alerts.append(AlertItem(
            metric="cpu", level="critical", value=cpu_val,
            threshold=thresholds.cpu_critical,
            message=f"CPU usage is critical: {cpu_val}% (threshold: {thresholds.cpu_critical}%)",
        ))
    elif cpu_val >= thresholds.cpu_warning:
        alerts.append(AlertItem(
            metric="cpu", level="warning", value=cpu_val,
            threshold=thresholds.cpu_warning,
            message=f"CPU usage warning: {cpu_val}% (threshold: {thresholds.cpu_warning}%)",
        ))

    # Memory check
    mem_val = vals.get("MEM", 0)
    if mem_val >= thresholds.memory_critical:
        alerts.append(AlertItem(
            metric="memory", level="critical", value=mem_val,
            threshold=thresholds.memory_critical,
            message=f"Memory usage is critical: {mem_val}% (threshold: {thresholds.memory_critical}%)",
        ))
    elif mem_val >= thresholds.memory_warning:
        alerts.append(AlertItem(
            metric="memory", level="warning", value=mem_val,
            threshold=thresholds.memory_warning,
            message=f"Memory usage warning: {mem_val}% (threshold: {thresholds.memory_warning}%)",
        ))

    # Disk check
    disk_val = vals.get("DISK", 0)
    if disk_val >= thresholds.disk_critical:
        alerts.append(AlertItem(
            metric="disk", level="critical", value=disk_val,
            threshold=thresholds.disk_critical,
            message=f"Disk usage is critical: {disk_val}% (threshold: {thresholds.disk_critical}%)",
        ))
    elif disk_val >= thresholds.disk_warning:
        alerts.append(AlertItem(
            metric="disk", level="warning", value=disk_val,
            threshold=thresholds.disk_warning,
            message=f"Disk usage warning: {disk_val}% (threshold: {thresholds.disk_warning}%)",
        ))

    # Load check
    load_val = vals.get("LOAD", 0)
    cores = vals.get("CORES", 1)
    load_threshold = cores * thresholds.load_warning_multiplier
    if load_val >= load_threshold:
        alerts.append(AlertItem(
            metric="load", level="warning", value=load_val,
            threshold=load_threshold,
            message=f"Load average warning: {load_val} (threshold: {load_threshold} = {int(cores)} cores x {thresholds.load_warning_multiplier})",
        ))

    # Determine overall status
    if any(a.level == "critical" for a in alerts):
        overall = "critical"
    elif any(a.level == "warning" for a in alerts):
        overall = "warning"
    else:
        overall = "ok"

    return AlertStatusResponse(alerts=alerts, overall_status=overall)


# ── Install sysstat ──────────────────────────────────────────────────


@router.post("/{server_id}/install-sysstat", response_model=InstallSysstatResponse)
async def install_sysstat(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Install sysstat and enable sar data collection on the server."""
    srv = await _get_owned_server(server_id, db, user)
    info = _to_server_info(srv)

    cmd = (
        "export DEBIAN_FRONTEND=noninteractive && "
        "apt-get install -y -qq sysstat && "
        "sed -i 's/ENABLED=\"false\"/ENABLED=\"true\"/' /etc/default/sysstat && "
        "systemctl restart sysstat && "
        "systemctl enable sysstat && "
        "echo 'SYSSTAT_OK'"
    )

    try:
        result = await _driver._ssh_exec(info, cmd, timeout=60)
    except Exception as e:
        logger.error(f"sysstat install failed on {server_id}: {e}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to install sysstat: {e}",
        )

    success = "SYSSTAT_OK" in result
    if not success:
        logger.warning(f"sysstat install on {server_id} did not return SYSSTAT_OK: {result}")

    return InstallSysstatResponse(
        success=success,
        detail="sysstat installed and enabled" if success else f"Unexpected output: {result[:500]}",
    )
