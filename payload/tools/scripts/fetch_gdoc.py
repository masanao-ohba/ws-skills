"""Fetch a Google Doc (including every tab) and write it out as Markdown.

Tabbed documents need includeTabsContent=True; without it the API returns only the
first tab's body, which silently loses most of the document.

    <tools> gdoc <DOC_ID_OR_URL> [OUTPUT_PATH]
"""

from __future__ import annotations

import re
from pathlib import Path

from googleapiclient.discovery import build

import ws_paths
from google_auth import get_credentials

# Google Docs named styles -> Markdown heading depth
HEADING_DEPTH = {
    "TITLE": 1,
    "SUBTITLE": 2,
    "HEADING_1": 1,
    "HEADING_2": 2,
    "HEADING_3": 3,
    "HEADING_4": 4,
    "HEADING_5": 5,
    "HEADING_6": 6,
}


def extract_doc_id(value: str) -> str:
    match = re.search(r"/document/d/([a-zA-Z0-9_-]+)", value)
    return match.group(1) if match else value


def render_paragraph(paragraph: dict, base_depth: int) -> str:
    text = "".join(
        el.get("textRun", {}).get("content", "") for el in paragraph.get("elements", [])
    ).rstrip("\n")
    if not text.strip():
        return ""

    style = paragraph.get("paragraphStyle", {}).get("namedStyleType", "NORMAL_TEXT")
    if style in HEADING_DEPTH:
        depth = min(base_depth + HEADING_DEPTH[style], 6)
        return f"{'#' * depth} {text.strip()}"

    if paragraph.get("bullet"):
        return f"- {text.strip()}"

    return text


def render_body(content: list[dict], base_depth: int) -> list[str]:
    lines: list[str] = []
    for element in content:
        if paragraph := element.get("paragraph"):
            lines.append(render_paragraph(paragraph, base_depth))
        elif table := element.get("table"):
            for row in table.get("tableRows", []):
                cells = []
                for cell in row.get("tableCells", []):
                    cell_text = " ".join(
                        line for line in render_body(cell.get("content", []), base_depth) if line
                    )
                    cells.append(cell_text.replace("|", "\\|"))
                lines.append("| " + " | ".join(cells) + " |")
    return lines


def render_tabs(tabs: list[dict], depth: int = 1) -> list[str]:
    out: list[str] = []
    for tab in tabs:
        title = tab.get("tabProperties", {}).get("title", "(untitled tab)")
        out.append(f"{'#' * min(depth, 6)} {title}")
        out.append("")
        body = tab.get("documentTab", {}).get("body", {}).get("content", [])
        out.extend(render_body(body, base_depth=depth))
        out.append("")
        out.extend(render_tabs(tab.get("childTabs", []), depth + 1))
    return out


def fetch(doc_ref: str, out_path: str | None = None, profile: str = "default") -> Path:
    doc_id = extract_doc_id(doc_ref)
    service = build("docs", "v1", credentials=get_credentials(profile), cache_discovery=False)
    doc = service.documents().get(documentId=doc_id, includeTabsContent=True).execute()

    title = doc.get("title", doc_id)
    lines = [
        f"# {title}",
        "",
        f"<!-- source: https://docs.google.com/document/d/{doc_id}/edit -->",
        "",
    ]

    tabs = doc.get("tabs", [])
    if tabs:
        lines.extend(render_tabs(tabs, depth=2))
    else:
        lines.extend(render_body(doc.get("body", {}).get("content", []), base_depth=1))

    target = Path(out_path) if out_path else ws_paths.raw_source() / f"{title}.md"
    target.parent.mkdir(parents=True, exist_ok=True)

    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    target.write_text(text.rstrip() + "\n", encoding="utf-8")

    print(f"[gdoc] {title} -> {target} ({len(text.splitlines())} lines, {len(tabs)} top-level tabs)")
    return target
