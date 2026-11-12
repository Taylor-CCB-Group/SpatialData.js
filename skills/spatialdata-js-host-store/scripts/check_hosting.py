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
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib

USER_AGENT = {"User-Agent": "spatialdata-js-check/1"}
# What a browser sends: compressed encodings normally, `identity` alongside Range (Fetch spec).
WHOLE_ENCODING = {"Accept-Encoding": "gzip, deflate"}
RANGE_ENCODING = {"Accept-Encoding": "identity"}
PROBE_BYTES = 8
CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+|\*)")

results: list[tuple[str, str, str]] = []  # (status, check, detail)


def record(status: str, check: str, detail: str = "") -> None:
    results.append((status, check, detail))


def request(url: str, origin: str, method: str = "GET", headers: dict | None = None,
            limit: int | None = None) -> tuple[int, dict, bytes]:
    """Fetch `url`. With `limit`, read at most that many body bytes, so a server
    that ignores Range cannot stream a whole store into memory."""
    is_range = "Range" in (headers or {})
    req = urllib.request.Request(url, method=method, headers={
        **USER_AGENT, **(RANGE_ENCODING if is_range else WHOLE_ENCODING),
        "Origin": origin, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            if method == "HEAD":
                return status, hdrs, b""
            body = resp.read(limit) if limit is not None else resp.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, b""
    if limit is None:  # urllib does not decode; the browser would
        encoding = hdrs.get("content-encoding", "identity")
        if encoding == "gzip":
            body = zlib.decompress(body, 16 + zlib.MAX_WBITS)
        elif encoding == "deflate":
            body = zlib.decompress(body)
    return status, hdrs, body


def header_list(headers: dict, name: str) -> set[str]:
    return {h.strip().lower() for h in headers.get(name, "").split(",") if h.strip()}


def check_cors(headers: dict, origin: str, label: str) -> bool:
    allow = headers.get("access-control-allow-origin")
    if allow in ("*", origin):
        return True
    record("FAIL", f"{label}: CORS", f"Access-Control-Allow-Origin is {allow!r}; the browser will "
           f"refuse the response for a page at {origin}. Send '*' or echo the Origin.")
    return False


def check_head(url: str, origin: str, label: str, zip_archive: bool) -> bool:
    """Returns whether the size came from Content-Length (else ranges must expose Content-Range)."""
    status, headers, _ = request(url, origin, "HEAD")
    if status != 200:
        record("FAIL", f"{label}: HEAD", f"status {status}. Readers size files with HEAD "
               "(zarrita for shard indexes, the zip reader for the archive).")
        return False
    if not check_cors(headers, origin, f"{label}: HEAD"):
        return False
    if "content-length" in headers:
        record("PASS", f"{label}: HEAD", f"Content-Length {headers['content-length']}")
        return True
    if zip_archive:
        # The zip reader falls back to a one-byte read and the total in Content-Range.
        _, probe, _ = request(url, origin, headers={"Range": "bytes=0-0"}, limit=2)
        exposed = header_list(probe, "access-control-expose-headers")
        if "/" in probe.get("content-range", "") and ("content-range" in exposed or "*" in exposed):
            record("PASS", f"{label}: size", "no Content-Length on HEAD; the reader's "
                   "bytes=0-0 fallback gets the size from Content-Range")
            return False
    record("FAIL", f"{label}: HEAD", "no Content-Length; readers size files from it.")
    return False


def check_ranges(url: str, origin: str, label: str, suffix: bool, need_content_range: bool) -> None:
    shapes = [("bounded range", f"bytes=0-{PROBE_BYTES - 1}")]
    if suffix:
        shapes.append(("suffix range", f"bytes=-{PROBE_BYTES}"))
    for shape, rng in shapes:
        status, headers, body = request(url, origin, headers={"Range": rng}, limit=PROBE_BYTES + 1)
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
            problems.append(f"Content-Encoding {headers['content-encoding']} on a range despite "
                            "Accept-Encoding: identity; byte offsets refer to the encoded body. "
                            "Disable compression for .zarr/.parquet/.zip paths.")
        if len(body) != PROBE_BYTES:
            problems.append(f"returned {'more than ' if len(body) > PROBE_BYTES else ''}"
                            f"{min(len(body), PROBE_BYTES)} bytes, expected {PROBE_BYTES}")
        if "content-range" not in headers:
            problems.append("no Content-Range header")
        else:
            match = CONTENT_RANGE.fullmatch(headers["content-range"].strip())
            if not match:
                problems.append(f"unparseable Content-Range {headers['content-range']!r}")
            else:
                start, end, total = int(match[1]), int(match[2]), match[3]
                if rng.startswith("bytes=-"):  # the last bytes, measured from the end
                    ok = total != "*" and (start, end) == (int(total) - PROBE_BYTES, int(total) - 1)
                else:
                    ok = (start, end) == (0, PROBE_BYTES - 1)
                if not ok:
                    problems.append(f"Content-Range {headers['content-range']!r} is not the "
                                    f"interval {rng} asked for")
        exposed = header_list(headers, "access-control-expose-headers")
        if need_content_range and "content-range" not in exposed and "*" not in exposed:
            problems.append("Content-Range is not in Access-Control-Expose-Headers, so the browser "
                            "hides it; readers learn the file size from it.")
        if problems:
            record("FAIL", check, " ".join(problems))
        else:
            record("PASS", check, headers.get("content-range", ""))


def check_preflight(url: str, origin: str, label: str, required: bool) -> None:
    """Range is CORS-safelisted only as a single bounded range, so suffix reads are preflighted."""
    status, headers, _ = request(url, origin, "OPTIONS", headers={
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "range",
    })
    allowed = header_list(headers, "access-control-allow-headers")
    problem = None
    if status >= 300:
        problem = f"OPTIONS returned {status}"
    elif headers.get("access-control-allow-origin") not in ("*", origin):
        problem = "no matching Access-Control-Allow-Origin on the OPTIONS reply"
    elif "range" not in allowed and "*" not in allowed:
        problem = f"Access-Control-Allow-Headers is {sorted(allowed)}; it must include Range"
    if problem is None:
        record("PASS", f"{label}: CORS preflight", f"status {status}")
    elif required:
        record("FAIL", f"{label}: CORS preflight", f"{problem}. Suffix-range reads will be blocked.")
    else:
        record("WARN", f"{label}: CORS preflight", f"{problem}. Bounded ranges need no preflight, "
               "but suffix ranges or extra request headers would.")


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
        # The zip reader sizes the archive with HEAD and reads bounded ranges only.
        check_preflight(store, args.origin, "zip archive", required=False)
        has_length = check_head(store, args.origin, "zip archive", zip_archive=True)
        check_ranges(store, args.origin, "zip archive", suffix=False, need_content_range=not has_length)
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

    # zarrita reads chunks and shards with HEAD and bounded ranges.
    check_preflight(meta_url, args.origin, "metadata file", required=False)
    check_head(meta_url, args.origin, "metadata file", zip_archive=False)
    check_ranges(meta_url, args.origin, "metadata file", suffix=False, need_content_range=False)
    # The Parquet reader reads footers with suffix ranges, which are preflighted.
    parquet = f"{store}/{args.parquet}" if args.parquet else find_parquet(store, args.origin, metadata)
    if parquet:
        check_preflight(parquet, args.origin, "points parquet", required=True)
        check_head(parquet, args.origin, "points parquet", zip_archive=False)
        check_ranges(parquet, args.origin, "points parquet", suffix=True, need_content_range=True)
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
