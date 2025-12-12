# @spatialdata/zarrextra

Extra utilities for working with zarr stores using zarrita.

This package provides helper functions and types for:
- Parsing zarr store contents into a tree structure
- Working with consolidated metadata
- Serializing zarr tree structures
- Result type for explicit error handling

## Result Type

This package includes a `Result<T, E>` type inspired by Rust for explicit error handling. This is a custom implementation for simplicity and to avoid dependencies. We may review using an existing Result library (such as `neverthrow` or `ts-result`) in the future, but for now this provides a lightweight solution.

## Installation

```bash
npm install @spatialdata/zarrextra
```

## Usage

```typescript
import { parseStoreContents, tryConsolidated, serializeZarrTree } from '@spatialdata/zarrextra';
import * as zarr from 'zarrita';

const store = new zarr.FetchStore('https://example.com/data.zarr');
const consolidatedStore = await tryConsolidated(store);
const tree = await parseStoreContents(consolidatedStore);
```

## API

See the TypeScript definitions for full API documentation.

