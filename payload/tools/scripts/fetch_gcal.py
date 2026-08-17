"""Fetch Google Calendar events for a date range into references/raw-source/.

Useful for pinning down dates that memory alone cannot (meetings, room bookings).
Colleagues' calendars are included where they are shared with the account.

    <tools> gcal --from 2026-04-01 --to 2026-04-30
    <tools> gcal --from 2026-04-01 --to 2026-04-30 --calendar all
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from googleapiclient.discovery import build

import ws_paths
from google_auth import get_credentials


def fetch(date_from: str, date_to: str, calendar: str = "primary", profile: str = "default") -> Path:
    service = build("calendar", "v3", credentials=get_credentials(profile), cache_discovery=False)

    if calendar == "all":
        listing = service.calendarList().list(maxResults=100).execute()
        calendar_ids = [c["id"] for c in listing.get("items", [])]
    else:
        calendar_ids = [calendar]

    collected: list[dict] = []
    for cal_id in calendar_ids:
        try:
            page_token = None
            while True:
                resp = (
                    service.events()
                    .list(
                        calendarId=cal_id,
                        timeMin=f"{date_from}T00:00:00Z",
                        timeMax=f"{date_to}T23:59:59Z",
                        singleEvents=True,
                        orderBy="startTime",
                        maxResults=250,
                        pageToken=page_token,
                    )
                    .execute()
                )
                for ev in resp.get("items", []):
                    collected.append(
                        {
                            "calendar": cal_id,
                            "start": ev["start"].get("dateTime", ev["start"].get("date")),
                            "end": ev.get("end", {}).get("dateTime", ev.get("end", {}).get("date")),
                            "summary": ev.get("summary"),
                            "location": ev.get("location"),
                            "organizer": ev.get("organizer", {}).get("email"),
                            "attendees": [a.get("email") for a in ev.get("attendees", [])],
                            "description": ev.get("description"),
                            "status": ev.get("status"),
                            "html_link": ev.get("htmlLink"),
                        }
                    )
                page_token = resp.get("nextPageToken")
                if not page_token:
                    break
        except Exception as exc:  # a calendar may be listed but unreadable
            print(f"[gcal] skipped {cal_id}: {type(exc).__name__}")

    collected.sort(key=lambda e: e["start"] or "")

    suffix = "" if profile == "default" else f"-{profile}"
    out = ws_paths.raw_source() / f"gcal{suffix}-{date_from}_{date_to}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "source": "google-calendar",
                "profile": profile,
                "range": {"from": date_from, "to": date_to},
                "calendars": calendar_ids,
                "fetched_at": datetime.now(tz=timezone.utc).isoformat(),
                "event_count": len(collected),
                "events": collected,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"[gcal] {len(collected)} events across {len(calendar_ids)} calendar(s) -> {out}")
    for ev in collected[:15]:
        print(f"  {str(ev['start'])[:16]}  {ev.get('summary') or '(no title)'}")
    return out
