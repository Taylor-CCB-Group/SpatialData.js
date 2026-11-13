import type { Layer } from '@deck.gl/core';
import {
  IsolatedGroupLayer,
  type RenderStack,
  type RenderStackEntry,
  type RenderStackHostEntry,
  type RenderStackSpatialEntry,
  resolveRenderStackGroupProps,
} from '@spatialdata/layers';
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

/**
 * What a leaf inherits from the groups above it.
 * - `visible`: false if it or any ancestor is hidden.
 * - `opacity`: the product of the pass-through groups' opacities up to the nearest
 *   isolated group, whose own opacity applies to its composite instead.
 */
interface InheritedState {
  visible: boolean;
  opacity: number;
}

type RenderStackLeaf = RenderStackSpatialEntry | RenderStackHostEntry;

/** Visits each spatial and host entry at any depth, in draw order. */
function forEachRenderStackLeaf(
  entries: readonly RenderStackEntry[],
  visit: (entry: RenderStackLeaf, inherited: InheritedState) => void,
  inherited: InheritedState = { visible: true, opacity: 1 }
): void {
  for (const entry of entries) {
    const visible = inherited.visible && entry.visible;
    if (entry.kind !== 'group') {
      visit(entry, { visible, opacity: inherited.opacity });
      continue;
    }
    const group = resolveRenderStackGroupProps(entry);
    const opacity = group.isolate ? 1 : inherited.opacity * group.opacity;
    forEachRenderStackLeaf(entry.children, visit, { visible, opacity });
  }
}

function spatialEntryToLayerConfig(
  entry: RenderStackSpatialEntry,
  inherited: InheritedState
): LayerConfig {
  // RenderStack props are JSON/runtime extension data. This is the narrow adapter
  // boundary where they merge with typed SpatialCanvas layer fields.
  return layerConfig(
    entry.source.elementType,
    {
      id: entry.id,
      elementKey: entry.source.elementKey,
      visible: inherited.visible,
      opacity: numberProp(entry.props, 'opacity', 1) * inherited.opacity,
    },
    entry.props
  );
}

/** Spatial entries at any depth, as layer configs in draw order. A config is hidden
 *  when an ancestor is, and carries its pass-through groups' opacity. */
export function renderStackToLayerInputs(renderStack: RenderStack): RenderStackLayerInputs {
  const layers: Record<string, LayerConfig> = {};
  const layerOrder: string[] = [];

  forEachRenderStackLeaf(renderStack.entries, (entry, inherited) => {
    if (entry.kind !== 'spatial') return;
    layers[entry.id] = spatialEntryToLayerConfig(entry, inherited);
    layerOrder.push(entry.id);
  });

  return { layers, layerOrder };
}

function resolveHostEntry(
  entry: RenderStackHostEntry,
  inherited: InheritedState,
  resolver: RenderStackHostLayerResolver,
  onUnknownHostLayer?: UnknownRenderStackHostLayerHandler
): Layer[] {
  const resolved = resolver(entry);
  if (!resolved) {
    onUnknownHostLayer?.(entry);
    return [];
  }
  const layers = Array.isArray(resolved) ? resolved.filter(Boolean) : [resolved];
  return layers.map((layer) =>
    layer.clone(
      inherited.opacity === 1
        ? { id: entry.id }
        : { id: entry.id, opacity: (layer.props.opacity ?? 1) * inherited.opacity }
    )
  );
}

/** Visible host entries at any depth, resolved to deck layers with their entry ids,
 *  carrying their pass-through groups' opacity. */
export function resolveRenderStackHostLayers(
  renderStack: RenderStack | undefined,
  resolver?: RenderStackHostLayerResolver,
  onUnknownHostLayer?: UnknownRenderStackHostLayerHandler
): Layer[] {
  if (!renderStack || !resolver) return [];

  const layers: Layer[] = [];
  forEachRenderStackLeaf(renderStack.entries, (entry, inherited) => {
    if (entry.kind !== 'host' || !inherited.visible) return;
    layers.push(...resolveHostEntry(entry, inherited, resolver, onUnknownHostLayer));
  });
  return layers;
}

/** Spatial and host entry ids at any depth, in draw order. */
export function renderStackOrder(
  renderStack: RenderStack | undefined,
  fallback: string[]
): string[] {
  if (!renderStack) return fallback;
  const order: string[] = [];
  forEachRenderStackLeaf(renderStack.entries, (entry) => {
    order.push(entry.id);
  });
  return order;
}

export interface RenderStackDeckLayerOptions {
  /**
   * Layers the caller has already built, by entry id: spatial entries, and any host
   * entries it resolved itself. They are used as given, so they must already carry
   * inherited visibility and opacity, as `renderStackToLayerInputs` and
   * `resolveRenderStackHostLayers` build them.
   */
  entryLayers?: ReadonlyMap<string, readonly Layer[]>;
  /** Resolves host entries that `entryLayers` has nothing for. */
  hostLayerResolver?: RenderStackHostLayerResolver;
  onUnknownHostLayer?: UnknownRenderStackHostLayerHandler;
}

/**
 * The stack as top-level deck layers, in draw order. Each isolated group, or group
 * with a blend mode other than `pass-through`, becomes an `IsolatedGroupLayer` with
 * the entry's id, holding its members' layers. Pass-through groups add no layer.
 *
 * Hidden entries contribute only what `entryLayers` already has for them, unwrapped,
 * so their layers keep their deck state while hidden.
 *
 * Runs with host layers alone: it needs no SpatialData, SpatialCanvas or Viv. A host
 * routing layers to views by id (as Viv does with `layerFilter`) tags the returned
 * top-level layers; members inside a group are never checked.
 */
export function renderStackToDeckLayers(
  renderStack: RenderStack,
  { entryLayers, hostLayerResolver, onUnknownHostLayer }: RenderStackDeckLayerOptions = {}
): Layer[] {
  const build = (entries: readonly RenderStackEntry[], inherited: InheritedState): Layer[] =>
    entries.flatMap((entry): Layer[] => {
      const visible = inherited.visible && entry.visible;
      if (entry.kind !== 'group') {
        const given = entryLayers?.get(entry.id);
        if (given) return [...given];
        if (entry.kind !== 'host' || !visible || !hostLayerResolver) return [];
        return resolveHostEntry(
          entry,
          { visible, opacity: inherited.opacity },
          hostLayerResolver,
          onUnknownHostLayer
        );
      }
      const group = resolveRenderStackGroupProps(entry);
      if (!visible || !group.isolate) {
        return build(entry.children, {
          visible,
          opacity: inherited.opacity * group.opacity,
        });
      }
      const members = build(entry.children, { visible, opacity: 1 });
      if (members.length === 0) return [];
      return [
        new IsolatedGroupLayer({
          id: entry.id,
          layers: members,
          blendMode: group.blendMode === 'pass-through' ? 'normal' : group.blendMode,
          opacity: inherited.opacity * group.opacity,
        }),
      ];
    });

  return build(renderStack.entries, { visible: true, opacity: 1 });
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
