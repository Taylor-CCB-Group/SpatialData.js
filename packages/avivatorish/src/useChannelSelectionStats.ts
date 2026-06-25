import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayerChannelSelection } from './layerChannelState';
import type { SelectionRaster } from './utils';
import { getSingleSelectionStats } from './utils';
import { selectionStatsKey } from './channelStats';

export type ChannelSelectionEntry = {
  domain: [number, number];
  contrastLimits: [number, number];
  raster?: SelectionRaster;
};

export type ChannelSelectionStatsResult = {
  /** Stats keyed by channelId (populated as each fetch completes). */
  statsByChannelId: Map<string, ChannelSelectionEntry>;
  /** Positional convenience: `statsByIndex[i]` === `statsByChannelId.get(channelIds[i])`. */
  statsByIndex: (ChannelSelectionEntry | undefined)[];
  /** True while a channel's stats are being fetched. */
  loadingByChannelId: Map<string, boolean>;
};

function buildSelectionKeys(channelIds: string[], selections: LayerChannelSelection[]): string[] {
  return channelIds.map((id, i) => selectionStatsKey(id, selections[i], i));
}

/**
 * Stateful async channel-stats hook: fetches, caches, and returns per-channel
 * stats (domain, contrastLimits, raster) keyed by channelId.
 *
 * Ported from MDV's `useImageLayerRuntime` cache/load/cancel loop, but returns
 * data instead of writing into host stores. MDV adopts this by calling the hook
 * then projecting its output into its zustand stores.
 *
 * - Cache persists across renders via a ref; only changed selection keys refetch.
 * - In-flight fetches are cancelled on unmount or when deps change.
 * - `fallbackDomains` (typically the current `contrastLimits`) are shown while
 *   a channel's stats are loading, matching MDV's pre-fetch display.
 */
export function useChannelSelectionStats({
  loader,
  channelIds,
  selections,
  use3d = false,
  fallbackDomains,
}: {
  loader: unknown;
  channelIds: string[];
  selections: LayerChannelSelection[];
  use3d?: boolean;
  fallbackDomains?: [number, number][];
}): ChannelSelectionStatsResult {
  const statsCacheRef = useRef(new Map<string, ChannelSelectionEntry>());
  const completedKeysRef = useRef<string[]>([]);

  const [result, setResult] = useState<ChannelSelectionStatsResult>(() => ({
    statsByChannelId: new Map(),
    loadingByChannelId: new Map(),
    statsByIndex: [],
  }));

  // Stable dep strings — same approach as MDV
  const channelIdsKey = channelIds.join('\0');
  const selectionsKey = JSON.stringify(selections);
  const fallbackDomainsKey = fallbackDomains ? JSON.stringify(fallbackDomains) : '';
  const selectionSignature = buildSelectionKeys(channelIds, selections).join('\0');
  const channelCount = channelIds.length;

  // Sync projection of the cache into result state, with fallback for unloaded
  // channels. Runs before paint so consumers never see a flash of stale data
  // when inputs change and cache has a hit.
  useLayoutEffect(() => {
    const cache = statsCacheRef.current;
    const statsByChannelId = new Map<string, ChannelSelectionEntry>();
    const loadingByChannelId = new Map<string, boolean>();

    for (let i = 0; i < channelIds.length; i++) {
      const id = channelIds[i];
      if (!id) continue;
      const key = selectionStatsKey(id, selections[i], i);
      const cached = cache.get(key);
      if (cached) {
        statsByChannelId.set(id, cached);
      } else if (fallbackDomains?.[i]) {
        const fb = fallbackDomains[i];
        statsByChannelId.set(id, { domain: fb, contrastLimits: fb });
      }
      loadingByChannelId.set(id, false);
    }

    const statsByIndex = channelIds.map((id) => statsByChannelId.get(id));
    setResult({ statsByChannelId, loadingByChannelId, statsByIndex });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelIdsKey, selectionsKey, fallbackDomainsKey, loader]);

  // Async fetch loop for selection keys that differ from the last completed set.
  useEffect(() => {
    if (!loader) return;

    const nextKeys = buildSelectionKeys(channelIds, selections);

    // Trim if channels were removed
    if (completedKeysRef.current.length > nextKeys.length) {
      completedKeysRef.current = completedKeysRef.current.slice(0, nextKeys.length);
    }

    const indicesToLoad: number[] = [];
    for (let i = 0; i < nextKeys.length; i++) {
      if (nextKeys[i] !== completedKeysRef.current[i]) indicesToLoad.push(i);
    }

    if (indicesToLoad.length === 0) {
      setResult((prev) => {
        const allCleared = channelIds.every((id) => !prev.loadingByChannelId.get(id));
        if (allCleared) return prev;
        const loadingByChannelId = new Map(prev.loadingByChannelId);
        for (const id of channelIds) loadingByChannelId.set(id, false);
        return { ...prev, loadingByChannelId };
      });
      return;
    }

    let cancelled = false;
    const cache = statsCacheRef.current;

    setResult((prev) => {
      const loadingByChannelId = new Map(prev.loadingByChannelId);
      for (const i of indicesToLoad) {
        const id = channelIds[i];
        if (id) loadingByChannelId.set(id, true);
      }
      return { ...prev, loadingByChannelId };
    });

    const markCompleted = (index: number, key: string) => {
      const completed = [...completedKeysRef.current];
      while (completed.length <= index) completed.push('');
      completed[index] = key;
      completedKeysRef.current = completed;
    };

    const applyEntry = (channelId: string, entry: ChannelSelectionEntry) => {
      setResult((prev) => {
        const statsByChannelId = new Map(prev.statsByChannelId);
        statsByChannelId.set(channelId, entry);
        const loadingByChannelId = new Map(prev.loadingByChannelId);
        loadingByChannelId.set(channelId, false);
        const statsByIndex = channelIds.map((id) => statsByChannelId.get(id));
        return { statsByChannelId, loadingByChannelId, statsByIndex };
      });
    };

    void (async () => {
      for (const index of indicesToLoad) {
        if (cancelled) return;

        const channelId = channelIds[index];
        const selection = selections[index];
        if (!channelId) continue;

        const statsKey = nextKeys[index];
        const cached = cache.get(statsKey);
        if (cached) {
          applyEntry(channelId, cached);
          markCompleted(index, statsKey);
          continue;
        }

        const vivSelection = {
          z: selection?.z ?? 0,
          c: selection?.c ?? index,
          t: selection?.t ?? 0,
        };

        try {
          const stats = await getSingleSelectionStats({
            loader,
            selection: vivSelection,
            use3d,
            includeRaster: true,
          });
          if (cancelled) return;

          const entry: ChannelSelectionEntry = {
            domain: stats.domain,
            contrastLimits: stats.contrastLimits,
            raster: stats.raster,
          };
          cache.set(statsKey, entry);
          applyEntry(channelId, entry);
          markCompleted(index, statsKey);
        } catch (error) {
          console.error('useChannelSelectionStats: failed to load channel stats', error);
          if (cancelled) return;
          setResult((prev) => {
            const loadingByChannelId = new Map(prev.loadingByChannelId);
            loadingByChannelId.set(channelId, false);
            return { ...prev, loadingByChannelId };
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelCount, loader, selectionSignature]);

  return result;
}
