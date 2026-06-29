import { useCallback, useEffect, useRef, useState } from 'react';

/** Minimal shape of deck.gl's interaction state (a subset of `InteractionState`). */
export interface ViewInteractionState {
  isDragging?: boolean;
  isPanning?: boolean;
  isZooming?: boolean;
  inTransition?: boolean;
}

export interface ViewInteractionGate {
  /** True while the camera is being panned/zoomed (or settling within the idle delay). */
  interacting: boolean;
  /** Wire to deck.gl's `onInteractionStateChange` (e.g. via `deckProps`). */
  onInteractionStateChange: (state: ViewInteractionState) => void;
}

/**
 * Tracks whether the deck.gl view is being actively manipulated, with the
 * transition back to idle debounced by `idleDelayMs`.
 *
 * Picking large shape layers is expensive: deck re-renders the full geometry
 * into the picking framebuffer on every pointer move to service hover /
 * autoHighlight. Disabling shape picking while `interacting` is true removes that
 * per-move cost during pan/zoom; the debounce avoids re-enabling (and paying a
 * picking pass) in the gaps between rapid drag steps.
 */
export function useViewInteractionGate(idleDelayMs = 150): ViewInteractionGate {
  const [interacting, setInteracting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onInteractionStateChange = useCallback(
    (state: ViewInteractionState) => {
      const active = Boolean(
        state && (state.isDragging || state.isPanning || state.isZooming || state.inTransition)
      );
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (active) {
        setInteracting(true);
      } else {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setInteracting(false);
        }, idleDelayMs);
      }
    },
    [idleDelayMs]
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  return { interacting, onInteractionStateChange };
}
