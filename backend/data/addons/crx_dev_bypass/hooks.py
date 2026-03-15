"""
Post-init hook: runs ONCE during module installation.
Sets ir.config_parameter values for subscription bypass.

NOTE: Monkey patches are in models/patches.py (import-time, survive restarts).
"""

import logging

_logger = logging.getLogger(__name__)


def _post_init_hook(env):
    """Called after module installation — set bypass config params."""
    ICP = env["ir.config_parameter"].sudo()
    ICP.set_param("database.expiration_date", "2099-12-31 23:59:59")
    ICP.set_param("database.expiration_reason", "")
    ICP.set_param("database.enterprise_code", "CRXDEV-000000")
    ICP.set_param("publisher_warranty.access_token", "crx-dev-bypass-token")

    # Enable "Use Your Own Developer Account" for all social platforms.
    # This bypasses the IAP proxy (social.api.odoo.com) and lets users
    # configure direct OAuth with their own API keys in Settings.
    for provider in ("facebook", "linkedin", "twitter", "youtube"):
        ICP.set_param(f"social.{provider}_use_own_account", "True")
    _logger.info("CRX Dev Bypass: social 'Use Your Own Account' enabled for all providers")

    env.cr.commit()
    _logger.info("CRX Dev Bypass: ir.config_parameter values set")


def _uninstall_hook(env):
    """Clear bypass params on uninstall."""
    ICP = env["ir.config_parameter"].sudo()
    ICP.set_param("database.expiration_date", "")
    ICP.set_param("database.expiration_reason", "")
    ICP.set_param("database.enterprise_code", "")
    env.cr.commit()
    _logger.info("CRX Dev Bypass: ir.config_parameter values cleared")
