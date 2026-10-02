import { MAX_CHANNELS } from '@hms-dbmi/viv';
import type { Texture } from '@luma.gl/core';

/**
 * Raw samples live in one `texture_2d_array<u32>`, one layer per channel, read with
 * `textureLoad`. Unsigned data keeps its native width (r8uint / r16uint / r32uint);
 * anything else is uploaded as f32 bit patterns into r32uint and `bitcast` back.
 * That avoids `r32float`, which WebGPU only lets a shader bind as filterable with the
 * optional `float32-filterable` feature — and luma's WGSL reflection always declares
 * `texture_2d<f32>` as filterable. Interpolation is done in the shader instead.
 */
const uniformBlock = /* wgsl */ `\
struct RasterUniforms {
  bounds: vec4<f32>,
  // Viv's channel limit, so UIs that cap channels at MAX_CHANNELS fit. Limits are
  // vec4 (.xy used) because uniform array elements are 16-byte aligned anyway.
  colors: array<vec4<f32>, ${MAX_CHANNELS}>,
  limits: array<vec4<f32>, ${MAX_CHANNELS}>,
  labelColor: vec4<f32>,
  highlightColor: vec4<f32>,
  mode: f32,
  numChannels: f32,
  valueKind: f32,
  linear: f32,
  lutWidth: f32,
  lutCount: f32,
  useLut: f32,
  highlightedLabel: f32,
  fillOpacity: f32,
  outlineOpacity: f32,
  strokeWidth: f32,
  opacity: f32,
};

@group(0) @binding(auto) var<uniform> raster: RasterUniforms;
@group(0) @binding(auto) var rasterData: texture_2d_array<u32>;
@group(0) @binding(auto) var rasterLut: texture_2d<f32>;
`;

type Vec4 = [number, number, number, number];

export type RasterUniformProps = {
  bounds: Vec4;
  colors: Vec4[];
  limits: Vec4[];
  labelColor: Vec4;
  highlightColor: Vec4;
  mode: number;
  numChannels: number;
  valueKind: number;
  linear: number;
  lutWidth: number;
  lutCount: number;
  useLut: number;
  highlightedLabel: number;
  fillOpacity: number;
  outlineOpacity: number;
  strokeWidth: number;
  opacity: number;
  rasterData: Texture;
  rasterLut: Texture;
};

export const rasterUniforms = {
  name: 'raster',
  source: uniformBlock,
  // Order must match the WGSL struct: luma lays the buffer out from this table.
  uniformTypes: {
    bounds: 'vec4<f32>',
    colors: ['vec4<f32>', MAX_CHANNELS],
    limits: ['vec4<f32>', MAX_CHANNELS],
    labelColor: 'vec4<f32>',
    highlightColor: 'vec4<f32>',
    mode: 'f32',
    numChannels: 'f32',
    valueKind: 'f32',
    linear: 'f32',
    lutWidth: 'f32',
    lutCount: 'f32',
    useLut: 'f32',
    highlightedLabel: 'f32',
    fillOpacity: 'f32',
    outlineOpacity: 'f32',
    strokeWidth: 'f32',
    opacity: 'f32',
  },
} as const;

export const source = /* wgsl */ `\
struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Two triangles over the tile, pulled from vertex_index: no vertex buffers.
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> Varyings {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  let corner = corners[vertexIndex];
  // Viv bounds are [left, bottom, right, top]; image row 0 sits at \`top\`.
  let x = mix(raster.bounds.x, raster.bounds.z, corner.x);
  let y = mix(raster.bounds.w, raster.bounds.y, corner.y);
  var output: Varyings;
  output.position = project_position_to_clipspace(
    vec3<f32>(x, y, 0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0)
  );
  output.uv = corner;
  return output;
}

fn raster_value(texel: vec2<i32>, channel: i32) -> f32 {
  let raw = textureLoad(rasterData, texel, channel, 0).r;
  if (raster.valueKind > 0.5) {
    return bitcast<f32>(raw);
  }
  return f32(raw);
}

fn raster_sample(texelPosition: vec2<f32>, size: vec2<i32>, channel: i32) -> f32 {
  let maxTexel = size - vec2<i32>(1);
  if (raster.linear < 0.5) {
    return raster_value(clamp(vec2<i32>(floor(texelPosition)), vec2<i32>(0), maxTexel), channel);
  }
  let p = texelPosition - vec2<f32>(0.5);
  let base = floor(p);
  let f = p - base;
  let t0 = clamp(vec2<i32>(base), vec2<i32>(0), maxTexel);
  let t1 = clamp(vec2<i32>(base) + vec2<i32>(1), vec2<i32>(0), maxTexel);
  let v00 = raster_value(t0, channel);
  let v10 = raster_value(vec2<i32>(t1.x, t0.y), channel);
  let v01 = raster_value(vec2<i32>(t0.x, t1.y), channel);
  let v11 = raster_value(t1, channel);
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

fn raster_image(texelPosition: vec2<f32>, size: vec2<i32>) -> vec4<f32> {
  var rgb = vec3<f32>(0.0);
  // Runtime bound: unused channels are never sampled. A per-count source (Viv's
  // NUM_CHANNELS) would only add unrolling; luma's WGSL path substitutes no defines.
  let count = min(i32(raster.numChannels), ${MAX_CHANNELS});
  for (var i = 0; i < count; i = i + 1) {
    let color = raster.colors[i];
    // colour.a carries channel visibility.
    if (color.a < 0.5) {
      continue;
    }
    let range = raster.limits[i].xy;
    let value = raster_sample(texelPosition, size, i);
    let intensity = clamp((value - range.x) / max(range.y - range.x, 1e-20), 0.0, 1.0);
    rgb = rgb + color.rgb * intensity;
  }
  return vec4<f32>(min(rgb, vec3<f32>(1.0)), raster.opacity);
}

fn raster_label_at(texelPosition: vec2<f32>, size: vec2<i32>) -> u32 {
  let texel = clamp(vec2<i32>(floor(texelPosition)), vec2<i32>(0), size - vec2<i32>(1));
  return textureLoad(rasterData, texel, 0, 0).r;
}

fn raster_label_style(id: u32) -> vec4<f32> {
  if (raster.useLut < 0.5 || f32(id) >= raster.lutCount) {
    return vec4<f32>(raster.labelColor.rgb, 1.0);
  }
  let width = u32(max(raster.lutWidth, 1.0));
  return textureLoad(rasterLut, vec2<i32>(i32(id % width), i32(id / width)), 0);
}

// Outline = a neighbour \`strokeWidth\` screen pixels away holds a different id.
// \`texelsPerPixel\` comes from fwidth, taken before any discard (WGSL uniformity).
fn raster_labels(texelPosition: vec2<f32>, size: vec2<i32>, texelsPerPixel: vec2<f32>) -> vec4<f32> {
  let id = raster_label_at(texelPosition, size);
  if (id == 0u) {
    return vec4<f32>(0.0);
  }
  let style = raster_label_style(id);
  if (style.a <= 0.0) {
    return vec4<f32>(0.0);
  }
  let offset = texelsPerPixel * raster.strokeWidth;
  var edge = 0.0;
  if (raster_label_at(texelPosition + vec2<f32>(offset.x, 0.0), size) != id ||
      raster_label_at(texelPosition - vec2<f32>(offset.x, 0.0), size) != id ||
      raster_label_at(texelPosition + vec2<f32>(0.0, offset.y), size) != id ||
      raster_label_at(texelPosition - vec2<f32>(0.0, offset.y), size) != id) {
    edge = 1.0;
  }
  var rgb = mix(style.rgb, mix(style.rgb, vec3<f32>(1.0), 0.4), edge);
  var alpha = mix(raster.fillOpacity, raster.outlineOpacity, edge) * style.a;
  if (f32(id) == raster.highlightedLabel) {
    rgb = mix(rgb, raster.highlightColor.rgb, raster.highlightColor.a);
    alpha = max(alpha, raster.highlightColor.a);
  }
  return vec4<f32>(rgb, alpha * raster.opacity);
}

@fragment
fn fragmentMain(input: Varyings) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(rasterData).xy);
  let texelPosition = input.uv * vec2<f32>(size);
  let texelsPerPixel = fwidth(texelPosition);

  var fragColor: vec4<f32>;
  if (raster.mode > 0.5) {
    fragColor = raster_labels(texelPosition, size, texelsPerPixel);
  } else {
    fragColor = raster_image(texelPosition, size);
  }
  if (fragColor.a <= 0.0) {
    discard;
  }

  if (picking.isActive > 0.5) {
    // One pickable object per tile; labels resolve the id CPU-side from the plane.
    // Raw (un-normalised) colour, as deck's own WGSL layers write it.
    return vec4<f32>(picking_getPickingColorFromIndex(0u), 1.0);
  }
  return deckgl_premultiplied_alpha(fragColor);
}
`;
