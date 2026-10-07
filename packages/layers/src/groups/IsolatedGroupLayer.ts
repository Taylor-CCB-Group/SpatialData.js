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
 *
 * Caching: a target is the size of one viewport, and is keyed by that viewport's
 * projection (`Viewport.equals`: size and matrices, not position). Views that show the
 * same thing — a grid of cells sharing one view state — share one target, drawn once
 * and composited into each. A target is redrawn only when its projection changes or
 * something inside the group asked deck for a redraw.
 *
 * Picking: deck reports the outermost layer as `info.layer`, so a pick inside a group
 * names the group. The innermost group records the child the pick came through, and
 * `getIsolatedGroupMember` reads it back.
 */

import {
  CompositeLayer,
  type Effect,
  type EffectContext,
  type FilterContext,
  type GetPickingInfoParams,
  Layer,
  type LayersList,
  _LayersPass as LayersPass,
  type PickingInfo,
  type PreRenderOptions,
  type UpdateParameters,
  type Viewport,
} from '@deck.gl/core';
import type { Device, Framebuffer, Texture } from '@luma.gl/core';
import { GroupCompositeLayer } from './GroupCompositeLayer';
import type { GroupBlendMode } from './groupBlend';
import { groupBlendParameters } from './groupBlend';

const ISOLATION_PASS_PREFIX = 'group-isolate:';
const GROUP_MEMBER_KEY = 'isolatedGroupMember';

/**
 * The layer a pick resolves to when groups are looked through: the direct child of
 * the innermost isolated group the pick passed through. Null when the pick did not
 * pass through a group, in which case `info.layer` is already that layer.
 */
export function getIsolatedGroupMember(info: object): Layer | null {
  const member: unknown = Reflect.get(info, GROUP_MEMBER_KEY);
  return member instanceof Layer ? member : null;
}

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

/** Why a group's target was drawn this frame. */
export type IsolationRenderReason = 'new' | 'contents' | 'view';

export interface IsolationRenderEvent {
  groupId: string;
  /** The viewport the target was drawn for; others with the same projection share it. */
  viewportId: string;
  reason: IsolationRenderReason;
  /** Target size in device pixels. */
  width: number;
  height: number;
}

export interface IsolatedGroupLayerProps {
  /** The group's children, drawn into its target in this order. */
  layers: LayersList;
  blendMode?: GroupBlendMode;
  /** Diagnostic: called each time a target is drawn, so cache hits are observable. */
  onTargetRender?: ((event: IsolationRenderEvent) => void) | null;
}

/** Whether any layer under `layer`, other than `skip`, has asked deck for a redraw.
 *  Reads the flags without clearing them. */
function subtreeNeedsRedraw(layer: Layer, skip: Layer | null): boolean {
  if (!(layer instanceof CompositeLayer)) return false;
  for (const sub of layer.getSubLayers()) {
    if (sub === skip) continue;
    if (sub.getNeedsRedraw({ clearRedrawFlags: false })) return true;
    if (subtreeNeedsRedraw(sub, skip)) return true;
  }
  return false;
}

export class IsolatedGroupLayer extends CompositeLayer<IsolatedGroupLayerProps> {
  static layerName = 'IsolatedGroupLayer';
  static defaultProps = {
    layers: { type: 'array', value: [], compare: true },
    blendMode: { type: 'string', value: 'normal' },
    onTargetRender: { type: 'function', value: null, optional: true },
  };

  /** `contentsChanged` latches until the effect next draws this group's targets. */
  declare state: { contentsChanged: boolean };

  initializeState(): void {
    this.setState({ contentsChanged: true });
    this.context.deck?._addDefaultEffect(new GroupIsolationEffect());
  }

  updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    // A removed member asks for no redraw of its own, so membership changes count here.
    const ids = (list: LayersList) => flattenLayers(list).map((layer) => layer.id);
    if (
      ids(params.props.layers).join('\u0000') !== ids(params.oldProps.layers ?? []).join('\u0000')
    ) {
      this.setState({ contentsChanged: true });
    }
  }

  /**
   * deck asks every layer, parents before children, whether it needs a redraw, and
   * clears each layer's flag as it goes. Asking here, before the members are asked,
   * is the one point where their flags can be read. Anything deck would redraw for —
   * changed props, a tile arriving, a highlight, a transition — then also redraws
   * the group's targets.
   */
  getNeedsRedraw(opts?: { clearRedrawFlags: boolean }): string | false {
    const redraw = super.getNeedsRedraw(opts);
    const ownComposite = this.getSubLayers().find((layer) => layer instanceof GroupCompositeLayer);
    if (this.state && subtreeNeedsRedraw(this, ownComposite ?? null)) {
      this.state.contentsChanged = true;
    }
    return redraw;
  }

  /** Read and clear the contents-changed latch. */
  _takeContentsChanged(): boolean {
    const changed = this.state?.contentsChanged ?? true;
    if (this.state) this.state.contentsChanged = false;
    return changed;
  }

  /** Mark contents changed from outside: a nested group's target was redrawn. */
  _markContentsChanged(): void {
    if (this.state) this.state.contentsChanged = true;
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

  /**
   * deck walks a pick up the layer tree, setting `info.layer` to each ancestor in turn
   * and passing the layer below as `sourceLayer`. The innermost group sees the member
   * the pick came through; outer groups see a group, and leave the record alone.
   */
  getPickingInfo({ info, sourceLayer }: GetPickingInfoParams): PickingInfo {
    if (!sourceLayer || sourceLayer instanceof IsolatedGroupLayer) return info;
    return Object.assign(info, { [GROUP_MEMBER_KEY]: sourceLayer });
  }

  /**
   * deck hands hover highlighting to the root layer, and a composite forwards it only
   * when its own `autoHighlight` is on, and then to every sublayer. A group needs
   * neither: it passes the pick to the member it came through, which applies its own
   * `autoHighlight`. Forwarding to every member would light up the same object index
   * in sibling layers. Nested groups need nothing extra, because the member is
   * already the innermost one.
   */
  updateAutoHighlight(info: PickingInfo): void {
    getIsolatedGroupMember(info)?.updateAutoHighlight(info);
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

type IsolationTarget = {
  /** The viewport last drawn into this target; others equal to it share the target. */
  viewport: Viewport;
  framebuffer: Framebuffer;
  color: Texture;
};

/** The same viewport moved to the canvas origin, so it fills a target of its own size.
 *  Everything but the position is read through to the original. */
function atOrigin(viewport: Viewport): Viewport {
  if (viewport.x === 0 && viewport.y === 0) return viewport;
  const moved: Viewport = Object.create(viewport);
  moved.x = 0;
  moved.y = 0;
  return moved;
}

/**
 * Draws each visible `IsolatedGroupLayer`'s members into viewport-sized targets before
 * the main pass. One instance per Deck, added through `_addDefaultEffect`.
 */
class GroupIsolationEffect implements Effect {
  id = 'spatialdata-group-isolation';
  props = null;
  useInPicking = false;
  order = 0;

  private device: Device | null = null;
  private pass: IsolationPass | null = null;
  private dummyTexture: Texture | null = null;
  /** Per group: one target per distinct projection seen in the last frame. */
  private targets = new Map<string, IsolationTarget[]>();

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
    for (const [id, targets] of this.targets) {
      if (!live.has(id)) {
        for (const target of targets) destroyTarget(target);
        this.targets.delete(id);
      }
    }
    const canvasContext = opts.canvasContext ?? device.canvasContext;
    if (groups.length === 0 || !canvasContext) return;
    const pixelRatio = canvasContext.cssToDeviceRatio();

    // LayerManager lists parents before children, so reversing draws the deepest
    // groups first: an inner group's target is ready before its parent samples it.
    for (const group of groups.reverse()) {
      const contentsChanged = group._takeContentsChanged();
      const previous = this.targets.get(group.id) ?? [];
      const kept: IsolationTarget[] = [];
      let drewAny = false;

      for (const viewport of this._viewportsShowing(group, opts)) {
        if (kept.some((target) => target.viewport.equals(viewport))) continue;
        const width = Math.max(1, Math.round(viewport.width * pixelRatio));
        const height = Math.max(1, Math.round(viewport.height * pixelRatio));
        const sized = (target: IsolationTarget) =>
          target.color.width === width && target.color.height === height;
        // Prefer a target already showing this projection; failing that, redraw one of
        // the right size (a pan), so panning does not reallocate every frame.
        const same = previous.find(
          (t) => !kept.includes(t) && sized(t) && t.viewport.equals(viewport)
        );
        const reusable = same ?? previous.find((t) => !kept.includes(t) && sized(t));
        const target = reusable ?? this._createTarget(device, group.id, viewport, width, height);
        const reason: IsolationRenderReason | null = !reusable
          ? 'new'
          : !same
            ? 'view'
            : contentsChanged
              ? 'contents'
              : null;
        if (reason) {
          pass.render({
            ...opts,
            pass: isolationPassName(group.id),
            layers: opts.layers.filter((layer) => isDescendantOf(layer, group)),
            viewports: [atOrigin(viewport)],
            target: target.framebuffer,
            clearCanvas: true,
            clearColor: [0, 0, 0, 0],
          });
          group.props.onTargetRender?.({
            groupId: group.id,
            viewportId: viewport.id,
            reason,
            width,
            height,
          });
          drewAny = true;
        }
        target.viewport = viewport;
        kept.push(target);
      }

      for (const target of previous) {
        if (!kept.includes(target)) destroyTarget(target);
      }
      this.targets.set(group.id, kept);
      // An enclosing group samples this target, so its own contents just changed.
      if (drewAny) {
        for (let p = group.parent; p; p = p.parent) {
          if (p instanceof IsolatedGroupLayer) p._markContentsChanged();
        }
      }
    }
  }

  /** Viewports the group draws in: those the deck's `layerFilter` admits its root to. */
  _viewportsShowing(group: IsolatedGroupLayer, opts: PreRenderOptions): Viewport[] {
    const { layerFilter } = opts;
    if (!layerFilter) return opts.viewports;
    const root = group.root;
    return opts.viewports.filter((viewport) =>
      layerFilter({ layer: root, viewport, isPicking: false, renderPass: 'screen' })
    );
  }

  /** deck activates each viewport before resolving a layer's module props, so the
   *  composite's context names the viewport it is about to draw in. */
  getShaderModuleProps(layer: Layer): Record<string, unknown> | undefined {
    if (!(layer instanceof GroupCompositeLayer)) return undefined;
    const viewport = layer.context.viewport;
    const target = this.targets
      .get(layer.props.groupId)
      ?.find((candidate) => candidate.viewport.equals(viewport));
    return { groupComposite: { groupTarget: target?.color ?? this.dummyTexture } };
  }

  cleanup(): void {
    for (const targets of this.targets.values()) {
      for (const target of targets) destroyTarget(target);
    }
    this.targets.clear();
    this.dummyTexture?.destroy();
    this.dummyTexture = null;
    this.pass = null;
    this.device = null;
  }

  _createTarget(
    device: Device,
    groupId: string,
    viewport: Viewport,
    width: number,
    height: number
  ): IsolationTarget {
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
    return { viewport, framebuffer, color };
  }
}

function destroyTarget(target: { framebuffer: Framebuffer; color: Texture }): void {
  target.framebuffer.destroy();
  target.color.destroy();
}
