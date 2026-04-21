# @spatialdata/core

Core library for interfacing with SpatialData stores in TypeScript/JavaScript.

## Node REPL

`readZarr` is async, and `@spatialdata/core` is published as ESM. In a Node REPL, the simplest pattern is to use `await import(...)`.

If you are working inside this monorepo, build first so the package entrypoint exists:

```bash
pnpm build
node
```

Then in the REPL:

```js
const { readZarr } = await import('./packages/core/dist/index.js');
const { FileSystemStore } = await import('@zarrita/storage');
```

### Open a local store from disk

Pass an explicit zarrita store instance. Plain filesystem path strings are not supported by `readZarr`.

```js
const store = new FileSystemStore('./test-fixtures/v0.7.2/blobs.zarr');
const sdata = await readZarr(store);

sdata.toString();
Object.keys(sdata.images ?? {});
sdata.coordinateSystems;
```

### Open a remote store over HTTP

Pass the store URL directly:

```js
const { readZarr } = await import('./packages/core/dist/index.js');
const sdata = await readZarr('http://localhost:8080/v0.7.2/blobs.zarr');

sdata.url;
Object.keys(sdata.images ?? {});
```

If you want to try that example against this repo's generated fixtures:

```bash
pnpm test:server
```

### Using an installed package

If `@spatialdata/core` is installed in another project, use the package name instead of the local dist path:

```js
const { readZarr } = await import('@spatialdata/core');
const { FileSystemStore } = await import('@zarrita/storage');

const sdata = await readZarr(new FileSystemStore('/absolute/path/to/store.zarr'));
```

### Common gotchas

- The REPL is not an ESM module file, so prefer `await import(...)` rather than `import { readZarr } from ...`.
- Local disk access should use `new FileSystemStore(...)`, not a bare path string.
- URL-backed loads set `sdata.url`; store-backed loads keep `sdata.url === undefined` and retain the original object on `sdata.source`.
- If the REPL says it cannot find `./packages/core/dist/index.js`, run `pnpm build` first.

## Development

The documentation package has a dependency on `packages/core` and can be used for experimenting with functionality inline with the documentation itself.


```bash
# Install dependencies
pnpm install

# develop docs & packages
pnpm dev

# Run tests
pnpm test

# Build
pnpm build
```

## License

MIT
