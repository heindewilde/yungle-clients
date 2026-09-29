import json

import httpx
import pytest

from yungle import Yungle, YungleError
from yungle.upload import chunk_size, upload_file


def client_with(handler, **kw):
    return Yungle("yk_live_test", base_url="http://x/v1", http=httpx.Client(transport=httpx.MockTransport(handler)), **kw)


def test_key_is_required(monkeypatch):
    monkeypatch.delenv("YUNGLE_API_KEY", raising=False)
    with pytest.raises(ValueError):
        Yungle()


def test_bearer_and_user_agent():
    seen = {}

    def handler(req):
        seen.update(req.headers)
        return httpx.Response(200, json={"ok": True})

    client_with(handler).me()
    assert seen["authorization"] == "Bearer yk_live_test"
    assert seen["user-agent"].startswith("yungle-python/")


def test_post_retries_with_one_idempotency_key(monkeypatch):
    monkeypatch.setattr("yungle.client.time.sleep", lambda s: None)
    keys = []

    def handler(req):
        keys.append(req.headers.get("idempotency-key"))
        if len(keys) == 1:
            return httpx.Response(503, json={"error": {"code": "internal_error", "message": "x"}})
        return httpx.Response(201, json={"contact": {"id": "c1"}})

    assert client_with(handler).create_contact("a@example.com", first_name="Anna")["contact"]["id"] == "c1"
    assert len(keys) == 2 and keys[0] and keys[0] == keys[1]


def test_patch_is_not_retried_after_a_5xx():
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(503, json={"error": {"code": "internal_error", "message": "x"}})

    with pytest.raises(YungleError) as e:
        client_with(handler).update_transfer("t1", expires_in_days=3)
    assert len(calls) == 1 and e.value.retryable


def test_error_carries_code_and_details():
    def handler(req):
        return httpx.Response(402, json={"error": {"code": "upgrade_required", "message": "Needs a plan", "details": {"a": 1}}})

    with pytest.raises(YungleError) as e:
        client_with(handler).create_collection("x")
    assert (e.value.status, e.value.code, e.value.details) == (402, "upgrade_required", {"a": 1})
    assert not e.value.retryable


def test_contact_fields_become_camel_case():
    bodies = []

    def handler(req):
        bodies.append(json.loads(req.content))
        return httpx.Response(201, json={})

    client_with(handler).create_contact("a@example.com", first_name="Anna", last_name="B")
    assert bodies[0] == {"email": "a@example.com", "firstName": "Anna", "lastName": "B"}


def test_all_transfers_walks_pages():
    urls = []

    def handler(req):
        urls.append(str(req.url))
        if "cursor" not in req.url.params:
            return httpx.Response(200, json={"transfers": [{"id": "a"}, {"id": "b"}], "nextCursor": "v1.b"})
        return httpx.Response(200, json={"transfers": [{"id": "c"}], "nextCursor": None})

    assert [t["id"] for t in client_with(handler).all_transfers(page_size=2)] == ["a", "b", "c"]
    assert "cursor=v1.b" in urls[1] and "limit=2" in urls[0]


def test_chunk_size_floor_and_growth():
    MiB = 1024 * 1024
    assert chunk_size(1) == 64 * MiB
    assert chunk_size(900 * 1024 * MiB) > 64 * MiB


def test_upload_continues_from_the_offset_the_server_returns(tmp_path):
    data = bytes(range(256)) * 400  # 100 KiB
    path = tmp_path / "f.bin"
    path.write_bytes(data)
    received = bytearray()
    patches = []

    def handler(req):
        assert req.headers["x-yungle-upload-token"] == "tok"
        if req.method == "POST":
            assert req.headers["upload-length"] == str(len(data))
            return httpx.Response(201, headers={"Location": "/files/u1"})
        if req.method == "HEAD":
            return httpx.Response(200, headers={"Upload-Offset": str(len(received))})
        off = int(req.headers["upload-offset"])
        patches.append(off)
        body = req.content
        # The first PATCH commits only half: the server's part boundary.
        keep = len(body) // 2 if len(patches) == 1 else len(body)
        received[off:] = body[:keep]
        return httpx.Response(204, headers={"Upload-Offset": str(off + keep)})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    url = upload_file("http://x/files", {"id": "f1", "name": "f.bin", "uploadToken": "tok"}, str(path), http=http)
    assert url == "http://x/files/u1"
    assert bytes(received) == data
    assert patches == [0, len(data) // 2]


def test_verify_webhook():
    import hashlib
    import hmac as _hmac

    from yungle import verify_webhook

    body = b'{"id":"evt_1"}'
    t = 1_700_000_000
    header = f"t={t},v1=" + _hmac.new(b"whsec_s", f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    assert verify_webhook(body, header, "whsec_s", now=t + 5)
    assert not verify_webhook(body + b" ", header, "whsec_s", now=t + 5)
    assert not verify_webhook(body, header, "whsec_other", now=t + 5)
    assert not verify_webhook(body, header, "whsec_s", now=t + 400)
    assert not verify_webhook(body, "garbage", "whsec_s", now=t)


def test_create_pull_webhook_sends_null_url():
    bodies = []

    def handler(req):
        bodies.append(json.loads(req.content))
        return httpx.Response(201, json={"webhook": {}, "secret": "whsec_x"})

    client_with(handler).create_webhook(None, ["transfer.ready"])
    assert bodies[0] == {"url": None, "events": ["transfer.ready"]}


def test_error_carries_docs_link():
    docs = "https://yungle.co/developers/errors#quota_exceeded"

    def handler(req):
        return httpx.Response(413, json={"error": {"code": "quota_exceeded", "message": "Full.", "docs": docs}})

    with pytest.raises(YungleError) as e:
        client_with(handler, max_retries=0).me()
    assert e.value.docs == docs


def test_retry_after_header_counts_when_the_body_states_no_wait():
    # The monthly-allowance 429: details carry only the limit, the wait is in the header.
    def handler(req):
        return httpx.Response(
            429,
            headers={"retry-after": "3600"},
            json={"error": {"code": "rate_limited", "message": "Allowance used.", "details": {"limit": 10000}}},
        )

    with pytest.raises(YungleError) as e:
        client_with(handler, max_retries=0).me()
    assert e.value.retry_after_seconds == 3600


def test_body_wins_over_header():
    err = YungleError(429, "rate_limited", "m", {"retryAfterSeconds": 12}, retry_after_header=60)
    assert err.retry_after_seconds == 12


def test_parse_retry_after():
    from yungle.errors import parse_retry_after

    now = 1790510400.0  # 2026-09-27T12:00:00Z
    assert parse_retry_after("120", now) == 120
    assert parse_retry_after("Sun, 27 Sep 2026 12:01:30 GMT", now) == 90
    assert parse_retry_after("Sun, 27 Sep 2026 11:00:00 GMT", now) is None
    assert parse_retry_after("-5", now) is None
    assert parse_retry_after("soon", now) is None
    assert parse_retry_after(None, now) is None
