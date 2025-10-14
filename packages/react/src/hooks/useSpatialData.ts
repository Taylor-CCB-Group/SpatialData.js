import { useEffect, useState } from 'react';
import type { SpatialData } from '@spatialdata/core';
import { useSpatialDataContext } from '../provider/SpatialDataProvider';

export function useSpatialData() {
  const { spatialDataPromise } = useSpatialDataContext();
  const [spatialData, setSpatialData] = useState<SpatialData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSpatialData(null);
    if (!spatialDataPromise) {
      setLoading(false);
      return;
    }
    spatialDataPromise
      .then((s) => {
        if (!cancelled) setSpatialData(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spatialDataPromise]);

  return { spatialData, loading, error } as const;
}


