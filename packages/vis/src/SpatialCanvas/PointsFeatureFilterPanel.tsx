import {
  featureNamesForCodes,
  pointsTilingEnabled,
  resolveFeatureSelectionCodes,
} from '@spatialdata/core';
import { featureCodeToRgb } from '@spatialdata/layers';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSpatialCanvasActions } from './context';
import {
  classifyFeatureRow,
  type FeatureRowsInput,
  featureRowOpacity,
  summariseFeatureRows,
} from './featureRowState';
import { usePointsFeatureState } from './PointsFeatureState';
import type { PointsLayerConfig } from './types';

// we need a pass on how we manage styles

// The colour swatch IS the picker: this span's background shows the feature's
// effective colour, and a transparent native colour input overlays it. `inline-block`
// + `box-sizing: border-box` make the 12×12 size hold regardless of flex context and
// keep the 1px border inside the box (an inline span would ignore width/height, and a
// content-box border would overflow — the layout bug this replaces).
const colorSwatchStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  boxSizing: 'border-box',
  width: 12,
  height: 12,
  flexShrink: 0,
  borderRadius: 2,
  border: '1px solid rgba(255, 255, 255, 0.25)',
};

const colorSwatchOverriddenStyle: CSSProperties = {
  borderColor: '#6cb6ff',
  boxShadow: '0 0 0 1px #6cb6ff',
};

const colorInputStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  margin: 0,
  padding: 0,
  border: 'none',
  opacity: 0,
  cursor: 'pointer',
  appearance: 'none',
  WebkitAppearance: 'none',
};

const resetOverrideStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
  padding: '0 3px',
  border: '1px solid #444',
  borderRadius: 3,
  background: '#222',
  cursor: 'pointer',
  flexShrink: 0,
};

const hex2 = (value: number): string =>
  Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');

/** `[r,g,b]` (0–255) → `#rrggbb` for a native colour input's value. */
function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** `#rrggbb` → `[r,g,b]` (0–255). */
function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  color: '#ccc',
  fontSize: '12px',
};

/**
 * Fixed row height (px) for the virtualized list. Fixed rather than measured: a row
 * is one line of text beside a checkbox and a swatch, so there is nothing to
 * measure and the virtualizer stays off `ResizeObserver`. {@link featureRowStyle}
 * pins the same number on the row — rows are absolutely positioned, so one taller
 * than its estimate would overlap its neighbour rather than push it down.
 */
const FEATURE_ROW_HEIGHT = 22;

/** Scroll viewport height, also the virtualizer's `initialRect`, so the first
 * render (before layout measures the container) windows to rows rather than none. */
const FEATURE_LIST_HEIGHT = 180;

const listStyle: CSSProperties = {
  maxHeight: FEATURE_LIST_HEIGHT,
  overflowY: 'auto',
};

const checkboxLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

/** A virtualized row: absolutely positioned in the spacer, translated to its slot. */
const featureRowStyle: CSSProperties = {
  ...checkboxLabelStyle,
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: FEATURE_ROW_HEIGHT,
};

const helperStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
};

const loadingStatStyle: CSSProperties = {
  color: '#6cb6ff',
  fontSize: '11px',
};

const errorStatStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 4,
  color: '#e2a0a0',
  fontSize: '11px',
};

/** The resident figure in a `resident / dataset` pair — the number that is actually
 * on screen, so it carries the emphasis. */
const shortfallStyle: CSSProperties = {
  color: '#d0a24c',
};

const ofTotalStyle: CSSProperties = {
  color: '#777',
};

const countStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
  marginLeft: 'auto',
  flexShrink: 0,
};

const searchStyle: CSSProperties = {
  color: '#ccc',
  fontSize: '12px',
  padding: '4px 6px',
  borderRadius: 4,
  border: '1px solid #444',
  background: '#1a1a1a',
};

const buttonStyle: CSSProperties = {
  alignSelf: 'flex-start',
  color: '#ddd',
  fontSize: '12px',
  padding: '4px 8px',
  borderRadius: 4,
  border: '1px solid #555',
  background: '#2a2a2a',
  cursor: 'pointer',
};

const FEATURE_LIST_SEARCH_THRESHOLD = 100;

function formatFeatureCount(count: number | undefined): string {
  if (count === undefined) {
    return '—';
  }
  return count.toLocaleString();
}

export interface PointsFeatureFilterPanelProps {
  config: PointsLayerConfig;
}

export function PointsFeatureFilterPanel({ config }: PointsFeatureFilterPanelProps) {
  // Opt out of the React Compiler. The usePoints* hooks re-render this component
  // on every engine `notify` (via useSyncExternalStore), but they read mutable
  // engine state the compiler can't see as a dependency, so it would memoize the
  // returned JSX and keep the pre-catalog "not loaded" branch on screen even
  // after the component re-runs with the catalog present. Scoped to this leaf,
  // this is far narrower than the old canvas-wide escape hatch.
  'use no memo';
  const layerId = config.id;
  const { updateLayer } = useSpatialCanvasActions();
  // Reactive points state, read straight from the engine via the surrounding
  // <PointsFeatureStateProvider>.
  const {
    catalog,
    catalogLoading,
    catalogRefining,
    residentCodes,
    tiled,
    loadedMatchingCodes,
    supportsOnDemandLoad,
    matchingLoadState,
    residentFeatureCounts,
    highlightedFeature,
    requestCatalog,
    setHighlightedFeature,
    retryFailedLoads,
  } = usePointsFeatureState(config);

  const [searchQuery, setSearchQuery] = useState('');
  // Request the full-dataset catalog whenever this panel is shown for a layer.
  // The engine dedupes (no-op once the full scan has settled), so this simply
  // upgrades the instant resident-subset preview to the complete list + counts.
  useEffect(() => {
    requestCatalog();
  }, [requestCatalog]);
  // Clear any lingering hover highlight when the panel unmounts (or its layer
  // changes), so an emphasis doesn't stick after the pointer is long gone.
  useEffect(() => () => setHighlightedFeature(null), [setHighlightedFeature]);
  const entries = useMemo(() => catalog?.entries ?? [], [catalog?.entries]);
  const hasCounts = entries.some((entry) => entry.count !== undefined);
  // Authoritative dataset counts only arrive with the catalog's counts scan. Until
  // then fall back to the running resident-window tally accumulated while the points
  // streamed in — enough to populate and sort the column immediately. Partial values
  // are marked with a leading "≥" so they are never mistaken for dataset totals.
  const partialCounts = residentFeatureCounts;
  const hasAnyCounts = hasCounts || (partialCounts?.size ?? 0) > 0;
  const effectiveCount = (entry: { code: number; count?: number }): number | undefined =>
    entry.count ?? partialCounts?.get(entry.code);
  const countIsPartial = (entry: { code: number; count?: number }): boolean =>
    entry.count === undefined && partialCounts?.get(entry.code) !== undefined;
  // Dataset totals by code, so a row need not rescan `entries` to find its own.
  // Memoised: it is O(features) to build, and it feeds the whole-catalog pass below,
  // which a fresh Map per render would defeat.
  const datasetCountByCode = useMemo(
    () =>
      new Map<number, number>(
        entries.flatMap((entry) => (entry.count !== undefined ? [[entry.code, entry.count]] : []))
      ),
    [entries]
  );
  /** Resident points for a feature, when that is meaningfully LESS than the dataset —
   * i.e. there is a shortfall worth showing. `undefined` otherwise. */
  const residentShortfall = (entry: { code: number; count?: number }): number | undefined => {
    if (entry.count === undefined) return undefined;
    const resident = residentFeatureCounts?.get(entry.code);
    if (resident === undefined || resident >= entry.count) return undefined;
    return resident;
  };
  // The selection persists as NAMES (see `PointsLayerConfig.featureNames`), but the
  // rest of this panel — checkboxes, greying, the engine reads — works in codes.
  // Resolve once here against the catalog we are already rendering. Memoised on the
  // two config fields rather than on `config`, which is a fresh object every render;
  // its identity gates the whole-catalog pass below.
  const configFeatureNames = config.featureNames;
  const configFeatureCodes = config.featureCodes;
  const selection = useMemo(
    () =>
      resolveFeatureSelectionCodes(
        { featureNames: configFeatureNames, featureCodes: configFeatureCodes },
        catalog
      ),
    [configFeatureNames, configFeatureCodes, catalog]
  );
  const allSelected = selection === undefined;
  const noneSelected = selection !== undefined && selection.length === 0;
  const selectedCodes = useMemo(
    () =>
      allSelected ? new Set(entries.map((entry) => entry.code)) : new Set<number>(selection ?? []),
    [allSelected, entries, selection]
  );

  const sortedEntries = useMemo(() => {
    const list = [...entries];
    const rank = (entry: { code: number; count?: number }): number =>
      entry.count ?? partialCounts?.get(entry.code) ?? -1;
    if (hasAnyCounts) {
      list.sort((left, right) => {
        const countDiff = rank(right) - rank(left);
        if (countDiff !== 0) {
          return countDiff;
        }
        return left.name.localeCompare(right.name);
      });
    } else {
      list.sort((left, right) => left.name.localeCompare(right.name));
    }
    return list;
  }, [entries, hasAnyCounts, partialCounts]);

  const visibleEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return sortedEntries;
    }
    return sortedEntries.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [sortedEntries, searchQuery]);

  // A feature's points are "loaded" (renderable now, not greyed) if it is in the
  // instant resident preview OR its points are currently on screen via the
  // last-completed feature-index scan (`loadedMatchingCodes`). Keying off what's
  // rendered — not the current scan's settled state — keeps already-loaded
  // features un-greyed while a newly added feature's scan is still in flight.
  const residentKnown = residentCodes !== undefined;
  // Element fact AND this layer's config — the probe's answer is cached per element
  // and outlives the config that asked for it.
  const tiledLayer = tiled && pointsTilingEnabled(config.pointsTiling);
  const scanning = matchingLoadState?.loading ?? false;
  const rowsInput = useMemo<FeatureRowsInput>(
    () => ({
      entries,
      residentCodes,
      loadedMatchingCodes,
      selectedCodes,
      allSelected,
      noneSelected,
      scanning,
      supportsOnDemandLoad,
      residentKnown,
      residentFeatureCounts,
      datasetCountByCode,
      tiled: tiledLayer,
    }),
    [
      entries,
      residentCodes,
      loadedMatchingCodes,
      selectedCodes,
      allSelected,
      noneSelected,
      scanning,
      supportsOnDemandLoad,
      residentKnown,
      residentFeatureCounts,
      datasetCountByCode,
      tiledLayer,
    ]
  );
  // The one remaining whole-catalog pass: the summary lines below count rows across
  // every feature, not the mounted window, so this is O(features) however few rows
  // render. Memoised so it re-runs when an answer could have changed, rather than on
  // every engine notify — dozens of times during a streaming preload.
  const { notLoadedCount, partialCount } = useMemo(
    () => summariseFeatureRows(rowsInput),
    [rowsInput]
  );
  const rowInfo = (code: number) => classifyFeatureRow(code, rowsInput);

  // Virtualized list. Without it a 12,448-feature Xenium panel mounts 12,453
  // checkboxes and ~91k DOM nodes — most of a minute of long tasks on its own
  // (#172). The React Compiler skips this component anyway ('use no memo' above),
  // which is what its incompatible-library warning about this hook amounts to here.
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleEntries.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => FEATURE_ROW_HEIGHT,
    // Codes are unique and stable, so a row keeps its React identity — and its open
    // colour picker — as the window scrolls past it.
    getItemKey: (index) => visibleEntries[index]?.code ?? index,
    overscan: 8,
    // Before layout measures the scroll box, fall back to its known height rather
    // than zero, or the first paint windows to no rows at all.
    initialRect: { width: 0, height: FEATURE_LIST_HEIGHT },
  });

  // A hovered row can be unmounted by a scroll while the pointer is still over it,
  // and removing a node fires no `mouseleave` — so the row's own handler never runs
  // and the canvas keeps emphasising a feature that is no longer under the pointer.
  // Watch for the highlighted row leaving the window instead. A boolean dep, so this
  // fires once on that transition rather than per render or per scroll event.
  const virtualRows = rowVirtualizer.getVirtualItems();
  const highlightMounted =
    highlightedFeature === null ||
    virtualRows.some((row) => visibleEntries[row.index]?.code === highlightedFeature);
  useEffect(() => {
    if (!highlightMounted) {
      setHighlightedFeature(null);
    }
  }, [highlightMounted, setHighlightedFeature]);

  // Write NAMES, and clear any legacy `featureCodes` so the two cannot disagree —
  // `featureNames` wins when both are set, and a stale code list left behind in a
  // saved config is exactly the confusion this change exists to remove.
  const setSelectedCodes = (nextCodes: number[] | undefined) => {
    updateLayer(layerId, {
      featureNames: nextCodes ? featureNamesForCodes(nextCodes, catalog) : undefined,
      featureCodes: undefined,
    });
  };

  // Per-feature colour overrides, keyed by feature NAME (survives code remapping).
  const colorOverrides = config.featureColorOverrides;
  const effectiveRgb = (name: string, code: number): [number, number, number] =>
    colorOverrides?.[name] ?? featureCodeToRgb(code);
  // `<input type="color">` fires change continuously while the picker is dragged,
  // and each commit is a layer-config write → new palette → deck layer update, on a
  // layer that can be holding millions of points. Coalesce to one write per frame:
  // the canvas still previews live (which is the whole point of the control), but
  // the work is bounded by the display rather than by event rate.
  // The pending value is the FULL next overrides map, not one entry: successive
  // edits inside a frame accumulate into it, so two features recoloured before the
  // frame fires both survive, and the merge base is taken at schedule time — no ref
  // read during render, and no dependence on which render created the handler.
  const pendingColorRef = useRef<Record<string, [number, number, number]> | null>(null);
  const colorFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (colorFrameRef.current !== null) {
        cancelAnimationFrame(colorFrameRef.current);
      }
    },
    []
  );
  const setColorOverride = (name: string, rgb: [number, number, number]) => {
    pendingColorRef.current = { ...(pendingColorRef.current ?? colorOverrides ?? {}), [name]: rgb };
    if (colorFrameRef.current !== null) {
      return;
    }
    colorFrameRef.current = requestAnimationFrame(() => {
      colorFrameRef.current = null;
      const pending = pendingColorRef.current;
      pendingColorRef.current = null;
      if (pending) {
        updateLayer(layerId, { featureColorOverrides: pending });
      }
    });
  };
  const clearColorOverride = (name: string) => {
    // A coalesced write may still be queued for this feature. It carries the whole
    // map, so letting it land after the clear would put the override straight back.
    if (pendingColorRef.current && name in pendingColorRef.current) {
      delete pendingColorRef.current[name];
    }
    if (!colorOverrides || !(name in colorOverrides)) {
      return;
    }
    const next = { ...colorOverrides };
    delete next[name];
    updateLayer(layerId, {
      featureColorOverrides: Object.keys(next).length > 0 ? next : undefined,
    });
  };

  const toggleFeature = (code: number, checked: boolean) => {
    const current = new Set(allSelected ? entries.map((entry) => entry.code) : (selection ?? []));
    if (checked) {
      current.add(code);
    } else {
      current.delete(code);
    }
    if (current.size === 0) {
      setSelectedCodes([]);
      return;
    }
    if (current.size === entries.length) {
      setSelectedCodes(undefined);
      return;
    }
    setSelectedCodes([...current].sort((left, right) => left - right));
  };

  // Only block on loading when there is NOTHING to show. The catalog scan publishes
  // the names/codes list before its (slow) per-feature counts pass, so once that
  // partial arrives the list is usable — features can be seen, coloured and selected
  // while the counts column is still filling in.
  if (catalogLoading && !catalog) {
    return (
      <div style={panelStyle}>
        <div style={helperStyle}>Loading features…</div>
      </div>
    );
  }

  if (catalog === undefined) {
    return (
      <div style={panelStyle}>
        <div style={helperStyle}>Feature list not loaded.</div>
        <button type="button" style={buttonStyle} onClick={() => requestCatalog()}>
          Load feature list
        </button>
      </div>
    );
  }

  if (!catalog || entries.length === 0) {
    return (
      <div style={panelStyle}>
        <div style={helperStyle}>
          {catalog === null
            ? 'No feature catalog available for this points layer (missing feature_key or unsupported encoding for this dataset size).'
            : 'No features found in the feature catalog.'}
        </div>
      </div>
    );
  }

  const selectedCount = noneSelected ? 0 : allSelected ? entries.length : selectedCodes.size;
  const showSearch = entries.length > FEATURE_LIST_SEARCH_THRESHOLD;

  return (
    <div style={panelStyle}>
      <div>
        Features ({catalog.featureKey})
        <span style={helperStyle}>
          {' '}
          · {selectedCount}/{entries.length} selected
          {hasAnyCounts ? (hasCounts ? ' · sorted by count' : ' · sorted by count so far') : ''}
        </span>
      </div>
      {catalogRefining ? <div style={helperStyle}>Loading the full feature list…</div> : null}
      {catalogLoading && !catalogRefining ? (
        // The list is already usable; only the per-feature counts are outstanding.
        <div style={helperStyle}>Counting features…</div>
      ) : null}
      {notLoadedCount > 0 ? (
        <div style={helperStyle}>
          {notLoadedCount} of {entries.length} feature{entries.length === 1 ? '' : 's'}{' '}
          {supportsOnDemandLoad
            ? 'not loaded yet (greyed below) — selecting one loads it on demand.'
            : "not in the loaded sample (greyed below) — this dataset has no feature index, so they can't be shown until the row cap is raised or it's rewritten with one."}
        </div>
      ) : null}
      {partialCount > 0 ? (
        <div style={helperStyle}>
          {partialCount} of {entries.length} feature{entries.length === 1 ? '' : 's'} only partly
          loaded — the resident window is capped, so the canvas is drawing a sample of each. Select
          one to fetch it in full, or raise the memory cap.
        </div>
      ) : null}
      {matchingLoadState?.failed ? (
        // A failed scan still DRAWS: the render path falls back to filtering the
        // resident batch, so the canvas shows whichever part of the selection was
        // inside the memory cap. Saying so matters more than the error text — without
        // it the partial view reads as the complete answer.
        <div style={errorStatStyle}>
          Could not load the selected features
          {matchingLoadState.error ? `: ${matchingLoadState.error.message}` : '.'}
          <div style={helperStyle}>
            Showing only the selected points already in memory.
            {matchingLoadState.error?.retryable === false ? '' : ' Retrying will re-run the scan.'}
          </div>
          {matchingLoadState.error?.retryable === false ? null : (
            <button type="button" style={buttonStyle} onClick={() => retryFailedLoads()}>
              Retry
            </button>
          )}
        </div>
      ) : matchingLoadState ? (
        <div style={matchingLoadState.loading ? loadingStatStyle : helperStyle}>
          {matchingLoadState.loading
            ? `Loading selected features… ${matchingLoadState.matchedRows.toLocaleString()} points so far`
            : matchingLoadState.covered
              ? `Selection served from ${matchingLoadState.matchedRows.toLocaleString()} points in memory (no re-scan)`
              : `${matchingLoadState.matchedRows.toLocaleString()} points loaded for this selection`}
        </div>
      ) : null}
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={allSelected}
          onChange={(event) => {
            if (event.target.checked) {
              setSelectedCodes(undefined);
            }
          }}
        />
        All features
      </label>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={noneSelected}
          onChange={(event) => {
            if (event.target.checked) {
              setSelectedCodes([]);
            }
          }}
        />
        Deselect all
      </label>
      {showSearch ? (
        <input
          type="search"
          placeholder="Search features…"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          style={searchStyle}
        />
      ) : null}
      {/* Focusable: only the MOUNTED rows hold checkboxes, so without a tab stop on
          the scroller a keyboard user reaches ~17 of 12,448 features and the list
          never scrolls. Arrow/PageDown on the focused container scrolls it. It carries
          no `aria-label` because biome will not accept a name on a generic role
          without a `<fieldset>`; the "Features (…)" heading right above names it.
          biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be
          keyboard reachable (WCAG 2.1.1); virtualization is what made it load-bearing. */}
      <div ref={listRef} style={listStyle} tabIndex={0}>
        {/* Spacer sized to the whole list, windowed rows inside it: the scrollbar
            tracks all 12k features while the DOM holds ~20. */}
        <div style={{ position: 'relative', width: '100%', height: rowVirtualizer.getTotalSize() }}>
          {virtualRows.map((virtualRow) => {
            const entry = visibleEntries[virtualRow.index];
            if (!entry) {
              return null;
            }
            const { resident, rendered, selected, state } = rowInfo(entry.code);
            const countStr =
              entry.count !== undefined ? ` · ${entry.count.toLocaleString()} pts` : '';
            // Multi-line diagnostic: the human state + reason, then the raw signals
            // that drove the decision (what made this row grey / not grey).
            const overridden = colorOverrides?.[entry.name] !== undefined;
            const rgb = effectiveRgb(entry.name, entry.code);
            const title =
              `${entry.name} · code ${entry.code}${countStr}\n` +
              `${state.label}: ${state.reason}\n` +
              `[resident=${resident ? 'y' : 'n'} rendered=${rendered ? 'y' : 'n'} ` +
              `selected=${selected ? 'y' : 'n'} scan=${scanning ? 'running' : 'idle'}]`;
            return (
              <label
                key={virtualRow.key}
                data-index={virtualRow.index}
                style={{
                  ...featureRowStyle,
                  transform: `translateY(${virtualRow.start}px)`,
                  opacity: featureRowOpacity(state),
                }}
                title={title}
                onMouseEnter={() => setHighlightedFeature(entry.code)}
                onMouseLeave={() => setHighlightedFeature(null)}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => toggleFeature(entry.code, event.target.checked)}
                />
                {/* Swatch = colour picker: this span's background is the effective
                    colour and a transparent colour input overlays it. Interactive content
                    inside the label, so operating it does not toggle the checkbox. */}
                <span
                  style={{
                    ...colorSwatchStyle,
                    background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
                    ...(overridden ? colorSwatchOverriddenStyle : {}),
                  }}
                  title={`${entry.name} colour${overridden ? ' (overridden)' : ''}`}
                >
                  <input
                    type="color"
                    aria-label={`${entry.name} colour`}
                    value={rgbToHex(rgb)}
                    style={colorInputStyle}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setColorOverride(entry.name, hexToRgb(event.target.value))}
                  />
                </span>
                <span>
                  {entry.name}
                  {state.greyed ? ' ·' : ''}
                </span>
                {overridden ? (
                  <button
                    type="button"
                    style={resetOverrideStyle}
                    title="Reset to default colour"
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      clearColorOverride(entry.name);
                    }}
                  >
                    ⟲
                  </button>
                ) : null}
                {hasAnyCounts
                  ? (() => {
                      // Once dataset totals land, keep showing the resident tally too when
                      // it falls short — the panel used to drop it, which is what let a
                      // capped element present "1,182,402" for a feature it was drawing a
                      // fraction of. `rendered` means a scan supplied it whole, so the
                      // shortfall is no longer what's on screen.
                      const shortfall =
                        state.tone === 'partial' ? residentShortfall(entry) : undefined;
                      return (
                        <span
                          style={countStyle}
                          title={
                            shortfall !== undefined
                              ? `${shortfall.toLocaleString()} of ${formatFeatureCount(
                                  entry.count
                                )} points are inside the memory cap`
                              : countIsPartial(entry)
                                ? 'Points loaded so far (resident window) — dataset total still counting'
                                : 'Points in the dataset'
                          }
                        >
                          {shortfall !== undefined ? (
                            <>
                              <span style={shortfallStyle}>{shortfall.toLocaleString()}</span>
                              <span style={ofTotalStyle}> / {formatFeatureCount(entry.count)}</span>
                            </>
                          ) : (
                            <>
                              {countIsPartial(entry) ? '≥' : ''}
                              {formatFeatureCount(effectiveCount(entry))}
                            </>
                          )}
                        </span>
                      );
                    })()
                  : null}
              </label>
            );
          })}
        </div>
        {showSearch && visibleEntries.length === 0 ? (
          <div style={helperStyle}>No features match your search.</div>
        ) : null}
      </div>
    </div>
  );
}
