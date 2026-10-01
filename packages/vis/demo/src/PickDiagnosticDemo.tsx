/**
 * Labels picking diagnostic: does a pick return the label that is actually DRAWN
 * under the pointer?
 *
 * Every label is drawn in a colour that encodes its id (r + 256·g, b = 255), fully
 * opaque with no outline, so the frame itself is the ground truth — independent of
 * the bounds and coordinate maths the CPU-side label lookup shares with rendering.
 * A scan reads that frame back, picks a grid of points, and classifies each one.
 *
 * `?device=webgl` switches backends (default webgpu); `?element=multiscale` picks
 * `blobs_multiscale_labels` instead of `blobs_labels`; `?fix=0` leaves deck's WebGPU
 * pick path unpatched (see `applyWebGPUPickingFix`).
 */
import { Deck, OrthographicView, type OrthographicViewState } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { applyWebGPUPickingFix, type LabelFeatureState, LabelsLayer } from '@spatialdata/layers';
import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadOmeZarrMultiscalesFromStore, type VivCompatiblePixelSource } from 'zarrextra';
import { getLocalBlobsFixtureUrl } from './fixtureUrls';

const params = new URLSearchParams(window.location.search);
const DEVICE: 'webgl' | 'webgpu' = params.get('device') === 'webgl' ? 'webgl' : 'webgpu';
const ELEMENT = params.get('element') === 'multiscale' ? 'blobs_multiscale_labels' : 'blobs_labels';
const FIX = params.get('fix') !== '0';

const CANVAS_SIZE = 600;
const GRID = 40;
const INITIAL_VIEW_STATE: OrthographicViewState = { target: [256, 256, 0], zoom: 0 };

/** Ids the encoding can carry: two bytes, with blue pinned as the "this is a label" mark. */
function idToColor(id: number): [number, number, number, number] {
  return [id & 255, (id >> 8) & 255, 255, 255];
}

function colorToId(r: number, g: number, b: number, a: number): number | 'ambiguous' | 0 {
  if (a === 0 || (r === 0 && g === 0 && b === 0)) return 0;
  // Anything else that is not an exact encoding is a blended (edge) pixel.
  return b === 255 && a === 255 ? r + 256 * g : 'ambiguous';
}

function isNumericArray(value: unknown): value is ArrayLike<number> {
  return (
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView) &&
    !(value instanceof BigInt64Array) &&
    !(value instanceof BigUint64Array)
  );
}

async function labelIds(loader: VivCompatiblePixelSource[]): Promise<Set<number>> {
  const { data } = await loader[0].getRaster({ selection: {} });
  const ids = new Set<number>();
  if (!isNumericArray(data)) return ids;
  for (let i = 0; i < data.length; i++) if (data[i] > 0) ids.add(data[i]);
  return ids;
}

type Outcome = 'correct' | 'wrongId' | 'missed' | 'spurious' | 'background' | 'ambiguous';

type ScanResult = {
  counts: Record<Outcome, number>;
  /** Wrong/missed/spurious picks whose result matches the drawn id at the y-mirrored pixel. */
  explainedByMirror: number;
  marks: { x: number; y: number; outcome: Outcome }[];
};

const MARK_COLORS: Record<Outcome, string> = {
  correct: 'rgba(0,255,0,0.9)',
  wrongId: 'rgba(255,0,0,1)',
  missed: 'rgba(255,160,0,1)',
  spurious: 'rgba(255,0,255,1)',
  background: 'rgba(255,255,255,0.25)',
  ambiguous: 'rgba(120,120,120,0.6)',
};

function PickDiagnostic() {
  const { spatialData } = useSpatialData();
  const container = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const deckRef = useRef<Deck<OrthographicView> | null>(null);
  const captureRef = useRef<((frame: ImageData) => void) | null>(null);
  const [loader, setLoader] = useState<VivCompatiblePixelSource[] | null>(null);
  const [featureState, setFeatureState] = useState<LabelFeatureState | null>(null);
  const [status, setStatus] = useState('loading…');
  const [result, setResult] = useState<ScanResult | null>(null);

  useEffect(() => {
    const element = spatialData?.labels?.[ELEMENT];
    if (!element) return;
    let cancelled = false;
    (async () => {
      const levels = await loadOmeZarrMultiscalesFromStore(element.getStore());
      const ids = await labelIds(levels);
      const fillColorByFeatureId = Object.fromEntries(
        [...ids].map((id) => [String(id), idToColor(id)])
      );
      if (cancelled) return;
      setLoader(levels);
      setFeatureState({ fillColorByFeatureId });
      setStatus(`${ELEMENT}: ${levels.length} level(s), ${ids.size} labels`);
    })();
    return () => {
      cancelled = true;
    };
  }, [spatialData]);

  const layers = useMemo(
    () =>
      loader && featureState
        ? [
            new LabelsLayer({
              id: `labels:${ELEMENT}`,
              loader,
              selections: [{}],
              featureState,
              channelOpacities: [1],
              channelOutlineOpacities: [0],
              channelStrokeWidths: [0],
              channelsFilled: [true],
            }),
          ]
        : [],
    [loader, featureState]
  );

  useEffect(() => {
    if (!container.current) return;
    const canvas = document.createElement('canvas');
    canvas.style.width = `${CANVAS_SIZE}px`;
    canvas.style.height = `${CANVAS_SIZE}px`;
    container.current.prepend(canvas);
    const deck = new Deck({
      canvas,
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      // One drawing-buffer pixel per CSS pixel, so frame and pick coordinates agree.
      useDevicePixels: false,
      ...(DEVICE === 'webgpu'
        ? { deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] } }
        : {}),
      views: new OrthographicView({ id: 'diag', controller: true }),
      initialViewState: INITIAL_VIEW_STATE,
      onDeviceInitialized: (device) => {
        if (FIX) applyWebGPUPickingFix(device);
      },
      onAfterRender: () => {
        // The drawing buffer is only readable inside the frame that drew it.
        const capture = captureRef.current;
        if (!capture) return;
        captureRef.current = null;
        const readback = document.createElement('canvas');
        readback.width = canvas.width;
        readback.height = canvas.height;
        const context = readback.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(canvas, 0, 0);
        capture(context.getImageData(0, 0, canvas.width, canvas.height));
      },
      onError: (error) => setStatus(`deck error: ${error.message}`),
    });
    deckRef.current = deck;
    return () => {
      deck.finalize();
      deckRef.current = null;
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    deckRef.current?.setProps({ layers });
  }, [layers]);

  const scan = useCallback(async () => {
    const deck = deckRef.current;
    if (!deck) return;
    setStatus('capturing frame…');
    const frame = await new Promise<ImageData>((resolve) => {
      captureRef.current = resolve;
      deck.redraw('pick-diagnostic');
    });
    const drawnAt = (x: number, y: number) => {
      const i = (Math.floor(y) * frame.width + Math.floor(x)) * 4;
      const d = frame.data;
      return colorToId(d[i], d[i + 1], d[i + 2], d[i + 3]);
    };
    setStatus('picking…');
    const counts: Record<Outcome, number> = {
      correct: 0,
      wrongId: 0,
      missed: 0,
      spurious: 0,
      background: 0,
      ambiguous: 0,
    };
    const marks: ScanResult['marks'] = [];
    let explainedByMirror = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        // Whole pixels: luma maps a pick point to a device pixel with Math.round, the
        // readback below with floor, and the two disagree by one pixel at x.5.
        const x = Math.floor((CANVAS_SIZE * (i + 0.5)) / GRID);
        const y = Math.floor((CANVAS_SIZE * (j + 0.5)) / GRID);
        const drawn = drawnAt(x, y);
        const info = await deck.pickObjectAsync({ x, y, radius: 0 });
        const labelId = info?.object?.labelId;
        const picked = typeof labelId === 'number' ? labelId : 0;
        let outcome: Outcome;
        if (drawn === 'ambiguous') outcome = 'ambiguous';
        else if (drawn === 0) outcome = picked === 0 ? 'background' : 'spurious';
        else if (picked === 0) outcome = 'missed';
        else outcome = picked === drawn ? 'correct' : 'wrongId';
        if (outcome === 'wrongId' || outcome === 'missed' || outcome === 'spurious') {
          if (drawnAt(x, CANVAS_SIZE - 1 - y) === picked) explainedByMirror += 1;
        }
        counts[outcome] += 1;
        marks.push({ x, y, outcome });
      }
    }
    setResult({ counts, explainedByMirror, marks });
    setStatus('done');
  }, []);

  useEffect(() => {
    const canvas = overlay.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const mark of result?.marks ?? []) {
      context.fillStyle = MARK_COLORS[mark.outcome];
      const r = mark.outcome === 'correct' || mark.outcome === 'background' ? 1.5 : 3;
      context.beginPath();
      context.arc(mark.x, mark.y, r, 0, Math.PI * 2);
      context.fill();
    }
  }, [result]);

  const links = (['webgpu', 'webgl'] as const).flatMap((device) =>
    (['single', 'multiscale'] as const).flatMap((element) =>
      (device === 'webgpu' ? [true, false] : [true]).map((fix) => ({
        href: `?device=${device}&element=${element}${fix ? '' : '&fix=0'}`,
        label: `${device} / ${element}${device === 'webgpu' && !fix ? ' / unpatched' : ''}`,
        active:
          device === DEVICE &&
          (element === 'multiscale') === (ELEMENT === 'blobs_multiscale_labels') &&
          (device !== 'webgpu' || fix === FIX),
      }))
    )
  );

  return (
    <div style={{ padding: 12, fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
        {links.map((l) => (
          <a key={l.href} href={l.href} style={{ color: l.active ? '#fff' : '#8af' }}>
            {l.label}
          </a>
        ))}
      </div>
      <div style={{ marginBottom: 8 }}>
        {status} · pan/zoom, then{' '}
        <button type="button" onClick={scan}>
          scan
        </button>{' '}
      </div>
      {result ? (
        <div style={{ marginBottom: 8, fontFamily: 'monospace' }}>
          {Object.entries(result.counts)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')}{' '}
          · wrong results explained by y-mirror {result.explainedByMirror}
        </div>
      ) : null}
      <div style={{ color: '#888', marginBottom: 8 }}>
        marks: green correct · red wrong id · orange missed (label drawn, pick empty) · magenta
        spurious (background drawn, pick found a label) · grey edge pixel (skipped)
      </div>
      <div
        ref={container}
        style={{
          position: 'relative',
          width: CANVAS_SIZE,
          height: CANVAS_SIZE,
          background: '#000',
        }}
      >
        <canvas
          ref={overlay}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        />
      </div>
    </div>
  );
}

export default function PickDiagnosticDemo() {
  const fixtureUrl = useMemo(() => getLocalBlobsFixtureUrl(), []);
  return (
    <SpatialDataProvider source={fixtureUrl}>
      <PickDiagnostic />
    </SpatialDataProvider>
  );
}
