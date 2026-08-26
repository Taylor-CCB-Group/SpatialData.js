import { ensureWorkers, Sketch } from '@spatialdata/vis';

/**
 * The docs demo, with the parquet worker actually wired up.
 *
 * This site is the one place the "Bundling into an application" page is describing,
 * so it should follow it. It did not: nothing called `ensureWorkers`, so every
 * parquet decode on this page ran on the main thread — 4.1s of long tasks on the
 * demo's shapes layer, 2.8s of it in a single task. With the worker wired that is
 * 1.9s across 3 tasks, and `decodeShapesGeometry` goes off-thread.
 *
 * `createWorker` rather than `workerUrl` because Docusaurus builds with webpack, and
 * webpack only *builds* a worker when it can see the `new Worker(new URL(...))` form
 * literally — and only when the URL points at a local source file. Pointing it at the
 * bare `@spatialdata/core/parquet-worker` specifier emits core's unbundled worker entry
 * as a static asset instead, 9kB whose every import 404s, which is the failure the
 * bundling page warns about. Hence the one-line `parquetWorkerEntry.ts` next door.
 *
 * Module-scope, not an effect: `ensureWorkers` is idempotent and attempts the worker
 * once per page, and this component is already behind `<BrowserOnly>`, so there is no
 * server render to guard against.
 */
ensureWorkers({
  parquet: {
    createWorker: () =>
      new Worker(new URL('./parquetWorkerEntry.ts', import.meta.url), {
        type: 'module',
      }),
  },
});

export default function DocsSketch() {
  return <Sketch />;
}
