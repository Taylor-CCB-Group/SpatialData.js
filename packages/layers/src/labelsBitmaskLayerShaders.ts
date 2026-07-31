/**
 * Single instance-ID raster plane (`channel0` + one `labelsBitmask` style slot).
 * Not expanded via `expandShaderModule` — SpatialData labels are one plane, not Viv multi-channel stacks.
 */

const labelsUniformBlock = `\
uniform labelsBitmaskUniforms {
  vec4 color0;
  vec4 highlightColor;
  float channelOpacity0;
  float channelOutlineOpacity0;
  float channelStrokeWidth0;
  float channelVisible0;
  float channelFilled0;
  float scaleFactor;
  float labelOpacity;
  float useFeatureColors;
  float featureTexWidth;
  float featureCount;
  float highlightedLabelId;
} labelsBitmask;
`;

export const labelsBitmaskUniforms = {
  name: 'labelsBitmask',
  fs: labelsUniformBlock,
  uniformTypes: {
    color0: 'vec4<f32>',
    /**
     * Hover highlight tint, RGB 0–1 with alpha as the MIX WEIGHT (not an opacity).
     * Kept next to `color0` because both are `vec4`: std140 aligns a `vec4` to 16
     * bytes, so grouping them ahead of the scalars keeps the block free of padding
     * holes.
     */
    highlightColor: 'vec4<f32>',
    channelOpacity0: 'f32',
    channelOutlineOpacity0: 'f32',
    channelStrokeWidth0: 'f32',
    channelVisible0: 'f32',
    channelFilled0: 'f32',
    scaleFactor: 'f32',
    labelOpacity: 'f32',
    /** 1 when `featureColorTexture` holds a real per-label LUT, else 0. */
    useFeatureColors: 'f32',
    /** Texel columns in `featureColorTexture` (LABEL_COLOR_LUT_WIDTH). */
    featureTexWidth: 'f32',
    /** Number of addressable label ids; ids at or beyond this are unannotated. */
    featureCount: 'f32',
    /**
     * The label id under the cursor, or `-1` for none.
     *
     * A uniform rather than a bit in the LUT: hover changes on every pointer move,
     * and re-uploading a table that is megabytes for a large segmentation to carry
     * one changed entry is the thing this whole design avoids.
     */
    highlightedLabelId: 'f32',
  },
} as const;

export const vs = `#version 300 es
#define SHADER_NAME labels-bitmask-layer-vertex-shader

in vec2 texCoords;
in vec3 positions;
in vec3 positions64Low;
in vec3 instancePickingColors;

out vec2 vTexCoord;

void main(void) {
  geometry.worldPosition = positions;
  geometry.uv = texCoords;
  geometry.pickingColor = instancePickingColors;
  gl_Position = project_position_to_clipspace(positions, positions64Low, vec3(0.0), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vTexCoord = texCoords;
  vec4 color = vec4(0.0);
  DECKGL_FILTER_COLOR(color, geometry);
}
`;

export const fs = `#version 300 es
#define SHADER_NAME labels-bitmask-layer-fragment-shader
precision highp float;
precision highp int;

uniform sampler2D channel0;
uniform sampler2D featureColorTexture;

in vec2 vTexCoord;

out vec4 fragColor;

/**
 * Per-label style from the lookup table: rgb is the label's fill colour and a
 * is an opacity SCALE, not an opacity — 0 hides the label, and anything else
 * multiplies the channel's fill and outline opacities, so the channel's own
 * sliders keep working while a filter is applied.
 *
 * A label id past the end of the table is unannotated (it exists in the raster but
 * the table says nothing about it) and keeps the plain channel colour, mirroring a
 * shape with no per-feature colour falling back to the layer default.
 */
vec4 getLabelFeatureStyle(float sampledLabel) {
  if (labelsBitmask.useFeatureColors < 0.5) {
    return vec4(labelsBitmask.color0.rgb, 1.0);
  }
  float labelId = floor(sampledLabel + 0.5);
  if (labelId < 0.0 || labelId >= labelsBitmask.featureCount) {
    return vec4(labelsBitmask.color0.rgb, 1.0);
  }
  float width = max(labelsBitmask.featureTexWidth, 1.0);
  ivec2 texel = ivec2(int(mod(labelId, width)), int(floor(labelId / width)));
  return texelFetch(featureColorTexture, texel, 0);
}

float labelMatch(float sampledLabel, float referenceLabel) {
  return 1.0 - step(0.5, abs(sampledLabel - referenceLabel));
}

float getCoverage(sampler2D dataTex, vec2 coord, float sampledData) {
  vec2 coordDx = dFdx(coord) * 0.5;
  vec2 coordDy = dFdy(coord) * 0.5;
  return 0.25 * (
    labelMatch(texture(dataTex, coord + coordDx + coordDy).r, sampledData) +
    labelMatch(texture(dataTex, coord + coordDx - coordDy).r, sampledData) +
    labelMatch(texture(dataTex, coord - coordDx + coordDy).r, sampledData) +
    labelMatch(texture(dataTex, coord - coordDx - coordDy).r, sampledData)
  );
}

float getEdgeAtRadius(sampler2D dataTex, vec2 coord, float sampledData, float radius) {
  vec2 texel = 1.0 / vec2(textureSize(dataTex, 0));
  vec2 offsetX = vec2(texel.x * radius, 0.0);
  vec2 offsetY = vec2(0.0, texel.y * radius);
  float diff = 0.0;
  diff = max(diff, 1.0 - labelMatch(texture(dataTex, coord + offsetX).r, sampledData));
  diff = max(diff, 1.0 - labelMatch(texture(dataTex, coord - offsetX).r, sampledData));
  diff = max(diff, 1.0 - labelMatch(texture(dataTex, coord + offsetY).r, sampledData));
  diff = max(diff, 1.0 - labelMatch(texture(dataTex, coord - offsetY).r, sampledData));
  diff = max(diff, 1.0 - labelMatch(texture(dataTex, coord + offsetX + offsetY).r, sampledData));
  diff = max(diff, 1.0 - labelMatch(texture(dataTex, coord + offsetX - offsetY).r, sampledData));
  diff = max(diff, 1.0 - labelMatch(texture(dataTex, coord - offsetX + offsetY).r, sampledData));
  diff = max(diff, 1.0 - labelMatch(texture(dataTex, coord - offsetX - offsetY).r, sampledData));
  return diff;
}

float getEdgeMask(
  sampler2D dataTex,
  vec2 coord,
  float sampledData,
  float strokeWidth,
  float coverage
) {
  if (strokeWidth <= 0.0) {
    return 0.0;
  }

  float scaledStrokeWidth = max(1.0, strokeWidth * max(labelsBitmask.scaleFactor, 1.0));
  float lowerRadius = max(1.0, floor(scaledStrokeWidth));
  float upperRadius = max(1.0, ceil(scaledStrokeWidth));
  float lowerEdge = getEdgeAtRadius(dataTex, coord, sampledData, lowerRadius);
  float upperEdge = getEdgeAtRadius(dataTex, coord, sampledData, upperRadius);
  float edge = mix(lowerEdge, upperEdge, fract(scaledStrokeWidth));
  return edge * coverage;
}

vec4 sampleAndGetData(sampler2D dataTex, vec2 coord, float isFilled, float strokeWidth, float isOn) {
  float sampledData = texture(dataTex, coord).r;
  if (isOn < 0.5 || sampledData <= 0.0) {
    return vec4(0.0, sampledData, 0.0, 0.0);
  }

  float coverage = getCoverage(dataTex, coord, sampledData);
  float isEdge = getEdgeMask(dataTex, coord, sampledData, strokeWidth, coverage);

  return vec4(1.0, sampledData, coverage, isEdge);
}

vec4 dataToColor(
  vec4 sampledDataAndCoverage,
  vec4 channelColor,
  float fillOpacity,
  float outlineOpacity,
  float isFilled
) {
  float hasData = sampledDataAndCoverage.x;
  float fillCoverage = sampledDataAndCoverage.z;
  float isEdge = sampledDataAndCoverage.w;
  float fillAlpha = hasData * fillOpacity * fillCoverage * step(0.5, isFilled);
  float edgeAlpha = hasData * outlineOpacity * isEdge;
  vec4 fillColor = vec4(channelColor.rgb, fillAlpha);
  vec4 edgeColor = vec4(mix(channelColor.rgb, vec3(1.0), 0.4), edgeAlpha);
  float outAlpha = edgeColor.a + fillColor.a * (1.0 - edgeColor.a);
  vec3 outRgb = outAlpha > 0.0
    ? (
      edgeColor.rgb * edgeColor.a +
      fillColor.rgb * fillColor.a * (1.0 - edgeColor.a)
    ) / outAlpha
    : vec3(0.0);
  return vec4(outRgb, outAlpha);
}

void main() {
  vec4 dat0 = sampleAndGetData(channel0, vTexCoord, labelsBitmask.channelFilled0, labelsBitmask.channelStrokeWidth0, labelsBitmask.channelVisible0);

  if (dat0.x == 0.0) {
    discard;
  }

  // dat0.y is the sampled instance id — the index into the feature-state LUT.
  vec4 featureStyle = getLabelFeatureStyle(dat0.y);
  if (featureStyle.a <= 0.0) {
    // Hidden by the filter. Discarding (rather than drawing at zero alpha) also
    // keeps the label out of the depth/blend path entirely.
    discard;
  }

  fragColor = dataToColor(
    dat0,
    vec4(featureStyle.rgb, 1.0),
    labelsBitmask.channelOpacity0 * featureStyle.a,
    labelsBitmask.channelOutlineOpacity0 * featureStyle.a,
    labelsBitmask.channelFilled0
  );

  // Hover highlight — the labels analogue of deck's \`autoHighlight\` on shapes.
  //
  // Resolved per FRAGMENT from the sampled instance id, because a tile's deck
  // picking colour covers the whole quad: there is no per-label deck object for
  // \`picking_filterHighlightColor\` to act on, so enabling deck's own autoHighlight
  // here would light up the entire tile. Placed after the hidden-label discard, so
  // a filtered-out label cannot highlight even if a stale id points at it.
  if (labelMatch(dat0.y, labelsBitmask.highlightedLabelId) > 0.5) {
    vec4 highlight = labelsBitmask.highlightColor;
    fragColor.rgb = mix(fragColor.rgb, highlight.rgb, highlight.a);
    // Tinting alone is nearly invisible at the default fill opacity (0.18), so the
    // hovered label's fill is lifted to at least the highlight's own weight. The
    // coverage factor keeps the boundary anti-aliased, and \`channelFilled0\` gates
    // it so outline-only mode highlights the outline instead of growing a fill the
    // display mode says should not be there.
    float fillBoost = highlight.a * dat0.z * step(0.5, labelsBitmask.channelFilled0);
    fragColor.a = max(fragColor.a, fillBoost);
  }

  fragColor.a = fragColor.a * labelsBitmask.labelOpacity;

  fragColor = picking_filterHighlightColor(fragColor);
  fragColor = picking_filterPickingColor(fragColor);
}
`;
