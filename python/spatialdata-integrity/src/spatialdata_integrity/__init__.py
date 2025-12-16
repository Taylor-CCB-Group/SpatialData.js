"""
Utilities for checking integrity of SpatialData Zarr stores.
"""

from .checker import (
    check_spatialdata,
    check_zarr_array,
    IntegrityResult,
    ElementResult,
    ChunkError,
)

__version__ = "0.1.0"
__all__ = [
    "check_spatialdata",
    "check_zarr_array",
    "IntegrityResult",
    "ElementResult",
    "ChunkError",
]

