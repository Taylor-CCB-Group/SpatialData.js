import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createStore } from 'zustand';
import { useStore } from 'zustand';
import { clampVivSelectionsToAxes } from './utils';
import { COLOR_PALLETE, MAX_CHANNELS } from './constants';

export type LayerChannelSelection = Partial<{ z: number; c: number; t: number }>;

/** Serializable struct-of-arrays channel config (Phase 1). Extension props stay host-owned. */
export type LayerChannelConfig = {
  channelIds?: string[];
  colors?: [number, number, number][];
  contrastLimits?: [number, number][];
  channelsVisible?: boolean[];
  selections?: LayerChannelSelection[];
};

export type LayerChannelDefaults = {
  colors?: [number, number, number][];
  contrastLimits?: [number, number][];
  channelsVisible?: boolean[];
  selections?: LayerChannelSelection[];
  selectionAxisSizes?: Partial<Record<'z' | 'c' | 't', number>>;
};

type AxisSizes = Partial<Record<'z' | 'c' | 't', number>>;

/**
 * Canonical, order-stable serialization of a channel config.
 *
 * Unlike a plain `JSON.stringify(config)`, this emits a deterministic string for
 * two semantically-equal configs. The array fields (`channelIds`, `colors`,
 * `contrastLimits`, `channelsVisible`) are positional and already stable; the
 * offender is `selections`, whose rows are `Partial<{ z, c, t }>` objects where
 * `JSON.stringify` key order follows insertion order — so `{ z:0, c:0 }` and
 * `{ c:0, z:0 }` would serialize differently despite being equal. Each selection
 * row is normalized to a fixed-order `[z, c, t]` tuple (absent axes as `null`,
 * which stays distinct from an explicit `0`).
 *
 * Use this as the single channel-config identity/equality basis on both sides of
 * the bridge (it backs {@link channelConfigsEqual} here, and is the intended
 * replacement for `JSON.stringify`-based `channelConfigKey` in the host).
 */
export function serializeChannelConfig(config: LayerChannelConfig): string {
  const selections = (config.selections ?? []).map((s) => [s.z ?? null, s.c ?? null, s.t ?? null]);
  return JSON.stringify({
    channelIds: config.channelIds ?? null,
    colors: config.colors ?? null,
    contrastLimits: config.contrastLimits ?? null,
    channelsVisible: config.channelsVisible ?? null,
    selections,
  });
}

/** Order-stable structural equality for channel configs, via {@link serializeChannelConfig}. */
export function channelConfigsEqual(a: LayerChannelConfig, b: LayerChannelConfig): boolean {
  return serializeChannelConfig(a) === serializeChannelConfig(b);
}

function emptySelectionRow(axisSizes: AxisSizes | undefined): LayerChannelSelection {
  if (axisSizes === undefined) {
    return { z: 0, c: 0, t: 0 };
  }
  const o: LayerChannelSelection = {};
  for (const dim of ['z', 'c', 't'] as const) {
    if (axisSizes[dim] !== undefined) {
      o[dim] = 0;
    }
  }
  return o;
}

function mergeSelectionRow(
  override: LayerChannelSelection | undefined,
  fallback: LayerChannelSelection,
  axisSizes: AxisSizes | undefined
): LayerChannelSelection {
  const merged: LayerChannelSelection = { ...fallback, ...override };
  if (axisSizes === undefined) {
    return {
      z: merged.z ?? 0,
      c: merged.c ?? 0,
      t: merged.t ?? 0,
    };
  }
  if (Object.keys(axisSizes).length === 0) {
    return {};
  }
  return clampVivSelectionsToAxes([merged], axisSizes)[0] ?? {};
}

function pad<T>(arr: T[], len: number, fill: T): T[] {
  const out = arr.slice(0, len);
  while (out.length < len) out.push(fill);
  return out;
}

export type MergedLayerChannelState = {
  channelCount: number;
  channelIds: string[];
  colors: [number, number, number][];
  contrastLimits: [number, number][];
  channelsVisible: boolean[];
  selections: LayerChannelSelection[];
};

export function mergeLayerChannelState(
  config: LayerChannelConfig,
  defaults: LayerChannelDefaults | undefined,
  layerId: string
): MergedLayerChannelState {
  const axisSizes = defaults?.selectionAxisSizes;
  const ch = config;

  const baseColors = defaults?.colors?.length
    ? defaults.colors
    : [[255, 255, 255] as [number, number, number]];
  const baseContrast = defaults?.contrastLimits?.length
    ? defaults.contrastLimits
    : [[0, 65535] as [number, number]];
  const baseVis = defaults?.channelsVisible?.length ? defaults.channelsVisible : [true];

  const baseSelRaw: LayerChannelSelection[] =
    defaults?.selections?.length && defaults.selections.length > 0
      ? defaults.selections.map((s) => ({ ...s }))
      : [emptySelectionRow(axisSizes)];

  const colors = ch.colors && ch.colors.length > 0 ? [...ch.colors] : [...baseColors];
  const contrastLimits =
    ch.contrastLimits && ch.contrastLimits.length > 0 ? [...ch.contrastLimits] : [...baseContrast];
  const channelsVisible =
    ch.channelsVisible && ch.channelsVisible.length > 0 ? [...ch.channelsVisible] : [...baseVis];

  let selections: LayerChannelSelection[];
  if (ch.selections && ch.selections.length > 0) {
    selections = ch.selections.map((s, i) =>
      mergeSelectionRow(
        s,
        baseSelRaw[i] ?? baseSelRaw[0] ?? emptySelectionRow(axisSizes),
        axisSizes
      )
    );
  } else {
    selections = baseSelRaw.map((s) => mergeSelectionRow(undefined, s, axisSizes));
  }

  const channelCount = Math.min(
    MAX_CHANNELS,
    Math.max(colors.length, contrastLimits.length, channelsVisible.length, selections.length, 1)
  );

  const fillSel = emptySelectionRow(axisSizes);

  const channelIds: string[] = [];
  for (let i = 0; i < channelCount; i++) {
    channelIds.push(ch.channelIds?.[i] ?? `${layerId}:ch:${i}`);
  }

  return {
    channelCount,
    channelIds,
    colors: pad(colors, channelCount, [255, 255, 255] as [number, number, number]),
    contrastLimits: pad(contrastLimits, channelCount, [0, 65535] as [number, number]),
    channelsVisible: pad(channelsVisible, channelCount, true),
    selections: pad(selections, channelCount, mergeSelectionRow(undefined, fillSel, axisSizes)),
  };
}

function mergedToConfig(merged: MergedLayerChannelState): LayerChannelConfig {
  return {
    channelIds: [...merged.channelIds],
    colors: merged.colors.map((c) => [...c] as [number, number, number]),
    contrastLimits: merged.contrastLimits.map((c) => [...c] as [number, number]),
    channelsVisible: [...merged.channelsVisible],
    selections: merged.selections.map((s) => ({ ...s })),
  };
}

type LayerChannelStoreState = MergedLayerChannelState;

function createLayerChannelStore(initial: MergedLayerChannelState) {
  return createStore<LayerChannelStoreState>(() => ({ ...initial }));
}

export type UseLayerChannelStateOptions = {
  config: LayerChannelConfig;
  defaults?: LayerChannelDefaults;
  layerId: string;
  onChannelsChange: (next: LayerChannelConfig) => void;
};

export type UseLayerChannelStateResult = MergedLayerChannelState & {
  selectionAxisSizes: AxisSizes | undefined;
  setChannels: (patch: Partial<LayerChannelConfig>) => void;
  addChannel: () => void;
  removeChannel: (index: number) => void;
};

export function useLayerChannelState({
  config,
  defaults,
  layerId,
  onChannelsChange,
}: UseLayerChannelStateOptions): UseLayerChannelStateResult {
  const selectionAxisSizes = defaults?.selectionAxisSizes;
  const lastEmittedRef = useRef<LayerChannelConfig | null>(null);

  const mergedInitial = useMemo(
    () => mergeLayerChannelState(config, defaults, layerId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate effect handles config updates
    [layerId]
  );

  const storeRef = useRef(createLayerChannelStore(mergedInitial));

  useEffect(() => {
    if (lastEmittedRef.current && channelConfigsEqual(config, lastEmittedRef.current)) {
      return;
    }
    storeRef.current.setState(mergeLayerChannelState(config, defaults, layerId));
  }, [config, defaults, layerId]);

  const merged = useStore(storeRef.current);

  const emit = useCallback(
    (nextMerged: MergedLayerChannelState) => {
      const nextConfig = mergedToConfig(nextMerged);
      lastEmittedRef.current = nextConfig;
      onChannelsChange(nextConfig);
    },
    [onChannelsChange]
  );

  const setChannels = useCallback(
    (patch: Partial<LayerChannelConfig>) => {
      const current = storeRef.current.getState();
      const nextMerged = mergeLayerChannelState(
        { ...mergedToConfig(current), ...patch },
        defaults,
        layerId
      );
      storeRef.current.setState(nextMerged);
      emit(nextMerged);
    },
    [defaults, emit, layerId]
  );

  const addChannel = useCallback(() => {
    const current = storeRef.current.getState();
    if (current.channelCount >= MAX_CHANNELS) return;

    const nextIndex = current.channelCount;
    const palette = COLOR_PALLETE[nextIndex % COLOR_PALLETE.length];
    const defaultContrast = current.contrastLimits[0] ?? ([0, 65535] as [number, number]);
    const fillSel = emptySelectionRow(selectionAxisSizes);
    const newId =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${layerId}:ch:${nextIndex}`;

    const nextMerged: MergedLayerChannelState = {
      channelCount: current.channelCount + 1,
      channelIds: [...current.channelIds, newId],
      colors: [...current.colors, [palette[0], palette[1], palette[2]] as [number, number, number]],
      contrastLimits: [...current.contrastLimits, [...defaultContrast] as [number, number]],
      channelsVisible: [...current.channelsVisible, true],
      selections: [
        ...current.selections,
        mergeSelectionRow(
          undefined,
          current.selections[0] ?? fillSel,
          selectionAxisSizes
        ),
      ],
    };
    storeRef.current.setState(nextMerged);
    emit(nextMerged);
  }, [emit, layerId, selectionAxisSizes]);

  const removeChannel = useCallback(
    (index: number) => {
      const current = storeRef.current.getState();
      if (current.channelCount <= 1 || index < 0 || index >= current.channelCount) return;

      const splice = <T,>(arr: T[]) => arr.filter((_, i) => i !== index);
      const nextMerged: MergedLayerChannelState = {
        channelCount: current.channelCount - 1,
        channelIds: splice(current.channelIds),
        colors: splice(current.colors),
        contrastLimits: splice(current.contrastLimits),
        channelsVisible: splice(current.channelsVisible),
        selections: splice(current.selections),
      };
      storeRef.current.setState(nextMerged);
      emit(nextMerged);
    },
    [emit]
  );

  return {
    ...merged,
    selectionAxisSizes,
    setChannels,
    addChannel,
    removeChannel,
  };
}
