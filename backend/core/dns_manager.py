"""Cloudflare DNS manager for wildcard subdomain provisioning under *.site.crx.team."""

import re
import unicodedata

import httpx
from loguru import logger

from core.config import settings

SITE_DOMAIN = "site.crx.team"
CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"


class CloudflareNotConfiguredError(Exception):
    """Raised when Cloudflare credentials are missing."""


class DNSError(Exception):
    """Generic DNS operation error."""


def _ensure_configured() -> None:
    """Raise if Cloudflare token or zone ID are not set."""
    if not settings.cloudflare_api_token or not settings.cloudflare_zone_id:
        raise CloudflareNotConfiguredError(
            "Cloudflare API token or zone ID not configured. "
            "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID in .env"
        )


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.cloudflare_api_token}",
        "Content-Type": "application/json",
    }


def _zone_url(path: str = "") -> str:
    return f"{CLOUDFLARE_API}/zones/{settings.cloudflare_zone_id}/dns_records{path}"


def _fqdn(subdomain: str) -> str:
    """Build the fully qualified domain name."""
    return f"{subdomain}.{SITE_DOMAIN}"


def generate_subdomain(name: str) -> str:
    """Generate a clean subdomain from an instance name.

    Rules:
    - Unicode normalized and stripped to ASCII
    - Lowercased
    - Non-alphanumeric characters replaced with hyphens
    - Consecutive hyphens collapsed
    - Leading/trailing hyphens removed
    - Max 63 characters (DNS label limit)
    """
    # Normalize unicode -> ASCII approximation
    normalized = unicodedata.normalize("NFKD", name)
    ascii_name = normalized.encode("ascii", "ignore").decode("ascii")

    # Lowercase, replace non-alphanum with hyphen
    cleaned = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower())

    # Collapse consecutive hyphens and strip edges
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")

    # DNS label limit
    cleaned = cleaned[:63].rstrip("-")

    if not cleaned:
        raise ValueError(f"Cannot generate a valid subdomain from name: {name!r}")

    return cleaned


async def check_subdomain_available(subdomain: str) -> bool:
    """Check if a subdomain is already in use.

    Returns True if the subdomain is available (no existing record),
    False if it is already taken.
    Falls back to True (available) if Cloudflare is not configured.
    """
    try:
        _ensure_configured()
    except CloudflareNotConfiguredError:
        logger.warning("Cloudflare not configured — assuming subdomain is available")
        return True

    fqdn = _fqdn(subdomain)
    logger.debug("Checking DNS availability for {}", fqdn)

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                _zone_url(),
                headers=_headers(),
                params={"name": fqdn, "type": "A"},
            )
            resp.raise_for_status()
            data = resp.json()

            if not data.get("success", False):
                errors = data.get("errors", [])
                raise DNSError(f"Cloudflare API error: {errors}")

            records = data.get("result", [])
            available = len(records) == 0

            if available:
                logger.info("Subdomain {} is available", fqdn)
            else:
                logger.info("Subdomain {} is already in use ({} record(s))", fqdn, len(records))

            return available

    except httpx.HTTPStatusError as exc:
        logger.error("Cloudflare API HTTP error checking {}: {}", fqdn, exc)
        raise DNSError(f"Failed to check subdomain {fqdn}: {exc}") from exc
    except httpx.RequestError as exc:
        logger.error("Network error checking {}: {}", fqdn, exc)
        raise DNSError(f"Network error checking subdomain {fqdn}: {exc}") from exc


async def create_subdomain(subdomain: str, ip: str) -> dict:
    """Create an A record for {subdomain}.site.crx.team pointing to the given IP.

    Returns the created DNS record dict from Cloudflare.
    Falls back gracefully (returns empty dict + warning) if Cloudflare is not configured.
    """
    try:
        _ensure_configured()
    except CloudflareNotConfiguredError:
        logger.warning(
            "Cloudflare not configured — skipping DNS record creation for {}.{}",
            subdomain, SITE_DOMAIN,
        )
        return {}

    fqdn = _fqdn(subdomain)
    logger.info("Creating DNS A record: {} -> {}", fqdn, ip)

    payload = {
        "type": "A",
        "name": fqdn,
        "content": ip,
        "ttl": 1,  # Auto TTL
        "proxied": False,
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                _zone_url(),
                headers=_headers(),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

            if not data.get("success", False):
                errors = data.get("errors", [])
                raise DNSError(f"Cloudflare API error creating {fqdn}: {errors}")

            record = data.get("result", {})
            logger.info(
                "DNS record created: {} -> {} (id={})",
                fqdn, ip, record.get("id", "unknown"),
            )
            return record

    except httpx.HTTPStatusError as exc:
        logger.error("Cloudflare API HTTP error creating {}: {}", fqdn, exc)
        raise DNSError(f"Failed to create DNS record for {fqdn}: {exc}") from exc
    except httpx.RequestError as exc:
        logger.error("Network error creating {}: {}", fqdn, exc)
        raise DNSError(f"Network error creating DNS record for {fqdn}: {exc}") from exc


async def remove_subdomain(subdomain: str) -> bool:
    """Remove the DNS A record for {subdomain}.site.crx.team.

    Returns True if a record was deleted, False if no record was found.
    Falls back gracefully (returns False + warning) if Cloudflare is not configured.
    """
    try:
        _ensure_configured()
    except CloudflareNotConfiguredError:
        logger.warning(
            "Cloudflare not configured — skipping DNS record removal for {}.{}",
            subdomain, SITE_DOMAIN,
        )
        return False

    fqdn = _fqdn(subdomain)
    logger.info("Removing DNS record for {}", fqdn)

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            # First, find the record ID
            list_resp = await client.get(
                _zone_url(),
                headers=_headers(),
                params={"name": fqdn, "type": "A"},
            )
            list_resp.raise_for_status()
            list_data = list_resp.json()

            if not list_data.get("success", False):
                errors = list_data.get("errors", [])
                raise DNSError(f"Cloudflare API error listing {fqdn}: {errors}")

            records = list_data.get("result", [])
            if not records:
                logger.warning("No DNS record found for {} — nothing to remove", fqdn)
                return False

            # Delete all matching records (normally just one)
            for record in records:
                record_id = record["id"]
                del_resp = await client.delete(
                    _zone_url(f"/{record_id}"),
                    headers=_headers(),
                )
                del_resp.raise_for_status()
                del_data = del_resp.json()

                if not del_data.get("success", False):
                    errors = del_data.get("errors", [])
                    raise DNSError(
                        f"Cloudflare API error deleting record {record_id} for {fqdn}: {errors}"
                    )

                logger.info("DNS record deleted: {} (id={})", fqdn, record_id)

            return True

    except httpx.HTTPStatusError as exc:
        logger.error("Cloudflare API HTTP error removing {}: {}", fqdn, exc)
        raise DNSError(f"Failed to remove DNS record for {fqdn}: {exc}") from exc
    except httpx.RequestError as exc:
        logger.error("Network error removing {}: {}", fqdn, exc)
        raise DNSError(f"Network error removing DNS record for {fqdn}: {exc}") from exc
