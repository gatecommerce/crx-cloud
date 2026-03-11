"""CMS Plugin management endpoints."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/")
async def list_available_plugins():
    """List available CMS plugins (odoo, wordpress, prestashop, etc.)."""
    return [
        {
            "id": "odoo",
            "name": "Odoo",
            "versions": ["18.0", "17.0", "16.0"],
            "status": "available",
            "description": "All-in-one business suite (ERP, CRM, eCommerce)",
        },
        {
            "id": "wordpress",
            "name": "WordPress",
            "versions": ["6.8", "6.7", "6.6"],
            "status": "coming_soon",
            "description": "World's most popular CMS",
        },
        {
            "id": "prestashop",
            "name": "PrestaShop",
            "versions": ["9.0", "8.2"],
            "status": "coming_soon",
            "description": "Open-source eCommerce platform",
        },
        {
            "id": "woocommerce",
            "name": "WooCommerce",
            "versions": ["9.5", "9.4"],
            "status": "coming_soon",
            "description": "WordPress eCommerce plugin",
        },
    ]


@router.get("/{plugin_id}")
async def get_plugin_details(plugin_id: str):
    """Get detailed info about a CMS plugin."""
    # TODO: load from plugin manifest
    return {"id": plugin_id, "status": "available"}
