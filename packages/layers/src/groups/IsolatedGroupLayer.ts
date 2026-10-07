/**
 * An isolated group: its children draw into an offscreen target, which is then
 * composited onto the canvas at the group's place in the draw order, with the
 * group's opacity and blend mode. See docs/plans/render-stack-hierarchy.md.
 *
 * Mechanism, on WebGL and WebGPU alike:
 * - `GroupIsolationEffect` (registered by the first group, as deck's MaskExtension
 *   registers MaskEffect) renders each group's subtree into the group's framebuffer
 *   in `preRender`, before the main pass. Pass name: `group-isolate:<groupId>`.
 * - `IsolatedGroupLayer.filterSubLayer` keeps the children out of the main pass and
 *   the composite layer out of the group's own pass. Picking still sees the children
 *   directly, so picks are unaffected by isolation.
 * - `GroupCompositeLayer` draws the target, receiving its texture through the effect's
 *   `getShaderModuleProps`.
 *
 * Nested groups work because the effect renders deepest groups first, and a group
 * treats a pass belonging to one of its ancestors like the main pass.
 */

import {
  CompositeLayer,
  type Effect,
  type EffectContext,
  type FilterContext,
  type Layer,
  type LayersList,
  _LayersPass as LayersPass,
  type PreRenderOptions,
} from '@deck.gl/core';
import type { Device, Framebuffer, Texture } from '@luma.gl/core';
import { GroupCompositeLayer } from './GroupCompositeLayer';
import type { GroupBlendMode } from './groupBlend';
import { groupBlendParameters } from './groupBlend';

const ISOLATION_PASS_PREFIX = 'group-isolate:';

function isolationPassName(groupId: string): string {
  return `${ISOLATION_PASS_PREFIX}${groupId}`;
}

function isolationPassGroupId(renderPass: string): string | null {
  return renderPass.startsWith(ISOLATION_PASS_PREFIX)
    ? renderPass.slice(ISOLATION_PASS_PREFIX.length)
    : null;
}

function flattenLayers(list: LayersList, out: Layer[] = []): Layer[] {
  for (const item of list) {
    if (Array.isArray(item)) flattenLayers(item, out);
    else if (item) out.push(item);
  }
  return out;
}

function isDescendantOf(layer: Layer, ancestor: Layer): boolean {
  for (let p = layer.parent; p; p = p.parent) {
    if (p === ancestor) return true;
  }
  return false;
}

export interface IsolatedGroupLayerProps {
  /** The group's children, drawn into its target in this order. */
  layers: LayersList;
  blendMode?: GroupBlendMode;
}

export class IsolatedGroupLayer extends CompositeLayer<IsolatedGroupLayerProps> {
  static layerName = 'IsolatedGroupLayer';
  static defaultProps = {
    layers: { type: 'array', value: [], compare: true },
    blendMode: { type: 'string', value: 'normal' },
  };

  initializeState(): void {
    this.context.deck?._addDefaultEffect(new GroupIsolationEffect());
  }

  renderLayers(): LayersList {
    const { blendMode = 'normal', opacity } = this.props;
    return [
      ...flattenLayers(this.props.layers),
      new GroupCompositeLayer({
        id: `${this.props.id}-composite`,
        groupId: this.props.id,
        blendMode,
        opacity,
        parameters: groupBlendParameters(blendMode),
      }),
    ];
  }

  /** The composite layer draws where the group sits; the children draw only into
   *  the group's target, plus picking. */
  filterSubLayer({ layer, renderPass, isPicking }: FilterContext): boolean {
    const isComposite = layer instanceof GroupCompositeLayer;
    if (isPicking) return !isComposite;
    const passGroupId = isolationPassGroupId(renderPass);
    if (passGroupId === this.props.id) return !isComposite;
    if (passGroupId !== null && !this._hasAncestor(passGroupId)) {
      // A descendant group's pass: the effect has already narrowed the layer list to
      // that group's subtree, which runs through one of our children.
      return true;
    }
    // The main pass, another pass, or an ancestor group's isolation pass.
    return isComposite;
  }

  _hasAncestor(id: string): boolean {
    for (let p = this.parent; p; p = p.parent) {
      if (p.id === id) return true;
    }
    return false;
  }
}

/** Draws only what the main pass would draw (not mask or terrain-only layers). */
class IsolationPass extends LayersPass {
  shouldDrawLayer(layer: Layer): boolean {
    return layer.props.operation.includes('draw');
  }
}

/**
 * Renders every visible `IsolatedGroupLayer`'s subtree into that group's target
 * before the main pass. One instance per Deck, added through `_addDefaultEffect`.
 */
class GroupIsolationEffect implements Effect {
  id = 'spatialdata-group-isolation';
  props = null;
  useInPicking = false;
  order = 0;

  private device: Device | null = null;
  private pass: IsolationPass | null = null;
  private dummyTexture: Texture | null = null;
  private targets = new Map<string, { framebuffer: Framebuffer; color: Texture }>();

  setup({ device }: EffectContext): void {
    this.device = device;
    this.pass = new IsolationPass(device);
    this.dummyTexture = device.createTexture({ width: 1, height: 1 });
  }

  preRender(opts: PreRenderOptions): void {
    const device = this.device;
    const pass = this.pass;
    if (!device || !pass || opts.isPicking) return;

    const groups = opts.layers.filter(
      (layer): layer is IsolatedGroupLayer =>
        layer instanceof IsolatedGroupLayer && layer.props.visible
    );
    const live = new Set(groups.map((group) => group.id));
    for (const [id, target] of this.targets) {
      if (!live.has(id)) {
        destroyTarget(target);
        this.targets.delete(id);
      }
    }
    if (groups.length === 0) return;

    const canvasContext = opts.canvasContext ?? device.canvasContext;
    if (!canvasContext) return;
    const [width, height] = canvasContext.getDrawingBufferSize();

    // LayerManager lists parents before children, so reversing renders the deepest
    // groups first: an inner group's target is ready before its parent samples it.
    for (const group of groups.reverse()) {
      const target = this._getTarget(device, group.id, width, height);
      pass.render({
        ...opts,
        pass: isolationPassName(group.id),
        layers: opts.layers.filter((layer) => isDescendantOf(layer, group)),
        target: target.framebuffer,
        clearCanvas: true,
        clearColor: [0, 0, 0, 0],
      });
    }
  }

  getShaderModuleProps(layer: Layer): Record<string, unknown> | undefined {
    if (!(layer instanceof GroupCompositeLayer)) return undefined;
    const target = this.targets.get(layer.props.groupId);
    return { groupComposite: { groupTarget: target?.color ?? this.dummyTexture } };
  }

  cleanup(): void {
    for (const target of this.targets.values()) destroyTarget(target);
    this.targets.clear();
    this.dummyTexture?.destroy();
    this.dummyTexture = null;
    this.pass = null;
    this.device = null;
  }

  _getTarget(device: Device, groupId: string, width: number, height: number) {
    const existing = this.targets.get(groupId);
    if (existing && existing.color.width === width && existing.color.height === height) {
      return existing;
    }
    if (existing) destroyTarget(existing);
    // Colour is created here rather than by format string: luma's auto-created
    // attachments are render-only, and this one must also be sampled. The
    // framebuffer does not own it, so destroyTarget frees it separately.
    const color = device.createTexture({ id: `${groupId}-isolation-color`, width, height });
    const framebuffer = device.createFramebuffer({
      id: `${groupId}-isolation`,
      width,
      height,
      colorAttachments: [color],
      depthStencilAttachment: 'depth24plus',
    });
    const target = { framebuffer, color };
    this.targets.set(groupId, target);
    return target;
  }
}

function destroyTarget(target: { framebuffer: Framebuffer; color: Texture }): void {
  target.framebuffer.destroy();
  target.color.destroy();
}
