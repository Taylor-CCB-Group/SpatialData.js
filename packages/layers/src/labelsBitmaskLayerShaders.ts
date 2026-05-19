/**
 * Single instance-ID raster plane (`channel0` + one `labelsBitmask` style slot).
 * Not expanded via `expandShaderModule` — SpatialData labels are one plane, not Viv multi-channel stacks.
 */

const labelsUniformBlock = `\
uniform labelsBitmaskUniforms {
  vec4 color0;
  float channelOpacity0;
  float channelOutlineOpacity0;
  float channelStrokeWidth0;
  float channelVisible0;
  float channelFilled0;
  float scaleFactor;
  float labelOpacity;
} labelsBitmask;
`;

export const labelsBitmaskUniforms = {
  name: 'labelsBitmask',
  fs: labelsUniformBlock,
  uniformTypes: {
    color0: 'vec4<f32>',
    channelOpacity0: 'f32',
    channelOutlineOpacity0: 'f32',
    channelStrokeWidth0: 'f32',
    channelVisible0: 'f32',
    channelFilled0: 'f32',
    scaleFactor: 'f32',
    labelOpacity: 'f32',
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

in vec2 vTexCoord;

out vec4 fragColor;

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

  fragColor = dataToColor(dat0, labelsBitmask.color0, labelsBitmask.channelOpacity0, labelsBitmask.channelOutlineOpacity0, labelsBitmask.channelFilled0);
  fragColor.a = fragColor.a * labelsBitmask.labelOpacity;

  fragColor = picking_filterHighlightColor(fragColor);
  fragColor = picking_filterPickingColor(fragColor);
}
`;
