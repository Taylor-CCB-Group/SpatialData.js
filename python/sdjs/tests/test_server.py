"""Mirrors packages/cli/tests/server.test.ts: both servers must behave the same."""

from __future__ import annotations

import http.client
import json
import os
import socket
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from sdjs.server import create_server, find_stores, is_servable_path, parse_range, resolve_served_root

TOKEN = "tok"
SD_ROOT = '{"zarr_format":3,"node_type":"group","attributes":{"spatialdata_attrs":{"version":"0.2"}}}'


def start(root: Path, token: str | None, app: Path | None = None):
    server = create_server(resolve_served_root(root), token, app, "127.0.0.1", 0, True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def fetch(url: str, method: str = "GET", headers: dict | None = None):
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, b""


@pytest.fixture(scope="module")
def tree(tmp_path_factory):
    d = tmp_path_factory.mktemp("sdjs")
    (d / "a.zarr" / "images").mkdir(parents=True)
    (d / "a.zarr" / "zarr.json").write_text(SD_ROOT)
    (d / "a.zarr" / ".zattrs").write_text("{}")
    (d / "a.zarr" / "images" / "chunk").write_bytes(b"0123456789")
    (d / "project" / "run 1" / "b.zarr" / "inner.zarr").mkdir(parents=True)
    (d / "project" / "c.zarr.zip").write_bytes(b"PK")
    # zarr v2 SpatialData, and a zarr group that is not SpatialData.
    (d / "other" / "v2.zarr").mkdir(parents=True)
    (d / "other" / "v2.zarr" / ".zgroup").write_text('{"zarr_format":2}')
    (d / "other" / "v2.zarr" / ".zattrs").write_text('{"spatialdata_attrs":{}}')
    (d / "other" / "plain.zarr").mkdir(parents=True)
    (d / "other" / "plain.zarr" / "zarr.json").write_text('{"zarr_format":3,"node_type":"group"}')
    (d / "other" / "bad.zarr").mkdir(parents=True)
    (d / "other" / "bad.zarr" / "zarr.json").write_text("{not json")
    (d / ".hidden" / "d.zarr").mkdir(parents=True)
    (d / "secret.txt").write_text("nope")
    os.symlink(d, d / "project" / "loop")
    (d / "app").mkdir()
    (d / "app" / "index.html").write_text("<html>viewer</html>")
    server, base = start(d, TOKEN, d / "app")
    yield d, base
    server.shutdown()


def test_catalog_lists_nested_stores(tree):
    _, base = tree
    status, headers, body = fetch(f"{base}/{TOKEN}/catalog.json")
    assert headers["Access-Control-Allow-Origin"] == "*"
    catalog = json.loads(body)
    assert catalog["version"] == 1
    assert catalog["stores"] == [
        {"path": "a.zarr", "url": "data/a.zarr", "kind": "spatialdata"},
        # Malformed metadata flags that store rather than failing the catalog.
        {"path": "other/bad.zarr", "url": "data/other/bad.zarr", "kind": "unknown"},
        {"path": "other/plain.zarr", "url": "data/other/plain.zarr", "kind": "zarr"},
        {"path": "other/v2.zarr", "url": "data/other/v2.zarr", "kind": "spatialdata"},
        # Zips are listed without being inspected.
        {"path": "project/c.zarr.zip", "url": "data/project/c.zarr.zip"},
        {"path": "project/run 1/b.zarr", "url": "data/project/run%201/b.zarr", "kind": "unknown"},
    ]


def test_catalog_is_gated_by_token(tree):
    _, base = tree
    assert fetch(f"{base}/other/catalog.json")[0] == 404
    assert fetch(f"{base}/stores/catalog.json")[0] == 404


def test_single_store_root(tree):
    d, _ = tree
    server, base = start(d / "a.zarr", None)
    try:
        catalog = json.loads(fetch(f"{base}/stores/catalog.json")[2])
        assert catalog["stores"] == [{"path": "a.zarr", "url": "data/a.zarr", "kind": "spatialdata"}]
        assert fetch(f"{base}/stores/data/a.zarr/zarr.json")[0] == 200
        assert fetch(f"{base}/stores/data/project/c.zarr.zip")[0] == 404
    finally:
        server.shutdown()


def test_serves_inside_stores_only(tree):
    _, base = tree
    data = f"{base}/{TOKEN}/data"
    assert fetch(f"{data}/a.zarr/zarr.json")[2] == SD_ROOT.encode()
    assert fetch(f"{data}/a.zarr/.zattrs")[0] == 200
    assert fetch(f"{data}/project/run%201/b.zarr/inner.zarr")[0] == 404
    for path in ["secret.txt", "a.zarr/%2e%2e/secret.txt", ".hidden/d.zarr", "a.zarr%2f..%2fsecret.txt"]:
        assert fetch(f"{data}/{path}")[0] == 404, path
    # Windows pathlib joins `C:..` as `..` on that drive.
    assert not is_servable_path(["a.zarr", "C:..", "secret.txt"])
    assert is_servable_path(["a.zarr", "images", "chunk"])


def test_dot_segments_are_refused_unnormalised(tree):
    # urllib would normalise `..` away, so send the raw request line.
    _, base = tree
    conn = http.client.HTTPConnection(base.removeprefix("http://"))
    conn.request("GET", f"/{TOKEN}/data/a.zarr/../secret.txt")
    assert conn.getresponse().status == 404


def test_ranges(tree):
    _, base = tree
    url = f"{base}/{TOKEN}/data/a.zarr/images/chunk"
    status, headers, body = fetch(url, headers={"Range": "bytes=2-4"})
    assert (status, headers["Content-Range"], body) == (206, "bytes 2-4/10", b"234")
    assert fetch(url, headers={"Range": "bytes=7-"})[2] == b"789"
    assert fetch(url, headers={"Range": "bytes=-3"})[2] == b"789"
    status, headers, _ = fetch(url, headers={"Range": "bytes=20-"})
    assert (status, headers["Content-Range"]) == (416, "bytes */10")


def test_head_and_preflight(tree):
    _, base = tree
    url = f"{base}/{TOKEN}/data/a.zarr/images/chunk"
    assert fetch(url, "HEAD")[1]["Content-Length"] == "10"
    status, headers, _ = fetch(url, "OPTIONS", {"Access-Control-Request-Private-Network": "true"})
    assert status == 204
    assert headers["Access-Control-Allow-Headers"] == "Range"
    assert headers["Access-Control-Allow-Private-Network"] == "true"


def test_app_routes(tree):
    _, base = tree
    assert b"viewer" in fetch(f"{base}/")[2]
    assert b"viewer" in fetch(f"{base}/headless")[2]
    assert fetch(f"{base}/missing.js")[0] == 404


def test_refuses_non_loopback_host(tree):
    _, base = tree
    conn = http.client.HTTPConnection(base.removeprefix("http://"))
    conn.request("GET", "/", headers={"Host": "evil.example:80"})
    assert conn.getresponse().status == 403


def test_parse_range_fallbacks():
    assert parse_range(None, 10) is None
    assert parse_range("bytes=0-1,4-5", 10) is None
    assert parse_range("bytes=-", 10) is None
    assert parse_range("bytes=-20", 10) == (0, 9)


@pytest.mark.skipif(sys.platform == "win32" or os.geteuid() == 0,
                    reason="needs POSIX permissions that apply to this user")
def test_discovery_skips_entries_it_cannot_stat(tmp_path):
    (tmp_path / "ok.zarr").mkdir()
    (tmp_path / "locked" / "sub").mkdir(parents=True)
    # Listable but not searchable: listing works, stat-ing an entry does not.
    os.chmod(tmp_path / "locked", 0o444)
    try:
        assert find_stores(resolve_served_root(tmp_path)) == ["ok.zarr"]
    finally:
        os.chmod(tmp_path / "locked", 0o755)


@pytest.mark.skipif(not socket.has_ipv6, reason="no IPv6")
def test_serves_on_ipv6_loopback(tmp_path):
    (tmp_path / "a.zarr").mkdir()
    server = create_server(resolve_served_root(tmp_path), None, None, "::1", 0, True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        status, _, body = fetch(f"http://[::1]:{server.server_address[1]}/stores/catalog.json")
        assert status == 200 and json.loads(body)["stores"][0]["path"] == "a.zarr"
    finally:
        server.shutdown()
