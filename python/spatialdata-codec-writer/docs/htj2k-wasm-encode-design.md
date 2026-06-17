# HTJ2K WASM encode (design notes)

Status: **phase 1 implemented** — Python writer/recompress call
`scripts/encode-htj2k-plane.mjs` when native `imagecodecs` HTJ2K encode is
unavailable (common on PyPI macOS wheels: `imagecodecs.HTJ2K.available` is
`False` even though JP2K works).

## Problem

The Python writer and recompressor encode HTJ2K through `imagecodecs.htj2k_encode`
(or `jpeg2k_encode(..., codecformat="jph")`). That requires a native OpenJPH
build inside `imagecodecs`. PyPI wheels on some platforms (notably macOS arm64)
ship HTJ2K as a **stub only** — decode registration exists in the API, but there
is no `_htj2k` extension module.

Alternatives today:

- `conda-forge::imagecodecs` (separate env, not a one-line `uv` fix)
- Build `imagecodecs` from source against Homebrew `openjph` (many native deps)
- **Implemented:** OpenJPH WASM encode via Node (`scripts/encode-htj2k-plane.mjs`)

The JavaScript stack already bundles OpenJPH for **decode**
(`@cornerstonejs/codec-openjph`, wired in `zarrextra` workers). The same WASM
build exposes **`HTJ2KEncoder`** (`encode`, `setQuality(quality, reversible)`,
`getEncodedBuffer`, …).

## What stays the same

Any encoder backend (Python native or WASM) should produce the same artifacts the
rest of the repo already expects:

| Contract | Detail |
|----------|--------|
| Zarr codec id | `experimental.imagecodecs_htj2k` |
| Array metadata | Zarr v3; `codecs: [{ name, configuration: {} }]` |
| Chunk bytes | Raw HTJ2K bitstream per 2D spatial plane (last two axes) |
| Chunking | Non-spatial `t/c/z` axes chunked as `1` (same as JP2K writer) |
| Manifest | Existing `spatialdata-codec-writer` / recompress manifest fields |
| Browser read | `registerExperimentalHtj2kCodec()` + worker (already implemented) |

The Python layout code (`_write_array_chunks`, `_recompress_image_array`, manifest
checksums) is **codec-backend agnostic** except for the call that turns a 2D plane
into bytes.

## Implemented: WASM encoder as a subprocess helper (shape A)

Python remains the orchestrator (SpatialData copy, Zarr paths, manifests).
`_encode_htj2k_plane()` in `writer.py` calls the Node helper when native encode is
missing:

```
Python                          Node (one-shot per plane)
──────                          ─────────────────────────
read 2D plane (uint8/uint16)  → stdin: JSON { width, height, dtype, quality, reversible, plane }
                                OpenJPH HTJ2KEncoder.encode()
                              ← stdout: encoded chunk bytes
write to .../c/...            validate (imagecodecs or WASM decode round-trip)
```

Entry point: [`scripts/encode-htj2k-plane.mjs`](../../../scripts/encode-htj2k-plane.mjs)

Python bridge: [`htj2k_wasm.py`](../src/spatialdata_codec_writer/htj2k_wasm.py)

TypeScript API: `encodeHtj2kPlane()` / `createOpenJphEncoder()` in
[`packages/zarrextra/src/htj2k-encode.ts`](../../../packages/zarrextra/src/htj2k-encode.ts)

Preset mapping for WASM:

| Preset | `setQuality(quality, reversible)` |
|--------|-----------------------------------|
| `lossless` | `(100, true)` |
| `balanced` | `(100, false)` |
| `small` | `(75, false)` |

## Integration shapes still open

### B. TypeScript-first writer / recompress (spatialdata.js scripting)

Treat **SpatialData.ts** as the scripting layer for codec transcoding, not only
visualisation:

```
@spatialdata/core     read source Zarr / SpatialData element
@spatialdata/zarrextra  OpenJPH WASM encode + decode
                      write Zarr v3 chunk files + manifest (new writer module)
```

- **Pros:** Single runtime; shares codec code with browser worker; natural home
  for “scripting” use cases; can run in CI on any platform Node supports.
- **Cons:** Duplicate orchestration logic unless Python is demoted to JP2K-only.

### C. Long-lived Node encode worker (middle ground)

Same protocol as (A), but one Node process loads WASM once (like
`zarrextra/workers/codec-worker.ts` today for decode). Python sends many planes
over a socket or pipe.

- **Pros:** Amortizes WASM init; still keeps Python CLI surface.
- **Cons:** More moving parts than (A); still two runtimes.

## Validation and tests

- **Round-trip:** WASM encode → WASM decode (same OpenJPH build) → compare samples;
  `packages/zarrextra/tests/codecs.spec.ts`.
- **Cross-runtime:** `generate-fixtures --experimental-htj2k` on macOS; run
  `tests/integration/codecFixtures.test.ts` decode smoke test.
- **Python parity:** Writer validates representative chunks after write; manifest
  `chunks_checked[0].samples` compared in JS tests.

## Non-goals (for now)

- Promoting `experimental.imagecodecs_htj2k` to a registered Zarr codec id
- HTJ2K encode inside the browser main thread (worker-only is fine for read;
  encode is a batch/offline concern)
- Replacing JP2K Python encode (JP2K native path works well on PyPI wheels)

## References in this repo

- Python encode gate: `htj2k_encode_available()` / `_encode_htj2k_plane()` in
  [`writer.py`](../src/spatialdata_codec_writer/writer.py)
- Python WASM bridge: [`htj2k_wasm.py`](../src/spatialdata_codec_writer/htj2k_wasm.py)
- Node helper: [`scripts/encode-htj2k-plane.mjs`](../../../scripts/encode-htj2k-plane.mjs)
- JS encode: [`packages/zarrextra/src/htj2k-encode.ts`](../../../packages/zarrextra/src/htj2k-encode.ts)
- JS decode: [`packages/zarrextra/src/codecs.ts`](../../../packages/zarrextra/src/codecs.ts),
  [`codec-worker.ts`](../../../packages/zarrextra/src/workers/codec-worker.ts)
- Fixture / browser path: [`docs/docs/vis/codec-fixtures.mdx`](../../../docs/docs/vis/codec-fixtures.mdx)
