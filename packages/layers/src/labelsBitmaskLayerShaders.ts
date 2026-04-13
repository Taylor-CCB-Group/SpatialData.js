const CHANNEL_INDICES = [0, 1, 2, 3, 4, 5, 6] as const;

const labelsUniformBlock = `\
uniform labelsBitmaskUniforms {
${CHANNEL_INDICES.map((index) => `  vec4 color${index};`).join('\n')}
${CHANNEL_INDICES.map((index) => `  float channelOpacity${index};`).join('\n')}
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
in vec3 instancePickingColors;

out vec2 vTexCoord;

void main(void) {
  geometry.worldPosition = positions;
  geometry.uv = texCoords;
  geometry.pickingColor = instancePickingColors;
  gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vTexCoord = texCoords;
  vec4 color = vec4(0.0);
  DECKGL_FILTER_COLOR(color, geometry);
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

float getEdgeMask(sampler2D dataTex, vec2 coord, float sampledData, float strokeWidth) {
  vec2 coordDx = dFdx(coord);
  vec2 coordDy = dFdy(coord);
  float edgePixels = max(1.0, 150.0 * strokeWidth * labelsBitmask.scaleFactor);
  vec2 offsetX = coordDx * edgePixels;
  vec2 offsetY = coordDy * edgePixels;

  float diff = 0.0;
  diff = max(diff, abs(texture(dataTex, coord + offsetX).r - sampledData));
  diff = max(diff, abs(texture(dataTex, coord - offsetX).r - sampledData));
  diff = max(diff, abs(texture(dataTex, coord + offsetY).r - sampledData));
  diff = max(diff, abs(texture(dataTex, coord - offsetY).r - sampledData));
  diff = max(diff, abs(texture(dataTex, coord + offsetX + offsetY).r - sampledData));
  diff = max(diff, abs(texture(dataTex, coord + offsetX - offsetY).r - sampledData));
  diff = max(diff, abs(texture(dataTex, coord - offsetX + offsetY).r - sampledData));
  diff = max(diff, abs(texture(dataTex, coord - offsetX - offsetY).r - sampledData));

  float aaWidth = max(fwidth(diff), 1e-6);
  return smoothstep(0.0, aaWidth, diff);
}

vec3 sampleAndGetData(sampler2D dataTex, vec2 coord, float isFilled, float strokeWidth, float isOn) {
  float sampledData = texture(dataTex, coord).r;
  if (isOn < 0.5 || sampledData <= 0.0) {
    return vec3(0.0, sampledData, 0.0);
  }

  float isEdge = getEdgeMask(dataTex, coord, sampledData, strokeWidth);

  return vec3(1.0, sampledData, isEdge);
}

vec4 dataToColor(
  vec3 sampledDataAndIsEdge,
  vec4 channelColor,
  float channelOpacity,
  float isFilled,
  float strokeWidth
) {
  float hasData = sampledDataAndIsEdge.x;
  float isEdge = sampledDataAndIsEdge.z;
  float fillAlpha = channelOpacity * step(0.5, isFilled);
  float edgeBoost = mix(2.5, 3.0, clamp((strokeWidth - 1.0) / 2.0, 0.0, 1.0));
  float edgeAlpha = min(1.0, channelOpacity * edgeBoost);
  float combinedAlpha = hasData * mix(fillAlpha, max(fillAlpha, edgeAlpha), isEdge);
  return vec4(channelColor.rgb, combinedAlpha);
}

void main() {
  vec3 dat0 = sampleAndGetData(channel0, vTexCoord, labelsBitmask.channelFilled0, labelsBitmask.channelStrokeWidth0, labelsBitmask.channelVisible0);
  vec3 dat1 = sampleAndGetData(channel1, vTexCoord, labelsBitmask.channelFilled1, labelsBitmask.channelStrokeWidth1, labelsBitmask.channelVisible1);
  vec3 dat2 = sampleAndGetData(channel2, vTexCoord, labelsBitmask.channelFilled2, labelsBitmask.channelStrokeWidth2, labelsBitmask.channelVisible2);
  vec3 dat3 = sampleAndGetData(channel3, vTexCoord, labelsBitmask.channelFilled3, labelsBitmask.channelStrokeWidth3, labelsBitmask.channelVisible3);
  vec3 dat4 = sampleAndGetData(channel4, vTexCoord, labelsBitmask.channelFilled4, labelsBitmask.channelStrokeWidth4, labelsBitmask.channelVisible4);
  vec3 dat5 = sampleAndGetData(channel5, vTexCoord, labelsBitmask.channelFilled5, labelsBitmask.channelStrokeWidth5, labelsBitmask.channelVisible5);
  vec3 dat6 = sampleAndGetData(channel6, vTexCoord, labelsBitmask.channelFilled6, labelsBitmask.channelStrokeWidth6, labelsBitmask.channelVisible6);

  if (
    dat0.x == 0.0 && dat1.x == 0.0 && dat2.x == 0.0 && dat3.x == 0.0 &&
    dat4.x == 0.0 && dat5.x == 0.0 && dat6.x == 0.0
  ) {
    discard;
  }

  vec4 val0 = dataToColor(dat0, labelsBitmask.color0, labelsBitmask.channelOpacity0, labelsBitmask.channelFilled0, labelsBitmask.channelStrokeWidth0);
  vec4 val1 = dataToColor(dat1, labelsBitmask.color1, labelsBitmask.channelOpacity1, labelsBitmask.channelFilled1, labelsBitmask.channelStrokeWidth1);
  vec4 val2 = dataToColor(dat2, labelsBitmask.color2, labelsBitmask.channelOpacity2, labelsBitmask.channelFilled2, labelsBitmask.channelStrokeWidth2);
  vec4 val3 = dataToColor(dat3, labelsBitmask.color3, labelsBitmask.channelOpacity3, labelsBitmask.channelFilled3, labelsBitmask.channelStrokeWidth3);
  vec4 val4 = dataToColor(dat4, labelsBitmask.color4, labelsBitmask.channelOpacity4, labelsBitmask.channelFilled4, labelsBitmask.channelStrokeWidth4);
  vec4 val5 = dataToColor(dat5, labelsBitmask.color5, labelsBitmask.channelOpacity5, labelsBitmask.channelFilled5, labelsBitmask.channelStrokeWidth5);
  vec4 val6 = dataToColor(dat6, labelsBitmask.color6, labelsBitmask.channelOpacity6, labelsBitmask.channelFilled6, labelsBitmask.channelStrokeWidth6);

  fragColor = val0;
  fragColor = (val1 == fragColor || val1 == vec4(0.0)) ? fragColor : vec4(mix(fragColor, val1, val1.a).rgb, max(fragColor.a, val1.a));
  fragColor = (val2 == fragColor || val2 == vec4(0.0)) ? fragColor : vec4(mix(fragColor, val2, val2.a).rgb, max(fragColor.a, val2.a));
  fragColor = (val3 == fragColor || val3 == vec4(0.0)) ? fragColor : vec4(mix(fragColor, val3, val3.a).rgb, max(fragColor.a, val3.a));
  fragColor = (val4 == fragColor || val4 == vec4(0.0)) ? fragColor : vec4(mix(fragColor, val4, val4.a).rgb, max(fragColor.a, val4.a));
  fragColor = (val5 == fragColor || val5 == vec4(0.0)) ? fragColor : vec4(mix(fragColor, val5, val5.a).rgb, max(fragColor.a, val5.a));
  fragColor = (val6 == fragColor || val6 == vec4(0.0)) ? fragColor : vec4(mix(fragColor, val6, val6.a).rgb, max(fragColor.a, val6.a));
  fragColor.a = fragColor.a * labelsBitmask.labelOpacity;

  geometry.uv = vTexCoord;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;
