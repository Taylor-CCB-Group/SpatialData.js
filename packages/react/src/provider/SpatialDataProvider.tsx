import { type PropsWithChildren, createContext, useContext, useMemo } from 'react';
import { readZarr, type ElementName, type SpatialData } from '@spatialdata/core';

type SpatialDataContextValue = {
  spatialDataPromise: Promise<SpatialData> | null;
};

const SpatialDataContext = createContext<SpatialDataContextValue>({ spatialDataPromise: null });

export type SpatialDataProviderProps = {
  storeUrl: string;
  selection?: ElementName[];
} & PropsWithChildren;

export function SpatialDataProvider({ children, storeUrl, selection }: SpatialDataProviderProps) {
  const spatialDataPromise = useMemo(() => readZarr(storeUrl, selection), [storeUrl, selection]);
  return (
    <SpatialDataContext.Provider value={{ spatialDataPromise }}>
      {children}
    </SpatialDataContext.Provider>
  );
}

export function useSpatialDataContext() {
  return useContext(SpatialDataContext);
}


