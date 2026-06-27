# Multi-component (volumetric) codec findings

Status: **investigation** — captured to inform an alternative codec implementation.

## Question

Can a single zarr chunk span more than one z-plane (`z > 1` per chunk) by
encoding the planes as **components of one codestream**, rather than one 2D
codestream per chunk?

The JPEG 2000 family supports this in principle. HTJ2K / JPEG 2000 Part 2 define
efficient coding of multi-component, hyperspectral, and volumetric content
(see the HTJ2K white paper, <https://htj2k.com/wp-content/uploads/white-paper.pdf>).
So the *format* is not the limitation. The question is whether the WASM
codecs this repo ships can actually round-trip independent multi-component data.

## TL;DR

The standard supports multi-component coding, but **neither WASM decoder this
repo currently depends on round-trips independent multi-component data**:

- `@cornerstonejs/codec-openjph` 2.4.7 (HTJ2K): silently keeps only component 0
  and replicates it across all output components; planes 2..N are lost.
- `@cornerstonejs/codec-openjpeg` 1.3.0 (JPEG 2000): multi-component decode
  throws an internal binding error for `componentCount >= 2`.

Encoding z-planes as components today would therefore **silently lose data** on
this stack. An alternative implementation needs a decoder verified to round-trip
multi-component before the writer can rely on it. OpenJPH (the C++/reference
library) is a reasonable target, but the **cornerstone WASM build of it is not a
working reference for multi-component** — see below.

## How it was tested

Each codec was exercised directly through its own encode → decode API (not via
zarr), with:

- `componentCount = N`, `isUsingColorTransform = false`
- 16-bit unsigned samples
- the encoder's `getDecodedBuffer(frame)` confirmed to return `N · width ·
  height` samples, with every sample filled before `encode()`
- inputs tried in both **planar** (`comp0` plane, then `comp1` plane, …) and
  **pixel-interleaved** (`c0p0, c1p0, …`) order

Round-trip identity (`decode(encode(x)) == x`) was the pass criterion. For
single-component (`N = 1`) both codecs round-trip cleanly, which confirms the
harness itself is correct.

## OpenJPH (HTJ2K) — `@cornerstonejs/codec-openjph` 2.4.7

| componentCount | round-trips? | observed |
|----------------|--------------|----------|
| 1 | ✅ | `[1,2,3,4]` → `[1,2,3,4]` |
| 2 | ❌ | `[1,2,3,4,5,6,7,8]` → `[1,1,2,2,3,3,4,4]` |
| 3 | ❌ | `…` → `[1,1,1,2,2,2,3,3,3,4,4,4]` |
| 4 | ❌ | `…` → `[1,1,1,1,2,2,2,2,…]` |

Interpreting the `N = 2`, 2×2 case (planar input
`comp0 = [1,2,3,4]`, `comp1 = [5,6,7,8]`):

- The output is **pixel-interleaved** (`out[pixel*C + comp]`).
- Every output component equals the **first input plane** (`[1,2,3,4]`); the
  second plane (`[5,6,7,8]`) is gone.

Feeding **interleaved** input instead does not help — the encoder reads the first
`N` samples as component 0 and discards the rest:

```
interleaved input: 10,200,11,201,12,202,13,203
decoded output   : 10,10,200,200,11,11,201,201   (plane 1 lost, comp0 replicated)
```

So the cornerstone wrapper effectively encodes a single component and replicates
it on decode. It is built for grayscale (1 component) and RGB-with-color-transform
(3 components, MCT on); arbitrary independent N-component planar data is not
supported by this build. **It cannot serve as a multi-component reference.**

## OpenJPEG (JPEG 2000) — `@cornerstonejs/codec-openjpeg` 1.3.0

- `componentCount = 1`: round-trips.
- `componentCount >= 2`: decode fails with an internal binding error
  (`Ea[F[((f + 4) >> 2)]] is not a function`) — i.e. the multi-component decode
  path is not wired up in this WASM build.

Note: very small planes (e.g. 2×2) also fail to *encode* with
"Number of resolutions is too high in comparison to the size of tiles"; use
`setDecompositions(<=3)` or a larger plane (≥32×32) when probing. This is
unrelated to the multi-component failure but worth knowing for test fixtures.

## Implications for an alternative implementation

1. **The decoder is the gate.** Before writing multi-component codestreams,
   verify the target decoder round-trips independent N-component data with the
   probe pattern above (planar in, planar out, identity). Do not assume a build
   supports it because the format does.

2. **OpenJPH the library vs. the cornerstone WASM build.** The cornerstone build
   is not a usable multi-component reference. If OpenJPH is the intended
   reference, build/bind it directly (or use the C++ tools / `imagecodecs` native
   HTJ2K) and confirm multi-component round-trip there first.

3. **Component layout matters.** When a working multi-component decoder is in
   place, pin down its buffer convention (planar vs. pixel-interleaved) on both
   encode input and decode output, and map zarr's planar `[…, z, y, x]` C-order
   chunk buffer accordingly. Lossless masks layout mistakes as long as encode and
   decode use the *same* convention, but mismatches wreck component decorrelation
   and lossy fidelity.

4. **Fallback if no multi-component decoder lands:** pack N standard 2D
   codestreams into one chunk behind a small length-prefixed container. This
   works on the current decoders and is lossless/lossy-safe, but it is a custom
   container, not a single standards-compliant volumetric codestream, so external
   tools reading the chunk as a raw codestream will not understand it.

## Current writer behaviour (for reference)

The writer encodes **one 2D codestream per chunk** and enforces it:

- `_validate_codec_chunks` requires chunk shape to begin `(1, 1, 1, …)`
  (`scripts/fixture_writer.py`).
- `_write_array_chunks` reshapes each chunk to `(y, x)` and calls
  `encode_image_plane` (`scripts/fixture_writer.py`).
- The volumetric `mandelbulb` fixture is `t=2, c=1, z=8, 128×128` chunked at
  `(1, 1, 1, 128, 128)` — one z-plane per chunk (`scripts/mandelbulb_fixtures.py`).

On the read side, `packages/zarrextra/src/codecs.ts` decodes one codestream per
chunk and validates `decoded length === product(chunk_shape)`.
