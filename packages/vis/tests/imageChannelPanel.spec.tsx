import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ImageChannelPanelFromStore } from '../src/SpatialCanvas/ImageChannelPanel.js';
import type { ImageLayerConfig } from '../src/SpatialCanvas/types.js';

type Editable = Pick<ImageLayerConfig, 'channels' | 'alphaFromIntensity'>;

/** The panel wired to a minimal store, exposing the config it writes. */
function Harness({ onConfig }: { onConfig: (config: Editable) => void }) {
  const [config, setConfig] = useState<Editable>({});
  return (
    <ImageChannelPanelFromStore
      layerId="img"
      config={config}
      updateLayer={(_id, updates) => {
        const next = { ...config, ...updates };
        onConfig(next);
        setConfig(next);
      }}
    />
  );
}

describe('ImageChannelPanel opacity from brightness', () => {
  it('turns the option on with defaults, edits it, and turns it off', () => {
    let config: Editable = {};
    render(<Harness onConfig={(next) => (config = next)} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Opacity from brightness' }));
    expect(config.alphaFromIntensity).toEqual({ threshold: 0, gain: 1 });

    fireEvent.change(screen.getByRole('slider', { name: /Threshold/ }), {
      target: { value: '0.3' },
    });
    // Gain is logarithmic: slider position 2 is gain 100.
    fireEvent.change(screen.getByRole('slider', { name: /Gain/ }), { target: { value: '2' } });
    expect(config.alphaFromIntensity).toEqual({ threshold: 0.3, gain: 100 });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Opacity from brightness' }));
    expect(config.alphaFromIntensity).toBeUndefined();
    expect(screen.queryByRole('slider', { name: /Threshold/ })).toBeNull();
  });
});
