import base64
import json
import os
import tempfile
import time

import httpx

from yungle.upload import token_expiry, upload_file

MiB = 1024 * 1024


def _token(exp_s: float, tag: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"scope": "upload", "sub": "f1", "exp": exp_s * 1000, "t": tag}).encode())
    return payload.decode().rstrip("=") + ".sig"


def test_token_expiry_reads_exp_in_seconds():
    assert token_expiry(_token(1234.5, "a")) == 1234.5
    assert token_expiry("garbage") is None


def test_a_token_past_half_life_is_renewed_and_the_new_one_is_used():
    now = time.time()
    # Issued long ago, 10 minutes left: past half its life, so the first request renews.
    old = _token(now + 600, "old")
    new = _token(now + 7200, "new")
    seen: list[tuple[str, str, str]] = []
    offset = {"v": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        tok = req.headers.get("x-yungle-upload-token", "")
        seen.append((req.method, req.url.path, tok))
        if req.url.path == "/api/uploads/token":
            assert tok == old
            return httpx.Response(200, json={"fileId": "f1", "uploadToken": new, "expiresAt": "x"})
        assert tok == new, f"{req.method} sent a stale token"
        if req.method == "POST":
            return httpx.Response(201, headers={"Location": "/files/f1"})
        if req.method == "HEAD":
            return httpx.Response(200, headers={"Upload-Offset": str(offset["v"])})
        offset["v"] += len(req.content)
        return httpx.Response(204, headers={"Upload-Offset": str(offset["v"])})

    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(b"x" * 1000)
    try:
        target = {"id": "f1", "name": "a.bin", "size": 1000, "uploadToken": old}
        stored: list[str] = []
        client = httpx.Client(transport=httpx.MockTransport(handler))
        # Make the keeper believe the token was issued 2h before its expiry.
        import yungle.upload as up

        real_init = up._TokenKeeper.__init__

        def init(self, *a, **kw):
            real_init(self, *a, **kw)
            self.issued = now - 7200 + 600

        up._TokenKeeper.__init__ = init
        try:
            upload_file("http://h/files", target, f.name, http=client, on_token=stored.append)
        finally:
            up._TokenKeeper.__init__ = real_init
        assert target["uploadToken"] == new, "the target dict carries the renewed token"
        assert stored == [new], "on_token hears about it once"
        assert [s[1] for s in seen].count("/api/uploads/token") == 1, "renewed once, not per request"
    finally:
        os.unlink(f.name)


def test_renewal_can_be_disabled():
    now = time.time()
    old = _token(now + 600, "old")

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path != "/api/uploads/token"
        if req.method == "POST":
            return httpx.Response(201, headers={"Location": "/files/f1"})
        if req.method == "HEAD":
            return httpx.Response(200, headers={"Upload-Offset": "0"})
        return httpx.Response(204, headers={"Upload-Offset": str(len(req.content))})

    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(b"y" * 10)
    try:
        target = {"id": "f1", "name": "a.bin", "size": 10, "uploadToken": old}
        upload_file("http://h/files", target, f.name, http=httpx.Client(transport=httpx.MockTransport(handler)), renew_url=None)
    finally:
        os.unlink(f.name)
