"""Override ir.http to bypass enterprise subscription checks in web controllers."""

import logging

from odoo import models

_logger = logging.getLogger(__name__)


class IrHttp(models.AbstractModel):
    _inherit = "ir.http"

    @classmethod
    def _check_enterprise_subscription(cls):
        """Skip enterprise subscription validation — dev bypass."""
        return True
