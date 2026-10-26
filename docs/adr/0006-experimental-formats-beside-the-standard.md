# Experimental Formats Sit Beside the Standard

**Status:** accepted
**Related:** [ADR 0002](0002-spatially-aware-vector-loading.md), [points-zarr reader spike](../plans/points-zarr-reader-spike.md)

We write and read draft formats that are not (yet) part of SpatialData: merfisheyes'
multiscale points-zarr, HTJ2K/JP2K image codecs, Morton-sorted points. A store that
carries one must still open in a standard reader, and anyone holding it must be able to
tell what is draft, which draft, and how to read or remove it.

## Decision

1. **Never claim a standard slot with draft content.** A standard reader must never
   parse draft data as if it were standard. Draft data goes in one of two places:
   - **Beside a standard copy, inside the element**: `points/<key>/experimental.<format>/`.
     The element keeps its standard form (`points.parquet`, `spatialdata_attrs.version`
     unchanged), so standard readers see an ordinary element. Our readers prefer the
     draft copy when they understand it. Rewriting the element with a standard tool
     deletes the draft copy with it, so it cannot go stale.
   - **On its own**, when there is no standard copy: the top-level
     `points.experimental/<key>/` (and `shapes.experimental/`) that ADR 0002 reserves.
     Standard readers do not look there.

   Measured with spatialdata 0.8: a store with a points-zarr copy in either place reads
   in full; a store whose `points/<key>` *is* a points-zarr element fails the whole read
   (`KeyError: '0.3-zarr'`).

2. **Inside its own group, a draft follows its own spec exactly.** The points-zarr
   group carries the spec's attributes as written, including
   `spatialdata_attrs.version: "0.3-zarr"`, because only readers of that spec look
   there. What the draft must not do is put that version on the standard element: it
   would occupy a string from spatialdata's own version list.

3. **Name and version every draft.** Identifiers are prefixed `experimental.` (the
   group name, codec names such as `experimental.openjph_htj2k`). The draft's own
   version key (`points:version`) and spec link are in its metadata, and our readers
   reject versions they do not know rather than guessing.

4. **Use a library's extension point, or none.** Where one exists, register through it:
   zarr codecs are `zarr.codecs` entry points, so installing `spatialdata-js-util` is
   enough for `spatialdata.read_zarr` to decode our images. Where none exists
   (spatialdata's element formats: `_read_points` reads `points.parquet` by name), we do
   not patch private functions; Python users read the standard copy through spatialdata,
   or the draft through our own reader API.

5. **Mark experimental code.** Exports that exist for a draft carry `@experimental`
   (TSDoc) or live in a module named for the draft, and adding one does not change the
   shape of a stable type.

6. **Prove compatibility from outside.** Each draft artifact has a test that writes a
   store containing it and reads that store with plain spatialdata.

## Formats in this repository

| Format | Status | Placement | A standard reader sees |
|---|---|---|---|
| Morton-sorted points (ADR 0002) | Vitessce practice | Canonical `points/<key>/points.parquet` | An ordinary element with extra columns |
| points-zarr 0.1 ([merfisheyes draft][pz]) | Draft, one group's | `points/<key>/experimental.points-zarr/` beside `points.parquet` | An ordinary element |
| HTJ2K/JP2K images | Our codecs | The image's own chunks | An error naming the missing codec, unless `spatialdata-js-util` is installed |

The image codecs cannot sit beside a standard copy without doubling the image, so a
store using them is readable only where the codec is installed. The codec name says
which package to install.

## Consequences

- Draft copies cost storage: a points-zarr copy beside a 16 GB parquet adds about 19 GB.
  The `points.experimental/` placement avoids that at the price of standard readers
  seeing no points at all.
- The viewer offers the copies as one element with a choice of form (tiles from the
  draft, or the standard preload). Choosing automatically is the default; the explicit
  choice exists so the drafts can be compared on the same data.
- Stores that already use a draft's own layout in a standard slot (merfisheyes' stores
  put points-zarr at `points/<key>`) stay readable by our reader; we do not write that
  layout.

[pz]: https://github.com/kresnajenie/merfisheyes/blob/main/docs/points-zarr-spec.md
