`points_v1.zarr` and `points_expected.json` are copied unmodified from
[kresnajenie/merfisheyes](https://github.com/kresnajenie/merfisheyes) at
`23a1f2751740c6e05caa6f80cca5b94b32e294b1` (`tests/data/tiny/zarr/`, MIT licence,
copyright MERFISHEYES). They are built by that repo's
`scripts/testdata/make-tiny-points.py`: 3,000 points, 4 genes, 3 levels, written in
points-zarr spec 0.1 (`docs/points-zarr-spec.md` there) with chunks and shards small
enough that reads cross both.
