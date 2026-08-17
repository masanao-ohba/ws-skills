"""Download and save assets (avatars, emoji, image files) from the Slack CDN."""

from __future__ import annotations

import hashlib
import urllib.request
from pathlib import Path
from typing import Iterator

from .parser import Message

# Image file extensions to download (other file types are skipped)
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}


def download_assets(messages: list[Message], output_dir: Path) -> None:
    """Download referenced assets and rewrite the messages with local paths."""
    output_dir = Path(output_dir)
    assets_dir = output_dir / "assets"

    avatars: dict[str, str] = {}   # url -> sender name
    emoji: dict[str, str] = {}     # url -> emoji name
    files: dict[str, str] = {}     # url -> file name

    for msg in _iter_all_messages(messages):
        if msg.avatar_url:
            avatars.setdefault(msg.avatar_url, msg.sender)
        for r in msg.reactions:
            if r.get("image_url"):
                emoji.setdefault(r["image_url"], r["name"])
        for e in msg.inline_emoji:
            if e.get("image_url"):
                emoji.setdefault(e["image_url"], e["name"])
        for a in msg.attachments:
            url = a.get("url", "")
            name = a.get("name", "")
            if url and _is_image(name, url):
                files.setdefault(url, name)

    print(
        f"[download] found: {len(avatars)} avatars, {len(emoji)} emoji, {len(files)} image files"
    )

    avatar_map = _download_batch(avatars, assets_dir / "avatars", "avatar")
    emoji_map = _download_batch(emoji, assets_dir / "emoji", "emoji")
    file_map = _download_batch(files, assets_dir / "files", "file")

    # Replace URLs with paths relative to the output directory.
    for msg in _iter_all_messages(messages):
        if msg.avatar_url in avatar_map:
            msg.avatar_url = str(avatar_map[msg.avatar_url].relative_to(output_dir))
        for r in msg.reactions:
            url = r.get("image_url", "")
            if url in emoji_map:
                r["image_url"] = str(emoji_map[url].relative_to(output_dir))
        for e in msg.inline_emoji:
            url = e.get("image_url", "")
            if url in emoji_map:
                e["image_url"] = str(emoji_map[url].relative_to(output_dir))
        for a in msg.attachments:
            url = a.get("url", "")
            if url in file_map:
                a["local_path"] = str(file_map[url].relative_to(output_dir))


def _iter_all_messages(messages: list[Message]) -> Iterator[Message]:
    """Yield every message including thread replies."""
    for msg in messages:
        yield msg
        yield from msg.thread_replies


def _is_image(name: str, url: str) -> bool:
    path = (name or url.split("?")[0]).lower()
    return any(path.endswith(ext) for ext in _IMAGE_EXTENSIONS)


def _download_batch(urls: dict[str, str], target_dir: Path, label: str) -> dict[str, Path]:
    """Download a batch of URLs. Returns a mapping from URL to local path."""
    if not urls:
        return {}

    target_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, Path] = {}
    success = 0

    for url, name in urls.items():
        local_path = target_dir / (_safe_filename(url) + _guess_extension(url))

        if local_path.exists():
            result[url] = local_path
            success += 1
            continue

        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                local_path.write_bytes(resp.read())
            result[url] = local_path
            success += 1
        except Exception as e:
            print(f"[download] failed {label} ({name}): {e}")

    print(f"[download] {label}: {success}/{len(urls)} downloaded")
    return result


def _safe_filename(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:12]


def _guess_extension(url: str) -> str:
    path = url.split("?")[0].split("/")[-1]
    if "." in path:
        ext = "." + path.rsplit(".", 1)[1].lower()
        if len(ext) <= 5:
            return ext
    return ".png"
