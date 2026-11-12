#!/usr/bin/env python3
"""Serve a directory of SpatialData stores for SpatialData.js. Standard library only.

`python -m http.server` ignores Range and sends no CORS headers, so a browser
viewer cannot read a store from it. This adds what the reader needs: bounded and
suffix byte ranges, CORS with a preflight that allows Range, exposed
Content-Range, and no-cache so a rewritten store is not mixed with stale copies.

    python serve_store.py ~/data                  # http://127.0.0.1:8000/<token>/<store>.zarr
    python serve_store.py ~/data --port 9000

CORS has to allow any origin (sandboxed viewers send `Origin: null`), so any web
page could otherwise read the files from loopback. Every URL therefore carries a
random token: share it like a password. `--no-token` drops it for a stable URL.
It binds to loopback; use --host 0.0.0.0 only on a network you trust.
"""

from __future__ import annotations

import argparse
import functools
import os
import re
import secrets
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class _Window:
    """A file object that yields only `length` bytes, for copyfile()."""

    def __init__(self, f, length: int) -> None:
        self.f, self.remaining = f, length

    def read(self, n: int = -1) -> bytes:
        if self.remaining <= 0:
            return b""
        n = self.remaining if n < 0 else min(n, self.remaining)
        data = self.f.read(n)
        self.remaining -= len(data)
        return data

    def close(self) -> None:
        self.f.close()


class StoreHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, token: str | None, **kwargs) -> None:
        self.prefix = f"/{token}" if token else ""
        super().__init__(*args, **kwargs)

    def admitted(self) -> bool:
        path = self.path.split("?", 1)[0]
        if not self.prefix or path == self.prefix or path.startswith(self.prefix + "/"):
            return True
        self.send_error(HTTPStatus.NOT_FOUND)
        return False

    def translate_path(self, path: str) -> str:
        return super().translate_path(path[len(self.prefix):] or "/")

    def do_GET(self) -> None:
        if self.admitted():
            super().do_GET()

    def do_HEAD(self) -> None:
        if self.admitted():
            super().do_HEAD()

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Length, Content-Range, Accept-Ranges, ETag")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        if not self.admitted():
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range")
        # Chrome asks before a public page (such as a sandboxed widget) reads localhost.
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        rng = self.headers.get("Range")
        if not rng or os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        size = os.fstat(f.fileno()).st_size
        match = RANGE.match(rng.strip())
        if not match or match.groups() == ("", ""):
            f.close()  # multi-range or another unit: a full 200 is allowed
            return super().send_head()
        first, last = match.groups()
        if first == "":  # suffix: the last N bytes
            start, end = max(0, size - int(last)), size - 1
        else:
            start, end = int(first), min(int(last), size - 1) if last else size - 1
        if start >= size or start > end:
            f.close()
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        f.seek(start)
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return _Window(f, end - start + 1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory", help="Directory containing one or more .zarr stores")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-token", action="store_true",
                        help="Serve at the root path, readable by any page that can reach the port")
    args = parser.parse_args()
    root = os.path.abspath(os.path.expanduser(args.directory))
    token = None if args.no_token else secrets.token_urlsafe(16)
    handler = functools.partial(StoreHandler, directory=root, token=token)
    with ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        stores = sorted(n for n in os.listdir(root) if n.endswith((".zarr", ".zip")))
        base = f"http://{args.host}:{args.port}" + (f"/{token}" if token else "")
        print(f"Serving {root} at {base}/", flush=True)
        for name in stores:
            print(f"  {base}/{name}", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
