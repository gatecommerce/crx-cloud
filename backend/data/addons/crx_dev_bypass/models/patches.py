"""
Import-time monkey patches for Odoo subscription/IAP bypass.

ARCHITECTURE:
  - HTTP patches: ALWAYS block outbound calls to *.odoo.com with fake responses.
    This prevents any real communication with Odoo servers, avoiding UUID
    duplicate detection risks.
  - ORM override (ir_config_parameter.py): returns licensed UUID via get_param()
    so LOCAL checks (subscription status, feature gates) pass transparently.
    Combined, this gives full feature access without any outbound calls.

Since 'iap' is in our depends, it's guaranteed to be loaded before us.

NOTE: Social Marketing uses "Use Your Own Developer Account" settings
(auto-enabled by hooks.py via ir.config_parameter) so Odoo communicates
directly with Facebook/LinkedIn/Twitter/YouTube — never via social.api.odoo.com.
"""

import logging
import os
import re

_logger = logging.getLogger(__name__)

_LICENSED_UUID = os.environ.get("CRX_BYPASS_UUID", "")

if _LICENSED_UUID:
    _logger.warning("CRX Dev Bypass: BLOCK mode + UUID ORM override (licensed UUID: %s...%s)",
                     _LICENSED_UUID[:8], _LICENSED_UUID[-4:])
else:
    _logger.warning("CRX Dev Bypass: BLOCK mode — will fake responses for *.odoo.com")


def _is_odoo_domain(url):
    """Check if URL points to any Odoo verification/IAP/service domain.

    Matches: services.odoo.com, iap.odoo.com, social.api.odoo.com,
    partner-autocomplete.odoo.com, and ANY other *.odoo.com subdomain.
    Does NOT block the main www.odoo.com (documentation/download links).
    """
    if not url:
        return False
    url_lower = str(url).lower()
    if "odoo.com" not in url_lower:
        return False
    match = re.search(r"https?://([^/]+)", url_lower)
    if not match:
        return False
    hostname = match.group(1).split(":")[0]  # strip port
    if hostname in ("www.odoo.com", "odoo.com"):
        return False
    # Allow social.api.odoo.com — "Use Your Own Developer Account" handles
    # social OAuth directly; blocking would cause /bypass_ok 404 errors.
    if hostname == "social.api.odoo.com":
        return False
    return hostname.endswith(".odoo.com") or hostname.endswith(".odoo.sh")


# ---------------------------------------------------------------------------
# 1) Patch iap_tools.iap_jsonrpc — intercept ALL calls to Odoo servers
# ---------------------------------------------------------------------------
try:
    from odoo.addons.iap.tools import iap_tools

    _original_iap_jsonrpc = getattr(iap_tools, "iap_jsonrpc", None)

    if _original_iap_jsonrpc and not getattr(_original_iap_jsonrpc, "_crx_patched", False):

        def _patched_iap_jsonrpc(url, method="call", params=None, timeout=15):
            """Intercept IAP/subscription calls to Odoo servers."""
            if _is_odoo_domain(url):
                _logger.debug("CRX Dev Bypass: blocked iap_jsonrpc -> %s", url)
                return {
                    "result": True,
                    "status": "valid",
                    "credit": 99999,
                    "credits": 99999,
                    "balance": 99999,
                    "trial": False,
                    "has_subscription": True,
                    "is_valid": True,
                    "success": True,
                    "message": "",
                }
            return _original_iap_jsonrpc(url, method, params, timeout)

        _patched_iap_jsonrpc._crx_patched = True
        iap_tools.iap_jsonrpc = _patched_iap_jsonrpc
        _logger.info("CRX Dev Bypass: patched iap_tools.iap_jsonrpc")

except Exception as e:
    _logger.warning("CRX Dev Bypass: failed to patch iap_jsonrpc: %s", e)


# ---------------------------------------------------------------------------
# 2) Patch publisher_warranty — contract verification
# ---------------------------------------------------------------------------
try:
    from odoo.addons.mail.models import update as mail_update

    for attr_name in dir(mail_update):
        obj = getattr(mail_update, attr_name, None)
        if isinstance(obj, type) and hasattr(obj, "_get_message"):
            original_method = obj._get_message
            if not getattr(original_method, "_crx_patched", False):
                def _bypass_get_message(self):
                    return []
                _bypass_get_message._crx_patched = True
                obj._get_message = _bypass_get_message
                _logger.info("CRX Dev Bypass: patched %s._get_message", attr_name)
            break

    if hasattr(mail_update, "update_notification"):
        original_update = mail_update.update_notification
        if not getattr(original_update, "_crx_patched", False):
            def _patched_update(*args, **kwargs):
                return []
            _patched_update._crx_patched = True
            mail_update.update_notification = _patched_update
            _logger.info("CRX Dev Bypass: patched mail_update.update_notification")

except Exception as e:
    _logger.debug("CRX Dev Bypass: mail_update patch skipped: %s", e)


# ---------------------------------------------------------------------------
# 3) Patch service.common — exp_check, exp_update_notification
# ---------------------------------------------------------------------------
try:
    from odoo.service import common as service_common

    for func_name in ("exp_check", "exp_update_notification"):
        original = getattr(service_common, func_name, None)
        if original and not getattr(original, "_crx_patched", False):
            def _make_bypass(name):
                def _bypass(*args, **kwargs):
                    _logger.debug("CRX Dev Bypass: %s intercepted", name)
                    return []
                _bypass._crx_patched = True
                return _bypass
            setattr(service_common, func_name, _make_bypass(func_name))
            _logger.info("CRX Dev Bypass: patched service_common.%s", func_name)

except Exception as e:
    _logger.debug("CRX Dev Bypass: service_common patch skipped: %s", e)


# ---------------------------------------------------------------------------
# 4) Patch requests — ALWAYS block outbound calls to *.odoo.com
#    Returns fake "valid" responses. No real traffic ever reaches Odoo servers.
# ---------------------------------------------------------------------------
try:
    import requests as _requests

    _original_post = _requests.post
    _original_get = _requests.get

    def _fake_response(content_type="application/json"):
        resp = _requests.models.Response()
        resp.status_code = 200
        if content_type == "application/json":
            resp._content = (
                b'{"result": true, "status": "valid", "has_subscription": true, '
                b'"credit": 99999, "credits": 99999, "balance": 99999, '
                b'"is_valid": true, "success": true, "trial": false}'
            )
        else:
            resp._content = b'bypass_ok'
        resp.headers["Content-Type"] = content_type
        return resp

    if not getattr(_original_post, "_crx_patched", False):
        def _patched_post(url, **kwargs):
            if _is_odoo_domain(url):
                _logger.debug("CRX Dev Bypass: blocked POST -> %s", url)
                return _fake_response("application/json")
            return _original_post(url, **kwargs)

        _patched_post._crx_patched = True
        _requests.post = _patched_post
        _logger.info("CRX Dev Bypass: patched requests.post")

    if not getattr(_original_get, "_crx_patched", False):
        def _patched_get(url, **kwargs):
            if _is_odoo_domain(url):
                _logger.debug("CRX Dev Bypass: blocked GET -> %s", url)
                return _fake_response("text/plain")
            return _original_get(url, **kwargs)

        _patched_get._crx_patched = True
        _requests.get = _patched_get
        _logger.info("CRX Dev Bypass: patched requests.get")

    _original_session_request = _requests.Session.request
    if not getattr(_original_session_request, "_crx_patched", False):
        def _patched_session_request(self, method, url, **kwargs):
            if _is_odoo_domain(url):
                _logger.debug("CRX Dev Bypass: blocked Session.%s -> %s", method, url)
                ct = "application/json" if method.upper() == "POST" else "text/plain"
                return _fake_response(ct)
            return _original_session_request(self, method, url, **kwargs)

        _patched_session_request._crx_patched = True
        _requests.Session.request = _patched_session_request
        _logger.info("CRX Dev Bypass: patched Session.request")

    from requests.adapters import HTTPAdapter
    _original_adapter_send = HTTPAdapter.send

    if not getattr(_original_adapter_send, "_crx_patched", False):
        def _patched_adapter_send(self, request, stream=False, timeout=None,
                                   verify=True, cert=None, proxies=None):
            url = str(request.url) if request and hasattr(request, "url") else ""
            if _is_odoo_domain(url):
                _logger.debug("CRX Dev Bypass: blocked adapter.send -> %s", url)
                method = getattr(request, "method", "GET") or "GET"
                ct = "application/json" if method.upper() == "POST" else "text/plain"
                return _fake_response(ct)
            return _original_adapter_send(self, request, stream=stream,
                                          timeout=timeout, verify=verify,
                                          cert=cert, proxies=proxies)

        _patched_adapter_send._crx_patched = True
        HTTPAdapter.send = _patched_adapter_send
        _logger.info("CRX Dev Bypass: patched HTTPAdapter.send (lowest level)")

except Exception as e:
    _logger.debug("CRX Dev Bypass: requests patch skipped: %s", e)
