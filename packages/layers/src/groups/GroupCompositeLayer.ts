/**
 * Draws an isolated group's offscreen target back onto the canvas, at the group's
 * place in the draw order, with the group's opacity and blend mode.
 *
 * A full-screen triangle that reads the target texel under each fragment. The target
 * is the size of the drawing buffer, so a fragment's own pixel coordinate is the
 * texel to read; both backends agree on that without any y-flip. Opacity is deck's
 * own `layer.opacity`, gamma-adjusted as for every other layer, so a group at 0.5
 * matches a lone layer at 0.5. The texture arrives
 * through `GroupIsolationEffect.getShaderModuleProps`, the way deck's mask effect
 * hands its mask map to masked layers.
 */

import { Layer, type LayerContext, picking, project32 } from '@deck.gl/core';
import { Model } from '@luma.gl/engine';
import type { GroupBlendMode } from './groupBlend';

const uniformBlock = `\
uniform groupCompositeUniforms {
  float backdropWhite;
} groupComposite;
`;

const uniformBlockWGSL = /* wgsl */ `\
struct GroupCompositeUniforms {
  backdropWhite: f32,
};

@group(0) @binding(auto) var<uniform> groupComposite: GroupCompositeUniforms;
@group(0) @binding(auto) var groupTarget: texture_2d<f32>;
`;

export const groupCompositeModule = {
  name: 'groupComposite',
  vs: uniformBlock,
  fs: uniformBlock,
  source: uniformBlockWGSL,
  uniformTypes: {
    backdropWhite: 'f32',
  },
} as const;

const vs = `#version 300 es
#define SHADER_NAME group-composite-vertex-shader
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const fs = `#version 300 es
#define SHADER_NAME group-composite-fragment-shader
precision highp float;
uniform sampler2D groupTarget;
out vec4 fragColor;
void main() {
  vec4 color = texelFetch(groupTarget, ivec2(gl_FragCoord.xy), 0) * layer.opacity;
  color.rgb += vec3(groupComposite.backdropWhite * (1.0 - color.a));
  fragColor = color;
}
`;

const source = /* wgsl */ `\
struct Varyings {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> Varyings {
  let p = vec2<f32>(f32((vid << 1u) & 2u), f32(vid & 2u));
  var output: Varyings;
  output.position = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  return output;
}

@fragment
fn fragmentMain(input: Varyings) -> @location(0) vec4<f32> {
  var color = textureLoad(groupTarget, vec2<i32>(input.position.xy), 0) * layer.opacity;
  color = vec4<f32>(color.rgb + vec3<f32>(groupComposite.backdropWhite * (1.0 - color.a)), color.a);
  return color;
}
`;

export interface GroupCompositeLayerProps {
  /** Id of the `IsolatedGroupLayer` whose target this layer draws. */
  groupId: string;
  blendMode: GroupBlendMode;
}

export class GroupCompositeLayer extends Layer<GroupCompositeLayerProps> {
  static layerName = 'GroupCompositeLayer';
  static defaultProps = {
    groupId: { type: 'string', value: '' },
    blendMode: { type: 'string', value: 'normal' },
  };

  declare state: { model?: Model };

  getShaders() {
    // project32 and picking are unused, but deck sets their props on every layer;
    // declaring them keeps luma from warning about unknown modules.
    return super.getShaders({
      vs,
      fs,
      source,
      modules: [project32, picking, groupCompositeModule],
    });
  }

  initializeState(): void {
    this.state.model = new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      topology: 'triangle-list',
      bufferLayout: [],
      isInstanced: false,
      vertexCount: 3,
      shaderAssembler: this.context.shaderAssembler,
    });
  }

  finalizeState(context: LayerContext): void {
    this.state.model?.destroy();
    super.finalizeState(context);
  }

  draw(): void {
    const { model } = this.state;
    if (!model) return;
    model.shaderInputs.setProps({
      groupComposite: { backdropWhite: this.props.blendMode === 'min' ? 1 : 0 },
    });
    model.draw(this.context.renderPass);
  }
}
