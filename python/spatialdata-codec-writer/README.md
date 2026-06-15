# spatialdata-codec-writer

Reference writer for small SpatialData/OME-Zarr image stores that use optional
image codecs such as JPEG 2000.

This package is intentionally small and fixture-oriented for now, but it is
structured as a publishable Python package. The generated stores are used by
SpatialData.ts to validate codec-aware JavaScript readers.

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer generate-fixtures
```

