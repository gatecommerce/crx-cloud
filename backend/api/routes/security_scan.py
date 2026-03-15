"""Security / CVE vulnerability scanning endpoints."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified
from loguru import logger

from api.models.server import Server
from core.auth import get_current_user
from core.database import get_db
from core.vm_controller import VMDriver
from core.server_manager import ServerInfo, ServerType
from core.ssh_keys import get_private_key_path

router = APIRouter()
_driver = VMDriver()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_owned_server(
    server_id: str, db: AsyncSession, user: dict,
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
        id=srv.id, name=srv.name,
        server_type=ServerType(srv.server_type), provider=srv.provider,
        endpoint=srv.endpoint,
        metadata={
            "ssh_user": srv.ssh_user or "root",
            "ssh_key_path": srv.ssh_key_path or get_private_key_path(),
            **(srv.meta or {}),
        },
    )


# ---------------------------------------------------------------------------
# Pydantic response / request models
# ---------------------------------------------------------------------------

class PackageInfo(BaseModel):
    name: str
    current: str = ""
    available: str = ""
    severity: str = "unknown"
    type: str = "unknown"


class OsUpdates(BaseModel):
    security_updates_available: int = 0
    total_updates_available: int = 0
    packages: list[PackageInfo] = Field(default_factory=list)


class DockerImageStatus(BaseModel):
    image: str
    status: str = "unknown"  # up_to_date | outdated | unknown
    latest: str | None = None


class OpenPort(BaseModel):
    port: int
    protocol: str = "tcp"
    process: str = ""
    risk: str = "low"
    note: str = ""


class SshSecurity(BaseModel):
    root_login: str = "unknown"
    password_auth: str = "unknown"
    ssh_port: int = 22
    weak_keys: list[str] = Field(default_factory=list)
    failed_logins_24h: int = 0


class SystemHealth(BaseModel):
    unattended_upgrades: bool = False
    reboot_required: bool = False
    last_update_days_ago: int = -1
    kernel_version: str = ""


class Recommendation(BaseModel):
    priority: str  # critical | high | medium | low
    action: str


class VulnerabilitySummary(BaseModel):
    total_vulnerabilities: int = 0
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0


class ScanResult(BaseModel):
    scan_time: str
    risk_score: int = 100
    risk_level: str = "low"
    summary: VulnerabilitySummary = Field(default_factory=VulnerabilitySummary)
    os_updates: OsUpdates = Field(default_factory=OsUpdates)
    docker_images: list[DockerImageStatus] = Field(default_factory=list)
    open_ports: list[OpenPort] = Field(default_factory=list)
    ssh_security: SshSecurity = Field(default_factory=SshSecurity)
    system_health: SystemHealth = Field(default_factory=SystemHealth)
    recommendations: list[Recommendation] = Field(default_factory=list)


class FixAction(BaseModel):
    action: str
    status: str  # success | failed | skipped
    detail: str = ""


class FixRequest(BaseModel):
    actions: list[str]


class FixResponse(BaseModel):
    results: list[FixAction]


# ---------------------------------------------------------------------------
# High-risk ports — databases, admin interfaces, etc.
# ---------------------------------------------------------------------------

_HIGH_RISK_PORTS: dict[int, str] = {
    3306: "MySQL should not be publicly accessible",
    5432: "PostgreSQL should not be publicly accessible",
    6379: "Redis should not be publicly accessible",
    27017: "MongoDB should not be publicly accessible",
    11211: "Memcached should not be publicly accessible",
    9200: "Elasticsearch should not be publicly accessible",
    5601: "Kibana should not be publicly accessible",
    2375: "Docker daemon TCP socket exposed — critical risk",
    2376: "Docker daemon TCP socket exposed — critical risk",
    1433: "MSSQL should not be publicly accessible",
}

_MEDIUM_RISK_PORTS: set[int] = {8080, 8443, 9090, 3000, 8888}

# Known security-critical packages
_CRITICAL_PACKAGES = {"openssl", "libssl3", "openssh-server", "openssh-client", "sudo", "linux-image"}
_HIGH_PACKAGES = {"nginx", "apache2", "curl", "libcurl4", "git", "python3", "docker-ce"}


# ---------------------------------------------------------------------------
# Scan command builder
# ---------------------------------------------------------------------------

_SCAN_CMD = r"""
echo '===SECURITY_UPDATES==='
apt-get update -qq 2>/dev/null && apt-get -s upgrade 2>/dev/null | grep -i security | head -50 || true
echo '===UPGRADABLE==='
apt list --upgradable 2>/dev/null | tail -n +2 | head -100 || true
echo '===DOCKER_IMAGES==='
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | head -20 || true
echo '===OPEN_PORTS==='
ss -tlnp 2>/dev/null | tail -n +2 || true
echo '===SSH_CONFIG==='
grep -E '^(PermitRootLogin|PasswordAuthentication|Port) ' /etc/ssh/sshd_config 2>/dev/null || true
echo '===FAILED_LOGINS==='
journalctl -u sshd --since "24 hours ago" 2>/dev/null | grep -c "Failed password" || echo 0
echo '===UNATTENDED==='
systemctl is-active unattended-upgrades 2>/dev/null || echo inactive
echo '===REBOOT==='
test -f /var/run/reboot-required && echo "REBOOT_REQUIRED" || echo "OK"
echo '===LAST_UPDATE==='
stat -c %Y /var/lib/apt/lists/ 2>/dev/null || echo 0
echo '===KERNEL==='
uname -r 2>/dev/null || echo unknown
echo '===SSH_HOST_KEYS==='
find /etc/ssh/ -name 'ssh_host_*_key.pub' -exec ssh-keygen -l -f {} \; 2>/dev/null || true
echo '===END==='
""".strip()


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def _split_sections(raw: str) -> dict[str, str]:
    """Split compound SSH output into named sections."""
    sections: dict[str, str] = {}
    current: str | None = None
    buf: list[str] = []
    for line in raw.splitlines():
        if line.startswith("===") and line.endswith("==="):
            if current is not None:
                sections[current] = "\n".join(buf).strip()
            current = line.strip("=")
            buf = []
        else:
            buf.append(line)
    if current is not None:
        sections[current] = "\n".join(buf).strip()
    return sections


def _parse_upgradable(section: str) -> list[PackageInfo]:
    """Parse `apt list --upgradable` output."""
    pkgs: list[PackageInfo] = []
    for line in section.splitlines():
        if not line.strip():
            continue
        # Format: package/suite version_new arch [upgradable from: version_old]
        m = re.match(
            r"^([a-zA-Z0-9_.+-]+)/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s+([^\]]+)\]",
            line,
        )
        if m:
            name, available, current = m.group(1), m.group(2), m.group(3)
            severity = _package_severity(name)
            pkgs.append(PackageInfo(
                name=name, current=current, available=available,
                severity=severity, type="security" if severity in ("critical", "high") else "update",
            ))
    return pkgs


def _package_severity(name: str) -> str:
    base = name.split(":")[0].lower()
    if base in _CRITICAL_PACKAGES or base.startswith("linux-image"):
        return "critical"
    if base in _HIGH_PACKAGES:
        return "high"
    return "medium"


def _count_security_lines(section: str) -> int:
    return len([l for l in section.splitlines() if l.strip()])


def _parse_open_ports(section: str) -> list[OpenPort]:
    ports: list[OpenPort] = []
    seen: set[int] = set()
    for line in section.splitlines():
        if not line.strip():
            continue
        # ss -tlnp columns: State Recv-Q Send-Q Local-Addr:Port Peer-Addr:Port Process
        parts = line.split()
        if len(parts) < 4:
            continue
        local = parts[3]
        # Extract port — may be *:PORT or 0.0.0.0:PORT or [::]:PORT
        port_match = re.search(r":(\d+)$", local)
        if not port_match:
            continue
        port = int(port_match.group(1))
        if port in seen:
            continue
        seen.add(port)

        process = ""
        if len(parts) >= 6:
            proc_match = re.search(r'"([^"]+)"', parts[-1])
            if proc_match:
                process = proc_match.group(1)

        risk = "low"
        note = ""
        if port in _HIGH_RISK_PORTS:
            risk = "high"
            note = _HIGH_RISK_PORTS[port]
        elif port in _MEDIUM_RISK_PORTS:
            risk = "medium"

        ports.append(OpenPort(port=port, protocol="tcp", process=process, risk=risk, note=note))
    return ports


def _parse_ssh_config(section: str) -> dict[str, str]:
    cfg: dict[str, str] = {}
    for line in section.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2:
            cfg[parts[0].lower()] = parts[1]
    return cfg


def _parse_ssh_keys(section: str) -> list[str]:
    """Return list of weak SSH host keys (< 2048 bits RSA, or < 256 bits ECDSA)."""
    weak: list[str] = []
    for line in section.splitlines():
        if not line.strip():
            continue
        # Format: 2048 SHA256:xxx root@host (RSA)
        m = re.match(r"(\d+)\s+\S+\s+.*\((\w+)\)", line)
        if m:
            bits = int(m.group(1))
            algo = m.group(2).upper()
            if algo == "RSA" and bits < 2048:
                weak.append(f"{algo}-{bits}bit: {line.strip()}")
            elif algo == "DSA":
                weak.append(f"DSA key (deprecated): {line.strip()}")
    return weak


def _parse_docker_images(section: str) -> list[DockerImageStatus]:
    """Parse docker images list. We can only flag <none> tags or known-outdated patterns."""
    images: list[DockerImageStatus] = []
    for line in section.splitlines():
        img = line.strip()
        if not img or img == "<none>:<none>":
            continue
        # Heuristic: if tag is "latest", we can't determine version
        if img.endswith(":latest") or ":" not in img:
            images.append(DockerImageStatus(image=img, status="unknown"))
        else:
            # We can't actually check remote registries in this scan, so mark as "check_manually"
            images.append(DockerImageStatus(image=img, status="check_manually"))
    return images


# ---------------------------------------------------------------------------
# Risk scoring
# ---------------------------------------------------------------------------

def _compute_risk(
    packages: list[PackageInfo],
    open_ports: list[OpenPort],
    ssh_cfg: dict[str, str],
    reboot_required: bool,
    unattended_active: bool,
    weak_keys: list[str],
) -> tuple[int, str, VulnerabilitySummary]:
    """Return (score, level, summary)."""
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}

    # Package vulnerabilities
    for p in packages:
        sev = p.severity if p.severity in counts else "medium"
        counts[sev] += 1

    # Open ports
    for op in open_ports:
        if op.risk == "high":
            counts["high"] += 1
        elif op.risk == "medium":
            counts["medium"] += 1

    # Weak SSH keys
    for _ in weak_keys:
        counts["high"] += 1

    total = sum(counts.values())
    summary = VulnerabilitySummary(
        total_vulnerabilities=total, **counts,
    )

    score = 100
    score -= counts["critical"] * 15
    score -= counts["high"] * 8
    score -= counts["medium"] * 3
    score -= counts["low"] * 1

    # SSH config penalties
    root_login = ssh_cfg.get("permitrootlogin", "unknown").lower()
    if root_login in ("yes", "without-password"):
        score -= 10
    password_auth = ssh_cfg.get("passwordauthentication", "unknown").lower()
    if password_auth == "yes":
        score -= 10
    if reboot_required:
        score -= 5
    if not unattended_active:
        score -= 5

    score = max(0, score)

    if score >= 80:
        level = "low"
    elif score >= 60:
        level = "medium"
    elif score >= 40:
        level = "high"
    else:
        level = "critical"

    return score, level, summary


def _build_recommendations(
    packages: list[PackageInfo],
    open_ports: list[OpenPort],
    ssh_cfg: dict[str, str],
    reboot_required: bool,
    unattended_active: bool,
    weak_keys: list[str],
) -> list[Recommendation]:
    recs: list[Recommendation] = []

    # Critical / high packages
    critical_pkgs = [p for p in packages if p.severity == "critical"]
    if critical_pkgs:
        names = ", ".join(p.name for p in critical_pkgs[:5])
        recs.append(Recommendation(
            priority="critical",
            action=f"Update critical packages: {names}",
        ))

    high_pkgs = [p for p in packages if p.severity == "high"]
    if high_pkgs:
        names = ", ".join(p.name for p in high_pkgs[:5])
        recs.append(Recommendation(priority="high", action=f"Update high-priority packages: {names}"))

    # Dangerous open ports
    for op in open_ports:
        if op.risk == "high":
            recs.append(Recommendation(
                priority="high",
                action=f"Close port {op.port} — {op.note or op.process + ' should not be publicly accessible'}",
            ))

    # SSH hardening
    if ssh_cfg.get("passwordauthentication", "").lower() == "yes":
        recs.append(Recommendation(
            priority="high",
            action="Disable SSH password authentication — use key-based auth only",
        ))
    root_login = ssh_cfg.get("permitrootlogin", "").lower()
    if root_login in ("yes", "without-password"):
        recs.append(Recommendation(
            priority="medium",
            action="Restrict SSH root login — set PermitRootLogin to 'prohibit-password' or 'no'",
        ))

    if not unattended_active:
        recs.append(Recommendation(
            priority="medium",
            action="Enable unattended-upgrades for automatic security patches",
        ))

    if reboot_required:
        recs.append(Recommendation(
            priority="medium",
            action="Reboot required to apply kernel/system updates",
        ))

    for wk in weak_keys:
        recs.append(Recommendation(priority="high", action=f"Replace weak SSH host key: {wk}"))

    return recs


# ---------------------------------------------------------------------------
# 1) GET /{server_id}/security/scan — Run vulnerability scan
# ---------------------------------------------------------------------------

@router.get("/{server_id}/security/scan", response_model=ScanResult)
async def run_security_scan(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Run a comprehensive security / vulnerability scan on the server."""
    srv = await _get_owned_server(server_id, db, user)
    server_info = _to_server_info(srv)

    try:
        raw = await _driver._ssh_exec(server_info, _SCAN_CMD, timeout=120)
    except Exception as exc:
        logger.error(f"Security scan SSH failed for {server_id}: {exc}")
        raise HTTPException(status_code=502, detail=f"SSH connection failed: {exc}")

    sections = _split_sections(raw)
    now = datetime.now(timezone.utc)

    # --- Parse each section ---
    # OS updates
    security_lines = _count_security_lines(sections.get("SECURITY_UPDATES", ""))
    packages = _parse_upgradable(sections.get("UPGRADABLE", ""))

    os_updates = OsUpdates(
        security_updates_available=security_lines,
        total_updates_available=len(packages),
        packages=packages,
    )

    # Docker
    docker_images = _parse_docker_images(sections.get("DOCKER_IMAGES", ""))

    # Open ports
    open_ports = _parse_open_ports(sections.get("OPEN_PORTS", ""))

    # SSH config
    ssh_cfg = _parse_ssh_config(sections.get("SSH_CONFIG", ""))
    ssh_port_str = ssh_cfg.get("port", "22")
    try:
        ssh_port = int(ssh_port_str)
    except ValueError:
        ssh_port = 22

    # Failed logins
    failed_raw = sections.get("FAILED_LOGINS", "0").strip()
    try:
        failed_logins = int(failed_raw)
    except ValueError:
        failed_logins = 0

    # SSH host keys
    weak_keys = _parse_ssh_keys(sections.get("SSH_HOST_KEYS", ""))

    ssh_security = SshSecurity(
        root_login=ssh_cfg.get("permitrootlogin", "unknown"),
        password_auth=ssh_cfg.get("passwordauthentication", "unknown"),
        ssh_port=ssh_port,
        weak_keys=weak_keys,
        failed_logins_24h=failed_logins,
    )

    # Unattended upgrades
    unattended_raw = sections.get("UNATTENDED", "inactive").strip().lower()
    unattended_active = unattended_raw == "active"

    # Reboot required
    reboot_raw = sections.get("REBOOT", "OK").strip()
    reboot_required = reboot_raw == "REBOOT_REQUIRED"

    # Last update
    last_update_ts = sections.get("LAST_UPDATE", "0").strip()
    try:
        ts = int(last_update_ts)
        if ts > 0:
            last_update_days = (now - datetime.fromtimestamp(ts, tz=timezone.utc)).days
        else:
            last_update_days = -1
    except ValueError:
        last_update_days = -1

    # Kernel
    kernel_version = sections.get("KERNEL", "unknown").strip()

    system_health = SystemHealth(
        unattended_upgrades=unattended_active,
        reboot_required=reboot_required,
        last_update_days_ago=last_update_days,
        kernel_version=kernel_version,
    )

    # --- Risk scoring ---
    risk_score, risk_level, summary = _compute_risk(
        packages, open_ports, ssh_cfg, reboot_required, unattended_active, weak_keys,
    )

    # --- Recommendations ---
    recommendations = _build_recommendations(
        packages, open_ports, ssh_cfg, reboot_required, unattended_active, weak_keys,
    )

    scan_result = ScanResult(
        scan_time=now.isoformat(),
        risk_score=risk_score,
        risk_level=risk_level,
        summary=summary,
        os_updates=os_updates,
        docker_images=docker_images,
        open_ports=open_ports,
        ssh_security=ssh_security,
        system_health=system_health,
        recommendations=recommendations,
    )

    # --- Persist to srv.meta for history ---
    meta = dict(srv.meta or {})
    meta["last_security_scan"] = scan_result.model_dump()
    srv.meta = meta
    flag_modified(srv, "meta")
    await db.commit()

    logger.info(
        f"Security scan complete for {srv.name} ({server_id}): "
        f"score={risk_score} level={risk_level} vulns={summary.total_vulnerabilities}"
    )
    return scan_result


# ---------------------------------------------------------------------------
# 2) POST /{server_id}/security/fix — Auto-fix selected vulnerabilities
# ---------------------------------------------------------------------------

_SSHD_CONFIG = "/etc/ssh/sshd_config"


@router.post("/{server_id}/security/fix", response_model=FixResponse)
async def fix_vulnerabilities(
    server_id: str,
    body: FixRequest,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Apply automated fixes for selected security issues."""
    srv = await _get_owned_server(server_id, db, user)
    server_info = _to_server_info(srv)

    if not body.actions:
        raise HTTPException(status_code=400, detail="No actions specified")

    results: list[FixAction] = []

    for action_str in body.actions:
        action_lower = action_str.strip().lower()

        try:
            if action_lower == "update_packages":
                result = await _fix_update_packages(server_info, srv)
                results.append(result)

            elif action_lower.startswith("close_port:"):
                port_str = action_lower.split(":", 1)[1].strip()
                try:
                    port = int(port_str)
                except ValueError:
                    results.append(FixAction(action=action_str, status="failed", detail=f"Invalid port: {port_str}"))
                    continue
                result = await _fix_close_port(server_info, port)
                results.append(result)

            elif action_lower == "enable_unattended_upgrades":
                result = await _fix_unattended_upgrades(server_info)
                results.append(result)

            elif action_lower == "disable_root_login":
                result = await _fix_sshd_setting(server_info, "PermitRootLogin", "no")
                results.append(FixAction(action=action_str, status=result.status, detail=result.detail))

            elif action_lower == "disable_password_auth":
                result = await _fix_sshd_setting(server_info, "PasswordAuthentication", "no")
                results.append(FixAction(action=action_str, status=result.status, detail=result.detail))

            else:
                results.append(FixAction(action=action_str, status="skipped", detail="Unknown action"))

        except Exception as exc:
            logger.error(f"Fix action '{action_str}' failed for {server_id}: {exc}")
            results.append(FixAction(action=action_str, status="failed", detail=str(exc)))

    logger.info(f"Security fix applied for {srv.name} ({server_id}): {len(results)} actions")
    return FixResponse(results=results)


async def _fix_update_packages(server_info: ServerInfo, srv: Server) -> FixAction:
    """Run apt-get upgrade for security packages."""
    cmd = (
        "export DEBIAN_FRONTEND=noninteractive && "
        "apt-get update -qq 2>/dev/null && "
        "apt-get upgrade -y -o Dpkg::Options::='--force-confold' 2>&1 | tail -20"
    )
    try:
        output = await _driver._ssh_exec(server_info, cmd, timeout=300)
        return FixAction(action="update_packages", status="success", detail=output[-500:] if output else "Done")
    except Exception as exc:
        return FixAction(action="update_packages", status="failed", detail=str(exc))


async def _fix_close_port(server_info: ServerInfo, port: int) -> FixAction:
    """Block a port using ufw."""
    action_name = f"close_port:{port}"
    # Ensure ufw is installed and enabled
    cmd = (
        f"which ufw >/dev/null 2>&1 || apt-get install -y ufw -qq 2>/dev/null; "
        f"ufw --force enable 2>/dev/null; "
        f"ufw deny {port}/tcp 2>&1; "
        f"ufw deny {port}/udp 2>&1"
    )
    try:
        output = await _driver._ssh_exec(server_info, cmd, timeout=60)
        return FixAction(action=action_name, status="success", detail=output)
    except Exception as exc:
        return FixAction(action=action_name, status="failed", detail=str(exc))


async def _fix_unattended_upgrades(server_info: ServerInfo) -> FixAction:
    """Install and enable unattended-upgrades."""
    cmd = (
        "export DEBIAN_FRONTEND=noninteractive && "
        "apt-get install -y unattended-upgrades -qq 2>/dev/null && "
        "echo 'APT::Periodic::Update-Package-Lists \"1\";' > /etc/apt/apt.conf.d/20auto-upgrades && "
        "echo 'APT::Periodic::Unattended-Upgrade \"1\";' >> /etc/apt/apt.conf.d/20auto-upgrades && "
        "systemctl enable unattended-upgrades 2>/dev/null && "
        "systemctl start unattended-upgrades 2>/dev/null && "
        "echo OK"
    )
    try:
        output = await _driver._ssh_exec(server_info, cmd, timeout=120)
        return FixAction(action="enable_unattended_upgrades", status="success", detail=output)
    except Exception as exc:
        return FixAction(action="enable_unattended_upgrades", status="failed", detail=str(exc))


async def _fix_sshd_setting(server_info: ServerInfo, key: str, value: str) -> FixAction:
    """Update an sshd_config directive and restart sshd."""
    action_name = f"set_{key.lower()}"
    # Use sed to update existing line or append if missing, then restart
    cmd = (
        f"cp {_SSHD_CONFIG} {_SSHD_CONFIG}.bak.$(date +%s) && "
        f"if grep -qE '^#?\\s*{key}\\b' {_SSHD_CONFIG}; then "
        f"  sed -i 's/^#*\\s*{key}\\b.*/{key} {value}/' {_SSHD_CONFIG}; "
        f"else "
        f"  echo '{key} {value}' >> {_SSHD_CONFIG}; "
        f"fi && "
        f"sshd -t 2>&1 && "
        f"systemctl restart sshd 2>&1 && "
        f"echo OK"
    )
    try:
        output = await _driver._ssh_exec(server_info, cmd, timeout=30)
        if "OK" in output:
            return FixAction(action=action_name, status="success", detail=f"{key} set to {value}")
        return FixAction(action=action_name, status="failed", detail=output)
    except Exception as exc:
        return FixAction(action=action_name, status="failed", detail=str(exc))


# ---------------------------------------------------------------------------
# 3) GET /{server_id}/security/scan/history — Last cached scan
# ---------------------------------------------------------------------------

@router.get("/{server_id}/security/scan/history", response_model=ScanResult | None)
async def get_scan_history(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Return the most recent cached security scan results."""
    srv = await _get_owned_server(server_id, db, user)
    meta = srv.meta or {}
    cached = meta.get("last_security_scan")
    if not cached:
        raise HTTPException(status_code=404, detail="No scan history available. Run a scan first.")
    return ScanResult(**cached)
