import type {
  RenderStack,
  RenderStackHostEntry,
  RenderStackSpatialEntry,
} from '@spatialdata/layers';
import type { Layer } from 'deck.gl';
import { layerConfig } from './layerConfig';
import type { LayerConfig } from './types';

export type RenderStackHostLayerResolver = (
  entry: RenderStackHostEntry
) => Layer | Layer[] | null | undefined;

export type UnknownRenderStackHostLayerHandler = (entry: RenderStackHostEntry) => void;

export interface RenderStackLayerInputs {
  layers: Record<string, LayerConfig>;
  layerOrder: string[];
}

function numberProp(props: Record<string, unknown>, key: string, fallback: number): number {
  const value = props[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function spatialEntryToLayerConfig(entry: RenderStackSpatialEntry): LayerConfig {
  // RenderStack props are JSON/runtime extension data. This is the narrow adapter
  // boundary where they merge with typed SpatialCanvas layer fields.
  return layerConfig(
    entry.source.elementType,
    {
      id: entry.id,
      elementKey: entry.source.elementKey,
      visible: entry.visible,
      opacity: numberProp(entry.props, 'opacity', 1),
    },
    entry.props
  );
}

export function renderStackToLayerInputs(renderStack: RenderStack): RenderStackLayerInputs {
  const layers: Record<string, LayerConfig> = {};
  const layerOrder: string[] = [];

  for (const entry of renderStack.entries) {
    if (entry.kind !== 'spatial') continue;
    layers[entry.id] = spatialEntryToLayerConfig(entry);
    layerOrder.push(entry.id);
  }

  return { layers, layerOrder };
}

export function resolveRenderStackHostLayers(
  renderStack: RenderStack | undefined,
  resolver?: RenderStackHostLayerResolver,
  onUnknownHostLayer?: UnknownRenderStackHostLayerHandler
): Layer[] {
  if (!renderStack || !resolver) return [];

  const layers: Layer[] = [];
  for (const entry of renderStack.entries) {
    if (entry.kind !== 'host' || !entry.visible) continue;
    const resolved = resolver(entry);
    if (!resolved) {
      onUnknownHostLayer?.(entry);
      continue;
    }
    if (Array.isArray(resolved)) {
      const compact = resolved.filter(Boolean);
      layers.push(...compact.map((layer) => layer.clone({ id: entry.id })));
    } else {
      layers.push(resolved.clone({ id: entry.id }));
    }
  }
  return layers;
}

export function renderStackOrder(
  renderStack: RenderStack | undefined,
  fallback: string[]
): string[] {
  if (!renderStack) return fallback;
  return renderStack.entries.flatMap((entry) => {
    if (entry.kind === 'spatial' || entry.kind === 'host') {
      return entry.id;
    }
    return entry.children;
  });
}

export function sortLayersByRenderStackOrder(layers: Layer[], order: string[]): Layer[] {
  if (order.length === 0) return layers;
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return layers
    .map((layer, originalIndex) => ({
      layer,
      originalIndex,
      order: orderIndex.get(layer.id),
    }))
    .sort((a, b) => {
      if (a.order === undefined && b.order === undefined) return a.originalIndex - b.originalIndex;
      if (a.order === undefined) return 1;
      if (b.order === undefined) return -1;
      return a.order - b.order;
    })
    .map((record) => record.layer);
}
