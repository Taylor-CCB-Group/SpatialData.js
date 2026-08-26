/**
 * Combinators for the async-iterable load APIs (#175) — rate control as a function
 * over the stream, rather than a flag threaded through every producer.
 *
 * Nothing here is points-specific.
 */

/**
 * Yield only the newest item whenever the consumer falls behind the producer, so a
 * repaint costs what the consumer can afford rather than what the producer emits.
 *
 * ONLY for CUMULATIVE streams — each item a snapshot subsuming its predecessors, as
 * a progressive load's growing buffer is. On a stream of deltas, dropping one loses
 * data.
 *
 * The source is pumped independently of the consumer, so a slow consumer never
 * throttles the decode. A source failure is raised after any item already in hand.
 */
export async function* coalesceLatest<T>(source: AsyncIterable<T>): AsyncGenerator<T, void> {
  const iterator = source[Symbol.asyncIterator]();
  /** Newest undelivered item, boxed so `undefined` stays a legal item value. */
  let latest: { item: T } | undefined;
  let finished = false;
  let failure: { error: unknown } | undefined;
  /** Resolves the consumer's wait when the pump has news. */
  let wake: (() => void) | undefined;

  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const pump = (async () => {
    try {
      for (;;) {
        const result = await iterator.next();
        if (result.done) {
          break;
        }
        // The overwrite IS the coalescing: whatever was waiting is superseded.
        latest = { item: result.value };
        notify();
      }
    } catch (error) {
      failure = { error };
    } finally {
      finished = true;
      notify();
    }
  })();
  // The pump owns its errors (re-raised below, in consumer order), so this never
  // rejects; referenced only so it does not look unhandled.
  void pump;

  try {
    for (;;) {
      if (latest) {
        const { item } = latest;
        latest = undefined;
        yield item;
        continue;
      }
      if (finished) {
        if (failure) {
          throw failure.error;
        }
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    // Cancellation, however the loop ended. Not awaited: an async generator queues
    // `return()` behind the pump's outstanding `next()`, so awaiting would block on
    // the very read we are abandoning. Posting it is what matters.
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

/**
 * Yield an item only once `metric` has advanced by `step` since the last — plus the
 * final item, always, so the consumer never ends on a stale view.
 *
 * "Repaint every 250k rows", not "every batch". {@link coalesceLatest} adapts to how
 * fast the consumer is; this one to how much has changed. They compose.
 */
export async function* sampleByStep<T>(
  source: AsyncIterable<T>,
  step: number,
  metric: (item: T) => number
): AsyncGenerator<T, void> {
  let lastEmitted: number | undefined;
  /** Held back, not dropped: if the stream ends here it is the consumer's only view
   * of the last few items. */
  let heldBack: { item: T } | undefined;
  for await (const item of source) {
    const value = metric(item);
    if (lastEmitted === undefined || value - lastEmitted >= step) {
      lastEmitted = value;
      heldBack = undefined;
      yield item;
    } else {
      heldBack = { item };
    }
  }
  if (heldBack) {
    yield heldBack.item;
  }
}

/**
 * Drain an async generator into `onItem` and return its return value — the bridge
 * that lets a deprecated `onProgress` be the same code path as the stream.
 */
export async function drainStream<T, TReturn>(
  stream: AsyncGenerator<T, TReturn>,
  onItem?: (item: T) => void
): Promise<TReturn> {
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      return next.value;
    }
    onItem?.(next.value);
  }
}
