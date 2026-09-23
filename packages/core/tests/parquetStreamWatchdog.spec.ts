import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBatchWithinBudget } from '../src/parquetStreamWatchdog.js';
import { setParquetWorkerRequestTimeout } from '../src/workers/parquetWorkerClient.js';

/**
 * parquet-wasm answers a refused HTTP range by panicking and leaving its promise
 * unsettled. On the main thread there is no `error` event to notice, so an unguarded
 * `reader.read()` simply never returns: the caller hangs, takes no fallback, and logs
 * nothing. These tests pin the guard, not the panic.
 */
function hangingReader() {
  return {
    read: () => new Promise<never>(() => {}),
    cancel: vi.fn(() => Promise.resolve()),
  } as unknown as ReadableStreamDefaultReader<string> & { cancel: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  setParquetWorkerRequestTimeout(30_000);
  vi.useRealTimers();
});

describe('readBatchWithinBudget', () => {
  it('passes a batch straight through', async () => {
    const reader = {
      read: () => Promise.resolve({ done: false, value: 'batch' }),
      cancel: () => Promise.resolve(),
    } as unknown as ReadableStreamDefaultReader<string>;

    await expect(readBatchWithinBudget(reader, 'testing')).resolves.toEqual({
      done: false,
      value: 'batch',
    });
  });

  it('rejects rather than hanging when the reader goes silent', async () => {
    setParquetWorkerRequestTimeout(20);
    const reader = hangingReader();

    await expect(readBatchWithinBudget(reader, 'scanning for selected features')).rejects.toThrow(
      /went quiet for 20ms while scanning for selected features/
    );
  });

  it('cancels the abandoned stream so it stops fetching', async () => {
    setParquetWorkerRequestTimeout(20);
    const reader = hangingReader();

    await expect(readBatchWithinBudget(reader, 'testing')).rejects.toThrow();
    expect(reader.cancel).toHaveBeenCalled();
  });

  it('honours a disabled budget by waiting indefinitely', async () => {
    setParquetWorkerRequestTimeout(0);
    const reader = hangingReader();
    const settled = vi.fn();
    void readBatchWithinBudget(reader, 'testing').then(settled, settled);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // 0 means "no watchdog" for the worker path; it has to mean the same here, or
    // turning the timeout off would change which reads are allowed to be slow.
    expect(settled).not.toHaveBeenCalled();
    expect(reader.cancel).not.toHaveBeenCalled();
  });
});
