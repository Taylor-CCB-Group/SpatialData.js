/**
 * SpatialViewer must keep one Deck, and so one GPU device, while image layers
 * come and go. A remount reinitialises every layer, refetches image tiles and
 * breaks consumers sharing deck's device.
 */

import type { View } from '@deck.gl/core';
import type { DeckGLRef } from '@deck.gl/react';
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpatialViewer, type SpatialViewerProps } from '../src/SpatialCanvas/SpatialViewer';
import type { ImageLayerConfig } from '../src/SpatialCanvas/useLayerData';

const fakeDeck = vi.hoisted(() => ({
  instances: 0,
  views: [] as unknown[],
  viewStates: [] as unknown[],
}));

// jsdom has no GPU. Stand in for <DeckGL> with something that, like the real one,
// creates its Deck and device once per mount.
vi.mock('@deck.gl/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deck.gl/react')>();
  const React = await import('react');
  type FakeDeckGLProps = {
    views?: unknown;
    viewState?: unknown;
    onDeviceInitialized?: (device: { type: string }) => void;
  };
  const DeckGL = React.forwardRef<{ deck: object }, FakeDeckGLProps>(
    function FakeDeckGL(props, ref) {
      const [deck] = React.useState(() => {
        fakeDeck.instances += 1;
        return { id: fakeDeck.instances };
      });
      React.useImperativeHandle(ref, () => ({ deck }), [deck]);
      const { onDeviceInitialized } = props;
      React.useEffect(() => {
        onDeviceInitialized?.({ type: 'webgl' });
      }, []);
      fakeDeck.views.push(props.views);
      fakeDeck.viewStates.push(props.viewState);
      return React.createElement('canvas');
    }
  );
  return { ...actual, DeckGL };
});

const imageLayer: ImageLayerConfig = {
  id: 'image-1',
  loader: [],
  colors: [[255, 255, 255]],
  contrastLimits: [[0, 255]],
  channelsVisible: [true],
  selections: [{}],
};

function firstView(views: unknown): View | undefined {
  const view = Array.isArray(views) ? views[0] : views;
  return view instanceof Object && 'props' in view ? view : undefined;
}

describe('SpatialViewer', () => {
  beforeEach(() => {
    fakeDeck.instances = 0;
    fakeDeck.views = [];
    fakeDeck.viewStates = [];
  });

  it('keeps one Deck while image layers are added and removed', () => {
    const onDeviceInitialized = vi.fn();
    const deckRef = createRef<DeckGLRef>();
    const props: SpatialViewerProps = {
      width: 400,
      height: 300,
      viewState: { target: [0, 0], zoom: 0 },
      onViewStateChange: () => {},
      layers: [],
      deckProps: { onDeviceInitialized },
      deckRef,
    };

    const { rerender } = render(<SpatialViewer {...props} />);
    const deck = deckRef.current?.deck;
    expect(deck).toBeDefined();

    rerender(<SpatialViewer {...props} vivLayerProps={[imageLayer]} />);
    expect(deckRef.current?.deck).toBe(deck);

    rerender(<SpatialViewer {...props} vivLayerProps={[]} />);
    expect(deckRef.current?.deck).toBe(deck);

    expect(fakeDeck.instances).toBe(1);
    expect(onDeviceInitialized).toHaveBeenCalledTimes(1);
  });

  it('honours controller: false without image layers', () => {
    render(
      <SpatialViewer
        width={400}
        height={300}
        viewState={{ target: [0, 0], zoom: 0 }}
        onViewStateChange={() => {}}
        layers={[]}
        deckProps={{ controller: false }}
      />
    );
    expect(firstView(fakeDeck.views.at(-1))?.props.controller).toBe(false);
  });

  it('frames the first image to arrive when the host gives no view state', () => {
    const props: SpatialViewerProps = {
      width: 400,
      height: 300,
      viewState: null,
      onViewStateChange: () => {},
      layers: [],
    };
    const loader = [{ shape: [4000, 2000], labels: ['y', 'x'], tileSize: 512 }];

    const { rerender } = render(<SpatialViewer {...props} />);
    const unframed = JSON.stringify(fakeDeck.viewStates.at(-1));
    rerender(<SpatialViewer {...props} vivLayerProps={[{ ...imageLayer, loader }]} />);

    expect(fakeDeck.instances).toBe(1);
    expect(JSON.stringify(fakeDeck.viewStates.at(-1))).not.toBe(unframed);
  });
});
