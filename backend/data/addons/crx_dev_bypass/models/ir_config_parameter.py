"""Override ir.config_parameter to always return valid subscription params.

In UUID PROXY mode (CRX_BYPASS_UUID env var set): returns the licensed UUID
when Odoo requests database.uuid, so ALL code paths (local checks, outbound
IAP calls, Social Marketing subscription verification) use the licensed UUID.
The real UUID stays in the database untouched.
"""

import logging
import os
from datetime import datetime, timedelta

from odoo import api, models

_logger = logging.getLogger(__name__)

_LICENSED_UUID = os.environ.get("CRX_BYPASS_UUID", "")


class IrConfigParameter(models.Model):
    _inherit = "ir.config_parameter"

    @api.model
    def get_param(self, key, default=False):
        """Override critical subscription params for dev bypass."""
        # UUID PROXY mode: return licensed UUID for ALL Odoo code paths
        if key == "database.uuid" and _LICENSED_UUID:
            return _LICENSED_UUID
        if key == "database.expiration_date":
            return (datetime.now() + timedelta(days=36500)).strftime(
                "%Y-%m-%d %H:%M:%S"
            )
        if key == "database.expiration_reason":
            return ""
        if key == "database.enterprise_code":
            return super().get_param(key, default) or "CRXDEV-000000"
        if key == "publisher_warranty.access_token":
            return super().get_param(key, default) or "crx-dev-bypass-token"
        return super().get_param(key, default)
