"""CMS server requirements — maps CMS types to recommended specs.

Used to show "Recommended for Odoo 18", "Minimum for WooCommerce", etc.
on server plan selection in the wizard.
"""

from __future__ import annotations


# Requirements per CMS (memory in MB, disk in GB)
CMS_REQUIREMENTS: dict[str, dict] = {
    "odoo-18": {
        "label": "Odoo 18",
        "min_ram_mb": 2048,
        "rec_ram_mb": 4096,
        "min_cores": 1,
        "rec_cores": 2,
        "min_disk_gb": 30,
        "rec_disk_gb": 60,
        "notes": "Odoo 18 + PostgreSQL 16",
    },
    "odoo-17": {
        "label": "Odoo 17",
        "min_ram_mb": 2048,
        "rec_ram_mb": 4096,
        "min_cores": 1,
        "rec_cores": 2,
        "min_disk_gb": 30,
        "rec_disk_gb": 60,
        "notes": "Odoo 17 + PostgreSQL 16",
    },
    "odoo-16": {
        "label": "Odoo 16",
        "min_ram_mb": 2048,
        "rec_ram_mb": 4096,
        "min_cores": 1,
        "rec_cores": 2,
        "min_disk_gb": 25,
        "rec_disk_gb": 50,
        "notes": "Odoo 16 + PostgreSQL 15",
    },
    "odoo-15": {
        "label": "Odoo 15",
        "min_ram_mb": 1024,
        "rec_ram_mb": 2048,
        "min_cores": 1,
        "rec_cores": 2,
        "min_disk_gb": 25,
        "rec_disk_gb": 40,
        "notes": "Odoo 15 + PostgreSQL 14",
    },
    "odoo-14": {
        "label": "Odoo 14",
        "min_ram_mb": 1024,
        "rec_ram_mb": 2048,
        "min_cores": 1,
        "rec_cores": 2,
        "min_disk_gb": 20,
        "rec_disk_gb": 40,
        "notes": "Odoo 14 + PostgreSQL 13",
    },
    "wordpress": {
        "label": "WordPress",
        "min_ram_mb": 512,
        "rec_ram_mb": 2048,
        "min_cores": 1,
        "rec_cores": 1,
        "min_disk_gb": 10,
        "rec_disk_gb": 25,
        "notes": "WordPress + MySQL + PHP-FPM",
    },
    "woocommerce": {
        "label": "WooCommerce",
        "min_ram_mb": 1024,
        "rec_ram_mb": 4096,
        "min_cores": 1,
        "rec_cores": 2,
        "min_disk_gb": 20,
        "rec_disk_gb": 40,
        "notes": "WordPress + WooCommerce + MySQL + Redis",
    },
    "prestashop": {
        "label": "PrestaShop",
        "min_ram_mb": 1024,
        "rec_ram_mb": 2048,
        "min_cores": 1,
        "rec_cores": 2,
        "min_disk_gb": 15,
        "rec_disk_gb": 30,
        "notes": "PrestaShop 8 + MySQL + PHP-FPM",
    },
    "magento": {
        "label": "Magento 2",
        "min_ram_mb": 4096,
        "rec_ram_mb": 8192,
        "min_cores": 2,
        "rec_cores": 4,
        "min_disk_gb": 50,
        "rec_disk_gb": 100,
        "notes": "Magento 2 + MySQL + Redis + Elasticsearch/OpenSearch + Varnish",
    },
}


def get_plan_recommendations(memory_mb: int, cores: int, disk_gb: int) -> list[dict]:
    """Given a plan's specs, return which CMS it supports and at what level.

    Returns list of {"cms": str, "label": str, "level": "recommended"|"minimum"|"insufficient"}.
    """
    results = []
    for cms_id, req in CMS_REQUIREMENTS.items():
        if memory_mb >= req["rec_ram_mb"] and cores >= req["rec_cores"] and disk_gb >= req["rec_disk_gb"]:
            level = "recommended"
        elif memory_mb >= req["min_ram_mb"] and cores >= req["min_cores"] and disk_gb >= req["min_disk_gb"]:
            level = "minimum"
        else:
            level = "insufficient"
        results.append({
            "cms": cms_id,
            "label": req["label"],
            "level": level,
        })
    return results


def get_cms_list() -> list[dict]:
    """Return all supported CMS with their requirements."""
    return [
        {"id": k, **v}
        for k, v in CMS_REQUIREMENTS.items()
    ]
