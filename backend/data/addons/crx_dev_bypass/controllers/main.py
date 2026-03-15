"""Override web_enterprise subscription check endpoints."""

import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class BypassSubscriptionController(http.Controller):
    """Intercept frontend subscription check RPC calls."""

    @http.route(
        "/web_enterprise/check_enterprise",
        type="json",
        auth="user",
        methods=["POST"],
    )
    def check_enterprise(self, **kw):
        """Frontend calls this to verify subscription — always valid."""
        _logger.debug("CRX Dev Bypass: /web_enterprise/check_enterprise → valid")
        return {
            "status": "valid",
            "expiration_date": "2099-12-31",
            "enterprise_code": "CRXDEV-000000",
        }

    @http.route(
        "/odoo-enterprise/check",
        type="json",
        auth="user",
        methods=["POST"],
    )
    def check_enterprise_alt(self, **kw):
        """Alternative subscription check endpoint."""
        return {
            "status": "valid",
            "expiration_date": "2099-12-31",
        }

    @http.route(
        "/publisher_warranty/check",
        type="json",
        auth="user",
        methods=["POST"],
    )
    def check_publisher_warranty(self, **kw):
        """Publisher warranty check — always valid."""
        return {
            "status": "valid",
            "result": True,
        }
