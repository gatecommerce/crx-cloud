"""DigitalOcean API client.

Docs: https://docs.digitalocean.com/reference/api/api-reference/
Handles: list droplet sizes, regions, images, create/delete droplets.
"""

from __future__ import annotations

import httpx
from loguru import logger


DO_API = "https://api.digitalocean.com/v2"


class DigitalOceanClient:
    """Async DigitalOcean API client."""

    def __init__(self, api_token: str):
        self.token = api_token

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    async def _get(self, path: str, params: dict | None = None) -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(f"{DO_API}{path}", headers=self._headers(), params=params)
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, json: dict) -> dict:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{DO_API}{path}", headers=self._headers(), json=json)
            r.raise_for_status()
            return r.json()

    async def _delete(self, path: str) -> bool:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.delete(f"{DO_API}{path}", headers=self._headers())
            # DO returns 204 No Content on delete
            return r.status_code in (200, 204)

    # --- Sizes (plans) ---

    async def list_sizes(self) -> list[dict]:
        """List available droplet sizes with pricing."""
        data = await self._get("/sizes", params={"per_page": 200})
        result = []
        for s in data.get("sizes", []):
            if not s.get("available", False):
                continue
            # Filter only standard/basic droplets (skip GPU, etc.)
            slug = s.get("slug", "")
            result.append({
                "id": slug,
                "name": slug,
                "description": s.get("description", ""),
                "cores": s.get("vcpus", 0),
                "memory_mb": s.get("memory", 0),
                "memory_gb": round(s.get("memory", 0) / 1024, 1),
                "disk_gb": s.get("disk", 0),
                "transfer_tb": s.get("transfer", 0),
                "price_monthly": s.get("price_monthly", 0),
                "price_hourly": s.get("price_hourly", 0),
                "regions": s.get("regions", []),
                "cpu_type": "dedicated" if "c-" in slug or "m-" in slug or "so-" in slug else "shared",
            })
        # Sort by price
        result.sort(key=lambda x: (x["price_monthly"], x["cores"], x["memory_gb"]))
        return result

    # --- Regions ---

    async def list_regions(self) -> list[dict]:
        """List DigitalOcean datacenter regions."""
        data = await self._get("/regions", params={"per_page": 50})
        return [
            {
                "id": r["slug"],
                "name": r["slug"],
                "city": r.get("name", ""),
                "country": _do_region_country(r["slug"]),
                "available": r.get("available", False),
            }
            for r in data.get("regions", [])
            if r.get("available", False)
        ]

    # --- SSH Keys ---

    async def list_ssh_keys(self) -> list[dict]:
        """List SSH keys registered in DigitalOcean."""
        data = await self._get("/account/keys")
        return [
            {"id": k["id"], "name": k["name"], "fingerprint": k["fingerprint"]}
            for k in data.get("ssh_keys", [])
        ]

    async def create_ssh_key(self, name: str, public_key: str) -> dict:
        """Register an SSH key in DigitalOcean."""
        data = await self._post("/account/keys", {"name": name, "public_key": public_key})
        key = data.get("ssh_key", {})
        return {"id": key["id"], "name": key["name"], "fingerprint": key.get("fingerprint", "")}

    async def ensure_ssh_key(self, public_key: str) -> int:
        """Ensure platform SSH key exists in DigitalOcean, return key ID."""
        keys = await self.list_ssh_keys()
        for k in keys:
            if k["name"] == "crx-cloud-platform":
                return k["id"]
        result = await self.create_ssh_key("crx-cloud-platform", public_key)
        logger.info(f"Registered SSH key in DigitalOcean: {result['fingerprint']}")
        return result["id"]

    # --- Droplets ---

    async def list_droplets(self) -> list[dict]:
        """List all droplets."""
        data = await self._get("/droplets", params={"per_page": 100})
        return [
            {
                "id": d["id"],
                "name": d["name"],
                "status": d["status"],  # new, active, off, archive
                "server_type": d.get("size_slug", ""),
                "ip": _extract_ipv4(d),
                "location": d.get("region", {}).get("slug", ""),
                "created": d.get("created_at", ""),
            }
            for d in data.get("droplets", [])
        ]

    async def create_droplet(
        self,
        name: str,
        size: str,
        region: str,
        ssh_key_ids: list[int],
        image: str = "ubuntu-24-04-x64",
    ) -> dict:
        """Create a new DigitalOcean droplet."""
        payload = {
            "name": name,
            "region": region,
            "size": size,
            "image": image,
            "ssh_keys": ssh_key_ids,
            "backups": False,
            "ipv6": True,
            "monitoring": True,
        }
        data = await self._post("/droplets", payload)
        droplet = data.get("droplet", {})
        return {
            "id": droplet["id"],
            "name": droplet["name"],
            "status": droplet["status"],
            "ip": _extract_ipv4(droplet),
            "server_type": size,
            "location": region,
        }

    async def get_droplet(self, droplet_id: int) -> dict:
        """Get droplet details (useful to poll for IP assignment)."""
        data = await self._get(f"/droplets/{droplet_id}")
        droplet = data.get("droplet", {})
        return {
            "id": droplet["id"],
            "name": droplet["name"],
            "status": droplet["status"],
            "ip": _extract_ipv4(droplet),
        }

    async def delete_droplet(self, droplet_id: int) -> bool:
        """Delete a DigitalOcean droplet."""
        try:
            return await self._delete(f"/droplets/{droplet_id}")
        except Exception as e:
            logger.error(f"Failed to delete DO droplet {droplet_id}: {e}")
            return False


# --- Helpers ---

def _extract_ipv4(droplet: dict) -> str:
    """Extract public IPv4 from droplet networks."""
    for net in droplet.get("networks", {}).get("v4", []):
        if net.get("type") == "public":
            return net.get("ip_address", "")
    return ""


def _do_region_country(slug: str) -> str:
    """Map DO region slug to country."""
    mapping = {
        "nyc": "US", "sfo": "US", "tor": "CA",
        "lon": "GB", "ams": "NL", "fra": "DE",
        "blr": "IN", "sgp": "SG", "syd": "AU",
    }
    prefix = slug[:3]
    return mapping.get(prefix, "")
