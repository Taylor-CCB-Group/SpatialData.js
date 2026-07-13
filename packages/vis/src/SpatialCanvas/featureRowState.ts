/**
 * Feature-row state classification for the points feature filter panel.
 *
 * Kept out of `PointsFeatureFilterPanel.tsx` so that module exports only its
 * component — a mixed component + plain-function export breaks Vite React Fast
 * Refresh (full reload, dropped React state) for the whole file.
 */

/** Why a feature row is (or isn't) greyed — drives both the dimming and the
 * diagnostic tooltip so they can never disagree. */
export type FeatureRowTone = 'resident' | 'loaded' | 'cached' | 'loading' | 'noIndex' | 'notLoaded';

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
}: FeatureRowStateInput): FeatureRowState {
  if (!residentKnown) {
    return {
      tone: 'loaded',
      greyed: false,
      label: 'shown',
      reason: 'The resident set is unknown for this element, so every feature is treated as shown.',
    };
  }
  if (resident) {
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

/** Opacity for a row given its state: crisp when its points are on screen,
 * mid-dim while loading, fully dim when not loaded. */
export function featureRowOpacity(state: FeatureRowState): number {
  if (!state.greyed) {
    return 1;
  }
  return state.tone === 'loading' ? 0.6 : 0.4;
}
