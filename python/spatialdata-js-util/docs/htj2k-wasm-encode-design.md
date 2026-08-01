# HTJ2K OpenJPH WASM encode

Status: **implemented** — HTJ2K encode uses vendored OpenJPH WASM inside a pool
of persistent Node.js workers (`spatialdata_js_util/codecs/vendor/encode-plane.mjs`).
New stores are labelled `experimental.openjph_htj2k`.

Native `imagecodecs` HTJ2K encode is intentionally **not** used: PyPI wheels are
often stub-only, conda installs are awkward, and the WASM encoder exposes a
simple `encode({ data, width, height, components, reversible, quality })` call.
We may re-evaluate native encode later; the frontend still decodes the legacy id
`experimental.imagecodecs_htj2k` for older fixtures.

The encoder/decoder is the [`openjph-wasm`](https://www.npmjs.com/package/openjph-wasm)
package. Earlier versions used `@cornerstonejs/codec-openjph`, whose WASM build
could not round-trip independent multi-component data
(see [multi-component-codec-findings.md](./multi-component-codec-findings.md));
`openjph-wasm` round-trips multi-component, planar, component-major buffers
losslessly, so a chunk's leading dims (e.g. z) are encoded as **codestream
components**. `z > 1` chunks are now wired up end-to-end: the writer encodes a
chunk's z-planes as one multi-component codestream, and the JS reader decodes it
back to planar `[..., z, y, x]`. The `mandelbulb` fixture uses
`(1, 1, 4, 128, 128)` chunks (4 z-planes per codestream). Chunk shapes must begin
`(1, 1)` (t and c are not chunked across components).

## Contracts

| Contract | Detail |
|----------|--------|
| Zarr codec id (new writes) | `experimental.openjph_htj2k` |
| Zarr codec id (legacy decode) | `experimental.imagecodecs_htj2k` |
| Encoder label | `openjph-wasm` (manifest `encoder` field) |
| Array metadata | Zarr v3; `codecs: [{ name, configuration: {} }]` |
| Chunk bytes | One HTJ2K codestream per chunk; the chunk's leading dims (z) are codestream components, the last two axes are the y/x plane |
| Browser read | `registerExperimentalHtj2kCodec()` registers both ids |

## Encode flow

```text
Python spatialdata-js-util
  → EncoderPool (N persistent Node workers)
  → vendored encode-plane.mjs --worker
  → openjph-wasm encode({ data, width, height, components, reversible, quality })
  → HTJ2K bytes per chunk
```

Vendoring: run `node scripts/vendor-openjph-for-python.mjs` at the monorepo root
to copy `openjph-wasm` dist assets (`index.mjs` + `wasm/`) into the Python package
wheel. The copied `vendor/openjph/` blobs are gitignored; CI and
`pnpm test:python` run the vendor step after `pnpm install`.

Preset mapping — the lossy steps are **relative to the input's bit depth**:

| Preset | `quality` in LSB | `uint8` step | `uint16` step |
|--------|------------------|--------------|---------------|
| `lossless` | — (`reversible: true`) | — | — |
| `balanced` | 2 | `0.0078125` | `0.000030518` |
| `small` | 5 | `0.01953125` | `0.000076294` |

`quality` is a float quantization step, normalised to the dtype's **full dynamic
range** (lower = better fidelity, larger output). Integer values above ~15 with
`reversible=false` produce degenerate output.

### Why presets are bit-depth relative

One input LSB is `1 / 2**bits`, so the same absolute `quality` means different
things at different depths. Measured on 1024² planes (`imagecodecs` 2026.6.26;
size as a ratio to the reversible encode of the same plane):

| Step, in LSB | `uint8` H&E | `uint8` retina | `uint16` cells3d | mean error |
|--------------|-------------|----------------|------------------|-----------|
| 0.05 | **1.89×** | **2.76×** | — | 0 |
| 0.26 | **1.39×** | **1.60×** | — | 0 |
| 1 | 0.92× | 0.58× | 1.00× | ~0.2 LSB |
| 2 (`balanced`) | 0.68× | 0.29× | 0.93× | ~0.6 LSB |
| 5 (`small`) | 0.39× | 0.13× | 0.83× | ~1.6 LSB |

Both effects are content-independent: a step measured in LSB is the
dtype-independent knob, and below ~1 LSB (`HTJ2K_QUALITY_FLOOR_LSB`) the
irreversible 9/7 path is strictly dominated — it returns a bit-identical image
for more bytes than reversible 5/3. Presets stay above that floor; an explicit
`quality` below it warns.

The earlier absolute presets (`balanced: 0.0002`, `small: 0.001`) were
calibrated only on full-range Xenium morphology `uint16`, where they are 13.1
and 65.5 LSB. On `uint8` they are 0.05 and 0.26 LSB, so both encoded *larger*
than `lossless` for a bit-identical image — the expected size ordering reversed.

Preset names track JP2K intent **roughly**, not bit-identical rate control. For
per-dataset tuning prefer an explicit `quality`, remembering it is an absolute
step rather than an LSB multiple.

### Known defect: saturated samples wrap on the lossy path

Lossy HTJ2K reconstructs samples at the dtype ceiling slightly out of range, and
**both** decoders (`imagecodecs` and `openjph-wasm`) wrap rather than clamp:
`255 → 0` for `uint8`, `65535 → 0` for `uint16`. On an H&E plane with a
saturated white background that is isolated black pixels — 14 of 1,048,576 at
`balanced`. Clipping the source to `254` removes them entirely and the
reversible path is unaffected, so encode `lossless` where data touches the dtype
maximum until this is fixed upstream.

### CLI and JSON

```bash
spatialdata-js-util images recompress input.zarr output.zarr \
  --image-key morphology_focus \
  --codec experimental.openjph_htj2k \
  --quality 0.001 \
  --sibling \
  --workers 4 \
  --overwrite
```

```json
{
  "images": {
    "morphology_focus": {
      "codec": "experimental.openjph_htj2k",
      "quality": 0.001
    }
  }
}
```

Setting `quality` implies `reversible=false` unless `reversible` is explicitly
`true`. Sibling outputs use `morphology_focus:htj2k_q0.001` when quality is set.

**Future:** add browser UI on the codec demo route to interactively transcode a
region or layer at arbitrary `q` and compare size/RMSE side by side (the
`htj2k-demo.zarr` multi-layer fixture is a step toward that).

`htj2k-quality-sweep.manifest.json` records encoded sizes and RMSE for a 64×64
Mandelbrot plane across several qualities.

## References

- Python encode: [`htj2k_wasm.py`](../src/spatialdata_js_util/codecs/htj2k_wasm.py),
  [`encoding.py`](../src/spatialdata_js_util/codecs/encoding.py)
- Vendored Node worker: [`vendor/encode-plane.mjs`](../src/spatialdata_js_util/codecs/vendor/encode-plane.mjs)
- Vendor script: [`scripts/vendor-openjph-for-python.mjs`](../../../scripts/vendor-openjph-for-python.mjs)
- Dev fixtures: [`scripts/generate_codec_fixtures.py`](../scripts/generate_codec_fixtures.py)
- JS encode: [`packages/zarrextra/src/htj2k-encode.ts`](../../../packages/zarrextra/src/htj2k-encode.ts)
- JS decode: [`packages/zarrextra/src/codecs.ts`](../../../packages/zarrextra/src/codecs.ts)
