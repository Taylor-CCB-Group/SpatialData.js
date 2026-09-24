import { parquetRequestTimeoutMs } from './workers/parquetWorkerClient.js';

/**
 * `reader.read()` with the same silence budget the worker path has always had.
 *
 * parquet-wasm answers a refused HTTP range by panicking with `RuntimeError:
 * unreachable` and **leaving its promise unsettled** — a failure the streaming reader
 * cannot signal any other way (see
 * `SpatialDataTableSource.serverSupportsStreamingRanges`). In the worker that surfaces
 * as an `error` event and `armTimeout` bounds the wait. Driven on this thread there is
 * no error event and there was no watchdog, so the read simply never settled: the
 * caller hung, no fallback was taken, and nothing was logged.
 *
 * A budget turns the hang into a rejection, which every caller here already handles by
 * falling back to the byte-oriented reader — the path that serves stores this one
 * cannot. `checkAbort` cannot do this job: it only runs between settled reads, and the
 * read that matters never settles.
 */
export async function readBatchWithinBudget<T>(
  reader: ReadableStreamDefaultReader<T>,
  label: string
): Promise<ReadableStreamReadResult<T>> {
  const budget = parquetRequestTimeoutMs();
  if (!(budget > 0 && Number.isFinite(budget))) {
    return reader.read();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Stop the reader fetching a stream nobody is waiting for. The cancel may
          // itself never settle, hence the floating catch rather than an await.
          void reader.cancel().catch(() => {});
          reject(
            new Error(
              `Parquet stream went quiet for ${budget}ms while ${label}; ` +
                'falling back to the byte-oriented reader.'
            )
          );
        }, budget);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * The same budget, for the steps that OPEN a stream.
 *
 * `ParquetFile.fromUrl()` and `file.stream()` issue their own range requests, so the
 * panic this module exists for can land there too — before there is a reader to guard.
 * Bounding only the reads left the open able to hang exactly as the reads once did.
 *
 * `Promise.race` does not cancel the loser, so a slow open can still resolve after the
 * caller has moved on to the byte-oriented reader. `dispose` is how that late arrival
 * gets released — a `ParquetFile` holds wasm memory until `free()`, and a `ReadableStream`
 * keeps fetching until cancelled. Without it, every timeout leaks range work that runs
 * alongside the fallback it just triggered.
 */
export async function withinBudget<T>(
  work: Promise<T>,
  label: string,
  dispose?: (value: T) => void
): Promise<T> {
  const budget = parquetRequestTimeoutMs();
  if (!(budget > 0 && Number.isFinite(budget))) {
    return work;
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Attached before the race so a late result is always released, including when the
  // work settles between the timer firing and this handler being registered.
  void work.then(
    (value) => {
      if (timedOut && dispose) {
        try {
          dispose(value);
        } catch {
          // Releasing a value nobody is waiting for must not replace the timeout error.
        }
      }
    },
    () => {
      // The work's own rejection is already the race's result when it loses; when it
      // arrives late there is nothing to release and nobody to tell.
    }
  );
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `Parquet stream went quiet for ${budget}ms while ${label}; ` +
                'falling back to the byte-oriented reader.'
            )
          );
        }, budget);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
