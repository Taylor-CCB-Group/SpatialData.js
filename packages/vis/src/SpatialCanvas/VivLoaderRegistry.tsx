import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';
import { loadOmeZarrMultiscalesData } from '@spatialdata/avivatorish';

export type VivLoaderRegistryValue = {
  /** Multiscales pixel sources for an OME-Zarr URL (SpatialCanvas image path). */
  getOmeZarrMultiscalesData: (url: string) => Promise<unknown>;
};

const defaultRegistry: VivLoaderRegistryValue = {
  getOmeZarrMultiscalesData: loadOmeZarrMultiscalesData,
};

const VivLoaderRegistryContext = createContext<VivLoaderRegistryValue>(defaultRegistry);

export function VivLoaderRegistryProvider({
  children,
  value,
}: PropsWithChildren<{ value?: Partial<VivLoaderRegistryValue> }>) {
  const merged = useMemo(
    () => ({ ...defaultRegistry, ...value }),
    [value?.getOmeZarrMultiscalesData],
  );
  return (
    <VivLoaderRegistryContext.Provider value={merged}>{children}</VivLoaderRegistryContext.Provider>
  );
}

export function useVivLoaderRegistry(): VivLoaderRegistryValue {
  return useContext(VivLoaderRegistryContext);
}
