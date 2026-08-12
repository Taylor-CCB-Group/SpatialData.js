/**
 * Feature-row state classification for the points feature filter panel.
 *
 * Kept out of `PointsFeatureFilterPanel.tsx` so that module exports only its
 * component — a mixed component + plain-function export breaks Vite React Fast
 * Refresh (full reload, dropped React state) for the whole file.
 */

/** Why a feature row is (or isn't) greyed — drives both the dimming and the
 * diagnostic tooltip so they can never disagree. */
export type FeatureRowTone =
  | 'resident'
  | 'partial'
  | 'tiled'
  | 'loaded'
  | 'cached'
  | 'loading'
  | 'noIndex'
  | 'notLoaded';

export interface FeatureRowState {
  tone: FeatureRowTone;
  /** Whether the row is dimmed (its points are not on screen). */
  greyed: boolean;
  /** Short state label, e.g. "loaded", "loading", "not loaded". */
  label: string;
  /** One sentence explaining the state / why it is greyed. */
  reason: string;
}

export interface FeatureRowStateInput {
  /** In the preloaded (resident) window. */
  resident: boolean;
  /** On screen now via the last-completed feature-index scan. */
  rendered: boolean;
  /** In the current selection (checked). */
  selected: boolean;
  /** A feature-index scan for the current selection is in flight. */
  scanning: boolean;
  /** The element can fetch non-resident features on demand (has a feature index). */
  supportsOnDemandLoad: boolean;
  /** The resident set is known (false → we can't distinguish, treat as shown). */
  residentKnown: boolean;
  /**
   * Points of this feature inside the resident window, and in the whole dataset.
   *
   * Together these separate "resident" from "all here", which `resident` alone
   * cannot: it means *at least one* point made the memory cap. On a truncated
   * element every feature is typically resident — one point each is enough — while
   * most of the data is absent, and a row that says nothing about that reads as a
   * complete answer. Both `undefined` until the counts are known, which is the only
   * time this classification falls back to the older, blunter one.
   */
  residentPointCount?: number;
  datasetPointCount?: number;
  /**
   * The layer reads viewport tiles rather than a resident window (D5).
   *
   * It has to be said explicitly, because every OTHER signal here describes a
   * resident batch that a tiled layer does not have: `resident` is false for every
   * feature, `residentKnown` is false, and the fallback that produces —"the resident
   * set is unknown, so treat everything as shown" — is accidentally the right
   * *outcome* for the wrong *reason*. On a tiled layer coverage is not unknown: every
   * feature in view is read on demand, and deselecting one drops its points inside
   * the scan rather than filtering a batch afterwards.
   */
  tiled?: boolean;
}

/**
 * Classify a feature's render state from the signals the panel already has.
 * Precedence matters: `resident`/`rendered` (its points are in memory) win over
 * selection/scan state. `rendered` here means "in the loaded matched batch",
 * i.e. in memory — a deselected-but-loaded feature is `cached`, not dropped,
 * because removing a feature filters the in-memory batch rather than re-scanning
 * (re-adding it is instant).
 *
 * This is up for review.
 */
export function describeFeatureRowState({
  resident,
  rendered,
  selected,
  scanning,
  supportsOnDemandLoad,
  residentKnown,
  residentPointCount,
  datasetPointCount,
  tiled,
}: FeatureRowStateInput): FeatureRowState {
  // Ranked first: a tiled layer's coverage does not depend on any of the resident
  // signals below, and answering from them would describe a batch it does not have.
  if (tiled) {
    return {
      tone: 'tiled',
      greyed: false,
      label: 'in view',
      reason:
        'Read from viewport tiles on demand — not limited by the memory cap. Deselecting it drops its points from the tiles before they are drawn.',
    };
  }
  if (!residentKnown) {
    return {
      tone: 'loaded',
      greyed: false,
      label: 'shown',
      reason: 'The resident set is unknown for this element, so every feature is treated as shown.',
    };
  }
  if (resident) {
    // Resident but incomplete: drawn, so not greyed, but the row must not imply the
    // whole feature is on screen. Ranked above plain `resident` because the shortfall
    // is the more useful fact when it exists.
    //
    // `rendered` vetoes it: a completed scan supplies the feature whole, so its
    // resident shortfall says nothing about what is drawn. Without this veto a
    // feature would be loaded in full and still be labelled partial.
    if (
      !rendered &&
      residentPointCount !== undefined &&
      datasetPointCount !== undefined &&
      residentPointCount < datasetPointCount
    ) {
      const percent = datasetPointCount > 0 ? (residentPointCount / datasetPointCount) * 100 : 0;
      return {
        tone: 'partial',
        greyed: false,
        label: 'partial',
        reason:
          `Only ${residentPointCount.toLocaleString()} of ${datasetPointCount.toLocaleString()} points ` +
          `(${formatCoveragePercent(percent)}) are inside the memory cap, and that is what is drawn. ` +
          'Select it to fetch the rest, or raise the cap.',
      };
    }
    return {
      tone: 'resident',
      greyed: false,
      label: 'resident',
      reason:
        'In the preloaded window — shown by filtering the in-memory batch (no dataset scan; a large batch can still take a moment to re-filter).',
    };
  }
  if (rendered) {
    return selected
      ? {
          tone: 'loaded',
          greyed: false,
          label: 'loaded',
          reason: 'On screen via the feature-index scan for the current selection.',
        }
      : {
          tone: 'cached',
          greyed: false,
          label: 'in memory',
          reason:
            'Loaded in the matched batch but hidden (deselected); re-adding it is instant, no scan.',
        };
  }
  if (selected && scanning) {
    return {
      tone: 'loading',
      greyed: true,
      label: 'loading',
      reason: 'Selected — its feature-index scan is in progress.',
    };
  }
  if (!supportsOnDemandLoad) {
    return {
      tone: 'noIndex',
      greyed: true,
      label: 'not in sample',
      reason:
        'Beyond the resident window, and this dataset has no feature index, so it can’t be fetched on demand. Raise the memory cap or rewrite the dataset with an index.',
    };
  }
  return {
    tone: 'notLoaded',
    greyed: true,
    label: 'not loaded',
    reason: 'Beyond the resident window; select it to fetch its points via the feature-index scan.',
  };
}

/**
 * A coverage share, rounded so it never reads as more certain than it is: `<1%`
 * rather than `0%` for a feature with a handful of points in a huge window, and
 * `>99%` rather than `100%` for one that is all-but-complete — the two cases where a
 * naive round would claim the opposite of the truth.
 */
function formatCoveragePercent(percent: number): string {
  if (percent > 0 && percent < 1) return '<1%';
  if (percent < 100 && percent > 99) return '>99%';
  return `${Math.round(percent)}%`;
}

/** Opacity for a row given its state: crisp when its points are on screen,
 * mid-dim while loading, fully dim when not loaded. */
export function featureRowOpacity(state: FeatureRowState): number {
  if (!state.greyed) {
    return 1;
  }
  return state.tone === 'loading' ? 0.6 : 0.4;
}
