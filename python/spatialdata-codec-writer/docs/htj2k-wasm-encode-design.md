# HTJ2K OpenJPH WASM encode

Status: **implemented** — the supported HTJ2K encode path uses OpenJPH WASM via
`scripts/encode-htj2k-plane.mjs`. New stores are labelled
`experimental.openjph_htj2k`.

Native `imagecodecs` HTJ2K encode is intentionally **not** used: PyPI wheels are
often stub-only, conda installs are awkward, and the WASM encoder exposes
`setQuality(reversible, quality)` for preset control. We may re-evaluate native
encode later; the frontend still decodes the legacy id
`experimental.imagecodecs_htj2k` for older fixtures.

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

```
Python spatialdata-codec-writer
  → stdin JSON to scripts/encode-htj2k-plane.mjs
  → OpenJPH HTJ2KEncoder.setQuality(reversible, quality).encode()
  → stdout HTJ2K bytes
```

Preset mapping:

| Preset | `setQuality(reversible, quality)` |
|--------|-----------------------------------|
| `lossless` | `(true, 0)` |
| `balanced` | `(false, 0.005)` |
| `small` | `(false, 0.01)` |

`quality` is a float quantization factor (lower = better fidelity, larger output).
Integer values above ~15 with `reversible=false` produce degenerate output.

`htj2k-quality-sweep.manifest.json` records encoded sizes and RMSE for a 64×64
Mandelbrot plane across several qualities.

## References

- Python encode: [`htj2k_encode.py`](../src/spatialdata_codec_writer/htj2k_encode.py),
  [`writer.py`](../src/spatialdata_codec_writer/writer.py)
- Node helper: [`scripts/encode-htj2k-plane.mjs`](../../../scripts/encode-htj2k-plane.mjs)
- JS encode: [`packages/zarrextra/src/htj2k-encode.ts`](../../../packages/zarrextra/src/htj2k-encode.ts)
- JS decode: [`packages/zarrextra/src/codecs.ts`](../../../packages/zarrextra/src/codecs.ts)
