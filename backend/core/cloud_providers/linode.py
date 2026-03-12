"""Linode (Akamai) API v4 client.

Docs: https://techdocs.akamai.com/linode-api/reference/api
Handles: list types, regions, create/delete linodes.
"""

from __future__ import annotations

import httpx
from loguru import logger


LINODE_API = "https://api.linode.com/v4"


class LinodeClient:
    """Async Linode API v4 client."""

    def __init__(self, api_token: str):
        self.token = api_token

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    async def _get(self, path: str, params: dict | None = None) -> dict:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(f"{LINODE_API}{path}", headers=self._headers(), params=params)
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, json: dict) -> dict:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{LINODE_API}{path}", headers=self._headers(), json=json)
            r.raise_for_status()
            return r.json()

    async def _delete(self, path: str) -> bool:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.delete(f"{LINODE_API}{path}", headers=self._headers())
            return r.status_code in (200, 204)

    # --- Types (plans) ---

    async def list_types(self) -> list[dict]:
        """List available Linode types (plans) with pricing."""
        data = await self._get("/linode/types", params={"page_size": 200})
        result = []
        for t in data.get("data", []):
            type_class = t.get("class", "")
            # Include nanode, standard, dedicated, highmem, premium, gpu
            if type_class not in ("nanode", "standard", "dedicated", "highmem", "premium"):
                continue
            price = t.get("price", {})
            result.append({
                "id": t["id"],
                "name": t["id"],
                "label": t.get("label", ""),
                "description": _linode_class_label(type_class),
                "cores": t.get("vcpus", 0),
                "memory_mb": t.get("memory", 0),
                "memory_gb": round(t.get("memory", 0) / 1024, 1),
                "disk_gb": round(t.get("disk", 0) / 1024) if t.get("disk", 0) > 1024 else t.get("disk", 0),
                "transfer_tb": round(t.get("transfer", 0) / 1000, 1) if t.get("transfer", 0) > 0 else 0,
                "price_monthly": price.get("monthly", 0),
                "price_hourly": price.get("hourly", 0),
                "cpu_type": "dedicated" if type_class in ("dedicated", "premium") else "shared",
                "type_class": type_class,
                "gpus": t.get("gpus", 0),
            })
        result.sort(key=lambda x: (x["price_monthly"] or 0, x["cores"], x["memory_gb"]))
        return result

    # --- Regions ---

    async def list_regions(self) -> list[dict]:
        """List Linode datacenter regions."""
        data = await self._get("/regions", params={"page_size": 100})
        return [
            {
                "id": r["id"],
                "name": r["id"],
                "city": r.get("label", ""),
                "country": r.get("country", "").upper(),
                "status": r.get("status", ""),
                "capabilities": r.get("capabilities", []),
            }
            for r in data.get("data", [])
            if r.get("status") == "ok"
        ]

    # --- SSH Keys ---

    async def list_ssh_keys(self) -> list[dict]:
        """List SSH keys registered in Linode."""
        data = await self._get("/profile/sshkeys")
        return [
            {"id": k["id"], "label": k["label"]}
            for k in data.get("data", [])
        ]

    async def create_ssh_key(self, label: str, public_key: str) -> dict:
        """Register an SSH key in Linode."""
        data = await self._post("/profile/sshkeys", {"label": label, "ssh_key": public_key})
        return {"id": data["id"], "label": data["label"]}

    async def ensure_ssh_key(self, public_key: str) -> int:
        """Ensure platform SSH key exists in Linode, return key ID."""
        keys = await self.list_ssh_keys()
        for k in keys:
            if k["label"] == "crx-cloud-platform":
                return k["id"]
        result = await self.create_ssh_key("crx-cloud-platform", public_key)
        logger.info(f"Registered SSH key in Linode: {result['id']}")
        return result["id"]

    # --- Linodes (instances) ---

    async def list_linodes(self) -> list[dict]:
        """List all Linodes."""
        data = await self._get("/linode/instances", params={"page_size": 100})
        return [
            {
                "id": l["id"],
                "name": l.get("label", ""),
                "status": l.get("status", ""),  # running, offline, booting, rebooting, shutting_down, provisioning
                "server_type": l.get("type", ""),
                "ip": _extract_ipv4(l),
                "location": l.get("region", ""),
                "created": l.get("created", ""),
            }
            for l in data.get("data", [])
        ]

    async def create_linode(
        self,
        label: str,
        linode_type: str,
        region: str,
        authorized_keys: list[str] | None = None,
        root_pass: str | None = None,
        image: str = "linode/ubuntu24.04",
    ) -> dict:
        """Create a new Linode instance.

        Note: Linode requires either root_pass or authorized_keys.
        We pass authorized_keys (the actual public key string, not IDs).
        """
        payload = {
            "label": label,
            "type": linode_type,
            "region": region,
            "image": image,
            "booted": True,
        }
        if authorized_keys:
            payload["authorized_keys"] = authorized_keys
        if root_pass:
            payload["root_pass"] = root_pass

        data = await self._post("/linode/instances", payload)
        return {
            "id": data["id"],
            "name": data.get("label", label),
            "status": data.get("status", "provisioning"),
            "ip": _extract_ipv4(data),
            "server_type": linode_type,
            "location": region,
        }

    async def get_linode(self, linode_id: int) -> dict:
        """Get Linode details (useful to poll for IP/status)."""
        data = await self._get(f"/linode/instances/{linode_id}")
        return {
            "id": data["id"],
            "name": data.get("label", ""),
            "status": data.get("status", ""),
            "ip": _extract_ipv4(data),
        }

    async def delete_linode(self, linode_id: int) -> bool:
        """Delete a Linode instance."""
        try:
            return await self._delete(f"/linode/instances/{linode_id}")
        except Exception as e:
            logger.error(f"Failed to delete Linode {linode_id}: {e}")
            return False


# --- Helpers ---

def _extract_ipv4(linode: dict) -> str:
    """Extract primary IPv4 from Linode."""
    ipv4 = linode.get("ipv4", [])
    return ipv4[0] if ipv4 else ""


def _linode_class_label(cls: str) -> str:
    """Map Linode type class to label."""
    labels = {
        "nanode": "Nanode",
        "standard": "Shared CPU",
        "dedicated": "Dedicated CPU",
        "highmem": "High Memory",
        "premium": "Premium",
    }
    return labels.get(cls, cls.title())
