# spatialdata-experimental-writer

Experimental vector optimization writers for browser-oriented SpatialData
rendering.

The initial writer targets Vitessce-compatible Morton-sorted Points Parquet:

- `x`, `y`, optional `z` coordinates are preserved.
- `morton_code_2d` is added using 16 bits per axis.
- the first 2-4 rows are sentinel/extreme rows with `morton_code_2d == 0`;
  readers can infer the full point bounding box from these rows.
- string/categorical columns are placed at the right side of the table.
- row-group size is controlled when writing Parquet.

The package also includes a small multiscale Parquet writer hook that stores
Padua-style `spatialdata_multiscale` JSON metadata in the Parquet schema.
