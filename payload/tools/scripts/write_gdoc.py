"""Append text to the end of a Google Doc.

Uses the separate Docs write token; the read-only token the fetch commands hold is
never touched.

    <tools> gdoc-append <DOC_ID_OR_URL> --text "text to append"
    <tools> gdoc-append <DOC_ID_OR_URL> --file notes.md
"""

from __future__ import annotations

import re
from pathlib import Path

from googleapiclient.discovery import build

import google_auth


def _doc_id(ref: str) -> str:
    m = re.search(r"/document/d/([\w-]+)", ref)
    return m.group(1) if m else ref


def append(
    doc_ref: str,
    text: str | None = None,
    file_path: str | None = None,
    profile: str = "default",
) -> None:
    if bool(text) == bool(file_path):
        raise SystemExit("[gdoc-append] specify exactly one of --text / --file")
    body_text = text if text else Path(file_path).read_text(encoding="utf-8")
    if not body_text.endswith("\n"):
        body_text += "\n"

    creds = google_auth.get_credentials(profile, write="docs")
    service = build("docs", "v1", credentials=creds, cache_discovery=False)
    doc_id = _doc_id(doc_ref)
    # The last structural element's endIndex includes the trailing newline, which
    # cannot be inserted at — insert just before it.
    doc = service.documents().get(documentId=doc_id, fields="body(content(endIndex)),title").execute()
    end = doc["body"]["content"][-1]["endIndex"] - 1
    service.documents().batchUpdate(
        documentId=doc_id,
        body={"requests": [{"insertText": {"location": {"index": end}, "text": "\n" + body_text}}]},
    ).execute()
    print(f"[gdoc-append] appended {len(body_text)} chars to '{doc.get('title', doc_id)}'")
