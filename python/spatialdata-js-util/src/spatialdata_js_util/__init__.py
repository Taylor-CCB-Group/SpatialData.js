"""Utilities for reading and writing browser-oriented SpatialData stores.

Three kinds of optimization live here, all aimed at making a SpatialData store
cheap to read incrementally over HTTP from `SpatialData.js`:

* **images** — recompress rasters with JPEG 2000 or HTJ2K so tiles decode in the
  browser (`recompress_spatialdata`).
* **points** — Morton-sort Points Parquet with sentinel bounding-box rows and
  controlled row groups, so a viewport maps to a few row-group reads
  (`write_morton_points_parquet`).
* **tables** — convert AnnData matrices to CSC so reading one gene is one
  contiguous range read (`convert_store_tables_to_csc`).

Installing this distribution also registers the image codecs with zarr-python,
so `spatialdata.read_zarr` can open stores written here — see
`spatialdata_js_util.codecs.zarr_codec`.
"""

from .codecs import (
    CODEC_HTJ2K_LEGACY,
    CODEC_HTJ2K_OPENJPH,
    CODEC_JPEG2K,
    backend_report,
    htj2k_available,
    is_htj2k_codec,
    register_codecs,
)
from .images import (
    HTJ2K_PRESETS,
    HTJ2K_QUALITY_FLOOR_LSB,
    JP2K_PRESETS,
    RecompressedSpatialData,
    dtype_quantum,
    htj2k_preset_quality,
    recompress_spatialdata,
    resolve_recompression_config,
)
from .pyramids import (
    PyramidResult,
    add_pyramids,
    has_pyramid,
    resolve_scale_factors,
)
from .points import (
    MORTON_CODE_2D_COLUMN,
    MORTON_CODE_EXTREME_VALUE_INDICATOR,
    build_spatialdata_multiscale_metadata,
    morton_sort_points,
    write_morton_points_parquet,
    write_multiscale_points_parquet,
)
from .tables import (
    CscConversion,
    anndata_to_csc,
    convert_store_tables_to_csc,
    to_csc,
)

__all__ = [
    "CODEC_HTJ2K_LEGACY",
    "CODEC_HTJ2K_OPENJPH",
    "CODEC_JPEG2K",
    "HTJ2K_PRESETS",
    "HTJ2K_QUALITY_FLOOR_LSB",
    "JP2K_PRESETS",
    "MORTON_CODE_2D_COLUMN",
    "MORTON_CODE_EXTREME_VALUE_INDICATOR",
    "CscConversion",
    "PyramidResult",
    "RecompressedSpatialData",
    "add_pyramids",
    "anndata_to_csc",
    "backend_report",
    "build_spatialdata_multiscale_metadata",
    "convert_store_tables_to_csc",
    "dtype_quantum",
    "has_pyramid",
    "htj2k_available",
    "htj2k_preset_quality",
    "is_htj2k_codec",
    "morton_sort_points",
    "recompress_spatialdata",
    "register_codecs",
    "resolve_recompression_config",
    "resolve_scale_factors",
    "to_csc",
    "write_morton_points_parquet",
    "write_multiscale_points_parquet",
]
