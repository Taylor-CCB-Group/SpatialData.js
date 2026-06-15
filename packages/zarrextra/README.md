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
