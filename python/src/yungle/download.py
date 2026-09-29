"""
Saving what a set of download links points at, resumably, with nothing but httpx.

The links come from ``Yungle.resolve_link`` (a link someone shared),
``transfer_download_links`` or ``collection_download_links`` (your own). Each URL
is signed and needs no key; each supports ``Range``, so an interrupted file
continues from its ``.part`` rather than starting again.
"""

from __future__ import annotations

import os
import re
import zlib
from typing import Any, Callable, Optional

import httpx

_UNSAFE = re.compile(r'[\x00-\x1f<>:"|?*]')


def safe_name(name: str) -> str:
    """The last path segment of an untrusted name, with hostile characters replaced."""
    last = name.replace("\\", "/").rstrip("/").split("/")[-1]
    cleaned = _UNSAFE.sub("_", last).strip()
    if cleaned in ("", ".", ".."):
        return "file"
    return cleaned


def safe_dir(path: Optional[str]) -> str:
    """A server-supplied folder path that cannot climb out of the output directory."""
    if not path:
        return ""
    parts = [p for p in path.replace("\\", "/").split("/") if p and p not in (".", "..")]
    return "/".join(safe_name(p) for p in parts)


def download_links(
    links: dict[str, Any],
    out_dir: str,
    *,
    http: Optional[httpx.Client] = None,
    on_progress: Optional[Callable[[str, int, int], None]] = None,
) -> list[str]:
    """
    Download every file in ``links`` into ``out_dir``, keeping folder paths.
    Files already there at their full size are skipped, so calling this again
    only fetches what is new. Returns the paths written or already present.
    """
    if links.get("e2ee"):
        raise ValueError("End-to-end encrypted: the bytes are ciphertext. Open the link in a browser.")
    client = http or httpx.Client(timeout=None, follow_redirects=True)
    used: set[str] = set()
    written: list[str] = []
    for f in links.get("files", []):
        rel_dir = safe_dir(f.get("path"))
        name = safe_name(f["name"])
        stem, dot, ext = name.rpartition(".")
        if not dot:
            stem, ext = name, ""
        candidate, n = name, 2
        while os.path.join(rel_dir, candidate).lower() in used:
            candidate = f"{stem} ({n}){'.' + ext if ext else ''}"
            n += 1
        used.add(os.path.join(rel_dir, candidate).lower())
        dest = os.path.join(out_dir, rel_dir, candidate)
        written.append(dest)
        size = int(f["size"])
        if os.path.exists(dest) and os.path.getsize(dest) == size:
            continue
        _fetch(client, f["downloadUrl"], dest, size, lambda got: on_progress and on_progress(dest, got, size))
        expected = f.get("crc32")
        if expected and _crc32(dest) != expected:
            os.remove(dest)
            raise ValueError(f"{dest} arrived damaged (checksum mismatch) and was deleted; download again.")
    return written


def _crc32(path: str) -> str:
    value = 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            value = zlib.crc32(chunk, value)
    return f"{value & 0xFFFFFFFF:08x}"


def _fetch(client: httpx.Client, url: str, dest: str, size: int, progress: Callable[[int], Any]) -> None:
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    part = dest + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    headers = {"Range": f"bytes={have}-"} if 0 < have < size else {}
    with client.stream("GET", url, headers=headers) as res:
        res.raise_for_status()
        # 200 to a Range request means the whole file is coming: start over.
        mode = "ab" if res.status_code == 206 else "wb"
        got = have if mode == "ab" else 0
        with open(part, mode) as out:
            for chunk in res.iter_bytes(1024 * 1024):
                out.write(chunk)
                got += len(chunk)
                progress(got)
    os.replace(part, dest)
