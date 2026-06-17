# HTJ2K WASM encode (design notes)

Status: **not implemented** — notes for a possible future path when Python
`imagecodecs` HTJ2K encode is unavailable (common on PyPI macOS wheels:
`imagecodecs.HTJ2K.available` is `False` even though JP2K works).

## Problem

The Python writer and recompressor encode HTJ2K through `imagecodecs.htj2k_encode`
(or `jpeg2k_encode(..., codecformat="jph")`). That requires a native OpenJPH
build inside `imagecodecs`. PyPI wheels on some platforms (notably macOS arm64)
ship HTJ2K as a **stub only** — decode registration exists in the API, but there
is no `_htj2k` extension module.

Alternatives today:

- `conda-forge::imagecodecs` (separate env, not a one-line `uv` fix)
- Build `imagecodecs` from source against Homebrew `openjph` (many native deps)

The JavaScript stack already bundles OpenJPH for **decode**
(`@cornerstonejs/codec-openjph`, wired in `zarrextra` workers). The same WASM
build exposes **`HTJ2KEncoder`** (`encode`, `setQuality`, `getEncodedBuffer`, …).

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

## Integration shapes (roughly increasing ambition)

### A. WASM encoder as a subprocess helper (smallest Python change)

Keep Python as the orchestrator (SpatialData copy, Zarr paths, manifests).
Replace only the encode step for HTJ2K:

```
Python                          Node (one-shot or pooled)
──────                          ─────────────────────────
read 2D plane (uint8/uint16)  → stdin: { width, height, dtype, bytes }
                                OpenJPH HTJ2KEncoder.encode()
                              ← stdout: encoded chunk bytes
write to .../c/...            validate (optional WASM decode round-trip)
```

- **Pros:** Reuses all existing `cli.py` / `recompress.py` / tests structure;
  WASM stays in the TS dependency tree; works on macOS without conda.
- **Cons:** IPC overhead per chunk; need a stable binary protocol; two runtimes in
  one workflow (`uv` + `node`/`pnpm`).

Sketch:

```bash
# future
uv run spatialdata-codec-writer recompress ... \
  --codec experimental.imagecodecs_htj2k \
  --htj2k-encoder node  # or implicit when native encode unavailable
```

Python would call something like
`pnpm exec spatialdata-codec-encode --codec htj2k` with plane bytes on stdin.

### B. TypeScript-first writer / recompress (spatialdata.js scripting)

Treat **SpatialData.ts** as the scripting layer for codec transcoding, not only
visualisation:

```
@spatialdata/core     read source Zarr / SpatialData element
@spatialdata/zarrextra  OpenJPH WASM encode + decode (new encode API)
                      write Zarr v3 chunk files + manifest (new writer module)
```

Flow mirrors Python `recompress_spatialdata`:

1. Open store (`readZarr` or `FileSystemStore`)
2. For each configured image / scale level, iterate chunk grid
3. Read raw plane → `encodeHtj2kPlane(plane, options)` → write `c/...` blob
4. Emit sidecar manifest JSON (same schema as Python for cross-validation)

- **Pros:** Single runtime; shares codec code with browser worker; natural home
  for “scripting” use cases; can run in CI on any platform Node supports.
- **Cons:** Duplicate orchestration logic unless Python calls into it (A) or
  Python writer is demoted to JP2K-only reference.

CLI sketch:

```bash
pnpm exec spatialdata-codec recompress input.zarr output.zarr \
  --image-key morphology_focus --codec experimental.imagecodecs_htj2k
```

### C. Long-lived Node encode worker (middle ground)

Same protocol as (A), but one Node process loads WASM once (like
`zarrextra/workers/codec-worker.ts` today for decode). Python sends many planes
over a socket or pipe.

- **Pros:** Amortizes WASM init; still keeps Python CLI surface.
- **Cons:** More moving parts than (A); still two runtimes.

## zarrextra / OpenJPH work (shared by B and C)

Today `zarrextra` is **decode-only** for image codecs (`encode` throws). A WASM
encode path would add:

```typescript
// packages/zarrextra/src/codecs.ts (future)
export function createOpenJphEncoder(factory: OpenJphFactory): ImageCodecEncoder;

// plane: Uint8Array | Uint16Array + { width, height, reversible?, level? }
// → Promise<Uint8Array>  // HTJ2K bitstream
```

Mirror `createOpenJphDecoder` / `createOpenJpegDecoder`. Register encode only if
we wire Zarrita’s `array_to_bytes` encode path; for chunk-file writers, a
standalone `encodeHtj2kPlane()` may be enough.

Optional dependency: `@cornerstonejs/codec-openjph` (already optional for decode).

## Validation and tests

- **Round-trip:** WASM encode → WASM decode (same OpenJPH build) → compare samples;
  matches what Python writer does with `imagecodecs` today.
- **Cross-runtime:** Generate fixture with WASM encoder; run existing
  `tests/integration/codecFixtures.test.ts` decode smoke test (already uses
  `registerExperimentalHtj2kCodec`).
- **Python parity:** Compare manifest `chunks_checked[0].samples` between Python
  JP2K and WASM HTJ2K fixtures (different codec, same synthetic raster).

## Suggested phasing (when we implement)

1. **zarrextra:** `createOpenJphEncoder` + unit test with real WASM (encode one
   small plane, decode back).
2. **Node CLI:** minimal `encode-plane` subcommand (stdin/stdout) for Python to
   call — unblocks `generate-fixtures --experimental-htj2k` on macOS.
3. **Optional:** TS `recompress` command sharing logic with vis demo / integration
   tests; document as the preferred HTJ2K path for scripting.
4. **Optional:** Python `--htj2k-encoder node` auto-fallback when
   `htj2k_encode_available()` is false.

## Non-goals (for now)

- Promoting `experimental.imagecodecs_htj2k` to a registered Zarr codec id
- HTJ2K encode inside the browser main thread (worker-only is fine for read;
  encode is a batch/offline concern)
- Replacing JP2K Python encode (JP2K native path works well on PyPI wheels)

## References in this repo

- Python encode gate: `htj2k_encode_available()` in
  [`writer.py`](../src/spatialdata_codec_writer/writer.py)
- Python chunk write loop: `_write_array_chunks`, `_recompress_image_array`
- JS decode: [`packages/zarrextra/src/codecs.ts`](../../../packages/zarrextra/src/codecs.ts),
  [`codec-worker.ts`](../../../packages/zarrextra/src/workers/codec-worker.ts)
- Fixture / browser path: [`docs/docs/vis/codec-fixtures.mdx`](../../../docs/docs/vis/codec-fixtures.mdx)
