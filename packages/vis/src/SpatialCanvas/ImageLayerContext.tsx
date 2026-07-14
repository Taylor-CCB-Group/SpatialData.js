import { createContext, type PropsWithChildren, useContext } from 'react';
import type { ImageLoaderData, LayerLoadState } from './useLayerData';

export type ImageLayerContextRegistry = {
  getImageLoadedDataByElementKey: (elementKey: string) => ImageLoaderData | undefined;
  getLayerLoadStateByElementKey?: (elementKey: string) => LayerLoadState | undefined;
};

export type ImageLayerContextValue = {
  loader: unknown;
  defaults: ImageLoaderData;
  channelNames: string[];
  selectionAxisSizes?: ImageLoaderData['selectionAxisSizes'];
  loadState?: LayerLoadState;
};

const ImageLayerContext = createContext<ImageLayerContextRegistry | null>(null);

export function ImageLayerContextProvider({
  children,
  getImageLoadedDataByElementKey,
  getLayerLoadStateByElementKey,
}: PropsWithChildren<ImageLayerContextRegistry>) {
  return (
    <ImageLayerContext.Provider
      value={{ getImageLoadedDataByElementKey, getLayerLoadStateByElementKey }}
    >
      {children}
    </ImageLayerContext.Provider>
  );
}

/**
 * Per-layer loaded Viv loader, loader defaults, and OME channel names for layer panels.
 * Returns `undefined` when the image element is not loaded yet.
 */
export function useImageLayerContext(elementKey: string): ImageLayerContextValue | undefined {
  const registry = useContext(ImageLayerContext);
  if (!registry) {
    throw new Error('useImageLayerContext must be used within SpatialCanvasViewer');
  }
  const defaults = registry.getImageLoadedDataByElementKey(elementKey);
  if (!defaults) {
    return undefined;
  }
  return {
    loader: defaults.loader,
    defaults,
    channelNames: defaults.channelNames ?? [],
    selectionAxisSizes: defaults.selectionAxisSizes,
    loadState: registry.getLayerLoadStateByElementKey?.(elementKey),
  };
}
