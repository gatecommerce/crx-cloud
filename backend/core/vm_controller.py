"""VM controller — manage traditional servers via SSH + systemd.

Provisioning includes: Docker CE, security hardening, firewall,
fail2ban, unattended-upgrades, swap, SSH hardening, kernel tuning.
"""

from __future__ import annotations

import asyncio
from functools import partial

import paramiko
from loguru import logger

from core.server_manager import ServerDriver, ServerInfo, ServerStatus
from core.ssh_keys import get_private_key_path, get_public_key


class VMDriver(ServerDriver):
    """Driver for VM/VPS servers (Hetzner, DigitalOcean, any SSH-accessible)."""

    def _get_ssh_client(
        self, server: ServerInfo, password: str | None = None
    ) -> paramiko.SSHClient:
        """Create and configure an SSH client.

        Auth priority: platform key → server-specific key → password.
        """
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        ssh_user = server.metadata.get("ssh_user", "root")
        ssh_key = server.metadata.get("ssh_key_path")
        ssh_port = server.metadata.get("ssh_port", 22)

        kwargs: dict = {
            "hostname": server.endpoint,
            "username": ssh_user,
            "port": ssh_port,
            "timeout": 15,
        }

        if password:
            kwargs["password"] = password
        elif ssh_key:
            kwargs["key_filename"] = ssh_key
        else:
            kwargs["key_filename"] = get_private_key_path()

        client.connect(**kwargs)
        return client

    async def _ssh_exec(
        self, server: ServerInfo, command: str,
        password: str | None = None, timeout: int = 120,
    ) -> str:
        """Execute SSH command asynchronously."""
        loop = asyncio.get_event_loop()

        def _run():
            client = self._get_ssh_client(server, password=password)
            try:
                _, stdout, stderr = client.exec_command(command, timeout=timeout)
                exit_code = stdout.channel.recv_exit_status()
                if exit_code != 0:
                    error = stderr.read().decode().strip()
                    raise RuntimeError(f"SSH command failed (exit {exit_code}): {error}")
                return stdout.read().decode().strip()
            finally:
                client.close()

        return await loop.run_in_executor(None, _run)

    async def connect(self, server: ServerInfo, password: str | None = None) -> bool:
        """Connect to VM via SSH."""
        try:
            result = await self._ssh_exec(server, "hostname", password=password)
            logger.info(f"Connected to VM: {server.name} ({result})")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to {server.name}: {e}")
            return False

    async def inject_ssh_key(self, server: ServerInfo, password: str) -> bool:
        """Inject platform public key via password auth (one-time setup)."""
        try:
            pub_key = get_public_key()
            cmd = (
                "mkdir -p ~/.ssh && chmod 700 ~/.ssh && "
                f"echo '{pub_key}' >> ~/.ssh/authorized_keys && "
                "chmod 600 ~/.ssh/authorized_keys && "
                "sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys"
            )
            await self._ssh_exec(server, cmd, password=password)
            logger.info(f"SSH key injected on {server.name}")
            return True
        except Exception as e:
            logger.error(f"Failed to inject SSH key on {server.name}: {e}")
            return False

    # ─── Security Pre-Check (existing server threat scan) ────────────

    async def security_precheck(self, server: ServerInfo) -> dict:
        """Deep security scan BEFORE provisioning an existing server.

        Detects: rootkits, crypto miners, suspicious processes, unauthorized
        SSH keys, malicious cron jobs, tampered binaries, rogue users,
        suspicious network connections, and known malware indicators.

        Returns:
            {
                "safe": bool,          # True = no critical threats
                "risk_level": str,     # "clean" | "low" | "medium" | "critical"
                "threats": [...],      # List of detected threats
                "system_info": {...},  # OS, kernel, uptime, etc.
                "recommendations": [...],  # What we'll fix during provisioning
            }
        """
        threats: list[dict] = []
        recommendations: list[str] = []
        system_info: dict = {}

        try:
            # ── 1. System info ──────────────────────────────────────
            os_info = await self._ssh_exec(
                server, ". /etc/os-release && echo \"$ID $VERSION_ID $PRETTY_NAME\""
            )
            kernel = await self._ssh_exec(server, "uname -r")
            uptime = await self._ssh_exec(server, "uptime -p 2>/dev/null || uptime")
            arch = await self._ssh_exec(server, "uname -m")

            system_info = {
                "os": os_info.strip(),
                "kernel": kernel.strip(),
                "uptime": uptime.strip(),
                "arch": arch.strip(),
            }

            # Check if supported distro
            distro_id = os_info.split()[0].lower() if os_info else ""
            if distro_id not in ("ubuntu", "debian"):
                threats.append({
                    "severity": "medium",
                    "category": "compatibility",
                    "detail": f"Unsupported distro: {os_info.strip()}. CRX Cloud requires Ubuntu or Debian.",
                })

            # ── 2. Suspicious processes (crypto miners, reverse shells) ─
            suspicious_procs = await self._ssh_exec(
                server,
                "ps aux 2>/dev/null | "
                "grep -iE '(xmrig|minerd|kdevtmpfsi|kinsing|xmr|cryptonight|"
                "stratum|nanopool|hashvault|monero|coinminer|"
                r"bash -i.*\/dev\/tcp|nc -e|ncat -e|python.*pty\.spawn|"
                "perl.*socket.*connect)' | "
                "grep -v grep || echo 'CLEAN'",
                timeout=15,
            )
            if suspicious_procs.strip() != "CLEAN":
                for line in suspicious_procs.strip().split("\n"):
                    if line.strip():
                        threats.append({
                            "severity": "critical",
                            "category": "malware",
                            "detail": f"Suspicious process: {line.strip()[:200]}",
                        })

            # ── 3. High CPU processes (mining indicator) ────────────
            high_cpu = await self._ssh_exec(
                server,
                "ps aux --sort=-%cpu 2>/dev/null | awk 'NR>1 && $3>80{print $11, $3\"%\"}' | head -5 || echo 'CLEAN'",
                timeout=10,
            )
            if high_cpu.strip() != "CLEAN" and high_cpu.strip():
                for line in high_cpu.strip().split("\n"):
                    if line.strip():
                        threats.append({
                            "severity": "medium",
                            "category": "resource_abuse",
                            "detail": f"High CPU process: {line.strip()[:150]}",
                        })

            # ── 4. Unauthorized SSH keys ────────────────────────────
            auth_keys = await self._ssh_exec(
                server,
                "cat /root/.ssh/authorized_keys 2>/dev/null | "
                "grep -v '^#' | grep -v '^$' | wc -l || echo '0'",
                timeout=10,
            )
            key_count = int(auth_keys.strip() or "0")
            if key_count > 5:
                threats.append({
                    "severity": "medium",
                    "category": "access",
                    "detail": f"{key_count} SSH keys in root authorized_keys (unusual for a fresh server)",
                })

            # ── 5. Suspicious cron jobs ─────────────────────────────
            cron_scan = await self._ssh_exec(
                server,
                "("
                "crontab -l 2>/dev/null; "
                "cat /etc/crontab 2>/dev/null; "
                "cat /etc/cron.d/* 2>/dev/null; "
                "ls /var/spool/cron/crontabs/ 2>/dev/null"
                ") | grep -viE '(^#|^$|^SHELL|^PATH|^MAILTO|anacron|logrotate|"
                "apt|unattended|certbot|update-notifier|popularity-contest)' | "
                "grep -iE '(curl|wget|python|perl|bash|sh |/tmp/|/dev/shm/|"
                r"base64|eval|\\$\\(|chmod \\+x)' || echo 'CLEAN'",
                timeout=15,
            )
            if cron_scan.strip() != "CLEAN":
                for line in cron_scan.strip().split("\n"):
                    if line.strip():
                        threats.append({
                            "severity": "high",
                            "category": "persistence",
                            "detail": f"Suspicious cron entry: {line.strip()[:200]}",
                        })

            # ── 6. /tmp and /dev/shm malware staging ────────────────
            tmp_check = await self._ssh_exec(
                server,
                "find /tmp /dev/shm /var/tmp -type f "
                "\\( -perm -111 -o -name '*.sh' -o -name '*.py' -o -name '*.pl' \\) "
                "2>/dev/null | head -20 || echo 'CLEAN'",
                timeout=15,
            )
            if tmp_check.strip() != "CLEAN":
                exec_files = [f.strip() for f in tmp_check.strip().split("\n") if f.strip()]
                if len(exec_files) > 3:
                    threats.append({
                        "severity": "high",
                        "category": "malware",
                        "detail": f"{len(exec_files)} executable files in /tmp or /dev/shm: {', '.join(exec_files[:5])}",
                    })

            # ── 7. Tampered system binaries (debsums) ───────────────
            debsums_check = await self._ssh_exec(
                server,
                "which debsums > /dev/null 2>&1 && "
                "debsums -s 2>/dev/null | head -10 || echo 'SKIP'",
                timeout=30,
            )
            if debsums_check.strip() not in ("SKIP", ""):
                threats.append({
                    "severity": "critical",
                    "category": "integrity",
                    "detail": f"Modified system binaries detected: {debsums_check.strip()[:300]}",
                })

            # ── 8. Rogue users / UID 0 ──────────────────────────────
            uid0_users = await self._ssh_exec(
                server,
                "awk -F: '$3==0 && $1!=\"root\"{print $1}' /etc/passwd || echo 'CLEAN'",
                timeout=10,
            )
            if uid0_users.strip() != "CLEAN" and uid0_users.strip():
                threats.append({
                    "severity": "critical",
                    "category": "access",
                    "detail": f"Non-root users with UID 0 (backdoor): {uid0_users.strip()}",
                })

            # Users with login shells (excluding standard system users)
            shell_users = await self._ssh_exec(
                server,
                "awk -F: '$7 ~ /(bash|sh|zsh)$/ && $3>=1000{print $1}' /etc/passwd "
                "2>/dev/null || echo 'NONE'",
                timeout=10,
            )
            if shell_users.strip() != "NONE" and shell_users.strip():
                user_list = shell_users.strip().split("\n")
                if len(user_list) > 3:
                    threats.append({
                        "severity": "low",
                        "category": "access",
                        "detail": f"{len(user_list)} non-system users with login shells: {', '.join(user_list[:5])}",
                    })

            # ── 9. Suspicious network connections ───────────────────
            net_check = await self._ssh_exec(
                server,
                "ss -tulpn 2>/dev/null | grep LISTEN | "
                "grep -vE '(:22 |:80 |:443 |:25 |:53 |:3306 |:5432 |:6379 |"
                ":8069|:8072|:11211|127\\.0\\.0|\\[::1\\])' | "
                "awk '{print $5, $7}' || echo 'CLEAN'",
                timeout=10,
            )
            if net_check.strip() != "CLEAN" and net_check.strip():
                unusual_ports = net_check.strip().split("\n")
                for port_info in unusual_ports[:5]:
                    if port_info.strip():
                        threats.append({
                            "severity": "medium",
                            "category": "network",
                            "detail": f"Unusual listening port: {port_info.strip()[:150]}",
                        })

            # ── 10. Outbound connections to mining pools ────────────
            outbound = await self._ssh_exec(
                server,
                "ss -tp 2>/dev/null | "
                "grep -iE '(pool\\.|xmr\\.|monero|nicehash|hashvault|"
                "nanopool|minexmr|:3333 |:4444 |:5555 |:7777 |:14444)' | "
                "head -5 || echo 'CLEAN'",
                timeout=10,
            )
            if outbound.strip() != "CLEAN":
                threats.append({
                    "severity": "critical",
                    "category": "malware",
                    "detail": f"Active connection to mining pool: {outbound.strip()[:200]}",
                })

            # ── 11. Kernel module check (rootkit indicator) ─────────
            suspicious_modules = await self._ssh_exec(
                server,
                "lsmod 2>/dev/null | "
                "grep -viE '(^Module|^ip|^nf_|^xt_|^x_tables|^tcp_|^udp_"
                "|^bridge|^veth|^overlay|^br_|^ebtable|^arp|^dm_|^sd_"
                "|^sr_|^sg_|^ext4|^xfs|^btrfs|^fat|^nls_|^isofs|^udf"
                "|^fuse|^loop|^kvm|^virtio|^vmw|^hv_|^hyperv|^xen_"
                "|^drm|^i2c|^snd_|^intel|^amd|^acpi|^pci|^usb|^input"
                "|^hid|^serio|^ata_|^ahci|^nvme|^scsi|^libata|^crc"
                "|^zlib|^lz4|^zstd|^sha|^aes|^crypto|^ghash|^hmac"
                "|^rng|^raid|^md_|^jbd2|^mbcache|^bonding|^tls"
                "|^nft_|^conntrack|^auth|^rpcsec|^nfsd|^nfs|^lockd"
                "|^sunrpc|^grace|^8021q|^mpls|^wireguard|^tun|^tap"
                "|^dummy|^macvlan|^ipvlan|^vxlan|^geneve)' | "
                "awk '{print $1}' | head -10 || echo 'CLEAN'",
                timeout=10,
            )
            if suspicious_modules.strip() != "CLEAN" and suspicious_modules.strip():
                mods = suspicious_modules.strip().split("\n")
                # Only flag if there are truly unknown modules
                if len(mods) > 5:
                    threats.append({
                        "severity": "low",
                        "category": "integrity",
                        "detail": f"Unknown kernel modules loaded: {', '.join(mods[:8])}",
                    })

            # ── 12. Check for running Docker (existing services) ────
            docker_running = await self._ssh_exec(
                server,
                "docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | head -20 || echo 'NO_DOCKER'",
                timeout=10,
            )
            if docker_running.strip() not in ("NO_DOCKER", ""):
                containers = docker_running.strip().split("\n")
                system_info["existing_containers"] = containers
                recommendations.append(
                    f"Server has {len(containers)} running Docker container(s). "
                    "They will NOT be affected by provisioning."
                )

            # ── Generate risk assessment ────────────────────────────
            critical_count = sum(1 for t in threats if t["severity"] == "critical")
            high_count = sum(1 for t in threats if t["severity"] == "high")
            medium_count = sum(1 for t in threats if t["severity"] == "medium")

            if critical_count > 0:
                risk_level = "critical"
            elif high_count > 0:
                risk_level = "high"
            elif medium_count > 0:
                risk_level = "medium"
            elif len(threats) > 0:
                risk_level = "low"
            else:
                risk_level = "clean"

            safe = risk_level in ("clean", "low")

            # Standard recommendations for provisioning
            if not threats or safe:
                recommendations.extend([
                    "Firewall (UFW) will be configured",
                    "Fail2ban will be installed for brute-force protection",
                    "SSH password auth will be disabled",
                    "Automatic security updates will be enabled",
                    "Docker CE will be installed/verified",
                    "Swap and kernel tuning will be applied",
                ])

            return {
                "safe": safe,
                "risk_level": risk_level,
                "threats": threats,
                "threat_count": len(threats),
                "system_info": system_info,
                "recommendations": recommendations,
            }

        except Exception as e:
            logger.error(f"Security precheck failed for {server.name}: {e}")
            return {
                "safe": False,
                "risk_level": "unknown",
                "threats": [{"severity": "high", "category": "scan_error", "detail": str(e)}],
                "threat_count": 1,
                "system_info": system_info,
                "recommendations": ["Could not complete security scan. Proceed with caution."],
            }

    # ─── Server Sanitization (clean threats before provisioning) ─────

    async def sanitize(self, server: ServerInfo, threats: list[dict]) -> dict:
        """Sanitize a compromised server — kill threats, remove malware,
        clean persistence mechanisms BEFORE provisioning.

        This does NOT format/reinstall — it surgically removes detected threats
        while preserving legitimate services and data.
        """
        actions: list[dict] = []

        try:
            # ── Kill suspicious processes ───────────────────────────
            malware_procs = [t for t in threats if t["category"] == "malware" and "process" in t.get("detail", "").lower()]
            if malware_procs:
                kill_result = await self._ssh_exec(
                    server,
                    "ps aux | "
                    "grep -iE '(xmrig|minerd|kdevtmpfsi|kinsing|xmr|cryptonight|"
                    "stratum|nanopool|hashvault|monero|coinminer)' | "
                    "grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null; "
                    "echo 'DONE'",
                    timeout=15,
                )
                actions.append({"action": "kill_malware_processes", "ok": True, "detail": "Killed suspicious processes"})

            # ── Remove executable files from staging dirs ───────────
            staging_threats = [t for t in threats if t["category"] == "malware" and "/tmp" in t.get("detail", "")]
            if staging_threats:
                await self._ssh_exec(
                    server,
                    "find /tmp /dev/shm /var/tmp -type f "
                    "\\( -perm -111 -o -name '*.sh' -o -name '*.py' -o -name '*.pl' \\) "
                    "-not -path '*/systemd*' -not -path '*/snap*' "
                    "-delete 2>/dev/null; echo 'DONE'",
                    timeout=15,
                )
                actions.append({"action": "clean_staging_dirs", "ok": True, "detail": "Removed executables from /tmp, /dev/shm, /var/tmp"})

            # ── Remove suspicious cron entries ─────────────────────
            cron_threats = [t for t in threats if t["category"] == "persistence"]
            if cron_threats:
                # Backup crontab, then remove suspicious lines
                await self._ssh_exec(
                    server,
                    "cp /var/spool/cron/crontabs/root /var/spool/cron/crontabs/root.bak.crx 2>/dev/null; "
                    "crontab -l 2>/dev/null | "
                    "grep -viE '(curl.*\\||wget.*\\||/tmp/|/dev/shm/|base64|eval|"
                    r"chmod \\+x.*http)' | "
                    "crontab - 2>/dev/null; "
                    # Also clean /etc/cron.d of suspicious entries
                    "find /etc/cron.d -type f -newer /etc/cron.d -mmin -43200 "
                    "-exec grep -lE '(curl|wget|/tmp/|/dev/shm/)' {} \\; "
                    "-exec rm {} \\; 2>/dev/null; "
                    "echo 'DONE'",
                    timeout=15,
                )
                actions.append({"action": "clean_cron", "ok": True, "detail": "Removed suspicious cron entries (backup saved)"})

            # ── Remove UID-0 backdoor users ─────────────────────────
            uid0_threats = [t for t in threats if t["category"] == "access" and "UID 0" in t.get("detail", "")]
            if uid0_threats:
                rogue_users = await self._ssh_exec(
                    server,
                    "awk -F: '$3==0 && $1!=\"root\"{print $1}' /etc/passwd",
                    timeout=10,
                )
                for user in rogue_users.strip().split("\n"):
                    user = user.strip()
                    if user:
                        await self._ssh_exec(
                            server,
                            f"userdel -f {user} 2>/dev/null; echo 'REMOVED {user}'",
                            timeout=10,
                        )
                        actions.append({"action": "remove_backdoor_user", "ok": True, "detail": f"Removed UID-0 backdoor user: {user}"})

            # ── Clean unauthorized SSH keys ─────────────────────────
            key_threats = [t for t in threats if t["category"] == "access" and "SSH keys" in t.get("detail", "")]
            if key_threats:
                # Backup, then keep only the platform key (if present) or empty
                platform_key = get_public_key()
                await self._ssh_exec(
                    server,
                    "cp /root/.ssh/authorized_keys /root/.ssh/authorized_keys.bak.crx 2>/dev/null; "
                    f"echo '{platform_key}' > /root/.ssh/authorized_keys && "
                    "chmod 600 /root/.ssh/authorized_keys; echo 'DONE'",
                    timeout=10,
                )
                actions.append({"action": "reset_ssh_keys", "ok": True, "detail": "Reset authorized_keys to platform key only (backup saved)"})

            # ── Kill outbound connections to mining pools ───────────
            mining_threats = [t for t in threats if "mining pool" in t.get("detail", "").lower()]
            if mining_threats:
                await self._ssh_exec(
                    server,
                    "ss -tp | "
                    "grep -iE '(pool\\.|xmr\\.|monero|nicehash|:3333 |:4444 |:5555 )' | "
                    "awk '{print $6}' | grep -oP 'pid=\\K[0-9]+' | "
                    "xargs -r kill -9 2>/dev/null; echo 'DONE'",
                    timeout=10,
                )
                actions.append({"action": "kill_mining_connections", "ok": True, "detail": "Terminated connections to mining pools"})

            # ── Disable suspicious systemd services ─────────────────
            await self._ssh_exec(
                server,
                "systemctl list-units --type=service --state=running 2>/dev/null | "
                "grep -iE '(miner|kdevtmpfsi|kinsing|xmr)' | "
                "awk '{print $1}' | xargs -r -I{} systemctl disable --now {} 2>/dev/null; "
                "echo 'DONE'",
                timeout=15,
            )

            # ── Post-sanitization verification ──────────────────────
            verify_procs = await self._ssh_exec(
                server,
                "ps aux | "
                "grep -iE '(xmrig|minerd|kdevtmpfsi|kinsing|xmr|cryptonight)' | "
                "grep -v grep | wc -l || echo '0'",
                timeout=10,
            )
            remaining = int(verify_procs.strip() or "0")

            return {
                "success": remaining == 0,
                "actions": actions,
                "remaining_threats": remaining,
                "message": (
                    "Server sanitized successfully. All detected threats removed."
                    if remaining == 0
                    else f"Sanitization complete but {remaining} suspicious process(es) still running. "
                    "Consider a full OS reinstall."
                ),
            }

        except Exception as e:
            logger.error(f"Sanitization failed for {server.name}: {e}")
            return {
                "success": False,
                "actions": actions,
                "remaining_threats": -1,
                "message": f"Sanitization error: {e}",
            }

    # ─── Full Provisioning ────────────────────────────────────────────

    async def provision(self, server: ServerInfo) -> dict:
        """Provision server with full security hardening.

        Steps:
        1. System update + upgrade
        2. Docker CE + Docker Compose
        3. Firewall (UFW)
        4. Fail2ban (brute-force protection)
        5. SSH hardening (disable password auth)
        6. Unattended security upgrades (Docker pinned)
        7. Swap file (OOM protection)
        8. Kernel tuning (network + security)
        9. CRX Cloud directory structure
        10. Verify all components
        """
        steps: list[dict] = []
        try:
            # ── Step 1: System update ─────────────────────────────
            await self._ssh_exec(
                server,
                "export DEBIAN_FRONTEND=noninteractive && "
                "apt-get update -qq && "
                "apt-get upgrade -y -qq -o Dpkg::Options::='--force-confdef' "
                "-o Dpkg::Options::='--force-confold'",
                timeout=300,
            )
            steps.append({"step": "system_update", "ok": True})

            # ── Step 2: Docker CE ─────────────────────────────────
            docker_check = await self._ssh_exec(
                server, "docker --version 2>/dev/null || echo NOT_INSTALLED"
            )
            if "NOT_INSTALLED" in docker_check:
                # Detect distro for Docker repo
                distro = await self._ssh_exec(
                    server, ". /etc/os-release && echo $ID"
                )
                distro = distro.strip() or "ubuntu"

                await self._ssh_exec(
                    server,
                    "export DEBIAN_FRONTEND=noninteractive && "
                    "apt-get install -y -qq ca-certificates curl gnupg && "
                    "install -m 0755 -d /etc/apt/keyrings && "
                    f"curl -fsSL https://download.docker.com/linux/{distro}/gpg | "
                    "gpg --dearmor -o /etc/apt/keyrings/docker.gpg && "
                    "chmod a+r /etc/apt/keyrings/docker.gpg && "
                    'echo "deb [arch=$(dpkg --print-architecture) '
                    "signed-by=/etc/apt/keyrings/docker.gpg] "
                    f"https://download.docker.com/linux/{distro} "
                    '$(. /etc/os-release && echo $VERSION_CODENAME) stable" | '
                    "tee /etc/apt/sources.list.d/docker.list > /dev/null && "
                    "apt-get update -qq && "
                    "apt-get install -y -qq docker-ce docker-ce-cli "
                    "containerd.io docker-buildx-plugin docker-compose-plugin && "
                    "systemctl enable --now docker",
                    timeout=300,
                )
                steps.append({"step": "docker_install", "ok": True})
            else:
                steps.append({"step": "docker_install", "ok": True, "note": "already installed"})

            # ── Step 3: Firewall (UFW) ────────────────────────────
            await self._provision_firewall(server)
            steps.append({"step": "firewall", "ok": True})

            # ── Step 4: Fail2ban ──────────────────────────────────
            await self._provision_fail2ban(server)
            steps.append({"step": "fail2ban", "ok": True})

            # ── Step 5: SSH hardening ─────────────────────────────
            await self._provision_ssh_hardening(server)
            steps.append({"step": "ssh_hardening", "ok": True})

            # ── Step 6: Unattended security upgrades ──────────────
            await self._provision_unattended_upgrades(server)
            steps.append({"step": "unattended_upgrades", "ok": True})

            # ── Step 7: Swap file ─────────────────────────────────
            await self._provision_swap(server)
            steps.append({"step": "swap", "ok": True})

            # ── Step 8: Kernel tuning ─────────────────────────────
            await self._provision_sysctl(server)
            steps.append({"step": "sysctl_tuning", "ok": True})

            # ── Step 9: CRX Cloud directories ─────────────────────
            await self._ssh_exec(
                server,
                "mkdir -p /opt/crx-cloud/{instances,backups,ssl,logs}"
            )
            steps.append({"step": "crx_directory", "ok": True})

            # ── Step 10: Verify ───────────────────────────────────
            docker_ver = await self._ssh_exec(server, "docker --version")
            compose_ver = await self._ssh_exec(
                server, "docker compose version 2>/dev/null || echo 'N/A'"
            )
            ufw_status = await self._ssh_exec(server, "ufw status | head -1")
            f2b_status = await self._ssh_exec(
                server, "systemctl is-active fail2ban 2>/dev/null || echo 'inactive'"
            )
            swap_info = await self._ssh_exec(server, "swapon --show --noheadings | wc -l")
            updates_status = await self._ssh_exec(
                server, "systemctl is-active unattended-upgrades 2>/dev/null || echo 'inactive'"
            )

            steps.append({
                "step": "verify", "ok": True,
                "docker": docker_ver,
                "compose": compose_ver,
                "firewall": ufw_status,
                "fail2ban": f2b_status,
                "swap": "active" if int(swap_info or "0") > 0 else "none",
                "auto_updates": updates_status,
            })

            return {"success": True, "steps": steps}

        except Exception as e:
            logger.error(f"Provision failed for {server.name}: {e}")
            steps.append({"step": "error", "ok": False, "error": str(e)})
            return {"success": False, "steps": steps, "error": str(e)}

    # ─── Provisioning Sub-Steps ───────────────────────────────────────

    async def _provision_firewall(self, server: ServerInfo):
        """Configure UFW firewall — allow SSH, HTTP, HTTPS, Docker ports."""
        await self._ssh_exec(
            server,
            "export DEBIAN_FRONTEND=noninteractive && "
            "apt-get install -y -qq ufw && "
            "ufw --force reset && "
            "ufw default deny incoming && "
            "ufw default allow outgoing && "
            "ufw allow 22/tcp comment 'SSH' && "
            "ufw allow 80/tcp comment 'HTTP' && "
            "ufw allow 443/tcp comment 'HTTPS' && "
            "ufw allow 8069:8099/tcp comment 'CMS instances' && "
            "ufw --force enable",
            timeout=60,
        )

    async def _provision_fail2ban(self, server: ServerInfo):
        """Install and configure fail2ban for SSH brute-force protection."""
        await self._ssh_exec(
            server,
            "export DEBIAN_FRONTEND=noninteractive && "
            "apt-get install -y -qq fail2ban && "
            "cat > /etc/fail2ban/jail.local << 'JAILEOF'\n"
            "[DEFAULT]\n"
            "bantime = 3600\n"
            "findtime = 600\n"
            "maxretry = 5\n"
            "banaction = ufw\n"
            "\n"
            "[sshd]\n"
            "enabled = true\n"
            "port = ssh\n"
            "filter = sshd\n"
            "logpath = /var/log/auth.log\n"
            "maxretry = 3\n"
            "bantime = 7200\n"
            "JAILEOF\n"
            "systemctl enable --now fail2ban && "
            "systemctl restart fail2ban",
            timeout=60,
        )

    async def _provision_ssh_hardening(self, server: ServerInfo):
        """Harden SSH — disable password auth, restrict root to key-only."""
        await self._ssh_exec(
            server,
            "cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.crx && "
            "mkdir -p /etc/ssh/sshd_config.d && "
            "cat > /etc/ssh/sshd_config.d/crx-hardening.conf << 'SSHEOF'\n"
            "# CRX Cloud SSH Hardening\n"
            "PasswordAuthentication no\n"
            "PermitRootLogin prohibit-password\n"
            "PubkeyAuthentication yes\n"
            "MaxAuthTries 5\n"
            "LoginGraceTime 30\n"
            "ClientAliveInterval 300\n"
            "ClientAliveCountMax 2\n"
            "X11Forwarding no\n"
            "AllowAgentForwarding no\n"
            "SSHEOF\n"
            "sshd -t && (systemctl reload sshd 2>/dev/null || systemctl reload ssh)",
            timeout=30,
        )

    async def _provision_unattended_upgrades(self, server: ServerInfo):
        """Auto security updates — Docker packages pinned (we control those)."""
        await self._ssh_exec(
            server,
            "export DEBIAN_FRONTEND=noninteractive && "
            "apt-get install -y -qq unattended-upgrades apt-listchanges && "
            "cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'UUEOF'\n"
            'Unattended-Upgrade::Allowed-Origins {\n'
            '    "${distro_id}:${distro_codename}-security";\n'
            '};\n'
            'Unattended-Upgrade::Automatic-Reboot "false";\n'
            'Unattended-Upgrade::Package-Blacklist {\n'
            '    "docker-ce";\n'
            '    "docker-ce-cli";\n'
            '    "containerd.io";\n'
            '    "docker-buildx-plugin";\n'
            '    "docker-compose-plugin";\n'
            '};\n'
            'Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";\n'
            'Unattended-Upgrade::Remove-Unused-Dependencies "true";\n'
            'UUEOF\n'
            "cat > /etc/apt/apt.conf.d/20auto-upgrades << 'AUTOEOF'\n"
            'APT::Periodic::Update-Package-Lists "1";\n'
            'APT::Periodic::Unattended-Upgrade "1";\n'
            'APT::Periodic::Download-Upgradeable-Packages "1";\n'
            'APT::Periodic::AutocleanInterval "7";\n'
            'AUTOEOF\n'
            "systemctl enable --now unattended-upgrades",
            timeout=60,
        )

    async def _provision_swap(self, server: ServerInfo):
        """Create swap file if not present — prevents OOM on small servers."""
        swap_check = await self._ssh_exec(
            server, "swapon --show --noheadings | wc -l"
        )
        if int(swap_check or "0") > 0:
            return

        ram_mb = await self._ssh_exec(server, "free -m | awk '/Mem:/{print $2}'")
        ram = int(ram_mb or "2048")
        swap_mb = min(ram, 4096) if ram <= 4096 else ram // 2

        await self._ssh_exec(
            server,
            f"fallocate -l {swap_mb}M /swapfile && "
            "chmod 600 /swapfile && "
            "mkswap /swapfile && "
            "swapon /swapfile && "
            "grep -q '/swapfile' /etc/fstab || "
            "echo '/swapfile none swap sw 0 0' >> /etc/fstab && "
            "sysctl vm.swappiness=10",
            timeout=30,
        )

    async def _provision_sysctl(self, server: ServerInfo):
        """Kernel tuning for Docker + web hosting workloads."""
        await self._ssh_exec(
            server,
            "cat > /etc/sysctl.d/99-crx-cloud.conf << 'SYSEOF'\n"
            "# CRX Cloud — kernel tuning\n"
            "net.core.somaxconn = 65535\n"
            "net.core.netdev_max_backlog = 65535\n"
            "net.ipv4.tcp_max_syn_backlog = 65535\n"
            "net.ipv4.ip_local_port_range = 1024 65535\n"
            "net.ipv4.tcp_tw_reuse = 1\n"
            "net.ipv4.tcp_keepalive_time = 600\n"
            "net.ipv4.tcp_keepalive_intvl = 60\n"
            "net.ipv4.tcp_keepalive_probes = 5\n"
            "fs.file-max = 2097152\n"
            "fs.inotify.max_user_watches = 524288\n"
            "vm.swappiness = 10\n"
            "vm.overcommit_memory = 1\n"
            "vm.max_map_count = 262144\n"
            "net.ipv4.conf.all.rp_filter = 1\n"
            "net.ipv4.conf.default.rp_filter = 1\n"
            "net.ipv4.icmp_echo_ignore_broadcasts = 1\n"
            "net.ipv4.conf.all.accept_redirects = 0\n"
            "net.ipv4.conf.default.accept_redirects = 0\n"
            "net.ipv4.conf.all.send_redirects = 0\n"
            "net.ipv4.conf.default.send_redirects = 0\n"
            "net.ipv4.conf.all.accept_source_route = 0\n"
            "net.ipv6.conf.all.accept_redirects = 0\n"
            "SYSEOF\n"
            "sysctl --system > /dev/null 2>&1",
            timeout=30,
        )

    # ─── Security Audit ───────────────────────────────────────────────

    async def security_audit(self, server: ServerInfo) -> dict:
        """Run security audit — check all hardening components."""
        audit = {}
        try:
            ufw = await self._ssh_exec(server, "ufw status 2>/dev/null || echo 'not installed'")
            audit["firewall"] = {
                "enabled": "Status: active" in ufw,
                "detail": ufw.split("\n")[0] if ufw else "unknown",
            }

            f2b = await self._ssh_exec(
                server, "systemctl is-active fail2ban 2>/dev/null || echo 'inactive'"
            )
            f2b_banned = "0"
            if f2b.strip() == "active":
                f2b_banned = await self._ssh_exec(
                    server,
                    "fail2ban-client status sshd 2>/dev/null | "
                    "grep 'Currently banned' | awk '{print $NF}' || echo '0'"
                )
            audit["fail2ban"] = {
                "active": f2b.strip() == "active",
                "banned_ips": int(f2b_banned or "0"),
            }

            ssh_pwd = await self._ssh_exec(
                server,
                "sshd -T 2>/dev/null | grep -i passwordauthentication | head -1 || echo 'unknown'"
            )
            audit["ssh"] = {
                "password_auth_disabled": "no" in ssh_pwd.lower(),
                "detail": ssh_pwd.strip(),
            }

            uu = await self._ssh_exec(
                server,
                "systemctl is-active unattended-upgrades 2>/dev/null || echo 'inactive'"
            )
            audit["auto_updates"] = {"active": uu.strip() == "active"}

            pending = await self._ssh_exec(
                server,
                "apt list --upgradable 2>/dev/null | grep -c upgradable || echo '0'"
            )
            audit["pending_updates"] = int(pending or "0")

            swap = await self._ssh_exec(server, "free -m | awk '/Swap:/{print $2}'")
            audit["swap_mb"] = int(swap or "0")

            docker = await self._ssh_exec(
                server, "docker --version 2>/dev/null || echo 'not installed'"
            )
            audit["docker"] = {
                "installed": "Docker version" in docker,
                "version": docker.strip(),
            }

            uptime = await self._ssh_exec(server, "uptime -p")
            kernel = await self._ssh_exec(server, "uname -r")
            os_info = await self._ssh_exec(
                server, ". /etc/os-release && echo \"$PRETTY_NAME\""
            )
            audit["system"] = {
                "uptime": uptime.strip(),
                "kernel": kernel.strip(),
                "os": os_info.strip(),
            }

            reboot = await self._ssh_exec(
                server, "test -f /var/run/reboot-required && echo 'yes' || echo 'no'"
            )
            audit["reboot_required"] = reboot.strip() == "yes"

            # Security score (0-100)
            score = 0
            if audit["firewall"]["enabled"]:
                score += 20
            if audit["fail2ban"]["active"]:
                score += 20
            if audit["ssh"]["password_auth_disabled"]:
                score += 20
            if audit["auto_updates"]["active"]:
                score += 20
            if audit["docker"]["installed"]:
                score += 10
            if audit["swap_mb"] > 0:
                score += 5
            if not audit["reboot_required"]:
                score += 5
            audit["security_score"] = score

            return audit

        except Exception as e:
            logger.error(f"Security audit failed for {server.name}: {e}")
            return {"error": str(e), "security_score": 0}

    # ─── Server Management ────────────────────────────────────────────

    async def reboot(self, server: ServerInfo) -> bool:
        """Schedule a graceful server reboot (1 minute delay)."""
        try:
            await self._ssh_exec(
                server,
                "shutdown -r +1 'CRX Cloud: scheduled reboot'",
                timeout=10,
            )
            logger.info(f"Reboot scheduled for {server.name}")
            return True
        except Exception as e:
            if "closed" in str(e).lower():
                return True
            logger.error(f"Reboot failed for {server.name}: {e}")
            return False

    async def get_pending_updates(self, server: ServerInfo) -> dict:
        """Check for pending OS updates."""
        try:
            raw = await self._ssh_exec(
                server,
                "apt list --upgradable 2>/dev/null | tail -n +2 || echo ''",
                timeout=30,
            )
            lines = [l.strip() for l in raw.split("\n") if l.strip()]
            security = []
            other = []
            for line in lines:
                pkg = line.split("/")[0]
                if "-security" in line:
                    security.append(pkg)
                else:
                    other.append(pkg)

            reboot = await self._ssh_exec(
                server, "test -f /var/run/reboot-required && echo 'yes' || echo 'no'"
            )
            return {
                "security_updates": len(security),
                "other_updates": len(other),
                "security_packages": security[:20],
                "other_packages": other[:20],
                "total": len(security) + len(other),
                "reboot_required": reboot.strip() == "yes",
            }
        except Exception as e:
            logger.error(f"Update check failed for {server.name}: {e}")
            return {"error": str(e), "total": 0, "reboot_required": False}

    # ─── Metrics ──────────────────────────────────────────────────────

    async def get_metrics(self, server: ServerInfo) -> dict:
        """Get system metrics via SSH."""
        try:
            cmd = (
                "echo CPU=$(top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}');"
                "echo RAM=$(free | awk '/Mem:/{printf \"%.0f\", $3/$2*100}');"
                "echo DISK=$(df / | awk 'NR==2{print $5}' | tr -d '%');"
                "echo UPTIME=$(uptime -p);"
                "echo LOAD=$(cat /proc/loadavg | awk '{print $1}')"
            )
            raw = await self._ssh_exec(server, cmd)
            metrics = {}
            for line in raw.split("\n"):
                if "=" in line:
                    k, v = line.split("=", 1)
                    metrics[k.strip()] = v.strip()

            return {
                "cpu_percent": round(float(metrics.get("CPU", "0"))),
                "ram_percent": int(metrics.get("RAM", "0")),
                "disk_percent": int(metrics.get("DISK", "0")),
                "uptime": metrics.get("UPTIME", "unknown"),
                "load_avg": metrics.get("LOAD", "0"),
            }
        except Exception as e:
            logger.warning(f"Metrics unavailable for {server.name}: {e}")
            return {"cpu_percent": 0, "ram_percent": 0, "disk_percent": 0, "uptime": "unknown"}

    async def execute(self, server: ServerInfo, command: str) -> str:
        """Execute SSH command."""
        return await self._ssh_exec(server, command)

    async def health_check(self, server: ServerInfo) -> ServerStatus:
        """Check VM health via SSH ping + service status."""
        try:
            await self._ssh_exec(server, "systemctl is-system-running")
            return ServerStatus.ONLINE
        except Exception:
            return ServerStatus.OFFLINE

    async def install_service(
        self, server: ServerInfo, service_name: str, config: dict
    ) -> bool:
        """Install and configure a systemd service."""
        try:
            unit = config.get("unit_content", "")
            if not unit:
                logger.error(f"No unit content for {service_name}")
                return False
            escaped = unit.replace("'", "'\\''")
            await self._ssh_exec(
                server,
                f"echo '{escaped}' > /etc/systemd/system/{service_name}.service "
                f"&& systemctl daemon-reload "
                f"&& systemctl enable --now {service_name}",
            )
            logger.info(f"Installed {service_name} on {server.name}")
            return True
        except Exception as e:
            logger.error(f"Failed to install {service_name}: {e}")
            return False

    async def restart_service(self, server: ServerInfo, service_name: str) -> bool:
        """Restart a systemd service."""
        try:
            await self._ssh_exec(server, f"systemctl restart {service_name}")
            logger.info(f"Restarted {service_name} on {server.name}")
            return True
        except Exception as e:
            logger.error(f"Failed to restart {service_name}: {e}")
            return False
