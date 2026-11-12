#!/usr/bin/env python3
"""Check that a SpatialData store URL is served the way SpatialData.js reads it.

Makes the same request shapes the browser runtime makes, with an Origin header
so CORS is exercised, and explains each failure. Standard library only.

    python check_hosting.py https://example.org/data/xenium.zarr
    python check_hosting.py http://127.0.0.1:8000/blobs.zarr --origin https://abc.claudemcpcontent.com

Exit status is 1 if any check fails.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BROWSER_HEADERS = {"Accept-Encoding": "gzip, deflate, br", "User-Agent": "spatialdata-js-check/1"}

results: list[tuple[str, str, str]] = []  # (status, check, detail)


def record(status: str, check: str, detail: str = "") -> None:
    results.append((status, check, detail))


def request(url: str, origin: str, method: str = "GET", headers: dict | None = None,
            read: bool = True) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, method=method,
                                 headers={**BROWSER_HEADERS, "Origin": origin, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read() if read and method != "HEAD" else b""
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, body
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, b""


def header_list(headers: dict, name: str) -> set[str]:
    return {h.strip().lower() for h in headers.get(name, "").split(",") if h.strip()}


def check_cors(headers: dict, origin: str, label: str) -> bool:
    allow = headers.get("access-control-allow-origin")
    if allow in ("*", origin):
        return True
    record("FAIL", f"{label}: CORS", f"Access-Control-Allow-Origin is {allow!r}; the browser will "
           f"refuse the response for a page at {origin}. Send '*' or echo the Origin.")
    return False


def check_file(url: str, origin: str, label: str, suffix: bool = True) -> None:
    """The range shapes zarr shards and Parquet readers need, against one file.
    A zip archive is sized with HEAD and read with bounded ranges only."""
    status, headers, _ = request(url, origin, "HEAD")
    if status != 200:
        record("FAIL", f"{label}: HEAD", f"status {status}. Readers size files with HEAD "
               "(zarrita for shard indexes, the zip reader for the archive).")
    elif "content-length" not in headers:
        record("FAIL", f"{label}: HEAD", "no Content-Length; readers size files from it.")
    elif check_cors(headers, origin, f"{label}: HEAD"):
        record("PASS", f"{label}: HEAD", f"Content-Length {headers['content-length']}")

    shapes = [("bounded range", "bytes=0-7")] + ([("suffix range", "bytes=-8")] if suffix else [])
    for shape, rng in shapes:
        status, headers, body = request(url, origin, headers={"Range": rng})
        check = f"{label}: {shape} ({rng})"
        if status == 200:
            record("FAIL", check, "200 with the whole body: the server ignores Range. Readers would "
                   "download whole files, and Parquet offsets come out wrong.")
            continue
        if status == 416:
            record("FAIL", check, "416. Many static servers refuse suffix ranges; SpatialData.js then "
                   "falls back to whole-file Parquet reads, which are slow on large points.")
            continue
        if status != 206:
            record("FAIL", check, f"status {status}")
            continue
        if not check_cors(headers, origin, check):
            continue
        problems = []
        if headers.get("content-encoding", "identity") != "identity":
            problems.append(f"Content-Encoding {headers['content-encoding']} on a range: byte offsets "
                            "refer to the encoded body. Disable compression for .zarr/.parquet paths.")
        if len(body) != 8:
            problems.append(f"returned {len(body)} bytes, expected 8")
        if "content-range" not in headers:
            problems.append("no Content-Range header")
        exposed = header_list(headers, "access-control-expose-headers")
        if "content-range" not in exposed and "*" not in exposed:
            problems.append("Content-Range is not in Access-Control-Expose-Headers, so the browser "
                            "hides it; Parquet readers learn the file size from it.")
        if problems:
            record("FAIL", check, " ".join(problems))
        else:
            record("PASS", check, headers.get("content-range", ""))


def check_preflight(url: str, origin: str) -> None:
    """Range is not a CORS-safelisted header, so every ranged read is preflighted."""
    status, headers, _ = request(url, origin, "OPTIONS", headers={
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "range",
    })
    allowed = header_list(headers, "access-control-allow-headers")
    if status >= 300:
        record("FAIL", "CORS preflight", f"OPTIONS returned {status}; ranged reads will be blocked.")
    elif headers.get("access-control-allow-origin") not in ("*", origin):
        record("FAIL", "CORS preflight", "no matching Access-Control-Allow-Origin on the OPTIONS reply.")
    elif "range" not in allowed and "*" not in allowed:
        record("FAIL", "CORS preflight", f"Access-Control-Allow-Headers is {sorted(allowed)}; "
               "it must include Range.")
    else:
        record("PASS", "CORS preflight", f"status {status}")


def find_parquet(store: str, origin: str, metadata: dict) -> str | None:
    """First points element's Parquet. A directory of parts cannot be listed over HTTP,
    so try the single-file layout, then the first part spatialdata writes. Static
    servers often answer a directory with an HTML listing, which is not the file."""
    keys = sorted({k.split("/")[1] for k in metadata if k.startswith("points/")})
    for key in keys:
        for path in (f"points/{key}/points.parquet", f"points/{key}/points.parquet/part.0.parquet"):
            status, headers, _ = request(f"{store}/{path}", origin, "HEAD")
            if status == 200 and not headers.get("content-type", "").startswith("text/html"):
                return f"{store}/{path}"
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("store_url", help="URL of the .zarr store root, or of a zipped store (.zip)")
    parser.add_argument("--origin", default="https://example.org",
                        help="Origin of the page that will read the store (default: %(default)s)")
    parser.add_argument("--parquet", help="Store-relative Parquet path to range-test "
                        "(default: first points element)")
    parser.add_argument("--json", action="store_true", help="Print results as JSON")
    args = parser.parse_args()
    store = args.store_url.rstrip("/")

    if urllib.parse.urlparse(store).path.lower().endswith(".zip"):
        check_preflight(store, args.origin)
        check_file(store, args.origin, "zip archive", suffix=False)
        report(args.json)
        return

    metadata: dict = {}
    status, headers, body = request(f"{store}/zarr.json", args.origin)
    meta_url = f"{store}/zarr.json"
    if status == 200:
        metadata = (json.loads(body).get("consolidated_metadata") or {}).get("metadata") or {}
    else:
        for name in ("zmetadata", ".zmetadata"):  # zarr v2
            status, headers, body = request(f"{store}/{name}", args.origin)
            if status == 200:
                meta_url, metadata = f"{store}/{name}", json.loads(body).get("metadata") or {}
                break
    if status != 200:
        record("FAIL", "store metadata", f"no zarr.json or zmetadata at {store} (last status {status}).")
    elif check_cors(headers, args.origin, "store metadata"):
        if metadata:
            record("PASS", "store metadata", f"consolidated metadata, {len(metadata)} entries")
        else:
            record("FAIL", "store metadata", "no consolidated metadata. Directories cannot be listed "
                   "over HTTP, so the browser cannot discover elements. Consolidate before serving.")
        cache = headers.get("cache-control")
        if not cache or "no-cache" not in cache:
            record("WARN", "caching", f"Cache-Control {cache!r}. If this store is rewritten in place, "
                   "browsers can mix stale metadata with new chunks. Use no-cache, or a new URL per rewrite.")

    check_preflight(meta_url, args.origin)
    check_file(meta_url, args.origin, "metadata file")
    parquet = f"{store}/{args.parquet}" if args.parquet else find_parquet(store, args.origin, metadata)
    if parquet:
        check_file(parquet, args.origin, "points parquet")
    elif any(k.startswith("points/") for k in metadata):
        record("WARN", "points parquet", "points elements exist but no Parquet was found to test; "
               "pass --parquet")

    report(args.json)


def report(as_json: bool) -> None:
    if as_json:
        print(json.dumps([{"status": s, "check": c, "detail": d} for s, c, d in results], indent=2))
    else:
        for s, c, d in results:
            print(f"{s:4}  {c}" + (f"\n      {d}" if d else ""))
    sys.exit(1 if any(s == "FAIL" for s, _, _ in results) else 0)


if __name__ == "__main__":
    main()
