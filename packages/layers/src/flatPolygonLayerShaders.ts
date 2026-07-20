/**
 * Shaders for `FlatPolygonLayer` — a **vertex-pulling** filled-polygon renderer that
 * imputes its own outline in the fragment shader.
 *
 * The draw is attribute-less: `gl_VertexID` selects the triangle (`id/3`) and the
 * corner (`id%3`); the vertex shader then fetches the triangle's record from
 * `triangleData` (three ring-vertex indices + boundary flags + feature index) and the
 * three corner positions from `ringPositions`. It picks this corner's position,
 * **computes** the boundary edge-distance `vec3` (nothing stored per vertex), and
 * samples the per-feature colour texture. This keeps geometry memory to two shared
 * textures instead of large de-indexed attribute buffers.
 *
 * OUTLINE. `min(vEdgeDistance)` is the distance to the nearest boundary edge (internal
 * earcut edges are the large sentinel). `fwidth(d) * strokeWidthPixels` is the
 * world-space width of a constant pixel-width band; `smoothstep` anti-aliases it.
 */

const flatPolygonUniformBlock = `\
uniform flatPolygonUniforms {
  float strokeWidthPixels;
  float opacity;
  float ringPosTexWidth;
  float triDataTexWidth;
  float featureTexWidth;
} flatPolygon;
`;

export const flatPolygonUniforms = {
  name: 'flatPolygon',
  vs: flatPolygonUniformBlock,
  fs: flatPolygonUniformBlock,
  uniformTypes: {
    strokeWidthPixels: 'f32',
    opacity: 'f32',
    ringPosTexWidth: 'f32',
    triDataTexWidth: 'f32',
    featureTexWidth: 'f32',
  },
} as const;

export const vs = `#version 300 es
#define SHADER_NAME flat-polygon-layer-vertex-shader
precision highp float;
precision highp int;

uniform sampler2D ringPositions;
uniform highp usampler2D triangleData;
uniform sampler2D featureColorTexture;
uniform sampler2D featureScaleTexture;

out vec3 vEdgeDistance;
out vec4 vFillColor;
out float vShapeScale;

ivec2 flatPolygon_texCoord(uint index, float width) {
  uint w = uint(width);
  return ivec2(int(index % w), int(index / w));
}

void main(void) {
  int vid = gl_VertexID;
  int tri = vid / 3;
  int corner = vid - tri * 3;

  uvec4 td = texelFetch(triangleData, flatPolygon_texCoord(uint(tri), flatPolygon.triDataTexWidth), 0);
  uint feature = td.w >> 3u;
  uint flags = td.w & 7u;

  vec2 A = texelFetch(ringPositions, flatPolygon_texCoord(td.x, flatPolygon.ringPosTexWidth), 0).xy;
  vec2 B = texelFetch(ringPositions, flatPolygon_texCoord(td.y, flatPolygon.ringPosTexWidth), 0).xy;
  vec2 C = texelFetch(ringPositions, flatPolygon_texCoord(td.z, flatPolygon.ringPosTexWidth), 0).xy;
  vec2 p = corner == 0 ? A : (corner == 1 ? B : C);

  // Boundary edge-distance vec3 (matches shapesPolygonTessellate's CPU reference):
  // component k is the distance to edge k (0=BC, 1=CA, 2=AB); internal edges get a
  // large sentinel so they never win the fragment's min.
  float crossMag = abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x));
  float lenBC = distance(B, C);
  float lenCA = distance(C, A);
  float lenAB = distance(A, B);
  float hA = lenBC > 0.0 ? crossMag / lenBC : 0.0;
  float hB = lenCA > 0.0 ? crossMag / lenCA : 0.0;
  float hC = lenAB > 0.0 ? crossMag / lenAB : 0.0;
  float large = max(hA, max(hB, hC)) * 8.0 + 1.0;
  bool bd0 = (flags & 1u) != 0u;
  bool bd1 = (flags & 2u) != 0u;
  bool bd2 = (flags & 4u) != 0u;
  if (corner == 0) {
    vEdgeDistance = vec3(bd0 ? hA : large, bd1 ? 0.0 : large, bd2 ? 0.0 : large);
  } else if (corner == 1) {
    vEdgeDistance = vec3(bd0 ? 0.0 : large, bd1 ? hB : large, bd2 ? 0.0 : large);
  } else {
    vEdgeDistance = vec3(bd0 ? 0.0 : large, bd1 ? 0.0 : large, bd2 ? hC : large);
  }

  vec3 pos = vec3(p, 0.0);
  geometry.worldPosition = pos;

  // Picking colour from the feature index — deck's encoding (index + 1 → RGB bytes).
  float fp = float(feature + 1u);
  geometry.pickingColor = vec3(
    mod(fp, 256.0),
    mod(floor(fp / 256.0), 256.0),
    mod(floor(fp / 65536.0), 256.0)
  );

  gl_Position = project_position_to_clipspace(pos, vec3(0.0), vec3(0.0), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  vFillColor = texelFetch(featureColorTexture, flatPolygon_texCoord(feature, flatPolygon.featureTexWidth), 0);
  vShapeScale = texelFetch(featureScaleTexture, flatPolygon_texCoord(feature, flatPolygon.featureTexWidth), 0).r;
  DECKGL_FILTER_COLOR(vFillColor, geometry);
}
`;

export const fs = `#version 300 es
#define SHADER_NAME flat-polygon-layer-fragment-shader
precision highp float;

// Outline appearance. Lightened toward white for contrast against the fill; capped to
// a fraction of the shape's on-screen size so it never dominates a small (zoomed-out)
// shape.
#define STROKE_LIGHTEN 0.55
#define STROKE_ALPHA_LIFT 0.35
#define STROKE_MAX_FRACTION 0.28
// Below OUTLINE_FADE_LO on-screen pixels the outline is fully faded out; above
// OUTLINE_FADE_HI it is at full strength. This stops the thin edge from aliasing into
// moiré on a regular grid when shapes go sub-pixel (zoomed out).
#define OUTLINE_FADE_LO 1.5
#define OUTLINE_FADE_HI 4.0

in vec3 vEdgeDistance;
in vec4 vFillColor;
in float vShapeScale;

out vec4 fragColor;

void main(void) {
  // Hidden features arrive as fully transparent fill — drop them entirely (both fill
  // and would-be outline), rather than letting the lightened stroke reappear.
  if (vFillColor.a == 0.0) {
    discard;
  }

  float d = min(vEdgeDistance.x, min(vEdgeDistance.y, vEdgeDistance.z));
  float worldPerPx = max(fwidth(d), 1e-20);

  // The shape's size in screen pixels (√area is world units; worldPerPx converts).
  // Cap the outline to a fraction of it so a tiny shape isn't all outline; when the
  // shape is large the requested pixel width wins.
  float shapePx = vShapeScale / worldPerPx;
  float strokePx = min(flatPolygon.strokeWidthPixels, shapePx * STROKE_MAX_FRACTION);
  float aa = max(worldPerPx * strokePx, 1e-20);
  float edge = 1.0 - smoothstep(0.0, aa, d);
  // Fade the outline out entirely for sub-pixel shapes so it doesn't alias into moiré.
  edge *= smoothstep(OUTLINE_FADE_LO, OUTLINE_FADE_HI, shapePx);

  // Outline = a lighter derivation of the fill (fill is the specified colour), so
  // adjacent shapes read as distinct — the same RULE as the object path's
  // deriveStrokeColor, but deliberately NOT the same constants (that path uses
  // 0.45 / 55-of-255). This outline is anti-aliased and width-capped per shape, so
  // it needs more lift to read at the same strength; the values here were tuned
  // against the rendered result. Don't "unify" them without re-checking on screen.
  vec3 strokeRgb = mix(vFillColor.rgb, vec3(1.0), STROKE_LIGHTEN);
  float strokeA = min(1.0, vFillColor.a + STROKE_ALPHA_LIFT);
  vec4 color = mix(vFillColor, vec4(strokeRgb, strokeA), edge);

  color.a *= flatPolygon.opacity;
  if (color.a == 0.0) {
    discard;
  }
  fragColor = color;

  fragColor = picking_filterHighlightColor(fragColor);
  fragColor = picking_filterPickingColor(fragColor);
}
`;
