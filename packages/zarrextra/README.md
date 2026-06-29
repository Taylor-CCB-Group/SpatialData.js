# zarrextra

Extra utilities for working with zarr stores using zarrita.

This package provides helper functions and types for:
- Parsing zarr store contents into a tree structure
- Working with consolidated metadata
- Serializing zarr tree structures
- Registering additional Zarrita codecs, including JP2K (`imagecodecs_jpeg2k`)
- Loading OME-Zarr multiscales from an existing Zarrita store for Viv-compatible viewers
- Result type for explicit error handling

## Result Type

This package includes a `Result<T, E>` type inspired by Rust for explicit error handling. This is a custom implementation for simplicity and to avoid dependencies. We may review using an existing Result library (such as `neverthrow`) in the future, but for now this provides a lightweight solution.

## Installation

```bash
npm install zarrextra
```

## Usage

```typescript
import { openExtraConsolidated } from 'zarrextra';
import * as zarr from 'zarrita';

const result = await openExtraConsolidated('https://example.com/store.zarr');
// or:
// const result = await openExtraConsolidated(new zarr.FetchStore('https://example.com/store.zarr'));
if (result.ok) {
  const { zarritaStore, tree } = result.value;
  ...
  profit();
} else {
  alert(result.error);
}
```

## API

See the TypeScript definitions for full API documentation.

## Codec registration

`registerJpeg2kCodec()` registers decode support for the standard
`imagecodecs_jpeg2k` codec id from the Zarr codecs registry. The default decoder
uses the optional `@cornerstonejs/codec-openjpeg` package.

```typescript
import { registerJpeg2kCodec } from 'zarrextra';

registerJpeg2kCodec();
```

Applications can pass a custom decoder for alternate WASM loading or tests:

```typescript
import OpenJPEGJS from '@cornerstonejs/codec-openjpeg/decode';
import { createOpenJpegDecoder, registerJpeg2kCodec } from 'zarrextra';

registerJpeg2kCodec({ decoder: createOpenJpegDecoder(OpenJPEGJS) });
```

`registerExperimentalHtj2kCodec()` registers decode for `experimental.openjph_htj2k`
(new writes) and legacy `experimental.imagecodecs_htj2k` fixtures. Keep datasets
using either id clearly labelled until there is community/registry alignment.

```typescript
import { decode as openJphDecode } from 'openjph-wasm';
import { createOpenJphDecoder, registerExperimentalHtj2kCodec } from 'zarrextra';

registerExperimentalHtj2kCodec({ decoder: createOpenJphDecoder(openJphDecode) });
```

`openjph-wasm` decodes J2K/HTJ2K codestreams and returns planar, component-major
samples. Unlike the older `@cornerstonejs/codec-openjph` build, it round-trips
genuine multi-component data losslessly (the repo's `multi-component-codec-findings.md`
has the details), so a multi-component codestream maps directly onto a Zarr
chunk's `[..., z, y, x]` layout. The `mandelbulb` test fixture exercises this:
each chunk is a single codestream spanning 4 z-planes (`(1, 1, 4, 128, 128)`).

For offline encode (fixtures, recompress), use `encodeHtj2kPlane()` or
`createOpenJphEncoder()` from the same package. Python `spatialdata-codec-writer`
uses vendored OpenJPH WASM with a persistent Node worker pool; new stores use
codec id `experimental.openjph_htj2k`.

```typescript
import { encodeHtj2kPlane } from 'zarrextra';

const plane = new Uint16Array(width * height);
// ... fill plane ...
const encoded = await encodeHtj2kPlane(plane, { width, height }, {
  reversible: false,
  quality: 75,
});
```

## Worker-backed chunk decode (browser)

Decoding and marshalling chunk data can block the main thread for a long time.
If you use `@spatialdata/vis`, its renderer path enables the bundled codec worker
automatically in browsers. You do not need to call this API for normal vis usage.

If we find that users get unexpected results or need more control we may revise this pattern.

For lower-level browser apps using `zarrextra` directly, use the optional
`zarrextra/workers` entry with
[`@fideus-labs/fizarrita`](https://www.npmjs.com/package/@fideus-labs/fizarrita)
to offload chunk decode to a Web Worker pool:

```typescript
import { enableWorkerChunkDecode, disableWorkerChunkDecode } from 'zarrextra/workers';

enableWorkerChunkDecode();
// ... load JP2K-backed SpatialData and render tiles ...
disableWorkerChunkDecode();
```

This uses a thin custom codec worker that registers zarrextra image codecs
(including OpenJPEG for `imagecodecs_jpeg2k` and OpenJPH for experimental HTJ2K)
into `zarrita.registry` inside the worker before fizarrita's codec handler runs. Built-in zarrita codecs (bytes, zstd,
blosc, …) are also adapted to fizarrita's worker metadata shape via
`wrapZarrRegistryForFizarritaWorker()`. Main-thread `registerJpeg2kCodec()` is not
required for that path.

| Context | Setup |
|---------|-------|
| Node / CI | `registerJpeg2kCodec()` / `registerExperimentalHtj2kCodec()` on the main thread |
| Browser with `@spatialdata/vis` | no setup for normal `SpatialCanvas` usage; optional `ensureCodecWorkers()` for eager activation |
| Browser without `@spatialdata/vis` | `enableWorkerChunkDecode()` from `zarrextra/workers` before loading JP2K or HTJ2K data |

Optional dependencies: `@fideus-labs/fizarrita`, `@fideus-labs/worker-pool`,
`@cornerstonejs/codec-openjpeg`, and `openjph-wasm` (bundled into the default
worker script). Future worker entries may let applications opt into lighter
worker bundles when JP2K or HTJ2K codecs are not needed.

Contributor note: new worker-backed entry points should follow the documented
[worker bundling pattern](https://github.com/Taylor-CCB-Group/SpatialData.js/blob/main/docs/docs/worker-bundling.mdx)
so consumers can use package APIs without passing private worker URLs.
