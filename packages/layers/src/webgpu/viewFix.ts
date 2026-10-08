import { _LayersPass as LayersPass, type View } from '@deck.gl/core';
import type { CanvasContext, Device, Framebuffer, Parameters, RenderPass } from '@luma.gl/core';
import { Model } from '@luma.gl/engine';

type Viewport4 = [number, number, number, number];

/** The parts of `_drawLayersInViewport`'s second argument this fix reads. */
interface DrawLayersInViewportOptions {
  target?: Framebuffer | null;
  canvasContext?: Pick<CanvasContext, 'getDrawingBufferSize'>;
  view?: View;
  isPicking?: boolean;
}

interface ViewClear {
  color: [number, number, number, number] | false;
  depth: number | false;
}

const fixedDevices = new WeakSet<Device>();
const clearModels = new WeakMap<Device, Map<string, Model>>();
let patched = false;

/** deck's reading of a view's `clear*` props, from `_drawLayersInViewport`. */
function viewClear(view: View, isPicking: boolean | undefined): ViewClear | null {
  const { clear, clearColor, clearDepth } = view.props;
  if (!clear) return null;
  let color: ViewClear['color'] = [0, 0, 0, 0];
  if (Array.isArray(clearColor) && !isPicking) {
    const [r, g, b, a] = clearColor;
    color = [r / 255, g / 255, b / 255, (a || 255) / 255];
  } else if (clearColor === false) {
    color = false;
  }
  return { color, depth: clearDepth ?? 1 };
}

// Writes the blend constant as the colour (src × constant + dst × 0), and the depth
// the viewport's depth range is pinned to, so the clear is all render-pass state and
// needs no uniform buffer.
const clearShader = /* wgsl */ `\
@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vid << 1u) & 2u), f32(vid & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}
`;

function clearModel(device: Device, writeColor: boolean, writeDepth: boolean): Model {
  let models = clearModels.get(device);
  if (!models) {
    models = new Map();
    clearModels.set(device, models);
  }
  const key = `${writeColor}:${writeDepth}`;
  let model = models.get(key);
  if (!model) {
    const parameters: Parameters = {
      depthCompare: 'always',
      depthWriteEnabled: writeDepth,
      colorMask: writeColor ? 0xf : 0,
      blend: true,
      blendColorOperation: 'add',
      blendColorSrcFactor: 'constant',
      blendColorDstFactor: 'zero',
      blendAlphaOperation: 'add',
      blendAlphaSrcFactor: 'constant',
      blendAlphaDstFactor: 'zero',
    };
    model = new Model(device, {
      id: `webgpu-view-clear-${key}`,
      source: clearShader,
      topology: 'triangle-list',
      bufferLayout: [],
      vertexCount: 3,
      parameters,
    });
    models.set(key, model);
  }
  return model;
}

/** Clears one viewport of an open render pass by drawing over it. Stencil is not
 *  cleared: deck's canvas and picking depth attachments have none. */
function clearViewport(
  device: Device,
  renderPass: RenderPass,
  [x, y, width, height]: Viewport4,
  clear: ViewClear
): void {
  if (clear.color === false && clear.depth === false) return;
  const depth = clear.depth === false ? 0 : clear.depth;
  renderPass.setParameters({
    viewport: [x, y, width, height, depth, depth],
    blendConstant: clear.color === false ? [0, 0, 0, 0] : clear.color,
  });
  clearModel(device, clear.color !== false, clear.depth !== false).draw(renderPass);
  renderPass.setParameters({ blendConstant: [0, 0, 0, 0] });
}

function patchLayersPass(): void {
  if (patched) return;
  patched = true;
  // deck's typings declare the method `private` with no signature, so it reads as
  // `any`; element access is how TypeScript lets us reach a private member.
  const method = '_drawLayersInViewport';
  const original = LayersPass.prototype[method];
  LayersPass.prototype[method] = function (
    this: InstanceType<typeof LayersPass>,
    renderPass: RenderPass,
    options: DrawLayersInViewportOptions,
    drawLayerParams: unknown
  ) {
    if (!fixedDevices.has(this.device)) {
      return original.call(this, renderPass, options, drawLayerParams);
    }
    const { target, canvasContext = this.device.canvasContext, view, isPicking } = options;
    // deck's own choice of height for its bottom-left viewport (`getGLViewport`).
    const targetHeight = target ? target.height : canvasContext?.getDrawingBufferSize()[1];
    const clear = view ? viewClear(view, isPicking) : null;
    const ownSetParameters = Object.hasOwn(renderPass, 'setParameters');
    const setParameters = renderPass.setParameters;
    // deck sets the viewport once, just before drawing the layers: flip it to
    // WebGPU's top-left origin, and clear the view there, inside the open pass.
    renderPass.setParameters = (parameters) => {
      const { viewport } = parameters;
      if (!viewport || targetHeight === undefined) {
        setParameters.call(renderPass, parameters);
        return;
      }
      renderPass.setParameters = setParameters;
      const [x, y, width, height] = viewport;
      const topLeft: Viewport4 = [x, targetHeight - y - height, width, height];
      if (clear) clearViewport(this.device, renderPass, topLeft, clear);
      setParameters.call(renderPass, { ...parameters, viewport: topLeft });
    };
    try {
      // Without the view, deck skips its own clear, which begins a second render
      // pass while this one is open.
      return original.call(this, renderPass, { ...options, view: undefined }, drawLayerParams);
    } finally {
      if (ownSetParameters) renderPass.setParameters = setParameters;
      else Reflect.deleteProperty(renderPass, 'setParameters');
    }
  };
}

/**
 * Experimental workaround for deck.gl 9.4 views on WebGPU.
 *
 * deck places each view with `getGLViewport`, whose y assumes WebGL's bottom-left
 * origin, so a view smaller than the canvas draws vertically mirrored on WebGPU. A
 * view with `clear: true` never draws: deck begins a render pass for the clear while
 * the view's own pass is still open, which invalidates the frame's command buffer —
 * and a WebGPU load-op clear would clear the whole attachment anyway. This flips the
 * viewport and draws the clear as a quad inside the view. Viv's OverviewView sets
 * `clear: true`.
 *
 * Call it from Deck's `onDeviceInitialized`. It patches deck's `LayersPass` once, but
 * acts only for devices passed here; a no-op on WebGL. Unlike the picking fix it is
 * not harmless once deck is fixed — the flip would mirror views again — so remove it
 * in the same change as the deck upgrade that fixes the viewport.
 */
export function applyWebGPUViewFix(device: Device): void {
  if (device.type !== 'webgpu') return;
  fixedDevices.add(device);
  patchLayersPass();
}
