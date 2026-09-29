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
import json
import os
import time
from typing import Any, Callable, Optional

import httpx

MiB = 1024 * 1024
_RETRY_DELAYS = (0, 1, 3, 5, 10, 30)


def chunk_size(size: int) -> int:
    """At least one server part per request, or the offset never advances."""
    return max(64 * MiB, (size // (9000 * MiB) + 2) * MiB)


def token_expiry(token: str) -> Optional[float]:
    """``exp`` of a signed upload token, in epoch seconds, or None if unreadable."""
    try:
        payload = token.split(".", 1)[0]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        return exp / 1000 if isinstance(exp, (int, float)) else None
    except Exception:
        return None


class _TokenKeeper:
    """
    Keeps a two-hour upload token alive for as long as the upload runs.

    Every tus request presents the token, so a PATCH sent after it expires is
    refused and the upload dies — for a 64 MiB-chunked client that means any
    upload longer than two hours. Before each request, a token past half its
    life is traded for a fresh one at ``POST /api/uploads/token``. The renewal
    is also how the server knows the upload is alive: its quota stays reserved.
    """

    def __init__(self, target: dict[str, Any], renew_url: Optional[str], client: httpx.Client,
                 on_token: Optional[Callable[[str], None]]):
        self.target = target
        self.renew_url = renew_url
        self.client = client
        self.on_token = on_token
        self.issued = time.time()

    @property
    def token(self) -> str:
        return self.target["uploadToken"]

    def fresh(self) -> str:
        if self.renew_url is None:
            return self.token
        exp = token_expiry(self.token)
        now = time.time()
        # Half the remaining life gone (or unreadable and an hour old): renew.
        due = (now - self.issued) >= (exp - self.issued) / 2 if exp else now - self.issued > 3600
        if not due:
            return self.token
        try:
            res = self.client.post(self.renew_url, headers={"x-yungle-upload-token": self.token})
        except httpx.TransportError:
            return self.token  # try again before the next request
        if res.status_code == 200:
            self.target["uploadToken"] = res.json()["uploadToken"]
            self.issued = now
            if self.on_token:
                self.on_token(self.target["uploadToken"])
        return self.token


def renew_url_for(tus_endpoint: str) -> str:
    """The renewal endpoint on the same host as the tus endpoint."""
    return str(httpx.URL(tus_endpoint).join("/api/uploads/token"))


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
    renew_url: Optional[str] = "auto",
    on_token: Optional[Callable[[str], None]] = None,
) -> str:
    """
    Stream one file to its upload target. Returns the upload URL, which can be
    passed back as ``upload_url`` to resume in a later process.

    Upload tokens last two hours and are renewed automatically for as long as
    the upload runs; ``target["uploadToken"]`` is updated in place, and
    ``on_token`` is called with each new one so you can store it for a resume.
    ``renew_url`` defaults to ``/api/uploads/token`` on the tus endpoint's host;
    pass None to disable renewal.
    """
    client = http or httpx.Client(timeout=None)
    size = os.path.getsize(path)
    keeper = _TokenKeeper(
        target, renew_url_for(tus_endpoint) if renew_url == "auto" else renew_url, client, on_token
    )

    def auth() -> dict[str, str]:
        # The token authorizes every request, HEAD and PATCH included — and it
        # is the CURRENT token, renewed if it was due.
        return {"Tus-Resumable": "1.0.0", "x-yungle-upload-token": keeper.fresh()}

    if upload_url is None:
        res = client.post(
            tus_endpoint,
            headers={
                **auth(),
                "Upload-Length": str(size),
                "Upload-Metadata": _metadata(
                    {"fileId": target["id"], "token": target["uploadToken"], "filename": target["name"]}
                ),
            },
        )
        res.raise_for_status()
        upload_url = str(httpx.URL(tus_endpoint).join(res.headers["Location"]))

    offset = _head(client, upload_url, auth())
    step = chunk_size(size)
    failures = 0
    with open(path, "rb") as f:
        while offset < size:
            f.seek(offset)
            data = f.read(step)
            try:
                res = client.patch(
                    upload_url,
                    headers={**auth(), "Upload-Offset": str(offset), "Content-Type": "application/offset+octet-stream"},
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
                offset = _head(client, upload_url, auth())
            if on_progress:
                on_progress(offset, size)
    return upload_url


def _head(client: httpx.Client, url: str, auth: dict[str, str]) -> int:
    res = client.head(url, headers=auth)
    res.raise_for_status()
    return int(res.headers.get("Upload-Offset", "0"))
