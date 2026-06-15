import {
  type OmeZarrMultiscalesSource,
  loadOmeZarrMultiscalesData,
} from '@spatialdata/avivatorish';
import { type PropsWithChildren, createContext, useContext, useMemo } from 'react';

export type VivLoaderRegistryValue = {
  /** Multiscales pixel sources for an OME-Zarr store or URL (SpatialCanvas image path). */
  getOmeZarrMultiscalesData: (source: OmeZarrMultiscalesSource) => Promise<unknown>;
};

const defaultRegistry: VivLoaderRegistryValue = {
  getOmeZarrMultiscalesData: loadOmeZarrMultiscalesData,
};

const VivLoaderRegistryContext = createContext<VivLoaderRegistryValue>(defaultRegistry);

export function VivLoaderRegistryProvider({
  children,
  value,
}: PropsWithChildren<{ value?: Partial<VivLoaderRegistryValue> }>) {
  const merged = useMemo(() => ({ ...defaultRegistry, ...value }), [value]);
  return (
    <VivLoaderRegistryContext.Provider value={merged}>{children}</VivLoaderRegistryContext.Provider>
  );
}

export function useVivLoaderRegistry(): VivLoaderRegistryValue {
  return useContext(VivLoaderRegistryContext);
}
