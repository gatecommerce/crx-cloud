"""Override IAP account to always return valid credits/subscription."""

import logging

from odoo import api, models

_logger = logging.getLogger(__name__)


class IapAccount(models.Model):
    _inherit = "iap.account"

    @api.model
    def get_credits(self, service_name):
        """Always return high credit balance for dev environments."""
        _logger.debug("CRX Dev Bypass: get_credits(%s) → 99999", service_name)
        return 99999

    @api.model
    def get_credits_url(self, service_name, base_url="", credit=0, trial=False):
        """Return empty URL — no need to buy credits in dev."""
        return ""
