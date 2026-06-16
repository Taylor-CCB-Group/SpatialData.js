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

`registerExperimentalHtj2kCodec()` is also available for non-standard HTJ2K
experiments. Keep fixtures and datasets using that codec clearly labelled until
there is community agreement on a registered codec id.

## Worker-backed chunk decode (browser)

JP2K and other codec work can block the main thread for a long time. For browser
apps, use the optional `zarrextra/workers` entry with
[`@fideus-labs/fizarrita`](https://www.npmjs.com/package/@fideus-labs/fizarrita)
to offload chunk decode to a Web Worker pool:

```typescript
import { enableWorkerChunkDecode, disableWorkerChunkDecode } from 'zarrextra/workers';

await enableWorkerChunkDecode();
// ... load JP2K-backed SpatialData and render tiles ...
disableWorkerChunkDecode();
```

This uses a thin custom codec worker that registers zarrextra image codecs
(including OpenJPEG for `imagecodecs_jpeg2k`) into `zarrita.registry` inside the
worker before fizarrita's codec handler runs. Built-in zarrita codecs (bytes, zstd,
blosc, …) are also adapted to fizarrita's worker metadata shape via
`wrapZarrRegistryForFizarritaWorker()`. Main-thread `registerJpeg2kCodec()` is not
required for that path.

| Context | Setup |
|---------|-------|
| Node / CI | `registerJpeg2kCodec()` on the main thread |
| Browser | `enableWorkerChunkDecode()` from `zarrextra/workers` before loading JP2K data |

Optional dependencies: `@fideus-labs/fizarrita`, `@fideus-labs/worker-pool`, and
`@cornerstonejs/codec-openjpeg` (bundled into the worker script).
