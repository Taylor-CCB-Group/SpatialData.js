import type { PickingInfo } from 'deck.gl';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Minimal shape of the deck.gl hover event (a mjolnir pointer event). `srcEvent`
 * is the underlying DOM pointer event; its `buttons` bitmask is non-zero while a
 * pointer button is held, which is how we detect an in-progress pan/drag.
 */
export type HoverPointerEvent = { srcEvent?: { buttons?: number } | null };

/** True when the hover event was produced while a pointer button is held (pan/drag). */
export function isHoverDuringDrag(event?: HoverPointerEvent | null): boolean {
  return (event?.srcEvent?.buttons ?? 0) !== 0;
}

/**
 * Wraps an expensive hover-tooltip resolver so it runs at most once per animation
 * frame using the most recent pointer position, and skips re-running while the
 * pointer sits on the same pixel.
 *
 * deck.gl fires `onHover` on every pointer move, and resolving an aggregated
 * tooltip performs one or more `pickMultipleObjects` GPU reads (each a
 * synchronous `readPixels` stall). Coalescing to a frame and de-duplicating
 * stationary positions keeps pointer movement smooth without changing pick
 * semantics. Cheaper hover work (single-pick feature/shape callbacks) should run
 * directly from the handler and not go through here.
 */
export function useThrottledHoverTooltip(
  resolve: (info: PickingInfo) => void
): (info: PickingInfo) => void {
  // Keep the latest resolver without re-subscribing the scheduler; written in an
  // effect (not during render) per the Rules of React.
  const resolveRef = useRef(resolve);
  useEffect(() => {
    resolveRef.current = resolve;
  }, [resolve]);

  const rafRef = useRef<number | null>(null);
  const latestRef = useRef<PickingInfo | null>(null);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const flush = useCallback(() => {
    rafRef.current = null;
    const info = latestRef.current;
    latestRef.current = null;
    if (!info) return;

    const { x, y, picked } = info;
    // While the pointer hovers the same pixel over a feature, the pick result is
    // unchanged, so skip the redundant GPU read. Always run when nothing is
    // picked so moving off a feature reliably clears the tooltip.
    if (
      picked &&
      typeof x === 'number' &&
      typeof y === 'number' &&
      lastPosRef.current &&
      lastPosRef.current.x === x &&
      lastPosRef.current.y === y
    ) {
      return;
    }
    lastPosRef.current = typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
    resolveRef.current(info);
  }, []);

  const schedule = useCallback(
    (info: PickingInfo) => {
      latestRef.current = info;
      if (rafRef.current !== null) return;
      if (typeof requestAnimationFrame === 'function') {
        rafRef.current = requestAnimationFrame(flush);
      } else {
        // Non-browser environments (e.g. SSR/tests): resolve synchronously.
        flush();
      }
    },
    [flush]
  );

  useEffect(
    () => () => {
      if (rafRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    },
    []
  );

  return schedule;
}
