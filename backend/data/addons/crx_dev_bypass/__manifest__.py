{
    "name": "CRX Dev Bypass",
    "version": "2.0.0",
    "category": "Technical",
    "summary": "Development-only: bypass enterprise subscription checks for local/staging use",
    "description": """
        Patches publisher_warranty, IAP subscription verification, and
        enterprise subscription checks so that enterprise features work
        in development/staging environments without an active Odoo.com subscription.

        WARNING: For development and testing purposes only.
        Do NOT use in production environments.
    """,
    "author": "CRX Cloud",
    "license": "LGPL-3",
    "depends": ["base", "mail", "iap"],
    "data": [],
    "post_init_hook": "_post_init_hook",
    "uninstall_hook": "_uninstall_hook",
    "installable": True,
    "auto_install": False,
    "application": False,
}
