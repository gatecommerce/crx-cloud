"""Hetzner Cloud API client.

Docs: https://docs.hetzner.cloud/
Handles: list server types, locations, images, create/delete servers.
"""

from __future__ import annotations

import httpx
from loguru import logger


HETZNER_API = "https://api.hetzner.cloud/v1"


class HetznerClient:
    """Async Hetzner Cloud API client."""

    def __init__(self, api_token: str):
        self.token = api_token

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    async def _get(self, path: str, params: dict | None = None) -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(f"{HETZNER_API}{path}", headers=self._headers(), params=params)
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, json: dict) -> dict:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{HETZNER_API}{path}", headers=self._headers(), json=json)
            r.raise_for_status()
            return r.json()

    async def _delete(self, path: str) -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.delete(f"{HETZNER_API}{path}", headers=self._headers())
            r.raise_for_status()
            return r.json()

    # --- Server Types (plans) ---

    async def list_server_types(self) -> list[dict]:
        """List available server plans with pricing (enriched)."""
        data = await self._get("/server_types", params={"per_page": 50})
        result = []
        for st in data.get("server_types", []):
            # Filter: only x86 (skip ARM for simplicity)
            if st.get("architecture") != "x86":
                continue
            prices = st.get("prices", [])
            monthly_eur = ""
            hourly_eur = ""
            for p in prices:
                if p.get("location") == "fsn1":
                    monthly_eur = p.get("price_monthly", {}).get("gross", "")
                    hourly_eur = p.get("price_hourly", {}).get("gross", "")
                    break
            if not monthly_eur and prices:
                monthly_eur = prices[0].get("price_monthly", {}).get("gross", "")
                hourly_eur = prices[0].get("price_hourly", {}).get("gross", "")

            # Determine storage type from name
            name = st["name"]
            disk_type = "NVMe" if name.startswith(("cx", "cpx", "ccx", "cax")) else "SSD"

            # Traffic included (Hetzner includes 20TB for most plans)
            included_traffic_tb = round(st.get("included_traffic", 0) / (1024 ** 4), 0) if st.get("included_traffic") else 20

            # Plan category
            cpu_type = st.get("cpu_type", "shared")
            if name.startswith("ccx"):
                plan_category = "Dedicated vCPU"
            elif name.startswith("cpx"):
                plan_category = "Shared vCPU (AMD)"
            elif name.startswith("cx"):
                plan_category = "Shared vCPU (Intel)"
            elif name.startswith("cax"):
                plan_category = "Arm64 (Ampere)"
            else:
                plan_category = cpu_type.title()

            result.append({
                "id": st["id"],
                "name": name,
                "description": st.get("description", ""),
                "cores": st["cores"],
                "memory_mb": int(st["memory"] * 1024),
                "memory_gb": st["memory"],
                "disk_gb": st["disk"],
                "disk_type": disk_type,
                "transfer_tb": included_traffic_tb,
                "price_monthly": float(monthly_eur) if monthly_eur else 0,
                "price_hourly": float(hourly_eur) if hourly_eur else 0,
                "cpu_type": cpu_type,
                "plan_category": plan_category,
            })
        # Sort by price then cores
        result.sort(key=lambda x: (x["price_monthly"], x["cores"], x["memory_gb"]))
        return result

    # --- Locations ---

    async def list_locations(self) -> list[dict]:
        """List Hetzner datacenter locations."""
        data = await self._get("/locations")
        return [
            {
                "id": loc["id"],
                "name": loc["name"],
                "city": loc["city"],
                "country": loc["country"],
                "description": loc.get("description", ""),
            }
            for loc in data.get("locations", [])
        ]

    # --- SSH Keys ---

    async def list_ssh_keys(self) -> list[dict]:
        """List SSH keys registered in Hetzner."""
        data = await self._get("/ssh_keys")
        return [
            {"id": k["id"], "name": k["name"], "fingerprint": k["fingerprint"]}
            for k in data.get("ssh_keys", [])
        ]

    async def create_ssh_key(self, name: str, public_key: str) -> dict:
        """Register an SSH key in Hetzner Cloud."""
        data = await self._post("/ssh_keys", {"name": name, "public_key": public_key})
        key = data.get("ssh_key", {})
        return {"id": key["id"], "name": key["name"], "fingerprint": key.get("fingerprint", "")}

    async def ensure_ssh_key(self, public_key: str) -> int:
        """Ensure platform SSH key exists in Hetzner, return key ID."""
        keys = await self.list_ssh_keys()
        # Check if our key already exists (by fingerprint or name)
        for k in keys:
            if k["name"] == "crx-cloud-platform":
                return k["id"]

        # Create it
        result = await self.create_ssh_key("crx-cloud-platform", public_key)
        logger.info(f"Registered SSH key in Hetzner: {result['fingerprint']}")
        return result["id"]

    # --- Servers ---

    async def list_servers(self) -> list[dict]:
        """List all Hetzner servers."""
        data = await self._get("/servers", params={"per_page": 50})
        return [
            {
                "id": s["id"],
                "name": s["name"],
                "status": s["status"],
                "server_type": s["server_type"]["name"],
                "ip": (s.get("public_net", {}).get("ipv4", {}) or {}).get("ip", ""),
                "location": s.get("datacenter", {}).get("location", {}).get("name", ""),
                "created": s.get("created", ""),
            }
            for s in data.get("servers", [])
        ]

    async def create_server(
        self,
        name: str,
        server_type: str,
        location: str,
        ssh_key_ids: list[int],
        image: str = "ubuntu-24.04",
    ) -> dict:
        """Create a new Hetzner Cloud server.

        Returns server info including IP (may need a few seconds to assign).
        """
        payload = {
            "name": name,
            "server_type": server_type,
            "location": location,
            "image": image,
            "ssh_keys": ssh_key_ids,
            "start_after_create": True,
        }
        data = await self._post("/servers", payload)
        server = data.get("server", {})
        ip = (server.get("public_net", {}).get("ipv4", {}) or {}).get("ip", "")
        return {
            "id": server["id"],
            "name": server["name"],
            "status": server["status"],
            "ip": ip,
            "server_type": server_type,
            "location": location,
            "root_password": data.get("root_password", ""),
        }

    async def get_server(self, server_id: int) -> dict:
        """Get server details (useful to poll for IP assignment)."""
        data = await self._get(f"/servers/{server_id}")
        server = data.get("server", {})
        ip = (server.get("public_net", {}).get("ipv4", {}) or {}).get("ip", "")
        return {
            "id": server["id"],
            "name": server["name"],
            "status": server["status"],
            "ip": ip,
        }

    async def resize_server(self, server_id: int, server_type: str, upgrade_disk: bool = True) -> dict:
        """Resize a Hetzner server to a new plan. Server must be powered off first."""
        data = await self._post(f"/servers/{server_id}/actions/change_type", {
            "server_type": server_type,
            "upgrade_disk": upgrade_disk,
        })
        return data.get("action", {})

    async def power_off_server(self, server_id: int) -> dict:
        """Power off a server (required before resize)."""
        data = await self._post(f"/servers/{server_id}/actions/poweroff", {})
        return data.get("action", {})

    async def power_on_server(self, server_id: int) -> dict:
        """Power on a server after resize."""
        data = await self._post(f"/servers/{server_id}/actions/poweron", {})
        return data.get("action", {})

    async def delete_server(self, server_id: int) -> bool:
        """Delete a Hetzner server."""
        try:
            await self._delete(f"/servers/{server_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete Hetzner server {server_id}: {e}")
            return False
