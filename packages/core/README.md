# @spatialdata/core

Core library for interfacing with SpatialData stores in TypeScript/JavaScript.

## Features

- 🔍 Read and validate SpatialData from zarr stores using zarrita
- 🛡️ Type-safe schemas with Zod
- 📦 Works in Node.js and browsers
- 🎯 Full TypeScript support

## Installation

```bash
pnpm add @spatialdata/core
```

## Usage

```typescript
import { openSpatialDataStore, readArray } from '@spatialdata/core';

// Open a SpatialData store
const metadata = await openSpatialDataStore('path/to/store.zarr');
console.log(metadata);

// Read an array from the store
const array = await readArray('path/to/store.zarr', 'images/image1');
```

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build
```

## License

MIT
