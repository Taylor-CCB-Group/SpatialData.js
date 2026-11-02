import {
  type BadFileHandler,
  type ElementName,
  readZarr,
  type SpatialData,
  type StoreReference,
} from '@spatialdata/core';
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

type SpatialDataContextValue = {
  spatialDataPromise: Promise<SpatialData> | null;
};

const SpatialDataContext = createContext<SpatialDataContextValue>({ spatialDataPromise: null });

/** A stable handler that forwards to whichever `onBadFiles` was most recently set. */
function createLatestHandler() {
  let current: BadFileHandler | undefined;
  return {
    set(handler?: BadFileHandler) {
      current = handler;
    },
    call: ((path, error) => current?.(path, error)) satisfies BadFileHandler,
  };
}

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
  const [latestHandler] = useState(createLatestHandler);
  useEffect(() => latestHandler.set(onBadFiles), [latestHandler, onBadFiles]);
  const spatialDataPromise = useMemo(
    () => (source ? readZarr(source, selection, latestHandler.call) : null),
    [source, selection, latestHandler]
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
