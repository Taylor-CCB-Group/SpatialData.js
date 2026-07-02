# SpatialData.js transform conformance dingus

A "dingus" CLI implementing the contract from
[clbarnes/ome_zarr_transformations_conformance](https://github.com/clbarnes/ome_zarr_transformations_conformance),
used to validate SpatialData.js's coordinate-transform computation against the
RFC-5 OME-Zarr transformations test cases.

## Motivation

The primary goal is to **mature the SpatialData.js transform implementation**:
the conformance suite gives an objective, RFC-5-aligned target, and the baseline
below is effectively the backlog of transform features still to implement. (A
secondary, incidental use was ruling our transform *math* in/out while chasing a
viv image-render bug — but that bug most likely lives in viv, not here.)

This is a dev script (not shipped in any package) — run it manually when
touching `packages/core/src/transformations/`.

## What it wraps

`dingus.ts` imports `parseTransformEntry` from
`packages/core/src/transformations/transformations.ts` and uses the resulting
`BaseTransformation.toMatrix()`/`.inverse()` (`@math.gl/core` `Matrix4`). That is
the actual SpatialData.js transform computation. The dingus adds only glue:

- reads `attributes.ome.scene` (coordinate systems + transformation edges) from
  the case `zarr.json`;
- builds a graph and BFS-finds a path SOURCE -> TARGET;
- composes per-edge matrices, applying coordinates in name-based `x/y/z` space;
- for **reverse** edges, calls `BaseTransformation.inverse()` (native to core);
- prints `{"coordinates": [...]}` (exit 0), or `{"message": "..."}` (exit 1) for
  any unsupported feature or failure, per the contract.

## RFC-5 support assessment (why many cases report `error`)

SpatialData.js's `parseTransformEntry` implements **identity, scale, translation,
affine, rotation, mapAxis, sequence** (with `input`/`output` coordinate-system
refs and axis-name -> XYZ mapping), plus a native `BaseTransformation.inverse()`.
It does **not** implement: `byDimension`, `bijection`, `displacements`, or
affine/rotation **by path** (parameters stored in an external zarr array). It
also has no standalone `$.ome.scene` graph reader (its model is element ->
coordinate-system via `element.getTransformation()` on multiscale
`coordinateTransformations`).

The dingus therefore reports those as unsupported (`error`) rather than guessing,
which is the honest signal of current library coverage. Non-spatial axes (e.g.
`i`, `v`) are also reported unsupported because the matrix path is XYZ-only.

## Run

Prerequisites: `pnpm install` at the SpatialData.js root (provides
`@math.gl/core`) and Node >= 22 (type stripping).

### Self-contained (recommended)

The conformance runner (`oztc`) and its RFC-5 cases are a **pinned uv git
dependency** declared in `pyproject.toml` here, so SpatialData.js can run
conformance with no external checkout:

```bash
cd dev_scripts/conformance-dingus
./run-conformance.sh            # uv sync + run all cases against the dingus
./run-conformance.sh -v -p affine   # extra args forwarded to oztc
```

`run-conformance.sh` resolves the cases bundled into the installed package
(site-packages/cases) and points `oztc` at them. Bump the rev in `pyproject.toml`
to track a newer suite.

### Against an external checkout

If you have the suite checked out (e.g. as a sibling submodule), invoke its
runner directly:

```bash
./transformation_conformance.py ./cases -- \
  /abs/path/to/SpatialData.js/dev_scripts/conformance-dingus/dingus.sh
```

### Single case (debugging)

```bash
node --experimental-strip-types dingus.ts \
  /path/to/cases/affine.ome.zarr input output '[[-1,-1,-1],[0,0,0]]'
```

## Baseline

`baseline-results.tsv` records the latest run (conformance suite pinned at
commit `6f93379`): **24 pass, 17 error, 0 fail**.

The key positive result is **0 `fail`**: every transform SpatialData.js actually
implements produced numerically correct coordinates, including inverse affine,
rotation, mapAxis, composed sequences, and multi-edge paths. All 17 `error` rows
are unsupported features (see assessment above), not wrong answers.

## Maturation backlog (driving the implementation)

Turning `error` rows into `pass` is the work this dingus exists to drive. In
roughly increasing effort, implement in
`packages/core/src/transformations/transformations.ts`:

1. ~~**`rotation`** — 8 cases; a rotation matrix is a special affine, so this is
   mostly a `parseTransformEntry` case + `toArray()` mapping.~~ Done: 4/8 now
   pass (the other 4 are the "by path" form, see item 7).
2. ~~**`mapAxis`** — 2 cases; finish the existing stub (permute axes).~~ Done.
3. ~~**Native inverse** — add `BaseTransformation.inverse()` so reverse traversal
   is library-native instead of the dingus's generic 4x4 invert.~~ Done.
4. **`byDimension`** — 4 cases; per-axis sub-transforms.
5. **`bijection`** — 2 cases; explicit forward/inverse pair.
6. **`displacements`** — 1 case; deformation field (largest lift; needs array IO).
7. **Affine/rotation *by path*** — load parameters from the referenced zarr array.
8. **Non-spatial / >3D axes** — generalise beyond the XYZ `Matrix4` fast path.

A standalone `$.ome.scene` graph reader (with SOURCE→TARGET pathfinding +
inversion) would let the library — not just this dingus — consume RFC-5 scenes
directly. After each change, re-run the suite; any new `fail` (vs `error`)
indicates a real numerical bug to fix.
