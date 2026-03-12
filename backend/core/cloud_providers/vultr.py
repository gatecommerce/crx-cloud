"""Vultr API v2 client.

Docs: https://www.vultr.com/api/
Handles: list plans, regions, create/delete instances.
"""

from __future__ import annotations

import httpx
from loguru import logger


VULTR_API = "https://api.vultr.com/v2"


class VultrClient:
    """Async Vultr API v2 client."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def _get(self, path: str, params: dict | None = None) -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(f"{VULTR_API}{path}", headers=self._headers(), params=params)
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, json: dict) -> dict:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{VULTR_API}{path}", headers=self._headers(), json=json)
            r.raise_for_status()
            return r.json()

    async def _delete(self, path: str) -> bool:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.delete(f"{VULTR_API}{path}", headers=self._headers())
            return r.status_code in (200, 204)

    # --- Plans ---

    async def list_plans(self) -> list[dict]:
        """List available VPS plans with pricing."""
        data = await self._get("/plans", params={"per_page": 200, "type": "all"})
        result = []
        for p in data.get("plans", []):
            plan_type = p.get("type", "")
            # Include vc2 (cloud compute), vhf (high frequency), vhp (high perf), vdc (dedicated)
            if plan_type not in ("vc2", "vhf", "vhp", "vdc2"):
                continue
            result.append({
                "id": p["id"],
                "name": p["id"],
                "description": _vultr_plan_label(p),
                "cores": p.get("vcpu_count", 0),
                "memory_mb": p.get("ram", 0),
                "memory_gb": round(p.get("ram", 0) / 1024, 1),
                "disk_gb": p.get("disk", 0),
                "disk_type": "NVMe" if p.get("disk_type") == "nvme" else "SSD",
                "transfer_tb": round(p.get("bandwidth", 0) / 1024, 1) if p.get("bandwidth", 0) > 0 else 0,
                "price_monthly": p.get("monthly_cost", 0),
                "price_hourly": p.get("hourly_cost", 0),
                "regions": p.get("locations", []),
                "cpu_type": "dedicated" if plan_type in ("vdc2", "vhp") else "shared",
                "plan_type": plan_type,
            })
        result.sort(key=lambda x: (x["price_monthly"], x["cores"], x["memory_gb"]))
        return result

    # --- Regions ---

    async def list_regions(self) -> list[dict]:
        """List Vultr datacenter regions."""
        data = await self._get("/regions")
        return [
            {
                "id": r["id"],
                "name": r["id"],
                "city": r.get("city", ""),
                "country": r.get("country", ""),
                "continent": r.get("continent", ""),
            }
            for r in data.get("regions", [])
        ]

    # --- SSH Keys ---

    async def list_ssh_keys(self) -> list[dict]:
        """List SSH keys registered in Vultr."""
        data = await self._get("/ssh-keys")
        return [
            {"id": k["id"], "name": k["name"], "fingerprint": k.get("ssh_key", "")[:40]}
            for k in data.get("ssh_keys", [])
        ]

    async def create_ssh_key(self, name: str, public_key: str) -> dict:
        """Register an SSH key in Vultr."""
        data = await self._post("/ssh-keys", {"name": name, "ssh_key": public_key})
        key = data.get("ssh_key", {})
        return {"id": key["id"], "name": key["name"]}

    async def ensure_ssh_key(self, public_key: str) -> str:
        """Ensure platform SSH key exists in Vultr, return key ID."""
        keys = await self.list_ssh_keys()
        for k in keys:
            if k["name"] == "crx-cloud-platform":
                return k["id"]
        result = await self.create_ssh_key("crx-cloud-platform", public_key)
        logger.info(f"Registered SSH key in Vultr: {result['id']}")
        return result["id"]

    # --- Instances ---

    async def list_instances(self) -> list[dict]:
        """List all Vultr instances."""
        data = await self._get("/instances", params={"per_page": 100})
        return [
            {
                "id": i["id"],
                "name": i.get("label", ""),
                "status": i.get("status", ""),  # pending, active, suspended, resizing
                "server_type": i.get("plan", ""),
                "ip": i.get("main_ip", ""),
                "location": i.get("region", ""),
                "created": i.get("date_created", ""),
            }
            for i in data.get("instances", [])
        ]

    async def create_instance(
        self,
        name: str,
        plan: str,
        region: str,
        ssh_key_ids: list[str],
        os_id: int = 2284,  # Ubuntu 24.04 LTS x64
    ) -> dict:
        """Create a new Vultr instance."""
        payload = {
            "label": name,
            "plan": plan,
            "region": region,
            "os_id": os_id,
            "sshkey_id": ssh_key_ids,
            "backups": "disabled",
            "enable_ipv6": True,
        }
        data = await self._post("/instances", payload)
        instance = data.get("instance", {})
        return {
            "id": instance["id"],
            "name": instance.get("label", name),
            "status": instance.get("status", "pending"),
            "ip": instance.get("main_ip", ""),
            "server_type": plan,
            "location": region,
            "default_password": instance.get("default_password", ""),
        }

    async def get_instance(self, instance_id: str) -> dict:
        """Get instance details (useful to poll for IP/status)."""
        data = await self._get(f"/instances/{instance_id}")
        instance = data.get("instance", {})
        return {
            "id": instance["id"],
            "name": instance.get("label", ""),
            "status": instance.get("status", ""),
            "ip": instance.get("main_ip", ""),
            "power_status": instance.get("power_status", ""),
        }

    async def delete_instance(self, instance_id: str) -> bool:
        """Delete a Vultr instance."""
        try:
            return await self._delete(f"/instances/{instance_id}")
        except Exception as e:
            logger.error(f"Failed to delete Vultr instance {instance_id}: {e}")
            return False


# --- Helpers ---

def _vultr_plan_label(p: dict) -> str:
    """Generate human-readable plan description."""
    plan_type = p.get("type", "")
    labels = {
        "vc2": "Cloud Compute",
        "vhf": "High Frequency",
        "vhp": "High Performance",
        "vdc2": "Dedicated Cloud",
    }
    return labels.get(plan_type, plan_type.upper())
