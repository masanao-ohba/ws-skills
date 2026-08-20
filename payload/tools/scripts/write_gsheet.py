"""Write cell values to a Google Sheet range, using the separate Sheets write token.

    <tools> gsheet-write <SHEET_ID_OR_URL> --range 'Tab!A1' --values '[["a","b"],["c","d"]]'
    <tools> gsheet-write <SHEET_ID_OR_URL> --range 'Tab!A1' --csv data.csv --append
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path

from googleapiclient.discovery import build

import google_auth


def _sheet_id(ref: str) -> str:
    m = re.search(r"/d/([\w-]+)", ref)
    return m.group(1) if m else ref


def write(
    sheet_ref: str,
    range_a1: str,
    values_json: str | None = None,
    csv_path: str | None = None,
    profile: str = "default",
    append: bool = False,
) -> None:
    if bool(values_json) == bool(csv_path):
        raise SystemExit("[gsheet-write] specify exactly one of --values / --csv")

    if values_json:
        values = json.loads(values_json)
        if not isinstance(values, list) or not all(isinstance(r, list) for r in values):
            raise SystemExit("[gsheet-write] --values must be a JSON array of row arrays")
    else:
        with Path(csv_path).open(newline="", encoding="utf-8") as f:
            values = list(csv.reader(f))

    creds = google_auth.get_credentials(profile, write="sheets")
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    body = {"values": values}
    target = service.spreadsheets().values()
    if append:
        result = target.append(
            spreadsheetId=_sheet_id(sheet_ref),
            range=range_a1,
            valueInputOption="USER_ENTERED",
            body=body,
        ).execute()
        updated = result.get("updates", {})
    else:
        updated = target.update(
            spreadsheetId=_sheet_id(sheet_ref),
            range=range_a1,
            valueInputOption="USER_ENTERED",
            body=body,
        ).execute()
    print(
        f"[gsheet-write] {updated.get('updatedRange', range_a1)}: "
        f"{updated.get('updatedCells', 0)} cells written"
    )
