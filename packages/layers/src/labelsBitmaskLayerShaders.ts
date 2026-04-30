const CHANNEL_INDICES = [0, 1, 2, 3, 4, 5, 6] as const;

const labelsUniformBlock = `\
uniform labelsBitmaskUniforms {
${CHANNEL_INDICES.map((index) => `  vec4 color${index};`).join('\n')}
${CHANNEL_INDICES.map((index) => `  float channelOpacity${index};`).join('\n')}
${CHANNEL_INDICES.map((index) => `  float channelOutlineOpacity${index};`).join('\n')}
${CHANNEL_INDICES.map((index) => `  float channelStrokeWidth${index};`).join('\n')}
${CHANNEL_INDICES.map((index) => `  float channelVisible${index};`).join('\n')}
${CHANNEL_INDICES.map((index) => `  float channelFilled${index};`).join('\n')}
  float scaleFactor;
  float labelOpacity;
} labelsBitmask;
`;

export const labelsBitmaskUniforms = {
  name: 'labelsBitmask',
  fs: labelsUniformBlock,
  uniformTypes: Object.fromEntries([
    ...CHANNEL_INDICES.map((index) => [`color${index}`, 'vec4<f32>']),
    ...CHANNEL_INDICES.map((index) => [`channelOpacity${index}`, 'f32']),
    ...CHANNEL_INDICES.map((index) => [`channelOutlineOpacity${index}`, 'f32']),
    ...CHANNEL_INDICES.map((index) => [`channelStrokeWidth${index}`, 'f32']),
    ...CHANNEL_INDICES.map((index) => [`channelVisible${index}`, 'f32']),
    ...CHANNEL_INDICES.map((index) => [`channelFilled${index}`, 'f32']),
    ['scaleFactor', 'f32'],
    ['labelOpacity', 'f32'],
  ]),
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
  picking_setPickingAttribute(gl_Position.z / gl_Position.w);
  vTexCoord = texCoords;
  picking_setPickingColor(geometry.pickingColor);
}
`;

export const fs = `#version 300 es
#define SHADER_NAME labels-bitmask-layer-fragment-shader
precision highp float;

uniform sampler2D channel0;
uniform sampler2D channel1;
uniform sampler2D channel2;
uniform sampler2D channel3;
uniform sampler2D channel4;
uniform sampler2D channel5;
uniform sampler2D channel6;

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

vec4 blendOver(vec4 baseColor, vec4 overlayColor) {
  if (overlayColor.a <= 0.0) {
    return baseColor;
  }
  return vec4(
    mix(baseColor.rgb, overlayColor.rgb, overlayColor.a),
    max(baseColor.a, overlayColor.a)
  );
}

void main() {
  vec4 dat0 = sampleAndGetData(channel0, vTexCoord, labelsBitmask.channelFilled0, labelsBitmask.channelStrokeWidth0, labelsBitmask.channelVisible0);
  vec4 dat1 = sampleAndGetData(channel1, vTexCoord, labelsBitmask.channelFilled1, labelsBitmask.channelStrokeWidth1, labelsBitmask.channelVisible1);
  vec4 dat2 = sampleAndGetData(channel2, vTexCoord, labelsBitmask.channelFilled2, labelsBitmask.channelStrokeWidth2, labelsBitmask.channelVisible2);
  vec4 dat3 = sampleAndGetData(channel3, vTexCoord, labelsBitmask.channelFilled3, labelsBitmask.channelStrokeWidth3, labelsBitmask.channelVisible3);
  vec4 dat4 = sampleAndGetData(channel4, vTexCoord, labelsBitmask.channelFilled4, labelsBitmask.channelStrokeWidth4, labelsBitmask.channelVisible4);
  vec4 dat5 = sampleAndGetData(channel5, vTexCoord, labelsBitmask.channelFilled5, labelsBitmask.channelStrokeWidth5, labelsBitmask.channelVisible5);
  vec4 dat6 = sampleAndGetData(channel6, vTexCoord, labelsBitmask.channelFilled6, labelsBitmask.channelStrokeWidth6, labelsBitmask.channelVisible6);

  if (
    dat0.x == 0.0 && dat1.x == 0.0 && dat2.x == 0.0 && dat3.x == 0.0 &&
    dat4.x == 0.0 && dat5.x == 0.0 && dat6.x == 0.0
  ) {
    discard;
  }

  vec4 val0 = dataToColor(dat0, labelsBitmask.color0, labelsBitmask.channelOpacity0, labelsBitmask.channelOutlineOpacity0, labelsBitmask.channelFilled0);
  vec4 val1 = dataToColor(dat1, labelsBitmask.color1, labelsBitmask.channelOpacity1, labelsBitmask.channelOutlineOpacity1, labelsBitmask.channelFilled1);
  vec4 val2 = dataToColor(dat2, labelsBitmask.color2, labelsBitmask.channelOpacity2, labelsBitmask.channelOutlineOpacity2, labelsBitmask.channelFilled2);
  vec4 val3 = dataToColor(dat3, labelsBitmask.color3, labelsBitmask.channelOpacity3, labelsBitmask.channelOutlineOpacity3, labelsBitmask.channelFilled3);
  vec4 val4 = dataToColor(dat4, labelsBitmask.color4, labelsBitmask.channelOpacity4, labelsBitmask.channelOutlineOpacity4, labelsBitmask.channelFilled4);
  vec4 val5 = dataToColor(dat5, labelsBitmask.color5, labelsBitmask.channelOpacity5, labelsBitmask.channelOutlineOpacity5, labelsBitmask.channelFilled5);
  vec4 val6 = dataToColor(dat6, labelsBitmask.color6, labelsBitmask.channelOpacity6, labelsBitmask.channelOutlineOpacity6, labelsBitmask.channelFilled6);

  fragColor = val0;
  fragColor = blendOver(fragColor, val1);
  fragColor = blendOver(fragColor, val2);
  fragColor = blendOver(fragColor, val3);
  fragColor = blendOver(fragColor, val4);
  fragColor = blendOver(fragColor, val5);
  fragColor = blendOver(fragColor, val6);
  fragColor.a = fragColor.a * labelsBitmask.labelOpacity;

  fragColor = picking_filterHighlightColor(fragColor);
  fragColor = picking_filterPickingColor(fragColor);
}
`;
