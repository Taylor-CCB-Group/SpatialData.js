import {
  type BadFileHandler,
  type ElementName,
  readZarr,
  type SpatialData,
  type StoreReference,
} from '@spatialdata/core';
import { createContext, type PropsWithChildren, useContext, useMemo, useRef } from 'react';

type SpatialDataContextValue = {
  spatialDataPromise: Promise<SpatialData> | null;
};

const SpatialDataContext = createContext<SpatialDataContextValue>({ spatialDataPromise: null });

export type SpatialDataProviderProps = {
  source?: StoreReference;
  selection?: ElementName[];
  /**
   * Called for each element that fails to load. Held in a ref, so a new function
   * identity does not reopen the store. Elements are also listed on `SpatialData.badFiles`.
   */
  onBadFiles?: BadFileHandler;
} & PropsWithChildren;

export function SpatialDataProvider({
  children,
  source,
  selection,
  onBadFiles,
}: SpatialDataProviderProps) {
  const onBadFilesRef = useRef(onBadFiles);
  onBadFilesRef.current = onBadFiles;
  const spatialDataPromise = useMemo(
    () =>
      source
        ? readZarr(source, selection, (path, error) => onBadFilesRef.current?.(path, error))
        : null,
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
