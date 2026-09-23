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
