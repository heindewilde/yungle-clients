import os

import httpx

from yungle.download import download_links, safe_dir, safe_name


def test_paths_cannot_escape():
    assert safe_dir("../../.ssh") == ".ssh"
    assert safe_dir("/Selects/Day 1/") == "Selects/Day 1"
    assert safe_name("../../etc/passwd") == "passwd"
    assert safe_name("..") == "file"


def test_downloads_keep_folders_resume_and_skip(tmp_path):
    data = b"0123456789" * 100
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.headers.get("range"))
        rng = req.headers.get("range")
        if rng:
            start = int(rng.split("=")[1].rstrip("-"))
            return httpx.Response(206, content=data[start:])
        return httpx.Response(200, content=data)

    links = {
        "e2ee": False,
        "files": [
            {"name": "a.bin", "size": len(data), "path": "Raw/Day1", "downloadUrl": "http://h/dl/1"},
            {"name": "a.bin", "size": len(data), "path": "Raw/Day1", "downloadUrl": "http://h/dl/2"},
        ],
    }
    # A partial from an interrupted run.
    os.makedirs(tmp_path / "Raw/Day1")
    (tmp_path / "Raw/Day1/a.bin.part").write_bytes(data[:300])
    client = httpx.Client(transport=httpx.MockTransport(handler))
    out = download_links(links, str(tmp_path), http=client)
    assert [os.path.relpath(p, tmp_path) for p in out] == ["Raw/Day1/a.bin", "Raw/Day1/a (2).bin"]
    assert (tmp_path / "Raw/Day1/a.bin").read_bytes() == data
    assert (tmp_path / "Raw/Day1/a (2).bin").read_bytes() == data
    assert calls[0] == "bytes=300-", "the partial resumed with Range"

    calls.clear()
    download_links(links, str(tmp_path), http=client)
    assert calls == [], "a second run skips files already whole"
