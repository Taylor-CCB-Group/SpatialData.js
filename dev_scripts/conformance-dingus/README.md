# SpatialData.js transform conformance dingus

A "dingus" CLI implementing the contract from
[clbarnes/ome_zarr_transformations_conformance](https://github.com/clbarnes/ome_zarr_transformations_conformance),
used to validate SpatialData.js's coordinate-transform computation against the
RFC-5 OME-Zarr transformations test cases.

This lives on the `transform-conformance` branch of SpatialData.js. It is a dev
script (not shipped in any package).

## What it wraps

`dingus.ts` imports `parseTransformEntry` from
`packages/core/src/transformations/transformations.ts` and uses the resulting
`BaseTransformation.toMatrix()` (a `@math.gl/core` `Matrix4`). That is the actual
SpatialData.js transform computation. The dingus adds only glue:

- reads `attributes.ome.scene` (coordinate systems + transformation edges) from
  the case `zarr.json`;
- builds a graph and BFS-finds a path SOURCE -> TARGET;
- composes per-edge matrices, applying coordinates in name-based `x/y/z` space;
- for **reverse** edges, inverts the 4x4 with `Matrix4.invert()` (a generic
  matrix inverse; SpatialData.js core has no native transform inversion);
- prints `{"coordinates": [...]}` (exit 0), or `{"message": "..."}` (exit 1) for
  any unsupported feature or failure, per the contract.

## RFC-5 support assessment (why many cases report `error`)

SpatialData.js's `parseTransformEntry` implements **identity, scale, translation,
affine, sequence** (with `input`/`output` coordinate-system refs and axis-name ->
XYZ mapping). It does **not** implement: `rotation`, `mapAxis` (class is a stub),
`byDimension`, `bijection`, `displacements`, or affine/rotation **by path**
(parameters stored in an external zarr array). It also has no standalone
`$.ome.scene` graph reader (its model is element -> coordinate-system via
`element.getTransformation()` on multiscale `coordinateTransformations`).

The dingus therefore reports those as unsupported (`error`) rather than guessing,
which is the honest signal of current library coverage. Non-spatial axes (e.g.
`i`, `v`) are also reported unsupported because the matrix path is XYZ-only.

## Run

Requires `pnpm install` at the SpatialData.js root (provides `@math.gl/core`) and
Node >= 22 (type stripping). From the conformance repo:

```bash
./transformation_conformance.py ./cases -- \
  /abs/path/to/SpatialData.js/dev_scripts/conformance-dingus/dingus.sh
```

Single case (for debugging):

```bash
node --experimental-strip-types dingus.ts \
  /path/to/cases/affine.ome.zarr input output '[[-1,-1,-1],[0,0,0]]'
```

## Baseline

`baseline-results.tsv` records the run captured when this dingus was written
(conformance suite pinned at commit `6f93379`): **18 pass, 23 error, 0 fail**.

The key positive result is **0 `fail`**: every transform SpatialData.js actually
implements produced numerically correct coordinates, including inverse affine,
composed sequences, and multi-edge paths. All 23 `error` rows are unsupported
features (see assessment above), not wrong answers.

To extend coverage, implement the missing transform types in
`packages/core/src/transformations/transformations.ts` (and a native inverse),
then re-run; failures would then surface real numerical bugs.
