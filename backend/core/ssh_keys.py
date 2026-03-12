"""SSH Key Manager — auto-generate and manage platform SSH keypair.

CRX Cloud generates its own SSH keypair. When connecting a new server,
the user either:
  1. Copies our public key to their server's authorized_keys, OR
  2. Provides root password for one-time setup (we inject the key automatically)
"""

import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from loguru import logger


_KEY_DIR = Path(__file__).parent.parent / "data" / "ssh_keys"
_PRIVATE_KEY = _KEY_DIR / "crx_cloud_id_rsa"
_PUBLIC_KEY = _KEY_DIR / "crx_cloud_id_rsa.pub"


def _ensure_keypair() -> None:
    """Generate RSA keypair if it doesn't exist."""
    _KEY_DIR.mkdir(parents=True, exist_ok=True)

    if _PRIVATE_KEY.exists() and _PUBLIC_KEY.exists():
        return

    logger.info("Generating CRX Cloud SSH keypair...")
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)

    # Write private key (PEM, no passphrase) — force LF line endings
    key_bytes = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.OpenSSH,
        encryption_algorithm=serialization.NoEncryption(),
    )
    _PRIVATE_KEY.write_bytes(key_bytes.replace(b"\r\n", b"\n"))
    os.chmod(str(_PRIVATE_KEY), 0o600)

    # Write public key
    pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.OpenSSH,
        format=serialization.PublicFormat.OpenSSH,
    )
    _PUBLIC_KEY.write_text(pub.decode() + " crx-cloud-platform\n")
    logger.info(f"SSH keypair generated at {_KEY_DIR}")


def get_public_key() -> str:
    """Return the platform public key (generates if needed)."""
    _ensure_keypair()
    return _PUBLIC_KEY.read_text().strip()


def get_private_key_path() -> str:
    """Return absolute path to private key (generates if needed)."""
    _ensure_keypair()
    return str(_PRIVATE_KEY)
