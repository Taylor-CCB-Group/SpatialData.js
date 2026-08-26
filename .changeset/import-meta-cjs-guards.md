---
"@spatialdata/core": patch
---

Stop the cjs build's `import.meta` replacement from being a latent crash.

The cjs pass replaces `import.meta` with `{}`, so `import.meta.url` is `undefined`
there. Two call sites used it unguarded, and both were in code meant to serve Node —
the one runtime the cjs build exists for:

- the parquet-wasm loader's Node branch called `fileURLToPath(undefined)`, a
  `TypeError`, on the first parquet read;
- `defaultWorkerUrl()` called `new URL('./parquet-worker.js', undefined)`, which throws
  `Invalid URL`, so `enableParquetWorker()` with no `workerUrl` threw instead of
  falling back.

Both now read `import.meta.url` into a variable and check it. The loader falls through
to the async init; `enableParquetWorker` warns that a CommonJS host must pass
`workerUrl` or `createWorker`, and leaves the worker off rather than throwing.

Two caveats worth knowing. The build still emits `EMPTY_IMPORT_META` twice — that is
now expected and is commented as such in `packages/core/vite.config.ts`; rolldown's
suggested `transform.define` suppression is not reachable through Vite 8's config.
And the cjs entry cannot currently be `require`d at all, for an unrelated reason:
`anndata.js` publishes no CommonJS export, so `require('@spatialdata/core')` fails
before any of this is reached. These guards are correctness for when that is fixed,
not a claim that the cjs build works today.
