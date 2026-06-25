import type { LayerChannelSelection } from './layerChannelState';

/**
 * Identity for a channel's *loaded stats* (domains / raster / histogram).
 *
 * Keyed by `channelId` **and** its `z`/`c`/`t` selection — channelId alone is
 * insufficient, because changing a row's selection must refetch its stats. The
 * `c` axis falls back to the row `index` (the conventional default selection),
 * `z`/`t` to `0`.
 */
export function selectionStatsKey(
  channelId: string,
  selection: LayerChannelSelection | undefined,
  index: number
): string {
  return `${channelId}:${selection?.z ?? 0}:${selection?.c ?? index}:${selection?.t ?? 0}`;
}

/**
 * Pick the `c` index for a newly added channel row: the first channel not
 * already selected by an existing row, or `0` if every channel is in use.
 */
export function pickDefaultSelectionForAdd(
  selections: LayerChannelSelection[],
  channelNames: string[]
): number {
  const used = new Set(selections.map((selection) => selection.c ?? 0));
  for (let c = 0; c < channelNames.length; c++) {
    if (!used.has(c)) return c;
  }
  return 0;
}
