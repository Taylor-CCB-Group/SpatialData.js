import { type PropsWithChildren, createContext, useContext, useMemo } from 'react';
import {
  readZarr,
  type ElementName,
  type SpatialData,
  type StoreReference,
} from '@spatialdata/core';

type SpatialDataContextValue = {
  spatialDataPromise: Promise<SpatialData> | null;
};

const SpatialDataContext = createContext<SpatialDataContextValue>({ spatialDataPromise: null });

export type SpatialDataProviderProps = {
  source?: StoreReference;
  selection?: ElementName[];
} & PropsWithChildren;

export function SpatialDataProvider({ children, source, selection }: SpatialDataProviderProps) {
  const spatialDataPromise = useMemo(
    () => (source ? readZarr(source, selection) : null),
    [source, selection]
  );
  return (
    <SpatialDataContext.Provider value={{ spatialDataPromise }}>
      {children}
    </SpatialDataContext.Provider>
  );
}

export function useSpatialDataContext() {
  return useContext(SpatialDataContext);
}
