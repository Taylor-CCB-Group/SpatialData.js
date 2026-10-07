# Render Stack hierarchy: groups, blend modes and derived entries

**Status:** draft. Phase 1 is being worked on, and the semantics below are proposals
to settle before the schema changes.
**Related:** [ADR 0001](../adr/0001-render-stack-owned-by-layers.md),
[ADR 0003 § FBO-based render caching](../adr/0003-points-render-resource.md),
[ADR 0004 § Out of scope](../adr/0004-resource-resolver-owned-by-core.md),
[CONTEXT.md](../../CONTEXT.md)

The Render Stack is to become a tree. **Group Entries** draw their children and
combine them with a blend mode. **Derived Entries** consume inputs of any element kind
and draw what an operator computes from them. Typical cases:
- A co-location (Gram) map over transcript densities, drawn over the image.
- Per-gene transcript density next to the same genes' expression. The expression
  comes from cell centroids splatted with their `X` values, or from cell shapes
  filled with them. The operator shows where the two disagree.
- Raw image channels combined with any of the above.

## Phases

1. **Settle the model.** Write this plan, then an ADR. Make the schema v2 tree with
   a v1 migration, and have the adapters walk the tree with today's behaviour.
   Deprecate `SpatialLayer`.
2. **Groups with no offscreen pass.**
   - Visibility, and opacity inherited by children.
   - Per-entry `blendMode` through deck `parameters` on WebGL and WebGPU.
   - Groups in the layer list UI.
3. **Isolated groups.** Children render to a screen-aligned target, which is
   composited with any blend mode, including ones fixed-function blending cannot do.
   This is also the substrate ADR 0003's FBO caching asks for. Works on both
   backends; see [Render-to-target spike](#render-to-target-spike).
4. **Derived Entries.**
   - Operator registry and a world-space input grid.
   - Rasteriser variants for each element kind.
   - Per-instance weights, and channel maps over features or `X` columns.
   - Channel stacks keyed by name.

Phases 3 and 4 share one primitive: render a set of layers into an offscreen target
on a defined grid.

## Backend support

The Render Stack schema does not depend on the backend: one saved stack loads on
both WebGL and WebGPU. What differs is what draws. Derived entries are planned for
WebGPU only:

| Feature | WebGPU | WebGL |
|---|---|---|
| Nested groups, inherited visibility and opacity (pass-through) | yes | yes |
| Fixed-function `blendMode` on deck layers we own (shapes, points, labels) | yes | yes |
| Fixed-function `blendMode` on image entries | yes: our `RasterTileLayer` | only if Viv honours `parameters`; unchecked |
| Opacity and blend mode per image channel | to add in our WGSL composite | a local Viv extension, then upstream |
| Isolated groups, and modes that need a composite shader | yes | yes |
| Derived Entries | yes | not planned |
| Reduced-resolution targets | yes | yes |

- **Per-channel blending sits below the stack.** An image entry's channels already
  composite inside one shader. Today both our WGSL and Viv add channel colours
  together and clamp the sum, with one opacity per layer.
  - Per-channel opacity and blend mode, such as alpha-over or max as alternatives to
    adding, work inside that shader on either backend. They need no offscreen pass.
  - On WebGL, a local Viv extension in place of `ColorPaletteExtension` can do it
    now. It goes through the existing `vivImageExtensions` passthrough. Offer it
    upstream as well; see [WebGPU and Viv](webgpu-viv-upstream.md).
  - Both backends should share one channel model, so it is the same feature on
    each.
- **Why derived entries are not planned for WebGL:**
  - they need compute;
  - they need additive blending into float targets, which WebGL2 only has through
    `EXT_color_buffer_float` plus `EXT_float_blend`, and not everywhere;
  - they need raw channel output, which Viv does not provide;
  - the expected operators are WGSL, in intraspatial.
- **Unsupported features degrade; the stack never fails to parse.** On WebGL:
  - an unsupported blend mode draws as `normal`;
  - a derived entry is not drawn.

  Each case raises a notice naming the backend requirement. Which channel those
  notices use is for the ADR to settle.

## Where things stand

- `renderStackSchema` (`core/src/renderStack.ts`) is flat and at `schemaVersion: 1`.
  A `group` entry holds `children: string[]`, which are ids of other top-level
  entries, and opaque `props`.
- The only consumer of groups is `renderStackOrder`
  (`vis/src/SpatialCanvas/renderStackAdapters.ts`). It splices the children's ids in
  at the group's position.
  - An entry that is both top-level and a group child appears in the order twice.
    `sortLayersByRenderStackOrder` keeps the later index, so the group's position
    wins silently.
  - The example in `docs/docs/layers/overview.mdx` does exactly this.
- `SpatialLayerProps.sublayers` (core) with the `SpatialLayer` composite (layers) is
  a second hierarchy. It renders only shapes, and only its own tests use it.
- The full-UI `SpatialCanvas` store holds `layers` plus a flat `layerOrder`, not a
  `RenderStack`. Only the headless viewer takes a `RenderStack`.

## Group Entry

A group draws its children, in order, and combines the result with what is beneath
it.

- `children` are nested entries, not ids. Inheritance, isolation and nesting all need
  a tree, and with nesting an entry can't be both top-level and a child. Ids stay
  unique across the whole tree.
- `visible: false` hides the whole subtree.
- `blendMode` defaults to `'pass-through'`. Each child then blends with the backdrop
  by its own mode, as if the group were not there.
- `isolate` (default `false`) draws the children into a transparent target first.
  That target is composited onto the backdrop with the group's `opacity` and
  `blendMode`.
  - Any `blendMode` other than `'pass-through'` implies isolation.
- `opacity` on a pass-through group multiplies into each child's opacity. That is
  exact only where children don't overlap; the alternative is setting `isolate`.
  Phase 2 ships this approximation. Phase 3 makes isolation real.
- The isolation target is **screen-aligned**, covering the viewport. Its resolution
  is renderer policy, not saved config. It defaults to device pixels, and may drop
  while the view is moving or tiles are in flight, then settle back to full. Nothing
  in phase 3 needs to build that policy; the composite step just must not assume
  the target matches the canvas size.

Blend modes on any entry: `normal | additive | multiply | screen | max | min`, plus
`pass-through` on groups. These six all map to fixed-function blend state.
- `overlay`, OKLab mixing and similar need an isolated composite shader. They are
  added in phase 3.
- The exact blend factors depend on whether deck's colour output is premultiplied.
  They are chosen and checked per backend in phase 2.

## Derived Entry

A derived entry draws what an operator computes from its inputs. Its inputs are
consumed, not drawn.

```ts
{
  kind: 'derived',
  id: 'transcripts-vs-expression',
  operator: { id: 'intraspatial:difference', params: { normalise: 'per-channel' } },
  inputs: [
    {
      name: 'transcripts',
      source: { elementType: 'points', elementKey: 'transcripts' },
      raster: { method: 'kde', bandwidth: 20 },
      channels: {
        by: 'feature',
        map: {
          epithelial: ['EPCAM', 'KRT8', { KRT18: 0.5 }],
          PTPRC: 'PTPRC',
        },
      },
    },
    {
      name: 'expression',
      source: { elementType: 'shapes', elementKey: 'cell_boundaries' },
      raster: { method: 'centroid-kde', bandwidth: 20 },
      channels: {
        by: 'var',
        table: 'table',
        map: {
          epithelial: ['EPCAM', 'KRT8', { KRT18: 0.5 }],
          PTPRC: 'PTPRC',
        },
      },
    },
  ],
  props: { blendMode: 'normal', opacity: 0.8 },
}
```

Field names are illustrative. The structure is the proposal.

- **Inputs are owned.** Each input carries its own source and props, and makes its
  own loader and layer instances. Changing the gene filter on a displayed points
  entry does not touch a computation over the same element.
  - Two consumers of one element fetch twice until core has a shared tile cache.
  - Inputs referring to another entry by id are an open question, below.
- **An input turns an element into fields, in three parts.**
  - **`raster`: how instances become a field.** Points use `kde`. Shapes use
    `centroid-kde` or `fill` (polygon coverage). Labels use `fill`. Images use
    `sample`, which reads raw intensities before colour mapping. Each method has its
    own parameters, such as kernel and bandwidth.
  - **`weight`: an optional scalar per instance.** It comes from a point attribute
    column, or through the element's table association from an `obs` column. It
    multiplies every channel. Without it, each instance counts 1.
  - **`channels`: a map from channel key to members.**
    - A member is a Points Feature (`by: 'feature'`), a `var` name resolved through
      the table association (`by: 'var'`), or an image channel.
    - **Weights are optional.** A channel's value is one of:
      - a name;
      - an array of names and `{ name: weight }` objects;
      - one `{ name: weight, … }` object.

      A bare name has weight 1.
    - The schema normalises all of these to `Record<key, Record<member, weight>>`,
      so consumers see one shape.
    - A member listed twice in one channel is a parse error, not a sum.
    - A channel's value for an instance is the weighted sum over its members.
      - For a point, that is the membership weight of the point's own feature.
      - For a `var` channel, it is `Σ w_g · X[i, g]`, which is a gene-set score per
        cell.
    - Members may appear in several channels, because gene programs overlap.
    - Channels are aligned by key, so object order matters only for packing them into
      targets.
      - JS orders integer-like keys first. A map keyed by cluster ids (`'0'`, `'1'`)
        packs in numeric order. That is harmless, but don't rely on authoring order.
    - Maps are saved by name, as points selections already are. They are resolved
      to feature codes or `var` indices at runtime.
    - For points, the splat reads a feature-code × channel weight lookup table,
      using the same LUT pattern as colour-by-feature. The number of channels per
      pass is bounded by render targets or texture-array layers; beyond that it takes
      more passes.
- **Operators align inputs by channel key, not by position.** That is what pairs
  the "epithelial" transcript density with the "epithelial" expression score, when
  both inputs use the same map.
  - Each channel also says what its values mean: count density, weighted density, or
    intensity. An operator comparing modalities needs that to normalise.
  - intraspatial checks channel-axis agreement when its ops combine fields
    (`docs/stream-a-placement-plan.md` there). Our channel key should map onto that
    check rather than invent a second one.
- **Rasterisers are render variants of the existing layers.** Splat variants of
  `PointsLayer` and of the shapes layer, and a raw-channel mode on the WebGPU
  `RasterTileLayer`. Derived entries are WebGPU only; see
  [Backend support](#backend-support).
- **The input grid is world space.** It is the current window plus a margin the
  operator declares (its kernel radius), at a resolution the operator chooses. This
  differs from a group's screen-aligned target: kernels are sized in world units, and
  a field must not change meaning as you zoom.
  - A coarser grid while inputs are still loading is the same renderer policy as for
    groups. It is sound while the cell size stays below the kernel bandwidth.
- **The operator** is serialised as `id` and JSON `params`. It is resolved at
  runtime from a registry supplied beside the stack, as `hostLayerResolver` is today:
  a **Runtime Attachment**, not saved config.
  - An unknown operator behaves like an unknown host layer: it raises a notice and
    nothing is drawn.
  - intraspatial's op-graph is the expected first implementer. sd.js renders the
    inputs to placed textures, and the operator returns layers or a placed texture.
- **Output** is a normal stack participant. It can sit in a group and has its own
  `opacity` and `blendMode`.

## Why two kinds, not one

An isolated group is close to a derived entry whose operator is "composite with blend
mode X". Unifying them is plausible. The proposal keeps two kinds that share one
runtime primitive, because they differ on every axis the schema exposes:

| | Group | Derived |
|---|---|---|
| Members | children, drawn | inputs, consumed |
| Member values | display RGBA | raw values: density, intensity |
| Target | screen-aligned, only when isolated | world space plus a margin, always |
| Combine step | closed set of blend modes | open operator registry |
| Member order | compositing order | named argument slots |

Merging them would make every one of these a mode switch on a single kind. A derived
entry can be a group child. Whether a group can be a derived input is an open
question.

## Schema v2

- `renderStackEntrySchema` becomes recursive (`z.lazy`): `group.children` is
  `RenderStackEntry[]`.
- Group `props` gain typed `opacity`, `blendMode` and `isolate`. Spatial and host
  entries gain an optional `blendMode`.
- Id uniqueness is checked across the tree.
- **Migration:** `renderStackSchema` accepts v1 and upgrades it during preprocessing.
  - Each v1 group takes the top-level entries its `children` ids name.
  - The group keeps its own position, which matches today's effective order.
  - Ids that name nothing are dropped, with a notice.
  - MDV passes stacks through this parser, so a saved v1 stack keeps loading.
- `derived` is **not** added in v2. Adding a union member is additive and needs no
  version bump, so it lands in phase 4 with the behaviour behind it. CONTEXT.md
  warns against reserving kinds before the behaviour exists; that is why `group` sat
  inert.

## Render-to-target spike

Isolated groups work on deck 9.4, on both WebGL and WebGPU, without forking deck.
The prototype is `packages/layers/src/groups/`, and its file comment describes the
mechanism. In short:
- An effect renders each group's subtree into the group's own framebuffer before the
  main pass. This is the pattern deck's mask effect uses.
- The group's `filterSubLayer` keeps its children out of the main pass.
- A full-screen composite layer draws the target at the group's place in the order.

The demo is `/groups` in the vis demo, with `?device=webgl` to switch backends.

**What was verified**, by pixel readback on both backends:
- Group opacity removes the overlap bleed that per-child opacity shows. A green
  circle over a red one inside a group at 50% reads as green only.
- All six blend modes match their predicted values exactly, and agree between
  backends.
- Pixels the group leaves empty keep the backdrop in every mode.
- A nested group gives the same picture in `normal` mode, to within 8-bit rounding.
- With a picture-in-picture inset (`?views=2`), each view's group copy composites
  correctly in its own view, with the same values as the main view.
- Picking still reaches children inside a group.
- No console errors or warnings.

**Behaviour to keep:**
- Group opacity uses deck's `layer.opacity`, which deck gamma-adjusts (`opacity^(1/2.2)`).
  A group at 0.5 therefore matches a lone layer at 0.5.
- The target holds premultiplied colour on both backends, so each blend mode is its
  premultiplied form.
- `min` composites the target over white first; otherwise empty pixels would darken
  the backdrop.
- A blend mode inside an isolated group blends against the group's own empty
  backdrop, not against the canvas. For example, `multiply` inside a nested isolated
  group comes out dark. That is what isolation means, and it is why pass-through is
  the default.

**Integration work it surfaced:**
- **Picking reports the outermost group.** `info.layer` becomes the outermost group,
  and `info.sourceLayer` is that group's direct child, not the leaf. The viewer
  routes hover and tooltips by `info.layer.id` (`featureTooltipHover.ts`,
  `SpatialCanvasViewer.tsx`). It needs to resolve the entry-level layer instead.
- **Groups must be built where `VivSpatialViewer` composes layers.** Viv assigns
  layers to views through deck's `layerFilter`, by matching the view id against each
  top-level layer's id. deck's `View` has no layer list of its own, so this filter is
  the only per-view routing hook.
  - `VivSpatialViewer` already adds the view's token to every top-level layer id
    (`withVivId`). A group assembled at that step gets the token like any other
    layer, and its children are never checked against it.
  - The group must therefore be built after Viv has produced the image layers, not
    upstream of the viewer.
  - With several views, such as a picture-in-picture overview, each view needs its own
    group instance and therefore its own target.
- **Private deck API.** The effect is registered through `deck._addDefaultEffect` and
  renders with `_LayersPass`. Both are underscore APIs, the same ones deck's
  `MaskExtension` uses.
- **No caching yet.** The subtree redraws into its target every frame, which costs
  one extra full-screen pass over drawing the children directly. Caching when
  nothing changed is ADR 0003's FBO caching, and it belongs here.
- **deck 9.4 bugs with several views on WebGPU.** These happen with no groups at
  all (`?group=0`).
  - A view with `clear: true` never draws. deck begins the clear pass while the
    main pass is still open. Viv's `OverviewView` sets `clear: true`, so Viv's
    picture-in-picture is broken on WebGPU.
  - A view smaller than the canvas is drawn upside down: its viewport y is
    computed for WebGL's bottom-left origin. This is the same family as the picking
    y-flip that `applyWebGPUPickingFix` works around.
- **Not yet tried:**
  - Viv image layers and tiled layers (`PointsLayer`, labels) as children;
  - a device pixel ratio above 1.

## Phase 1 deliverables

1. Agree the semantics above. Write ADR 0006, and update CONTEXT.md: revise Group
   Entry, and add Derived Entry, Blend Mode and Isolation.
2. Schema v2 with the v1 migration, and tests for the migration and for tree-wide id
   uniqueness.
3. `renderStackOrder`, `renderStackToLayerInputs` and `resolveRenderStackHostLayers`
   walk the tree. Visibility inherits. No rendering change beyond that.
4. Deprecate `SpatialLayer`, `spatialLayerPropsSchema` and `migrateSpatialLayerProps`
   with a changeset, and fix the layers and avivatorish READMEs. Remove them in a
   later minor.

## Open questions

- **Derived inputs by reference.** Should `{ ref: entryId }` reuse a displayed
  entry's source and props? That is convenient, but it brings back the coupling that
  owned inputs avoid.
- **A group as a derived input.** This would mean "compute over what is displayed",
  with the input form `rgba`. There is no case for it yet.
- **The `SpatialCanvas` store.** Groups in the full UI need a tree in the store.
  Should the store hold a `RenderStack` outright? ADR 0001 rejects parallel
  `layerOrder` state. This is a phase 2 decision.
- **Viv on WebGL.** Do Viv's image layers honour a `parameters` blend override?
  Unchecked. If they don't, image blend modes are WebGPU-only in phase 2. Check this
  alongside the phase 1 spike.
- **Host overlays.** Applying `blendMode` means cloning the host's layer with
  `parameters`, which may override parameters the host set itself.
- **Shared channel maps.** The example repeats one map in two inputs. Should a
  derived entry define its maps once and have inputs refer to them by name? That
  guarantees the keys agree. Maps might also be worth saving outside any one
  entry, as named gene sets.
- **`X`-backed channels.** `var` channels need matrix-backed values
  to resolve through table associations.
  - That is still open in [feature table associations](../docs/vis/feature-table-associations.mdx),
    checklist item 3.
  - Core can already read `X` slices (`VAnnDataSource.loadNumericForDims`,
    `loadVarIndex`). The gap is wiring them through the alignment.
- **Units across modalities.** Is the value-kind tag on a channel enough for an
  operator to normalise transcript counts against normalised expression? Or does an
  input need explicit scaling?
- **Naming.** Derived Entry, Compute Entry or Operator Entry.
