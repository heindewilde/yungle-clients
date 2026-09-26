from __future__ import annotations

import os
import random
import time
import uuid
from typing import Any, Iterator, Optional, Sequence
from urllib.parse import quote

import httpx

from .errors import YungleError
from .upload import upload_file

DEFAULT_BASE = "https://yungle.co/api/v1"
_VERSION = "0.1.0"


def _enc(value: str) -> str:
    return quote(value, safe="")


class Yungle:
    """
    A client for the Yungle API.

    >>> yungle = Yungle()  # reads YUNGLE_API_KEY
    >>> t = yungle.send(["report.pdf"], to=["client@example.com"])
    >>> t["url"]

    Responses are the API's JSON, as dicts. Every POST carries an
    ``Idempotency-Key`` reused across its retries, so a create that fails with a
    5xx or a dropped connection is retried without making a second copy.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        max_retries: int = 3,
        timeout: float = 60.0,
        http: Optional[httpx.Client] = None,
    ):
        key = api_key or os.environ.get("YUNGLE_API_KEY", "").strip()
        if not key:
            raise ValueError("An API key is required: pass api_key or set YUNGLE_API_KEY.")
        self._key = key
        self.base_url = (base_url or os.environ.get("YUNGLE_API_URL") or DEFAULT_BASE).rstrip("/")
        self.max_retries = max_retries
        self._http = http or httpx.Client(timeout=timeout)
        self._headers = {
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": f"yungle-python/{_VERSION}",
        }

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Yungle":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ── The one-call send ─────────────────────────────────────────────────────

    def send(
        self,
        paths: Sequence[str],
        *,
        to: Sequence[str] = (),
        message: Optional[str] = None,
        title: Optional[str] = None,
        password: Optional[str] = None,
        expires_in_days: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Create a transfer, upload the files resumably, send it, and return the
        finalized transfer (``url``, ``expiresAt``, …). With no ``to`` it is a
        link only; nobody is emailed.
        """
        files = [{"name": os.path.basename(p), "size": os.path.getsize(p)} for p in paths]
        draft = self.create_transfer(files, title=title, expires_in_days=expires_in_days)
        for target, path in zip(draft["files"], paths):
            upload_file(draft["tusEndpoint"], target, path, http=self._http)
        sent = self.finalize_transfer(
            draft["transfer"]["id"], recipients=list(to), message=message, password=password
        )
        return {**sent["transfer"], "notified": sent.get("notified", [])}

    # ── Account ───────────────────────────────────────────────────────────────

    def me(self) -> dict[str, Any]:
        return self._request("GET", "/me")

    # ── Transfers ─────────────────────────────────────────────────────────────

    def list_transfers(self, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> dict[str, Any]:
        """One page, newest first. Follow ``nextCursor``, or use ``all_transfers()``."""
        return self._request("GET", "/transfers", params=_page(limit, cursor))

    def all_transfers(self, page_size: int = 500) -> Iterator[dict[str, Any]]:
        cursor: Optional[str] = None
        while True:
            page = self.list_transfers(limit=page_size, cursor=cursor)
            yield from page["transfers"]
            cursor = page.get("nextCursor")
            if not cursor:
                return

    def create_transfer(
        self, files: Sequence[dict[str, Any]], *, title: Optional[str] = None, expires_in_days: Optional[int] = None
    ) -> dict[str, Any]:
        """A draft plus upload targets. Nothing is live until ``finalize_transfer``."""
        return self._request(
            "POST", "/transfers", json=_drop_none({"files": list(files), "title": title, "expiresInDays": expires_in_days})
        )

    def get_transfer(self, id: str) -> dict[str, Any]:
        return self._request("GET", f"/transfers/{_enc(id)}")

    def finalize_transfer(
        self,
        id: str,
        *,
        recipients: Sequence[str] = (),
        message: Optional[str] = None,
        password: Optional[str] = None,
        title: Optional[str] = None,
    ) -> dict[str, Any]:
        body = _drop_none({"recipients": list(recipients) or None, "message": message, "password": password, "title": title})
        return self._request("POST", f"/transfers/{_enc(id)}/finalize", json=body)

    def add_transfer_files(self, id: str, files: Sequence[dict[str, Any]]) -> dict[str, Any]:
        return self._request("POST", f"/transfers/{_enc(id)}/files", json={"files": list(files)})

    def remove_transfer_file(self, id: str, file_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/transfers/{_enc(id)}/files/{_enc(file_id)}")

    def update_transfer(
        self, id: str, *, expires_in_days: Optional[int] = None, max_downloads: Any = ...
    ) -> dict[str, Any]:
        body: dict[str, Any] = _drop_none({"expiresInDays": expires_in_days})
        if max_downloads is not ...:
            body["maxDownloads"] = max_downloads  # None clears the limit
        return self._request("PATCH", f"/transfers/{_enc(id)}", json=body)

    def revoke_transfer(self, id: str) -> dict[str, Any]:
        """Immediate and irreversible: the link stops working and the content is destroyed."""
        return self._request("DELETE", f"/transfers/{_enc(id)}")

    def transfer_downloads(self, id: str) -> dict[str, Any]:
        return self._request("GET", f"/transfers/{_enc(id)}/downloads")

    # ── Collections (a paid plan) ─────────────────────────────────────────────

    def list_collections(self) -> dict[str, Any]:
        return self._request("GET", "/collections")

    def create_collection(self, title: str, *, description: Optional[str] = None) -> dict[str, Any]:
        return self._request("POST", "/collections", json=_drop_none({"title": title, "description": description}))

    def get_collection(self, id: str) -> dict[str, Any]:
        return self._request("GET", f"/collections/{_enc(id)}")

    def update_collection(
        self, id: str, *, title: Optional[str] = None, description: Optional[str] = None
    ) -> dict[str, Any]:
        return self._request("PATCH", f"/collections/{_enc(id)}", json=_drop_none({"title": title, "description": description}))

    def delete_collection(self, id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/collections/{_enc(id)}")

    def list_collection_files(
        self, id: str, *, folder_id: Optional[str] = None, limit: Optional[int] = None, cursor: Optional[str] = None
    ) -> dict[str, Any]:
        """``folder_id='root'`` lists the top level. Without ``limit``, every file comes back."""
        params = {**_drop_none({"folderId": folder_id}), **_page(limit, cursor)}
        return self._request("GET", f"/collections/{_enc(id)}/files", params=params)

    def all_collection_files(
        self, id: str, *, folder_id: Optional[str] = None, page_size: int = 1000
    ) -> Iterator[dict[str, Any]]:
        cursor: Optional[str] = None
        while True:
            page = self.list_collection_files(id, folder_id=folder_id, limit=page_size, cursor=cursor)
            yield from page["files"]
            cursor = page.get("nextCursor")
            if not cursor:
                return

    def add_collection_files(
        self, id: str, files: Sequence[dict[str, Any]], *, folder_id: Optional[str] = None
    ) -> dict[str, Any]:
        return self._request("POST", f"/collections/{_enc(id)}/files", json=_drop_none({"files": list(files), "folderId": folder_id}))

    def delete_collection_files(self, id: str, file_ids: Sequence[str]) -> dict[str, Any]:
        return self._request("DELETE", f"/collections/{_enc(id)}/files", json={"fileIds": list(file_ids)})

    def list_folders(self, id: str) -> dict[str, Any]:
        return self._request("GET", f"/collections/{_enc(id)}/folders")

    def create_folder(self, id: str, name: str, *, parent_id: Optional[str] = None) -> dict[str, Any]:
        return self._request("POST", f"/collections/{_enc(id)}/folders", json=_drop_none({"name": name, "parentId": parent_id}))

    def list_guests(self, id: str) -> dict[str, Any]:
        return self._request("GET", f"/collections/{_enc(id)}/guests")

    def invite_guests(self, id: str, emails: Sequence[str]) -> dict[str, Any]:
        return self._request("POST", f"/collections/{_enc(id)}/guests", json={"emails": list(emails)})

    def remove_guest(self, id: str, guest_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/collections/{_enc(id)}/guests/{_enc(guest_id)}")

    # ── Webhooks ──────────────────────────────────────────────────────────────

    def list_webhooks(self) -> dict[str, Any]:
        return self._request("GET", "/webhooks")

    def create_webhook(
        self, url: Optional[str], events: Sequence[str], *, description: Optional[str] = None
    ) -> dict[str, Any]:
        """``url=None`` makes a pull endpoint. The ``secret`` is in this response only."""
        return self._request("POST", "/webhooks", json={"url": url, "events": list(events), **_drop_none({"description": description})})

    def get_webhook(self, id: str) -> dict[str, Any]:
        return self._request("GET", f"/webhooks/{_enc(id)}")

    def update_webhook(self, id: str, **fields: Any) -> dict[str, Any]:
        """Fields: url, events, description, enabled."""
        return self._request("PATCH", f"/webhooks/{_enc(id)}", json=fields)

    def delete_webhook(self, id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/webhooks/{_enc(id)}")

    def rotate_webhook_secret(self, id: str) -> dict[str, Any]:
        return self._request("POST", f"/webhooks/{_enc(id)}/rotate-secret")

    def test_webhook(self, id: str) -> dict[str, Any]:
        return self._request("POST", f"/webhooks/{_enc(id)}/test")

    def list_webhook_deliveries(self, id: str) -> dict[str, Any]:
        return self._request("GET", f"/webhooks/{_enc(id)}/deliveries")

    def retry_webhook_delivery(self, id: str, delivery_id: str) -> dict[str, Any]:
        return self._request("POST", f"/webhooks/{_enc(id)}/deliveries/{_enc(delivery_id)}/retry")

    def list_webhook_events(self, id: str, *, cursor: Optional[str] = None, limit: Optional[int] = None) -> dict[str, Any]:
        """Oldest first after ``cursor``. ``nextCursor`` is returned even with nothing new: keep it."""
        return self._request("GET", f"/webhooks/{_enc(id)}/events", params=_page(limit, cursor))

    # ── Contacts ──────────────────────────────────────────────────────────────

    def list_contacts(self) -> dict[str, Any]:
        return self._request("GET", "/contacts")

    def create_contact(self, email: str, **fields: Any) -> dict[str, Any]:
        """Fields: first_name, last_name, company, phone, type."""
        return self._request("POST", "/contacts", json={"email": email, **_camel(fields)})

    def get_contact(self, id: str) -> dict[str, Any]:
        return self._request("GET", f"/contacts/{_enc(id)}")

    def update_contact(self, id: str, email: str, **fields: Any) -> dict[str, Any]:
        return self._request("PATCH", f"/contacts/{_enc(id)}", json={"email": email, **_camel(fields)})

    def delete_contact(self, id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/contacts/{_enc(id)}")

    # ── Transport ─────────────────────────────────────────────────────────────

    def _request(
        self, method: str, path: str, *, json: Any = None, params: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        # GET and DELETE are safe to repeat by nature; a POST is made safe by its
        # key. PATCH is not retried after a 5xx.
        headers = dict(self._headers)
        if method == "POST":
            headers["Idempotency-Key"] = str(uuid.uuid4())
        safe = method in ("GET", "DELETE", "POST")
        attempt = 0
        while True:
            try:
                res = self._http.request(method, self.base_url + path, headers=headers, json=json, params=params)
            except httpx.TransportError:
                if not safe or attempt >= self.max_retries:
                    raise
                time.sleep(_backoff(attempt, None))
                attempt += 1
                continue
            if res.is_success:
                return res.json() if res.content else {}
            err = _to_error(res)
            if not (err.status == 429 or (safe and err.retryable)) or attempt >= self.max_retries:
                raise err
            time.sleep(_backoff(attempt, err))
            attempt += 1


def _to_error(res: httpx.Response) -> YungleError:
    try:
        body = res.json().get("error") or {}
    except Exception:
        body = {}
    return YungleError(
        res.status_code,
        body.get("code", "http_error"),
        body.get("message", f"Request failed with status {res.status_code}."),
        body.get("details"),
    )


def _backoff(attempt: int, err: Optional[YungleError]) -> float:
    if err is not None and err.retry_after_seconds is not None:
        return err.retry_after_seconds
    return min(2**attempt * 0.5, 8.0) + random.random() * 0.25


def _page(limit: Optional[int], cursor: Optional[str]) -> dict[str, Any]:
    return _drop_none({"limit": limit, "cursor": cursor})


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _camel(fields: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for k, v in fields.items():
        head, *rest = k.split("_")
        out[head + "".join(w.title() for w in rest)] = v
    return out
