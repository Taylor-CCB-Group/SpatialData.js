# deck.gl WebGPU issues to file

Drafts for visgl/deck.gl, not yet filed. Each is worked around in `packages/layers/src/webgpu/`; the `test.fail()` specs named below flag when deck fixes them, at which point the workaround and spec are removed together. Summary: [WebGPU](../docs/vis/webgpu.mdx).

---

# deck.gl: every pick reads the vertically mirrored pixel on WebGPU

Repo: visgl/deck.gl. Versions: `@deck.gl/core` 9.4.0, `@luma.gl/*` 9.4.2, Chromium with WebGPU.

`lib/deck-picker.ts` converts the pointer with `canvasContext.cssToDevicePixels([x, y], true)` (L266, L432, L588/595, L694/701). The `true` is `yInvert`, WebGL's bottom-left origin. It is passed on WebGPU too, whose textures are top-left, and the result is used for both the scissor and the texture readback. So `pickObject`, `pickMultipleObjects`, `pickObjectsInRect` and hover all read the mirrored row.

luma's own picker avoids this by passing `device.type !== 'webgpu'`.

## Evidence

- A stock `ScatterplotLayer` on one default canvas: 24/24 hits sit at the mirrored y, 6/24 at the true y.
- A labels raster with ids encoded as colours, picked on a 40x40 grid: 58 correct / 257 missed on WebGPU, 305 correct / 0 missed on WebGL. Forcing `yInvert = false` gives 315/315 on WebGPU.
- With `_canvases` (multi-canvas mode) the same bug shows as "the second canvas picks almost nothing" and "hovering the right canvas returns layers that exist only in the left view". Both were this y-flip, not a separate multi-canvas problem.

## Repro

Any layer whose objects are not vertically symmetric about the canvas centre, picked at a known object:

```ts
const deck = new Deck({
  canvas,
  width: 200, height: 200, useDevicePixels: false,
  deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] },
  views: new OrthographicView({ id: 'main' }),
  initialViewState: { target: [0, 0, 0], zoom: 0 },
  controller: false,
  layers: [
    new ScatterplotLayer({
      id: 'dot',
      data: [{ p: [0, -60] }],        // below centre on screen is +y in orthographic
      getPosition: (d) => d.p,
      getRadius: 10, radiusUnits: 'pixels', pickable: true,
    }),
  ],
});
// after the first frame:
deck.pickObject({ x: 100, y: 160 })?.object;  // expect the dot; WebGPU returns null
deck.pickObject({ x: 100, y: 40 })?.object;   // WebGPU returns the dot (mirrored)
```

This snippet is a sketch of the same check, not run standalone. Our test covers it with labels: `tests/production/browser/labels-pick-webgpu.spec.ts` in SpatialData.js (the second test, `test.fail()`, fails on deck alone and passes with the workaround).

## Suggested fix

Pass `device.type !== 'webgpu'` as `yInvert` at each `cssToDevicePixels` call in `deck-picker.ts`, as luma's picker does.

Workaround meanwhile (harmless once fixed): wrap the device's canvas context `cssToDevicePixels` to force `yInvert = false` (`packages/layers/src/webgpu/pickingFix.ts`).

## Related, separate

`pickObjectAsync({ viewId })` ignores `viewId` and picks the default canvas in `_canvases` mode.


---

# deck.gl: views are mirrored, and `clear: true` views never draw, on WebGPU

Repo: visgl/deck.gl. Versions: `@deck.gl/core` 9.4.0, `@luma.gl/*` 9.4.2, Chromium with WebGPU. Still present on master as of 2026-10-08.

Two problems in `@deck.gl/core` `passes/layers-pass.ts`, both only on WebGPU.

## 1. A view smaller than the canvas draws vertically mirrored

`getGLViewport` returns a bottom-left y (`height - (y + h) * pixelRatio`, commented "bottom up WebGL coordinates"). `_drawLayersInViewport` passes it to `renderPass.setParameters({viewport})` on every backend. WebGPU's viewport origin is top-left, so any view that doesn't span the full canvas height is placed at the mirrored y.

## 2. A view with `clear: true` never draws

`_drawLayersInViewport` calls `this.device.beginRenderPass(...)` for the clear (`layers-pass.ts` ~L327) while the view's own render pass is still open. On WebGPU that invalidates the frame's command buffer, so nothing from that view reaches the canvas. A load-op clear can't stand in for it: it would clear the whole attachment, not the view's rectangle. Viv's `OverviewView` sets `clear: true`, so Viv's overview panel is blank on WebGPU.

## Repro

Two `OrthographicView`s on a 200x200 WebGPU canvas: a full-canvas `main`, and an inset at `{x: 110, y: 130, width: 80, height: 60}` with `clear: true, clearColor: [255, 0, 255, 255]`. No layers. Read the canvas back after the first frame.

```ts
import { Deck, OrthographicView } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';

const canvas = document.createElement('canvas');
canvas.style.width = canvas.style.height = '200px';
document.body.appendChild(canvas);

new Deck({
  canvas,
  width: 200,
  height: 200,
  useDevicePixels: false,
  deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] },
  views: [
    new OrthographicView({ id: 'main' }),
    new OrthographicView({
      id: 'inset',
      x: 110, y: 130, width: 80, height: 60,
      clear: true,
      clearColor: [255, 0, 255, 255],
    }),
  ],
  initialViewState: { target: [0, 0, 0], zoom: 0 },
  controller: false,
  layers: [],
  onAfterRender: () => {
    const copy = document.createElement('canvas');
    copy.width = copy.height = 200;
    const ctx = copy.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    console.log('inset   (150,160)', ctx.getImageData(150, 160, 1, 1).data);
    console.log('mirrored (150, 40)', ctx.getImageData(150, 40, 1, 1).data);
  },
  onError: (e) => console.error(e),
});
```

Expected: `inset` is `[255, 0, 255, 255]`, `mirrored` is `[0, 0, 0, 0]`.
Actual: the inset never draws (problem 2). If the clear is removed from the view and it is given content instead, that content appears at the mirrored y (problem 1).

The sampled points come from our test, which asserts the expected result with a workaround applied and the actual result without it: `tests/production/browser/views-webgpu.spec.ts` in SpatialData.js. The snippet above is the same scenario without our workaround, not run standalone.

## Suggested fix

1. In `getGLViewport` (or at its call site), keep the top-left y when `device.type === 'webgpu'`.
2. Do the view clear inside the open pass: draw a viewport-sized quad with the clear colour and depth, or end and reopen the pass with `loadOp: 'load'` around it.

Our workaround patches `_LayersPass.prototype._drawLayersInViewport` to flip the viewport and draw the clear as a quad inside the pass (`packages/layers/src/webgpu/viewFix.ts` in SpatialData.js). Note it double-flips once deck fixes (1).
