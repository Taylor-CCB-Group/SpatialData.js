# HTJ2K OpenJPH WASM encode

Status: **implemented** — HTJ2K encode uses vendored OpenJPH WASM inside a pool
of persistent Node.js workers (`spatialdata_codec_writer/vendor/encode-plane.mjs`).
New stores are labelled `experimental.openjph_htj2k`.

Native `imagecodecs` HTJ2K encode is intentionally **not** used: PyPI wheels are
often stub-only, conda installs are awkward, and the WASM encoder exposes a
simple `encode({ data, width, height, components, reversible, quality })` call.
We may re-evaluate native encode later; the frontend still decodes the legacy id
`experimental.imagecodecs_htj2k` for older fixtures.

The encoder/decoder is the [`openjph-wasm`](https://www.npmjs.com/package/openjph-wasm)
package. Earlier versions used `@cornerstonejs/codec-openjph`, whose WASM build
could not round-trip independent multi-component data
(see [multi-component-codec-findings.md](./multi-component-codec-findings.md)).
`openjph-wasm` decodes/encodes multi-component codestreams with planar,
component-major buffers.

## Contracts

| Contract | Detail |
|----------|--------|
| Zarr codec id (new writes) | `experimental.openjph_htj2k` |
| Zarr codec id (legacy decode) | `experimental.imagecodecs_htj2k` |
| Encoder label | `openjph-wasm` (manifest `encoder` field) |
| Array metadata | Zarr v3; `codecs: [{ name, configuration: {} }]` |
| Chunk bytes | Raw HTJ2K bitstream per 2D spatial plane (last two axes) |
| Browser read | `registerExperimentalHtj2kCodec()` registers both ids |

## Encode flow

```text
Python spatialdata-codec-writer
  → EncoderPool (N persistent Node workers)
  → vendored encode-plane.mjs --worker
  → openjph-wasm encode({ data, width, height, components, reversible, quality })
  → HTJ2K bytes per chunk
```

Vendoring: run `node scripts/vendor-openjph-for-python.mjs` at the monorepo root
to copy `openjph-wasm` dist assets (`index.mjs` + `wasm/`) into the Python package
wheel. The copied `vendor/openjph/` blobs are gitignored; CI and
`pnpm test:codec-writer` run the vendor step after `pnpm install`.

Preset mapping:

| Preset | `encode({ reversible, quality })` |
|--------|-----------------------------------|
| `lossless` | `{ reversible: true }` |
| `balanced` | `{ reversible: false, quality: 0.0002 }` |
| `small` | `{ reversible: false, quality: 0.001 }` |

`quality` is a float quantization factor (lower = better fidelity, larger output).
Integer values above ~15 with `reversible=false` produce degenerate output.

### Preset calibration (rough)

Early presets (`balanced: 0.005`, `small: 0.01`) were tuned on 64×64 Mandelbrot
fixtures. On full-range Xenium morphology `uint16` chunks (1024×1024 planes), that
`balanced` setting was far more lossy than JP2K `balanced` (`level=100`).

Spot checks on one morphology pyramid chunk (`RMSE` on decoded vs source):

| Setting | Encoded (1024² `uint16`) | RMSE |
|---------|--------------------------|------|
| JP2K `balanced` | ~722 KiB | ~0.3 |
| HTJ2K `q=0.0002` (new `balanced`) | ~419 KiB | ~5 |
| HTJ2K `q=0.001` (new `small`) | ~128 KiB | ~22 |
| HTJ2K `q=0.005` (old `balanced`) | ~39 KiB | ~60 |

Preset names are aligned **roughly** with JP2K intent on real morphology data,
not bit-identical rate control. For per-dataset tuning, prefer explicit `quality`
rather than presets alone.

### CLI and JSON

```bash
spatialdata-codec-writer recompress input.zarr output.zarr \
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

- Python encode: [`htj2k_encode.py`](../src/spatialdata_codec_writer/htj2k_encode.py),
  [`codecs.py`](../src/spatialdata_codec_writer/codecs.py)
- Vendored Node worker: [`vendor/encode-plane.mjs`](../src/spatialdata_codec_writer/vendor/encode-plane.mjs)
- Vendor script: [`scripts/vendor-openjph-for-python.mjs`](../../../scripts/vendor-openjph-for-python.mjs)
- Dev fixtures: [`scripts/generate_codec_fixtures.py`](../scripts/generate_codec_fixtures.py)
- JS encode: [`packages/zarrextra/src/htj2k-encode.ts`](../../../packages/zarrextra/src/htj2k-encode.ts)
- JS decode: [`packages/zarrextra/src/codecs.ts`](../../../packages/zarrextra/src/codecs.ts)
