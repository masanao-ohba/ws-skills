"""Snapshot a Google Sheet's cell values into references/raw-source/.

Tables in Sheets are edited in place, so a link alone shows only today's state.
This freezes the values of every tab (or a named one) as JSON.

    <tools> gsheet <SHEET_ID_OR_URL>              # every tab
    <tools> gsheet <URL> --tab "Summary"          # tabs whose title contains this
    <tools> gsheet <URL> --list                   # tab names only

Read-only (`spreadsheets.readonly`). Comment threads are fetched by `gcomments`.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from googleapiclient.discovery import build

import ws_paths
from google_auth import get_credentials


def _sheet_id(ref: str) -> str:
    m = re.search(r"/d/([\w-]+)", ref)
    return m.group(1) if m else ref


def fetch(
    ref: str,
    tab: str | None = None,
    profile: str = "default",
    label: str | None = None,
    list_only: bool = False,
) -> Path | None:
    sheet_id = _sheet_id(ref)
    api = build("sheets", "v4", credentials=get_credentials(profile), cache_discovery=False)
    meta = api.spreadsheets().get(spreadsheetId=sheet_id, includeGridData=False).execute()
    # Chart/timeline sheets have no cell grid; asking for their range is a 400, so skip them.
    titles = [
        s["properties"]["title"]
        for s in meta["sheets"]
        if s["properties"].get("sheetType", "GRID") == "GRID"
    ]

    if list_only:
        print(f"[gsheet] {meta['properties']['title']}")
        for t in titles:
            print(f"  - {t}")
        return None

    wanted = [t for t in titles if tab is None or tab in t]
    if not wanted:
        raise SystemExit(f"[gsheet] no tab matching {tab!r}; available: {titles}")

    # batchGet keeps this to one round trip; FORMATTED_VALUE preserves what a reader saw.
    resp = (
        api.spreadsheets()
        .values()
        .batchGet(
            spreadsheetId=sheet_id,
            ranges=[f"'{t}'" for t in wanted],
            valueRenderOption="FORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
    )
    tabs = {t: r.get("values", []) for t, r in zip(wanted, resp.get("valueRanges", []))}

    stamp = datetime.now(tz=timezone.utc)
    slug = label or re.sub(r"[^\w\-]+", "-", meta["properties"]["title"]).strip("-")[:60]
    out = ws_paths.unique_path(
        ws_paths.raw_source(), f"gsheet-{slug}-{stamp.strftime('%Y%m%d')}.json"
    )

    out.write_text(
        json.dumps(
            {
                "source": "google-sheets",
                "fetched_at": stamp.isoformat(),
                "spreadsheet_id": sheet_id,
                "title": meta["properties"]["title"],
                "all_tabs": titles,
                "tabs": tabs,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"[gsheet] {meta['properties']['title']}: {len(tabs)} tabs -> {out}")
    return out
