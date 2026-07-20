/**
 * Shared hover-tooltip machinery for the two SpatialCanvas surfaces
 * (`SpatialCanvasViewer` headless viewer and `SpatialCanvasInner` full UI).
 *
 * Both resolve the picked feature(s) under the cursor into a tooltip, position it
 * in viewport coordinates, and portal it to `document.body` (or a caller node).
 * That logic — the `hoverTooltip` state, the pick→tooltip resolution, and the
 * portal — is identical between them and lived as a copy in each; this hook is the
 * single copy.
 *
 * It deliberately does NOT import `HoverTooltipMode` / `shouldRenderInternalTooltip`
 * from `SpatialCanvasViewer` (that would be a circular import). Callers pass the two
 * already-derived booleans — `enabled` (mode ≠ 'off') and `aggregate` (mode ===
 * 'aggregate') — and the render-tooltip union is expressed structurally here.
 *
 * The per-component `handleHover`/`handleClick` wrappers stay in each component:
 * they differ (the headless viewer also emits `onFeatureHover`/`onShapeHover`
 * pick-event callbacks), and the shared part is just `resolveTooltip` + the drag
 * guard, which they call.
 */

import type { DeckGLRef, PickingInfo } from 'deck.gl';
import { type ReactNode, type RefObject, useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type FeatureTooltipResolver,
  getDeckFromDeckGlRef,
  resolveHoverFeatureTooltip,
} from './featureTooltipHover';
import {
  type SpatialCanvasTooltipRenderProps,
  SpatialFeatureTooltip,
  type SpatialFeatureTooltipData,
} from './SpatialFeatureTooltip';

/**
 * A caller-supplied tooltip renderer, or `false` to suppress the built-in tooltip
 * entirely (the consumer renders its own from `onFeatureHover`). Mirrors
 * `SpatialCanvasViewerRenderTooltip` structurally to avoid importing it.
 */
type RenderTooltip = false | ((props: SpatialCanvasTooltipRenderProps) => ReactNode);

/** Tooltip payload plus the resolved viewport-space client position. */
type PositionedTooltip = SpatialFeatureTooltipData & {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
};

export interface UseHoverFeatureTooltipOptions {
  /** Hover tooltips active at all (mode ≠ 'off'). */
  enabled: boolean;
  /** Aggregate across all layers under the cursor (mode === 'aggregate'). */
  aggregate: boolean;
  /** The renderer's `getFeatureTooltip` — resolves a pick to a tooltip payload. */
  getFeatureTooltip: FeatureTooltipResolver;
  /** Logical layer ids to cap Deck's aggregate pick passes. */
  hoverPickLayerIds: string[];
  /** Ref to the DeckGL instance (for aggregate `pickMultipleObjects`). */
  deckRef: RefObject<DeckGLRef | null>;
  /** Caller tooltip renderer, or `false` to suppress the built-in tooltip. */
  renderTooltip?: RenderTooltip;
  /** Portal mount node; defaults to `document.body`. */
  tooltipContainer?: HTMLElement | null;
}

export interface UseHoverFeatureTooltip {
  /**
   * Ref for the viewer container element, read (via `getBoundingClientRect`) to map
   * deck-local pick coordinates to viewport coordinates. Assign it to the element
   * the deck canvas is measured against — usually alongside `useMeasure`'s ref.
   */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Resolve + position the tooltip for a pick (no drag guard — callers apply it). */
  resolveTooltip: (info: PickingInfo) => void;
  /** Hide the tooltip (e.g. while dragging). */
  clearTooltip: () => void;
  /** The portaled tooltip node, or `null` when nothing is shown. */
  tooltipPortal: ReactNode;
}

export function useHoverFeatureTooltip({
  enabled,
  aggregate,
  getFeatureTooltip,
  hoverPickLayerIds,
  deckRef,
  renderTooltip,
  tooltipContainer,
}: UseHoverFeatureTooltipOptions): UseHoverFeatureTooltip {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverTooltip, setHoverTooltip] = useState<PositionedTooltip | null>(null);

  const clearTooltip = useCallback(() => setHoverTooltip(null), []);

  // Tooltips active at all? Used both to gate resolution and to DROP any stored
  // result when activation flips — hiding the portal alone would keep the last
  // tooltip in state, so switching the mode off and back on would resurrect it at
  // its stale position without a fresh hover.
  //
  // Adjusted during render (React's "adjusting state when a prop changes" pattern)
  // rather than in an effect: `react-hooks/set-state-in-effect` rightly rejects the
  // effect form, and this re-renders immediately with the corrected state instead of
  // painting the stale tooltip for a frame first.
  const active = enabled && renderTooltip !== false;
  const [lastActive, setLastActive] = useState(active);
  if (lastActive !== active) {
    setLastActive(active);
    setHoverTooltip(null);
  }

  // The expensive part of hovering: pick the feature(s) under the cursor and
  // position the tooltip. Callers throttle by only invoking this per hover event.
  const resolveTooltip = useCallback(
    (info: PickingInfo) => {
      if (!active) {
        setHoverTooltip(null);
        return;
      }
      const tooltip =
        info.picked && typeof info.x === 'number' && typeof info.y === 'number'
          ? resolveHoverFeatureTooltip(info, getFeatureTooltip, {
              aggregate,
              deck: getDeckFromDeckGlRef(deckRef),
              pickLayerIds: hoverPickLayerIds,
            })
          : null;
      if (!tooltip) {
        setHoverTooltip(null);
        return;
      }
      // Resolve viewport coordinates here (in the event handler) rather than
      // reading the container ref during render.
      const rect = containerRef.current?.getBoundingClientRect();
      setHoverTooltip({
        ...tooltip,
        clientX: (rect?.left ?? 0) + tooltip.x,
        clientY: (rect?.top ?? 0) + tooltip.y,
      });
    },
    [active, aggregate, getFeatureTooltip, hoverPickLayerIds, deckRef]
  );

  const tooltipPortal = useMemo<ReactNode>(() => {
    const portalTarget =
      typeof document !== 'undefined' ? (tooltipContainer ?? document.body) : null;
    if (!active || !hoverTooltip || !portalTarget) {
      return null;
    }
    return createPortal(
      renderTooltip ? (
        renderTooltip({
          clientX: hoverTooltip.clientX,
          clientY: hoverTooltip.clientY,
          tooltip: hoverTooltip,
        })
      ) : (
        <SpatialFeatureTooltip
          x={hoverTooltip.clientX}
          y={hoverTooltip.clientY}
          tooltip={hoverTooltip}
          position="fixed"
        />
      ),
      portalTarget
    );
  }, [active, renderTooltip, hoverTooltip, tooltipContainer]);

  return { containerRef, resolveTooltip, clearTooltip, tooltipPortal };
}
