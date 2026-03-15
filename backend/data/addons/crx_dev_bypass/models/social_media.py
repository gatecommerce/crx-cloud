"""
Override social.media to bypass IAP subscription check for social modules.

In Odoo 19, social_facebook/linkedin/twitter/instagram/youtube call
requests.get("https://social.api.odoo.com/api/social/{platform}/1/add_accounts")
and raise UserError("Oops! You currently don't have an active subscription...")
when the response is 'unauthorized'.

This override intercepts ALL _add_{platform}_accounts_from_iap methods and
makes them raise a clear message about configuring API keys directly instead.
"""

import logging

from odoo import _, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

_SETUP_GUIDE = {
    "facebook": (
        "Per usare Facebook Social senza IAP, configura:\n"
        "- Impostazioni → Tecnico → Parametri di Sistema:\n"
        "  • social.facebook_app_id = [Il tuo Facebook App ID]\n"
        "  • social.facebook_client_secret = [Il tuo Facebook App Secret]\n"
        "Crea un'app su https://developers.facebook.com"
    ),
    "instagram": (
        "Per usare Instagram Social senza IAP, configura:\n"
        "- Impostazioni → Tecnico → Parametri di Sistema:\n"
        "  • social.instagram_app_id = [Il tuo Instagram/Facebook App ID]\n"
        "  • social.instagram_client_secret = [Il tuo App Secret]\n"
        "Usa la stessa Facebook App con permissions Instagram."
    ),
    "linkedin": (
        "Per usare LinkedIn Social senza IAP, configura:\n"
        "- Impostazioni → Tecnico → Parametri di Sistema:\n"
        "  • social.linkedin_client_id = [Il tuo LinkedIn Client ID]\n"
        "  • social.linkedin_client_secret = [Il tuo LinkedIn Client Secret]\n"
        "Crea un'app su https://developer.linkedin.com"
    ),
    "twitter": (
        "Per usare Twitter/X Social senza IAP, configura:\n"
        "- Impostazioni → Tecnico → Parametri di Sistema:\n"
        "  • social.twitter_consumer_key = [La tua API Key]\n"
        "  • social.twitter_consumer_secret = [La tua API Secret]\n"
        "Crea un'app su https://developer.twitter.com"
    ),
    "youtube": (
        "Per usare YouTube Social senza IAP, configura:\n"
        "- Impostazioni → Tecnico → Parametri di Sistema:\n"
        "  • social.youtube_client_id = [Il tuo Google Client ID]\n"
        "  • social.youtube_client_secret = [Il tuo Google Client Secret]\n"
        "Crea credenziali su https://console.cloud.google.com"
    ),
}


class SocialMediaBypass(models.Model):
    _inherit = "social.media"

    def _add_facebook_accounts_from_iap(self):
        _logger.warning("CRX Dev Bypass: Facebook IAP blocked — use direct configuration")
        raise UserError(_SETUP_GUIDE["facebook"])

    def _add_instagram_accounts_from_iap(self):
        _logger.warning("CRX Dev Bypass: Instagram IAP blocked — use direct configuration")
        raise UserError(_SETUP_GUIDE["instagram"])

    def _add_linkedin_accounts_from_iap(self):
        _logger.warning("CRX Dev Bypass: LinkedIn IAP blocked — use direct configuration")
        raise UserError(_SETUP_GUIDE["linkedin"])

    def _add_twitter_accounts_from_iap(self):
        _logger.warning("CRX Dev Bypass: Twitter IAP blocked — use direct configuration")
        raise UserError(_SETUP_GUIDE["twitter"])

    def _add_youtube_accounts_from_iap(self):
        _logger.warning("CRX Dev Bypass: YouTube IAP blocked — use direct configuration")
        raise UserError(_SETUP_GUIDE["youtube"])
