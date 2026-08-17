"""Read-only Backlog API client with per-project credential resolution.

More than one key can coexist — your own, plus keys shared with you that reach a
single project. A borrowed credential must never leak into calls for another
project, so the key is resolved from the project key rather than from one global
variable:

    BACKLOG_DOMAIN               space host, e.g. yourspace.backlog.jp
    BACKLOG_API_KEY              default key
    BACKLOG_API_KEY_<PROJECT>    used for every call on that project, e.g. ..._ABC123
    BACKLOG_DOMAIN_<PROJECT>     only if that project lives in another space (optional)

Values resolve from the process environment first, then `.env` in the current
directory, then the shared `.env` in the tooling home.

**Read-only by construction**: this module issues GET only. There is no
POST/PATCH/DELETE path here, so a key cannot be used to write even by mistake.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

import ws_paths


class BacklogError(RuntimeError):
    pass


def _suffix(project_key: str) -> str:
    """ABC123 -> ABC123; ABC123-12 -> ABC123. Uppercased, non-alnum to underscore."""
    head = project_key.split("-")[0].upper()
    return "".join(c if c.isalnum() else "_" for c in head)


class Backlog:
    """A GET-only Backlog session bound to one project key."""

    def __init__(self, project_key: str) -> None:
        self.project_key = _suffix(project_key)
        self.domain = ws_paths.lookup(f"BACKLOG_DOMAIN_{self.project_key}") or ws_paths.lookup(
            "BACKLOG_DOMAIN"
        )
        self.key = ws_paths.lookup(f"BACKLOG_API_KEY_{self.project_key}")
        self.scoped = self.key is not None
        if self.key is None:
            self.key = ws_paths.lookup("BACKLOG_API_KEY")
        if not self.domain or not self.key:
            raise BacklogError(
                f"[backlog] no credential for {self.project_key}: set BACKLOG_DOMAIN and "
                f"BACKLOG_API_KEY_{self.project_key} (or BACKLOG_API_KEY) in the environment, "
                f"in ./.env, or in {ws_paths.shared_env_file()}"
            )

    def get(self, path: str, **params) -> object:
        query = [(k, v) for k, v in params.items() if v is not None]
        flat: list[tuple[str, str]] = []
        for k, v in query:
            # Backlog takes repeated keys for list params, e.g. projectId[]=1&projectId[]=2
            for item in v if isinstance(v, (list, tuple)) else [v]:
                flat.append((k, str(item)))
        flat.append(("apiKey", self.key))
        url = f"https://{self.domain}/api/v2/{path}?{urllib.parse.urlencode(flat)}"
        req = urllib.request.Request(url, method="GET")
        # Backlog rate-limits per API key; exploration paginates, so back off rather
        # than aborting a half-collected sweep.
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 4:
                    wait = int(e.headers.get("Retry-After") or 0) or 15 * (attempt + 1)
                    print(f"[backlog] rate limited; retrying in {wait}s")
                    time.sleep(wait)
                    continue
                body = e.read().decode("utf-8", "replace")[:500]
                raise BacklogError(f"[backlog] GET {path} -> {e.code}: {body}") from e

    def paged(self, path: str, limit: int | None = None, **params) -> list:
        """Walk an offset-paginated collection endpoint, stopping at `limit` items.

        `limit` is enforced *while* paging, not by slicing afterwards: a project with
        thousands of issues would otherwise be walked in full for a 5-row listing.
        """
        out: list = []
        offset = 0
        while True:
            count = 100 if limit is None else min(100, limit - len(out))
            batch = self.get(path, count=count, offset=offset, **params)
            if not isinstance(batch, list) or not batch:
                break
            out.extend(batch)
            if len(batch) < count or (limit is not None and len(out) >= limit):
                break
            offset += count
        return out
