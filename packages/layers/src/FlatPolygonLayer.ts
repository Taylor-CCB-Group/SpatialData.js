/**
 * A vertex-pulling filled-polygon layer that draws its own outline in the fragment
 * shader and colours each polygon by sampling a per-feature colour texture.
 *
 * The pan/zoom regression on large shape sets (Visium HD `square_002um`, ~2.7M shapes)
 * came from outlining polygons with a `PathLayer`, which tessellates every ring into
 * width-quads. This layer draws the fill triangles with an **attribute-less** shader:
 * `gl_VertexID` selects the triangle + corner, and the vertex shader pulls the
 * topology and shared ring positions from two textures, computing position and the
 * boundary edge-distance on the fly (see `shapesPolygonTessellate` +
 * `flatPolygonLayerShaders`). Nothing is stored per de-indexed vertex — geometry is
 * two shared textures instead of large attribute buffers.
 *
 * Feature-state (colour-by-column, hide, fade) is a per-feature colour texture indexed
 * by feature (the "table column → buffer" primitive): a feature-state change reuploads
 * only that small texture, never the geometry textures. Highlight stays on deck's
 * picking module. Picking colours are computed in-shader from the feature index.
 *
 * Hand-rolled luma `Model` — the lowest-level deck extension surface, kept to this
 * file plus its shaders. The `Model`/texture/uniform-block API is backend-agnostic;
 * a WebGPU port needs only a WGSL variant of the shaders (and can use storage buffers
 * instead of texture-packing).
 */

import { Layer, type LayerProps, picking, project32 } from '@deck.gl/core';
import { Model } from '@luma.gl/engine';
import { flatPolygonUniforms, fs, vs } from './flatPolygonLayerShaders';

/** Data-texture width (texel columns). 2048 keeps heights well under the WebGL2 max
 *  texture size for our largest elements. The shader computes texel coords from this. */
const TEX_WIDTH = 2048;

/** deck's default picking-colour encoding (index → RGB), matched so `pickingInfo.index`
 *  decodes back to the feature index. Used by the pick handler, not the shader. */
export function encodeFeaturePickingColors(featureIndex: Uint32Array): Uint8Array {
  const out = new Uint8Array(featureIndex.length * 3);
  for (let v = 0; v < featureIndex.length; v += 1) {
    const i = featureIndex[v] + 1;
    out[v * 3] = i & 255;
    out[v * 3 + 1] = (i >> 8) & 255;
    out[v * 3 + 2] = (i >> 16) & 255;
  }
  return out;
}

export interface FlatPolygonLayerProps extends LayerProps {
  /** Shared ring vertices, interleaved XY (`2 * ringVertexCount`). */
  ringPositions: Float32Array;
  ringVertexCount: number;
  /** Per-triangle record `[g0, g1, g2, feature*8 + flags]` (`4 * triangleCount`). */
  triangleData: Uint32Array;
  triangleCount: number;
  /** Per-feature RGBA colours (`4 * featureCount`); new identity only on a
   *  feature-state change. */
  featureColors: Uint8Array;
  featureCount: number;
  /** Per-feature characteristic size (√area, world units), `featureCount` long. Static
   *  with the geometry; used to keep the outline from dominating small shapes. */
  featureScale: Float32Array;
  /** Outline width in screen pixels (upper bound; thinned for small shapes). */
  strokeWidthPixels?: number;
}

const DEFAULT_PROPS = {
  strokeWidthPixels: { type: 'number', value: 1.5 },
};

// deck's Layer generics don't model a fully hand-rolled Model layer; the repo's other
// custom-shader layers use the same `any` widening (see LabelsBitmaskTileLayer).
// biome-ignore lint/suspicious/noExplicitAny: hand-rolled deck Layer subclass.
export class FlatPolygonLayer extends (Layer as any) {
  static layerName = 'FlatPolygonLayer';
  static defaultProps = DEFAULT_PROPS;

  // biome-ignore lint/complexity/noUselessConstructor: widens the `any` base constructor.
  // biome-ignore lint/suspicious/noExplicitAny: base widened to `any`.
  constructor(...args: any[]) {
    super(...args);
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches base getShaders shape.
  getShaders(): any {
    return super.getShaders({
      vs,
      fs,
      modules: [project32, picking, flatPolygonUniforms],
      // The draw is a non-instanced triangle list with no vertex attributes; the
      // shader reads everything from textures via gl_VertexID.
      defines: { NON_INSTANCED_MODEL: 1 },
    });
  }

  initializeState(): void {
    // Attribute-less: no AttributeManager attributes. Geometry lives in textures.
    this.state.model = this._getModel();
    this._updateGeometryTextures();
    this._updateFeatureTexture();
  }

  updateState(params: {
    props: FlatPolygonLayerProps;
    oldProps: Partial<FlatPolygonLayerProps>;
    changeFlags: { extensionsChanged?: boolean };
  }): void {
    super.updateState(params);
    const { props, oldProps, changeFlags } = params;
    if (changeFlags.extensionsChanged) {
      this.state.model?.destroy();
      this.state.model = this._getModel();
    }
    // Invalidate on every prop the texture builders actually read — the counts size
    // the textures, so a count change with a reused buffer would otherwise leave a
    // stale texture (or stale dimensions) on the GPU.
    if (
      props.ringPositions !== oldProps.ringPositions ||
      props.ringVertexCount !== oldProps.ringVertexCount ||
      props.triangleData !== oldProps.triangleData ||
      props.triangleCount !== oldProps.triangleCount ||
      props.featureScale !== oldProps.featureScale ||
      props.featureCount !== oldProps.featureCount
    ) {
      this._updateGeometryTextures();
    }
    if (
      props.featureColors !== oldProps.featureColors ||
      props.featureCount !== oldProps.featureCount
    ) {
      this._updateFeatureTexture();
    }
  }

  finalizeState(context: unknown): void {
    // The model owns GPU resources too; textures alone are not the whole footprint.
    this.state.model?.destroy();
    this.state.ringPosTexture?.destroy();
    this.state.triDataTexture?.destroy();
    this.state.featureScaleTexture?.destroy();
    this.state.featureTexture?.destroy();
    // biome-ignore lint/suspicious/noExplicitAny: base Layer is widened to `any`.
    (super.finalizeState as any)?.(context);
  }

  /** Upload the shared ring positions (`rg32float`) and per-triangle topology
   *  (`rgba32uint`). Static — rebuilt only when the geometry changes. */
  _updateGeometryTextures(): void {
    const { ringPositions, ringVertexCount, triangleData, triangleCount } = this.props;
    const device = this.context.device;

    const ringHeight = Math.max(1, Math.ceil(ringVertexCount / TEX_WIDTH));
    const ringData = new Float32Array(TEX_WIDTH * ringHeight * 2);
    ringData.set(ringPositions.subarray(0, Math.min(ringPositions.length, ringData.length)));
    this.state.ringPosTexture?.destroy();
    this.state.ringPosTexture = device.createTexture({
      width: TEX_WIDTH,
      height: ringHeight,
      format: 'rg32float',
      data: ringData,
      mipmaps: false,
      sampler: { minFilter: 'nearest', magFilter: 'nearest' },
    });

    const triHeight = Math.max(1, Math.ceil(triangleCount / TEX_WIDTH));
    const triData = new Uint32Array(TEX_WIDTH * triHeight * 4);
    triData.set(triangleData.subarray(0, Math.min(triangleData.length, triData.length)));
    this.state.triDataTexture?.destroy();
    this.state.triDataTexture = device.createTexture({
      width: TEX_WIDTH,
      height: triHeight,
      format: 'rgba32uint',
      data: triData,
      mipmaps: false,
      sampler: { minFilter: 'nearest', magFilter: 'nearest' },
    });

    // Per-feature characteristic size (√area), sampled by the outline to avoid
    // dominating small shapes. Same feature indexing as the colour texture.
    const scaleHeight = Math.max(1, Math.ceil(this.props.featureCount / TEX_WIDTH));
    const scaleData = new Float32Array(TEX_WIDTH * scaleHeight);
    const scaleSrc = this.props.featureScale;
    scaleData.set(scaleSrc.subarray(0, Math.min(scaleSrc.length, scaleData.length)));
    this.state.featureScaleTexture?.destroy();
    this.state.featureScaleTexture = device.createTexture({
      width: TEX_WIDTH,
      height: scaleHeight,
      format: 'r32float',
      data: scaleData,
      mipmaps: false,
      sampler: { minFilter: 'nearest', magFilter: 'nearest' },
    });

    this.state.triDataTexWidth = TEX_WIDTH;
    this.state.ringPosTexWidth = TEX_WIDTH;
    this.state.vertexCount = triangleCount * 3;
  }

  /** (Re)build the per-feature colour texture from `props.featureColors`. */
  _updateFeatureTexture(): void {
    const height = Math.max(1, Math.ceil(this.props.featureCount / TEX_WIDTH));
    const data = new Uint8Array(TEX_WIDTH * height * 4);
    const src = this.props.featureColors;
    data.set(src.subarray(0, Math.min(src.length, data.length)));
    this.state.featureTexture?.destroy();
    this.state.featureTexture = this.context.device.createTexture({
      width: TEX_WIDTH,
      height,
      format: 'rgba8unorm',
      data,
      mipmaps: false,
      sampler: { minFilter: 'nearest', magFilter: 'nearest' },
    });
    this.state.featureTexWidth = TEX_WIDTH;
  }

  draw(): void {
    const model = this.state.model;
    if (!model || !this.state.ringPosTexture) {
      return;
    }
    model.setVertexCount(this.state.vertexCount);
    model.shaderInputs.setProps({
      flatPolygon: {
        strokeWidthPixels: this.props.strokeWidthPixels ?? 1.5,
        opacity: this.props.opacity ?? 1,
        ringPosTexWidth: this.state.ringPosTexWidth,
        triDataTexWidth: this.state.triDataTexWidth,
        featureTexWidth: this.state.featureTexWidth,
        ringPositions: this.state.ringPosTexture,
        triangleData: this.state.triDataTexture,
        featureColorTexture: this.state.featureTexture,
        featureScaleTexture: this.state.featureScaleTexture,
      },
    });
    model.draw(this.context.renderPass);
  }

  _getModel(): Model {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      topology: 'triangle-list',
      bufferLayout: [],
      isInstanced: false,
    });
  }
}
