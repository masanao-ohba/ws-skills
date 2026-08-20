"""Obtain and refresh Google API tokens, with read and write kept apart.

Fetching uses a **read-only** token, so the fetch commands cannot write even by
mistake. Writing uses a separate per-service token (`token_sheets.json` /
`token_docs.json`), authorized on its own.

Multiple accounts are supported through profiles. Set GOOGLE_PROFILES to a comma
separated list; each profile keeps its own OAuth client and token files in the
tooling home's `google/` directory:

    default        credentials.json          token_readonly.json
    <name>         credentials_<name>.json   token_readonly_<name>.json

An "Internal" OAuth client only accepts accounts in its own organization, so a
second organization needs its own profile.

    <tools> auth                       # authorize the read-only token
    <tools> auth --check               # status of every profile and token
    <tools> auth --write sheets        # authorize/refresh the Sheets write token
"""

from __future__ import annotations

import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

import ws_paths

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]

# Separate per-service tokens: the read-only token stays unable to write.
WRITE_SCOPES = {
    "sheets": ["https://www.googleapis.com/auth/spreadsheets"],
    "docs": ["https://www.googleapis.com/auth/documents"],
}

SETUP_HINT = (
    "Create an OAuth client (type: Desktop app) in a Google Cloud project owned by "
    "that account, download the JSON, and save it at the path above. See the README "
    "section 'Google authorization'."
)


def profile_names() -> list[str]:
    raw = ws_paths.lookup("GOOGLE_PROFILES") or "default"
    names = [n.strip() for n in raw.split(",") if n.strip()]
    return names or ["default"]


def _suffix(profile: str) -> str:
    return "" if profile == "default" else f"_{profile}"


def credentials_path(profile: str = "default") -> Path:
    return ws_paths.google_dir() / f"credentials{_suffix(profile)}.json"


def token_path(profile: str = "default", write: str | None = None) -> Path:
    kind = write if write else "readonly"
    return ws_paths.google_dir() / f"token_{kind}{_suffix(profile)}.json"


def _callback_port() -> int:
    return int(ws_paths.lookup("GOOGLE_OAUTH_PORT") or 8765)


class _CallbackHandler(BaseHTTPRequestHandler):
    """Receives the authorization code exactly once."""

    code: str | None = None
    error: str | None = None

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler convention)
        params = parse_qs(urlparse(self.path).query)
        _CallbackHandler.code = params.get("code", [None])[0]
        _CallbackHandler.error = params.get("error", [None])[0]

        body = (
            "Authorization complete. You can close this tab."
            if _CallbackHandler.code
            else f"Authorization failed: {_CallbackHandler.error}"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"<html><body><p>{body}</p></body></html>".encode())

    def log_message(self, *args: object) -> None:
        """Suppress access logs."""


def _authorize(profile: str, scopes: list[str], open_browser: bool = False) -> Credentials:
    _CallbackHandler.code = None
    _CallbackHandler.error = None

    cred = credentials_path(profile)
    if not cred.exists():
        sys.exit(f"[auth] no OAuth client for profile '{profile}' at {cred}.\n       {SETUP_HINT}")

    port = _callback_port()
    redirect_uri = f"http://localhost:{port}/"
    flow = InstalledAppFlow.from_client_secrets_file(str(cred), scopes, redirect_uri=redirect_uri)
    url, _ = flow.authorization_url(access_type="offline", prompt="consent select_account")

    print(f"\n=== Open this URL and approve with the '{profile}' account ===", flush=True)
    print(url, flush=True)
    print(f"\n(waiting for the redirect to {redirect_uri} ...)\n", flush=True)
    # Off by default: signing in through the browser the tool picks can invalidate
    # the session of the browser the person actually uses.
    if open_browser:
        webbrowser.open(url)

    server = HTTPServer(("localhost", port), _CallbackHandler)
    server.handle_request()
    server.server_close()

    if not _CallbackHandler.code:
        raise RuntimeError(f"no authorization code received: {_CallbackHandler.error}")

    flow.fetch_token(code=_CallbackHandler.code)
    return flow.credentials


def get_credentials(
    profile: str = "default", write: str | None = None, open_browser: bool = False
) -> Credentials:
    """Return valid credentials for a profile, refreshing or re-authorizing as needed.

    write="sheets" / "docs" uses that service's separate write token. A new scope
    must be registered in Google Cloud Console -> Data Access before its consent
    screen will accept it.
    """
    if write and write not in WRITE_SCOPES:
        sys.exit(f"[auth] unknown write service '{write}'. Known: {', '.join(WRITE_SCOPES)}")
    path = token_path(profile, write)
    scopes = WRITE_SCOPES[write] if write else SCOPES
    creds: Credentials | None = None

    if path.exists():
        creds = Credentials.from_authorized_user_file(str(path), scopes)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        creds = _authorize(profile, scopes, open_browser)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(creds.to_json())
    path.chmod(0o600)
    return creds


def whoami(profile: str = "default") -> str:
    """Return the email address a profile's token belongs to, via the Drive API."""
    from googleapiclient.discovery import build

    service = build("drive", "v3", credentials=get_credentials(profile), cache_discovery=False)
    about = service.about().get(fields="user(emailAddress)").execute()
    return about["user"]["emailAddress"]


def check() -> None:
    for name in profile_names():
        cred = credentials_path(name)
        for write in (None, *WRITE_SCOPES):
            path = token_path(name, write)
            mode = f"write:{write}" if write else "read"
            if not path.exists():
                missing = "" if cred.exists() else f" / no OAuth client ({cred.name})"
                print(f"[auth] {name:10} {mode:12} not authorized ({path.name} missing){missing}")
                continue
            scopes = WRITE_SCOPES[write] if write else SCOPES
            creds = Credentials.from_authorized_user_file(str(path), scopes)
            state = "valid" if creds.valid else ("expired (refreshable)" if creds.expired else "invalid")
            print(f"[auth] {name:10} {mode:12} {state}")


if __name__ == "__main__":
    check()
