"""Export the Slack desktop app's session as a Playwright storage_state.

A workspace that signs in through Google cannot be driven by a scripted login, so
the way in is the session that already exists: the desktop app stores its cookies
the way Chromium does — an AES-CBC encrypted store with the key in the OS keychain
— so the current session can be read and handed to Playwright. The `d` cookie is a
unified Slack session, so this reaches every workspace the app is signed into.

macOS only for now; on other platforms use `slack-signin` instead.
Nothing here reaches the network; cookie values are written only to the local
state file, which the caller deletes as soon as the run ends.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

COOKIES_DB = Path.home() / "Library/Application Support/Slack/Cookies"
KEYCHAIN_SERVICE = "Slack Safe Storage"

_SAMESITE = {0: "None", 1: "Lax", 2: "Strict", -1: "Lax"}


def _key() -> bytes:
    pw = subprocess.check_output(
        ["security", "find-generic-password", "-w", "-s", KEYCHAIN_SERVICE]
    ).strip()
    return hashlib.pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, dklen=16)


def _decrypt(enc: bytes, key: bytes) -> str:
    from Cryptodome.Cipher import AES

    if enc[:3] in (b"v10", b"v11"):
        enc = enc[3:]
    dec = AES.new(key, AES.MODE_CBC, b" " * 16).decrypt(enc)
    pad = dec[-1]
    if 1 <= pad <= 16:
        dec = dec[:-pad]
    try:
        return dec.decode("utf-8")
    except UnicodeDecodeError:
        # Newer Chromium prepends a 32-byte SHA256 domain hash to the plaintext.
        return dec[32:].decode("utf-8", "replace")


def export_state(out_path: Path) -> Path:
    """Decrypt the Slack app cookies and write a Playwright storage_state JSON."""
    if sys.platform != "darwin":
        raise SystemExit(
            "[slack] --from-app reads the macOS keychain and is macOS only. "
            "Run `slack-signin` once instead and reuse the saved session."
        )
    if not COOKIES_DB.exists():
        raise FileNotFoundError(
            f"Slack app cookie store not found at {COOKIES_DB} — is the desktop app installed?"
        )
    key = _key()

    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        shutil.copy(COOKIES_DB, tmp.name)
        con = sqlite3.connect(f"file:{tmp.name}?mode=ro", uri=True)
        rows = con.execute(
            "SELECT host_key, name, encrypted_value, path, is_secure, is_httponly, "
            "expires_utc, samesite FROM cookies WHERE host_key LIKE '%slack.com%'"
        ).fetchall()
        con.close()

    cookies = []
    for host, name, enc, path, secure, httponly, expires_utc, samesite in rows:
        cookies.append({
            "name": name,
            "value": _decrypt(enc, key),
            "domain": host,
            "path": path or "/",
            "expires": (expires_utc / 1_000_000 - 11644473600) if expires_utc else -1,
            "httpOnly": bool(httponly),
            "secure": bool(secure),
            "sameSite": _SAMESITE.get(samesite, "Lax"),
        })

    if not any(c["name"] == "d" for c in cookies):
        raise RuntimeError("no `d` auth cookie found — is the Slack app signed in?")

    out_path.write_text(json.dumps({"cookies": cookies, "origins": []}, indent=2))
    out_path.chmod(0o600)
    return out_path
