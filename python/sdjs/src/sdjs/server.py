"""Store server for `sdjs serve`. Standard library only.

Mirrors packages/cli/src/server.ts: the viewer at `/`, and under `/<token>/` (or
`/stores/` without a token) a `catalog.json` of the stores beneath the root plus
their files at `data/<path>`, with CORS, byte ranges and a loopback Host check.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
from dataclasses import dataclass
from email.utils import formatdate
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DATA_PREFIX = "data/"
SKIPPED_DIRS = {"node_modules", "__pycache__"}
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")
UNSAFE = re.compile(r"[\\/\0]")
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def is_store_name(name: str, is_dir: bool) -> bool:
    lower = name.lower()
    return lower.endswith(".zarr") if is_dir else lower.endswith(".zarr.zip")


def _skipped(name: str) -> bool:
    return name.startswith(".") or name in SKIPPED_DIRS


@dataclass(frozen=True)
class ServedRoot:
    dir: Path
    only: str | None = None  # set when a single store was given as the root


def resolve_served_root(path: Path) -> ServedRoot:
    path = path.expanduser().resolve()
    if is_store_name(path.name, path.is_dir()) and path.exists():
        return ServedRoot(path.parent, path.name)
    if not path.is_dir():
        raise SystemExit(f"{path} is neither a directory nor a .zarr / .zarr.zip store")
    return ServedRoot(path)


def find_stores(root: ServedRoot, max_depth: int = 8) -> list[str]:
    """Stores under the root, stopping at each; symlinks are followed once."""
    if root.only:
        return [root.only]
    found: list[str] = []
    seen: set[str] = set()

    def walk(directory: Path, rel: list[str], depth: int) -> None:
        try:
            real = os.path.realpath(directory)
            names = sorted(os.listdir(directory))
        except OSError:
            return
        if real in seen:
            return
        seen.add(real)
        for name in names:
            if _skipped(name):
                continue
            child = directory / name
            is_dir = child.is_dir()
            if is_store_name(name, is_dir):
                found.append("/".join([*rel, name]))
            elif is_dir and depth < max_depth:
                walk(child, [*rel, name], depth + 1)

    walk(root.dir, [], 0)
    return found


def _read_json(path: Path):
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _root_attributes(store: Path) -> dict | None:
    v3 = _read_json(store / "zarr.json")
    if isinstance(v3, dict):
        attrs = v3.get("attributes")
        return attrs if isinstance(attrs, dict) else {}
    if _read_json(store / ".zgroup") is None:
        return None
    v2 = _read_json(store / ".zattrs")
    return v2 if isinstance(v2, dict) else {}


def classify_store(path: Path) -> str | None:
    """"spatialdata", "zarr" (a zarr group without SpatialData's root attributes),
    "unknown" (no zarr root metadata), or None for a zip, which is not inspected:
    finding a member means reading the whole central directory."""
    if is_store_name(path.name, False):
        return None
    attrs = _root_attributes(path)
    if attrs is None:
        return "unknown"
    return "spatialdata" if "spatialdata_attrs" in attrs else "zarr"


def build_catalog(root: ServedRoot, stores: list[str]) -> dict:
    entries = []
    for p in stores:
        entry = {"path": p, "url": DATA_PREFIX + "/".join(urllib.parse.quote(s, safe="") for s in p.split("/"))}
        kind = classify_store(root.dir.joinpath(*p.split("/")))
        if kind:
            entry["kind"] = kind
        entries.append(entry)
    return {"version": 1, "name": root.only or root.dir.name, "stores": entries}


def is_servable_path(segments: list[str], only: str | None = None) -> bool:
    """Whether decoded request segments lie inside a store. Hidden names are refused
    only above the store, since `.zattrs` and friends live inside it."""
    if any(s in ("", ".", "..") or UNSAFE.search(s) for s in segments):
        return False
    last = len(segments) - 1
    store = next((i for i, s in enumerate(segments)
                  if is_store_name(s, True) or (i == last and is_store_name(s, False))), -1)
    if store < 0 or any(_skipped(s) for s in segments[:store]):
        return False
    return only is None or (store == 0 and segments[0] == only)


def parse_range(header: str | None, size: int) -> tuple[int, int] | str | None:
    """(start, end) inclusive, "unsatisfiable", or None for the whole file."""
    match = RANGE.match(header.strip()) if header else None
    if not match or match.groups() == ("", ""):
        return None
    first, last = match.groups()
    if first == "":
        start, end = max(0, size - int(last)), size - 1
    else:
        start, end = int(first), (min(int(last), size - 1) if last else size - 1)
    if start >= size or start > end:
        return "unsatisfiable"
    return start, end


def stores_prefix(token: str | None) -> str:
    return f"/{token}/" if token else "/stores/"


class _Handler(BaseHTTPRequestHandler):
    root: ServedRoot
    prefix: str
    app_dir: Path | None
    loopback_only: bool
    max_depth: int

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
        pass

    def _host_ok(self) -> bool:
        if not self.loopback_only:
            return True
        host = self.headers.get("Host", "")
        name = host[: host.find("]") + 1] if host.startswith("[") else host.split(":")[0]
        return name in LOOPBACK_HOSTS

    def _dispatch(self) -> None:
        if not self._host_ok():
            self._plain(HTTPStatus.FORBIDDEN, b"Forbidden host")
            return
        path = self.path.split("?", 1)[0]
        if path.startswith(self.prefix):
            self._stores(path[len(self.prefix):])
        else:
            self._app(path)

    do_GET = do_HEAD = do_OPTIONS = _dispatch

    def _plain(self, status: HTTPStatus, body: bytes = b"Not found",
               headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _stores(self, rest: str) -> None:
        cors = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
            "Cache-Control": "no-cache",
        }
        if self.command == "OPTIONS":
            self.send_response(HTTPStatus.NO_CONTENT)
            for k, v in cors.items():
                self.send_header(k, v)
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Range")
            # Chrome asks before a public page (such as a sandboxed widget) reads localhost.
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
            return
        if rest == "catalog.json":
            body = json.dumps(build_catalog(self.root, find_stores(self.root, self.max_depth))).encode()
            self.send_response(HTTPStatus.OK)
            for k, v in cors.items():
                self.send_header(k, v)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        if rest.startswith(DATA_PREFIX):
            try:
                segments = [urllib.parse.unquote(s, errors="strict")
                            for s in rest[len(DATA_PREFIX):].split("/")]
            except UnicodeDecodeError:
                segments = []
            if is_servable_path(segments, self.root.only) and self._file(
                    self.root.dir.joinpath(*segments), cors):
                return
        self._plain(HTTPStatus.NOT_FOUND, headers=cors)

    def _app(self, path: str) -> None:
        if self.app_dir is None or self.command == "OPTIONS":
            self._plain(HTTPStatus.NOT_FOUND)
            return
        try:
            segments = [urllib.parse.unquote(s, errors="strict") for s in path.split("/") if s]
        except UnicodeDecodeError:
            segments = [".."]
        if any(s == ".." or s.startswith(".") or UNSAFE.search(s) for s in segments):
            self._plain(HTTPStatus.NOT_FOUND)
            return
        if segments and self._file(self.app_dir.joinpath(*segments), {}):
            return
        # The viewer routes by path (/headless, /codec…), so extensionless paths get the page.
        if (not segments or not os.path.splitext(path)[1]) and self._file(
                self.app_dir / "index.html", {"Cache-Control": "no-cache"}):
            return
        self._plain(HTTPStatus.NOT_FOUND)

    def _file(self, path: Path, headers: dict[str, str]) -> bool:
        try:
            f = open(path, "rb")  # noqa: SIM115 - closed below
        except OSError:
            return False
        with f:
            st = os.fstat(f.fileno())
            if not os.path.isfile(path):
                return False
            size = st.st_size
            rng = parse_range(self.headers.get("Range"), size)
            if rng == "unsatisfiable":
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return True
            start, end = rng if isinstance(rng, tuple) else (0, size - 1)
            self.send_response(HTTPStatus.PARTIAL_CONTENT if rng else HTTPStatus.OK)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Content-Type", MIME.get(path.suffix.lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", formatdate(st.st_mtime, usegmt=True))
            if rng:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if self.command == "HEAD":
                return True
            f.seek(start)
            remaining = end - start + 1
            try:
                while remaining > 0:
                    chunk = f.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return True


def create_server(root: ServedRoot, token: str | None, app_dir: Path | None, host: str,
                  port: int, loopback_only: bool, max_depth: int = 8) -> ThreadingHTTPServer:
    handler = type("Handler", (_Handler,), {
        "root": root, "prefix": stores_prefix(token), "app_dir": app_dir,
        "loopback_only": loopback_only, "max_depth": max_depth,
    })
    return ThreadingHTTPServer((host, port), handler)
