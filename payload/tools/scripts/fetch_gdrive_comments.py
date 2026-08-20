"""Snapshot the comment threads on a Google Doc / Sheet into references/raw-source/.

Works for any Drive file (Docs, Sheets, Slides) — comments live on the Drive item.

    <tools> gcomments <FILE_ID_OR_URL>
    <tools> gcomments <URL> --profile <name>

Read-only: `drive.readonly` covers comments.list; nothing here writes.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from googleapiclient.discovery import build

import ws_paths
from google_auth import get_credentials

FIELDS = (
    "nextPageToken,comments(id,createdTime,modifiedTime,author(displayName,emailAddress),"
    "content,quotedFileContent,anchor,resolved,"
    "replies(id,createdTime,author(displayName,emailAddress),content,action))"
)


def _file_id(ref: str) -> str:
    m = re.search(r"/d/([\w-]+)", ref)
    return m.group(1) if m else ref


def fetch(ref: str, profile: str = "default", label: str | None = None) -> Path:
    file_id = _file_id(ref)
    creds = get_credentials(profile)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)

    # Without supportsAllDrives the API answers 404 for a shared-drive file the
    # account can actually read.
    meta = (
        drive.files()
        .get(fileId=file_id, fields="id,name,mimeType,modifiedTime,driveId", supportsAllDrives=True)
        .execute()
    )

    comments: list = []
    token = None
    while True:
        # includeDeleted keeps a retracted remark visible as such rather than absent.
        resp = (
            drive.comments()
            .list(fileId=file_id, pageSize=100, fields=FIELDS, includeDeleted=True, pageToken=token)
            .execute()
        )
        comments.extend(resp.get("comments", []))
        token = resp.get("nextPageToken")
        if not token:
            break

    stamp = datetime.now(tz=timezone.utc)
    slug = label or re.sub(r"[^\w\-]+", "-", meta["name"]).strip("-")[:60]
    out = ws_paths.unique_path(
        ws_paths.raw_source(), f"gdrive-comments-{slug}-{stamp.strftime('%Y%m%d')}.json"
    )

    out.write_text(
        json.dumps(
            {
                "source": "google-drive-comments",
                "fetched_at": stamp.isoformat(),
                "profile": profile,
                "file": meta,
                "comments": comments,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    replies = sum(len(c.get("replies", [])) for c in comments)
    print(f"[gcomments] {meta['name']}: {len(comments)} threads / {replies} replies -> {out}")
    return out
