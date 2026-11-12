---
name: spatialdata-js-host-store
description: Get a SpatialData .zarr (or zipped) store into SpatialData.js in a browser — opened locally or served over HTTP — and diagnose why a served store will not load. Covers byte-range requests (including suffix ranges), CORS and preflight, exposed headers, caching after rewrites, local serving, and S3/GCS/R2/nginx setup. Use this whenever someone wants to open a local or cloud SpatialData store in the SpatialData.js demo, MDV, a notebook widget or a Claude tile; asks for a URL for their store; or reports a store that loads in Python but fails, hangs or is slow in the browser (CORS errors, 416, "Failed to fetch", points never appearing). Use spatialdata-js-prepare-store first if the store has not been optimised.
compatibility: Python 3 (standard library only) for the bundled scripts.
---

# Host a SpatialData store for SpatialData.js

SpatialData.js reads a store from its URL with many small HTTP range requests,
and it never downloads the whole store. That only works if the server answers
those requests exactly as browsers expect. Most failures are server
configuration problems, not data problems. A store that opens fine in Python
can still fail, or silently become slow, in a browser.

## First: does this need a server?

To look at a local store in the SpatialData.js demo, it doesn't. The demo
(<https://taylor-ccb-group.github.io/SpatialData.js/docs/demo/>, or a local dev
build) has **Open folder…** and **Open zip…** buttons that read the store
straight from disk. Use those. They avoid every problem below, including
browsers that block public pages from reading `localhost`.

Host the store when it needs a URL:
- to share it,
- for viewers without a file picker (MDV, notebook widgets, Claude tiles),
- or for a `?url=` link.

A zipped store (`spatialdata-js-util zip`) can be hosted as a single `.zip`
file. The reader opens any URL ending in `.zip` as an archive and range-reads
it. That only needs `HEAD` with `Content-Length`, bounded ranges and CORS on
the one file.

## What the server must do

Each requirement exists because a specific reader depends on it:

1. **Bounded ranges.** `Range: bytes=A-B` must return `206` with exactly those
   bytes. This is how zarr chunks and Parquet column chunks are read. A server
   that ignores `Range` and returns `200` with the whole file breaks offsets.
2. **Suffix ranges.** `Range: bytes=-N` must return `206` with the last N
   bytes. The Parquet reader uses this to read file footers. Many static
   servers return `416` here, and SpatialData.js then falls back to
   whole-file Parquet downloads. Points still appear, just slowly.
3. **`HEAD` with `Content-Length`.** zarrita sizes sharded arrays this way
   before reading a shard index.
4. **CORS.**
   - Responses must carry `Access-Control-Allow-Origin`, either `*` or the
     viewer page's origin.
   - `Range` is not a CORS-safelisted header, so every ranged read is
     preflighted. `OPTIONS` must succeed and allow the `Range` header.
   - `Access-Control-Expose-Headers` must include `Content-Range`, otherwise
     the browser hides it from the reader.
5. **No compression on ranged files.** Do not apply
   `Content-Encoding: gzip`/`br` to `.zarr` chunks or `.parquet` files. Range
   offsets would refer to the compressed stream. The data is already
   compressed anyway.
6. **Consolidated metadata.** Directories cannot be listed over HTTP, so the
   store root needs consolidated metadata: inline in `zarr.json` for zarr v3,
   or `zmetadata` for v2. `spatialdata` writes it by default, and
   `spatialdata-js-util` refreshes it after its rewrites.
7. **Caching that respects rewrites.** If a store is rewritten in place, the
   browser can mix stale cached metadata with new chunks. Serve with
   `Cache-Control: no-cache`, or publish each rewrite at a new URL.

## Check a URL

```bash
python <this skill>/scripts/check_hosting.py https://host/path/store.zarr
python <this skill>/scripts/check_hosting.py http://127.0.0.1:8000/store.zarr --origin https://my-viewer.example
```

The script makes the same request shapes the runtime makes, against the
metadata file and the first points Parquet. It sends an `Origin` header and
explains each `FAIL`. Its exit status is non-zero if anything fails. Run it
after any hosting change, and before telling the user a URL is ready. Pass
`--origin` as the viewer page's origin when the server allowlists origins
rather than sending `*`.

## Serve a local store

```bash
python <this skill>/scripts/serve_store.py ~/data            # serves every *.zarr under ~/data
python <this skill>/scripts/serve_store.py ~/data --port 9000
```

It prints a URL per store, such as `http://127.0.0.1:8000/xenium.zarr`. It
binds to loopback only. `--host 0.0.0.0` would expose every file under that
directory to the network, so use it only when the user asks and the network
is trusted. If the port is taken, choose another.

Plain `python -m http.server` is not enough: it ignores `Range` and sends no
CORS headers. `check_hosting.py` shows exactly that.

## Cloud and production servers

For S3, Google Cloud Storage, Cloudflare R2, nginx or Caddy, read
`references/servers.md`. It has the CORS configuration and the pitfalls for
each. Apply the configuration, then run `check_hosting.py` against the public
URL. Provider consoles differ, and only the check is authoritative.

## Reading the browser's network log

When the viewer won't load, the browser devtools network log is the
evidence, but some of it is normal:
- **404s for `.zmetadata`, `.zattrs` or `.zgroup` on a zarr v3 store are
  expected.** The reader checks for the v2 layout first.
- **What matters:**
  - CORS errors;
  - `416` responses;
  - ranged requests answered `200` instead of `206`;
  - a failed `OPTIONS` preflight.

  `check_hosting.py` reproduces each of these outside the browser.

## Viewer-specific notes

- **Mixed content.** A page served over `https://` cannot fetch `http://`
  URLs on other hosts. Use HTTPS for anything other than localhost.
- **Claude tiles (MCP Apps).** These run in a sandboxed iframe with its own
  origin, of the form `<hash>.claudemcpcontent.com`, and a content security
  policy. The store's origin must be listed in the app's
  `_meta.ui.csp.connectDomains`, and the server must allow that origin, so
  `*` is simplest. Whether a tile can reach a store on `localhost` depends on
  the host. The `apps/mcp-probe` app in the SpatialData.js repo measures this.

If you can drive a browser, finish by opening the viewer the user named with
the URL. For the SpatialData.js demo that is its page with `?url=<store URL>`.
Confirm that the elements are listed and a layer renders. The check proves the
server is right; only the viewer proves the whole path.

## Report back

Give the user:
- the URL to use,
- the `check_hosting.py` result,
- the command to restart the server if it is local,
- anything left as `WARN` and what it means for them.
