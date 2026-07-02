import type { SpatialData } from '@spatialdata/core';
import { useEffect, useState } from 'react';
import { useSpatialDataContext } from '../provider/SpatialDataProvider';

type ResolvedSpatialData = {
  /** The promise this result was produced from, used to detect stale results. */
  promise: Promise<SpatialData> | null;
  spatialData: SpatialData | null;
  error: Error | null;
};

export function useSpatialData() {
  const { spatialDataPromise } = useSpatialDataContext();
  // Track which promise each settled result came from so loading/reset can be
  // derived during render rather than synchronised with a setState-in-effect.
  const [resolved, setResolved] = useState<ResolvedSpatialData>({
    promise: null,
    spatialData: null,
    error: null,
  });

  useEffect(() => {
    if (!spatialDataPromise) return;
    let cancelled = false;
    spatialDataPromise
      .then((s) => {
        if (!cancelled) setResolved({ promise: spatialDataPromise, spatialData: s, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setResolved({
            promise: spatialDataPromise,
            spatialData: null,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [spatialDataPromise]);

  // When the current promise hasn't settled into `resolved` yet, we're loading
  // (or idle, if there is no promise). Deriving this avoids resetting state in
  // an effect every time `spatialDataPromise` changes.
  const settled = resolved.promise === spatialDataPromise;
  const loading = Boolean(spatialDataPromise) && !settled;

  return {
    spatialData: settled ? resolved.spatialData : null,
    loading,
    error: settled ? resolved.error : null,
  } as const;
}
