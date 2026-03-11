"""Kubernetes controller — manage clusters, deployments, scaling."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile

from loguru import logger

from core.server_manager import ServerDriver, ServerInfo, ServerStatus


class KubernetesDriver(ServerDriver):
    """Driver for Kubernetes clusters (AKS, EKS, GKE, k3s, custom)."""

    def _kubeconfig_env(self, server: ServerInfo) -> dict:
        """Build env dict with KUBECONFIG pointing to the right config."""
        env = os.environ.copy()
        kubeconfig = server.metadata.get("kubeconfig_path", "")
        if kubeconfig:
            env["KUBECONFIG"] = kubeconfig
        return env

    async def _kubectl(self, server: ServerInfo, args: str) -> str:
        """Run kubectl with server's kubeconfig."""
        env = self._kubeconfig_env(server)
        namespace = server.metadata.get("namespace", "default")
        cmd = f"kubectl -n {namespace} {args}"
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            error = stderr.decode().strip()
            logger.error(f"kubectl error on {server.name}: {error}")
            raise RuntimeError(error)
        return stdout.decode().strip()

    async def _helm(self, server: ServerInfo, args: str) -> str:
        """Run helm with server's kubeconfig."""
        env = self._kubeconfig_env(server)
        cmd = f"helm {args}"
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            error = stderr.decode().strip()
            logger.error(f"helm error on {server.name}: {error}")
            raise RuntimeError(error)
        return stdout.decode().strip()

    async def connect(self, server: ServerInfo) -> bool:
        """Connect to K8s cluster via kubeconfig."""
        try:
            # Write inline kubeconfig to temp file if provided
            inline = server.metadata.get("kubeconfig_inline")
            if inline:
                tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".yaml", mode="w")
                tmp.write(inline)
                tmp.close()
                server.metadata["kubeconfig_path"] = tmp.name

            result = await self._kubectl(server, "get nodes -o json")
            nodes = json.loads(result)
            node_count = len(nodes.get("items", []))
            logger.info(f"Connected to {server.name}: {node_count} nodes")
            return node_count > 0
        except Exception as e:
            logger.error(f"Failed to connect to {server.name}: {e}")
            return False

    async def get_metrics(self, server: ServerInfo) -> dict:
        """Get cluster metrics via metrics-server."""
        try:
            nodes_raw = await self._kubectl(server, "top nodes --no-headers")
            pods_raw = await self._kubectl(server, "get pods --all-namespaces --no-headers")

            # Parse node metrics
            total_cpu, total_ram, nodes = 0, 0, 0
            for line in nodes_raw.strip().split("\n"):
                if not line.strip():
                    continue
                parts = line.split()
                if len(parts) >= 5:
                    total_cpu += int(parts[2].rstrip("%"))
                    total_ram += int(parts[4].rstrip("%"))
                    nodes += 1

            pods_running = sum(1 for l in pods_raw.split("\n") if "Running" in l)

            return {
                "cpu_percent": round(total_cpu / max(nodes, 1)),
                "ram_percent": round(total_ram / max(nodes, 1)),
                "pods_running": pods_running,
                "nodes": nodes,
            }
        except Exception as e:
            logger.warning(f"Metrics unavailable for {server.name}: {e}")
            return {"cpu_percent": 0, "ram_percent": 0, "pods_running": 0, "nodes": 0}

    async def execute(self, server: ServerInfo, command: str) -> str:
        """Execute kubectl command."""
        return await self._kubectl(server, command)

    async def health_check(self, server: ServerInfo) -> ServerStatus:
        """Check cluster health."""
        try:
            result = await self._kubectl(server, "get nodes -o json")
            nodes = json.loads(result)
            for node in nodes.get("items", []):
                for cond in node.get("status", {}).get("conditions", []):
                    if cond["type"] == "Ready" and cond["status"] != "True":
                        return ServerStatus.ERROR
            return ServerStatus.ONLINE
        except Exception:
            return ServerStatus.OFFLINE

    async def deploy_helm_chart(
        self,
        server: ServerInfo,
        chart_path: str,
        release_name: str,
        namespace: str = "default",
        values: dict | None = None,
    ) -> bool:
        """Deploy a Helm chart to the cluster."""
        env = self._kubeconfig_env(server)
        values_arg = ""
        if values:
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json", mode="w")
            json.dump(values, tmp)
            tmp.close()
            values_arg = f"--values {tmp.name}"

        kubeconfig = server.metadata.get("kubeconfig_path", "")
        kc_arg = f"--kubeconfig {kubeconfig}" if kubeconfig else ""
        cmd = f"upgrade --install {release_name} {chart_path} -n {namespace} --create-namespace {values_arg} {kc_arg}"

        try:
            await self._helm(server, cmd)
            logger.info(f"Deployed {release_name} to {server.name}/{namespace}")
            return True
        except Exception as e:
            logger.error(f"Helm deploy failed: {e}")
            return False

    async def scale(
        self, server: ServerInfo, deployment: str, replicas: int, namespace: str = "default"
    ) -> bool:
        """Scale a deployment."""
        try:
            await self._kubectl(server, f"-n {namespace} scale deployment/{deployment} --replicas={replicas}")
            logger.info(f"Scaled {deployment} to {replicas} on {server.name}")
            return True
        except Exception:
            return False

    async def get_pods(self, server: ServerInfo, namespace: str = "default") -> list[dict]:
        """List pods in namespace."""
        try:
            raw = await self._kubectl(server, f"-n {namespace} get pods -o json")
            data = json.loads(raw)
            return [
                {
                    "name": p["metadata"]["name"],
                    "status": p["status"]["phase"],
                    "ready": all(
                        c.get("ready", False)
                        for c in p.get("status", {}).get("containerStatuses", [])
                    ),
                    "restarts": sum(
                        c.get("restartCount", 0)
                        for c in p.get("status", {}).get("containerStatuses", [])
                    ),
                }
                for p in data.get("items", [])
            ]
        except Exception:
            return []

    async def get_logs(
        self, server: ServerInfo, pod: str, namespace: str = "default", tail: int = 100
    ) -> str:
        """Get pod logs."""
        try:
            return await self._kubectl(server, f"-n {namespace} logs {pod} --tail={tail}")
        except Exception:
            return ""
