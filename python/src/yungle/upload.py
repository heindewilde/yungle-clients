"""
Resumable uploads to Yungle's tus endpoint, with nothing but httpx.

One rule is specific to this server: it commits bytes in parts, and answers a
PATCH with the offset of the last committed part boundary, which can be less
than what was sent. So the loop always continues from the offset the server
returns, never from what it sent. A chunk smaller than one part would never
move that boundary, which is why the chunk size has a floor.
"""

from __future__ import annotations

import base64
import os
import time
from typing import Any, Callable, Optional

import httpx

MiB = 1024 * 1024
_RETRY_DELAYS = (0, 1, 3, 5, 10, 30)


def chunk_size(size: int) -> int:
    """At least one server part per request, or the offset never advances."""
    return max(64 * MiB, (size // (9000 * MiB) + 2) * MiB)


def _metadata(pairs: dict[str, str]) -> str:
    return ",".join(f"{k} {base64.b64encode(v.encode()).decode()}" for k, v in pairs.items())


def upload_file(
    tus_endpoint: str,
    target: dict[str, Any],
    path: str,
    *,
    http: Optional[httpx.Client] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
    upload_url: Optional[str] = None,
) -> str:
    """
    Stream one file to its upload target. Returns the upload URL, which can be
    passed back as ``upload_url`` to resume in a later process.
    """
    client = http or httpx.Client(timeout=None)
    size = os.path.getsize(path)
    # The token authorizes every request, HEAD and PATCH included.
    auth = {"Tus-Resumable": "1.0.0", "x-yungle-upload-token": target["uploadToken"]}

    if upload_url is None:
        res = client.post(
            tus_endpoint,
            headers={
                **auth,
                "Upload-Length": str(size),
                "Upload-Metadata": _metadata(
                    {"fileId": target["id"], "token": target["uploadToken"], "filename": target["name"]}
                ),
            },
        )
        res.raise_for_status()
        upload_url = str(httpx.URL(tus_endpoint).join(res.headers["Location"]))

    offset = _head(client, upload_url, auth)
    step = chunk_size(size)
    failures = 0
    with open(path, "rb") as f:
        while offset < size:
            f.seek(offset)
            data = f.read(step)
            try:
                res = client.patch(
                    upload_url,
                    headers={**auth, "Upload-Offset": str(offset), "Content-Type": "application/offset+octet-stream"},
                    content=data,
                )
                res.raise_for_status()
                offset = int(res.headers["Upload-Offset"])
                failures = 0
            except (httpx.TransportError, httpx.HTTPStatusError) as err:
                status = err.response.status_code if isinstance(err, httpx.HTTPStatusError) else None
                if status is not None and 400 <= status < 500 and status not in (409, 423, 429):
                    raise
                if failures >= len(_RETRY_DELAYS):
                    raise
                time.sleep(_RETRY_DELAYS[failures])
                failures += 1
                # Ask where the server actually is before sending anything else.
                offset = _head(client, upload_url, auth)
            if on_progress:
                on_progress(offset, size)
    return upload_url


def _head(client: httpx.Client, url: str, auth: dict[str, str]) -> int:
    res = client.head(url, headers=auth)
    res.raise_for_status()
    return int(res.headers.get("Upload-Offset", "0"))
