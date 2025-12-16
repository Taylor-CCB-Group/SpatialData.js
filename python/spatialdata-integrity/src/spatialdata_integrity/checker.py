"""
Core integrity checking functions for SpatialData and Zarr arrays.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union, List, Dict, Any
import traceback

try:
    import zarr
    import numpy as np
    import spatialdata as sd
except ImportError as e:
    raise ImportError(
        "spatialdata-integrity requires zarr, numpy, and spatialdata. "
        f"Install them with: pip install zarr numpy spatialdata\n"
        f"Original error: {e}"
    )


@dataclass
class ChunkError:
    """Information about a corrupt chunk."""

    chunk_index: tuple
    error_type: str
    error_message: str
    array_path: Optional[str] = None


@dataclass
class ElementResult:
    """Result of checking a single SpatialData element."""

    element_type: str  # 'images', 'labels', 'points', 'shapes', 'tables'
    element_name: str
    is_valid: bool
    chunks_checked: int = 0
    errors: List[ChunkError] = field(default_factory=list)
    warning: Optional[str] = None

    def __str__(self) -> str:
        status = "✓" if self.is_valid else "✗"
        msg = f"{status} {self.element_type.capitalize()}: '{self.element_name}'"
        if self.chunks_checked > 0:
            msg += f" ({self.chunks_checked} chunks checked)"
        if self.warning:
            msg += f" - Warning: {self.warning}"
        if self.errors:
            for error in self.errors:
                msg += f"\n  - Error at chunk {error.chunk_index}: {error.error_type}"
        return msg


@dataclass
class IntegrityResult:
    """Result of checking a SpatialData object."""

    path: Optional[str] = None
    is_valid: bool = True
    elements: List[ElementResult] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    def __str__(self) -> str:
        lines = []
        if self.path:
            lines.append(f"Checking SpatialData object: {self.path}")
        else:
            lines.append("Checking SpatialData object")

        for element in self.elements:
            lines.append(f"  {element}")

        if self.errors:
            lines.append("")
            lines.append("Errors encountered:")
            for error in self.errors:
                lines.append(f"  - {error}")

        lines.append("")
        error_count = sum(1 for e in self.elements if not e.is_valid)
        lines.append(f"Summary: {error_count} error(s) found in {len(self.elements)} element(s)")

        return "\n".join(lines)


def check_zarr_array(
    array: zarr.Array,
    sample_chunks: bool = True,
    max_chunks_to_check: Optional[int] = None,
    array_path: Optional[str] = None,
) -> ElementResult:
    """
    Check the integrity of a zarr array by attempting to read chunks.

    Args:
        array: The zarr array to check
        sample_chunks: If True, sample chunks across the array. If False, check all chunks.
        max_chunks_to_check: Maximum number of chunks to check (None = check all)
        array_path: Optional path identifier for error reporting

    Returns:
        ElementResult with validation results
    """
    errors: List[ChunkError] = []
    chunks_checked = 0

    try:
        # Get array shape and chunks
        shape = array.shape
        chunks = array.chunks

        if chunks is None:
            # No chunking, try to read a small slice
            try:
                # Read a small sample from the beginning
                sample_shape = tuple(min(10, s) for s in shape)
                _ = array[tuple(slice(0, s) for s in sample_shape)]
                chunks_checked = 1
            except Exception as e:
                error_type = type(e).__name__
                error_message = str(e)
                errors.append(
                    ChunkError(
                        chunk_index=(0,) * len(shape),
                        error_type=error_type,
                        error_message=error_message,
                        array_path=array_path,
                    )
                )
                chunks_checked = 1
        else:
            # Calculate chunk indices
            chunk_indices = []
            for dim_size, chunk_size in zip(shape, chunks):
                num_chunks = (dim_size + chunk_size - 1) // chunk_size
                chunk_indices.append(list(range(num_chunks)))

            # Generate chunk coordinates to check
            import itertools

            all_chunk_coords = list(itertools.product(*chunk_indices))

            if sample_chunks and len(all_chunk_coords) > 10:
                # Sample chunks: first, last, and a few in between
                import random

                samples = [all_chunk_coords[0], all_chunk_coords[-1]]
                if len(all_chunk_coords) > 2:
                    samples.extend(
                        random.sample(
                            all_chunk_coords[1:-1],
                            min(8, len(all_chunk_coords) - 2),
                        )
                    )
                chunks_to_check = samples
            else:
                chunks_to_check = all_chunk_coords

            # Limit number of chunks if specified
            if max_chunks_to_check is not None:
                chunks_to_check = chunks_to_check[:max_chunks_to_check]

            # Check each chunk
            for chunk_coords in chunks_to_check:
                try:
                    # Calculate slice for this chunk
                    slices = []
                    for coord, dim_size, chunk_size in zip(chunk_coords, shape, chunks):
                        start = coord * chunk_size
                        end = min(start + chunk_size, dim_size)
                        slices.append(slice(start, end))

                    # Try to read the chunk
                    _ = array[tuple(slices)]
                    chunks_checked += 1
                except Exception as e:
                    error_type = type(e).__name__
                    error_message = str(e)

                    # Check if it's a blosc decompression error
                    if "blosc" in error_message.lower() or "decompression" in error_message.lower():
                        error_type = "BloscDecompressionError"

                    errors.append(
                        ChunkError(
                            chunk_index=chunk_coords,
                            error_type=error_type,
                            error_message=error_message,
                            array_path=array_path,
                        )
                    )
                    chunks_checked += 1

    except Exception as e:
        # Error accessing array metadata
        error_type = type(e).__name__
        error_message = str(e)
        errors.append(
            ChunkError(
                chunk_index=(),
                error_type=error_type,
                error_message=error_message,
                array_path=array_path,
            )
        )

    return ElementResult(
        element_type="array",
        element_name=array_path or "unknown",
        is_valid=len(errors) == 0,
        chunks_checked=chunks_checked,
        errors=errors,
    )


def check_spatialdata_element(
    element: Any,
    element_type: str,
    element_name: str,
    verbose: bool = False,
) -> ElementResult:
    """
    Check a single SpatialData element (image, label, points, shape, or table).

    Args:
        element: The SpatialData element to check
        element_type: Type of element ('images', 'labels', 'points', 'shapes', 'tables')
        element_name: Name of the element
        verbose: If True, provide more detailed output

    Returns:
        ElementResult with validation results
    """
    errors: List[ChunkError] = []
    chunks_checked = 0
    warning: Optional[str] = None

    try:
        if element_type in ("images", "labels"):
            # Images and labels are typically DataTree or similar with .data attribute
            if hasattr(element, "data"):
                data = element.data
                
                # Try to access as DataTree (multi-scale)
                # DataTree objects can be iterated or accessed via .values() or items()
                scale_levels = None
                if hasattr(data, "values"):
                    # DataTree with .values() method
                    try:
                        scale_levels = list(data.values())
                    except Exception:
                        pass
                elif hasattr(data, "items"):
                    # DataTree with .items() method
                    try:
                        scale_levels = [(k, v) for k, v in data.items()]
                    except Exception:
                        pass
                elif hasattr(data, "__iter__") and not isinstance(data, (str, bytes)):
                    # Try as iterable
                    try:
                        scale_levels = list(data)
                    except Exception:
                        pass
                
                if scale_levels:
                    # Multi-scale: check each scale level
                    for i, scale_item in enumerate(scale_levels):
                        if isinstance(scale_item, tuple):
                            scale_name, scale_data = scale_item
                        else:
                            scale_name = f"scale_{i}"
                            scale_data = scale_item
                        
                        # Try to get underlying zarr array from dask array
                        zarr_array = None
                        if hasattr(scale_data, "store"):
                            # Dask array with store attribute
                            try:
                                # Try to get zarr array from dask
                                if hasattr(scale_data.store, "array"):
                                    zarr_array = scale_data.store.array
                            except Exception:
                                pass
                        
                        # If we have a zarr array, check it directly
                        if zarr_array is not None and hasattr(zarr_array, "chunks"):
                            result = check_zarr_array(
                                zarr_array,
                                array_path=f"{element_name}/{scale_name}",
                            )
                            chunks_checked += result.chunks_checked
                            errors.extend(result.errors)
                        else:
                            # Try to read a small sample to trigger chunk access
                            try:
                                # Get shape and read a small slice
                                if hasattr(scale_data, "shape"):
                                    shape = scale_data.shape
                                    # Read first chunk or small slice
                                    ndim = len(shape)
                                    if ndim >= 2:
                                        # Read a small 2D slice
                                        slices = tuple(slice(0, min(10, s)) for s in shape[:2])
                                        if ndim > 2:
                                            # For higher dims, take first index
                                            slices = slices + tuple(0 for _ in range(ndim - 2))
                                        
                                        # Try to access - this will trigger chunk loading
                                        sample = scale_data[slices]
                                        
                                        # If it's a dask array, compute it
                                        if hasattr(sample, "compute"):
                                            _ = sample.compute()
                                        
                                        chunks_checked += 1
                                    else:
                                        # 1D or 0D - just try to access
                                        _ = scale_data[0] if shape[0] > 0 else scale_data
                                        chunks_checked += 1
                                else:
                                    # No shape attribute - try basic access
                                    _ = scale_data[0] if hasattr(scale_data, "__getitem__") else scale_data
                                    chunks_checked += 1
                            except Exception as e:
                                error_type = type(e).__name__
                                error_message = str(e)
                                if "blosc" in error_message.lower() or "decompression" in error_message.lower():
                                    error_type = "BloscDecompressionError"
                                errors.append(
                                    ChunkError(
                                        chunk_index=(scale_name,),
                                        error_type=error_type,
                                        error_message=error_message,
                                        array_path=f"{element_name}/{scale_name}",
                                    )
                                )
                                chunks_checked += 1
                elif hasattr(data, "chunks"):
                    # Single zarr array (not multi-scale)
                    result = check_zarr_array(data, array_path=element_name)
                    chunks_checked += result.chunks_checked
                    errors.extend(result.errors)
                else:
                    # Try to access directly as array-like
                    try:
                        if hasattr(data, "shape"):
                            shape = data.shape
                            if len(shape) >= 2:
                                slices = tuple(slice(0, min(10, s)) for s in shape[:2])
                                sample = data[slices]
                                if hasattr(sample, "compute"):
                                    _ = sample.compute()
                                chunks_checked += 1
                            else:
                                _ = data[0] if shape[0] > 0 else data
                                chunks_checked += 1
                        else:
                            warning = "Could not determine array structure - no shape attribute"
                    except Exception as e:
                        error_type = type(e).__name__
                        error_message = str(e)
                        if "blosc" in error_message.lower():
                            error_type = "BloscDecompressionError"
                        errors.append(
                            ChunkError(
                                chunk_index=(),
                                error_type=error_type,
                                error_message=error_message,
                                array_path=element_name,
                            )
                        )
                        chunks_checked += 1
            else:
                warning = "Element has no 'data' attribute"

        elif element_type == "points":
            # Points are typically dask DataFrames
            # For now, just check if we can access metadata
            try:
                if hasattr(element, "compute"):
                    # Try a small sample
                    sample = element.head(10)
                    _ = sample.compute() if hasattr(sample, "compute") else sample
                    chunks_checked = 1
                else:
                    # Already computed or not dask
                    _ = element.head(10)
                    chunks_checked = 1
            except Exception as e:
                error_type = type(e).__name__
                error_message = str(e)
                errors.append(
                    ChunkError(
                        chunk_index=(),
                        error_type=error_type,
                        error_message=error_message,
                        array_path=element_name,
                    )
                )
                chunks_checked = 1

        elif element_type == "shapes":
            # Shapes are typically GeoDataFrames
            # Just check if we can access them
            try:
                _ = len(element)
                chunks_checked = 1
            except Exception as e:
                error_type = type(e).__name__
                error_message = str(e)
                errors.append(
                    ChunkError(
                        chunk_index=(),
                        error_type=error_type,
                        error_message=error_message,
                        array_path=element_name,
                    )
                )
                chunks_checked = 1

        elif element_type == "tables":
            # Tables are AnnData objects
            try:
                # Check if we can access the data
                _ = element.shape
                _ = element.X
                chunks_checked = 1
            except Exception as e:
                error_type = type(e).__name__
                error_message = str(e)
                errors.append(
                    ChunkError(
                        chunk_index=(),
                        error_type=error_type,
                        error_message=error_message,
                        array_path=element_name,
                    )
                )
                chunks_checked = 1

    except Exception as e:
        error_type = type(e).__name__
        error_message = str(e)
        errors.append(
            ChunkError(
                chunk_index=(),
                error_type=error_type,
                error_message=error_message,
                array_path=element_name,
            )
        )

    return ElementResult(
        element_type=element_type,
        element_name=element_name,
        is_valid=len(errors) == 0,
        chunks_checked=chunks_checked,
        errors=errors,
        warning=warning,
    )


def check_spatialdata(
    sdata: Union[sd.SpatialData, str, Path],
    element_types: Optional[List[str]] = None,
    verbose: bool = False,
) -> IntegrityResult:
    """
    Check the integrity of a SpatialData object.

    Args:
        sdata: SpatialData object or path to zarr store
        element_types: Optional list of element types to check (e.g., ['images', 'labels']).
                      If None, checks all element types.
        verbose: If True, provide more detailed output

    Returns:
        IntegrityResult with validation results
    """
    # Load SpatialData if path provided
    if isinstance(sdata, (str, Path)):
        path = str(sdata)
        try:
            sdata = sd.read_zarr(path)
        except Exception as e:
            return IntegrityResult(
                path=path,
                is_valid=False,
                errors=[f"Failed to load SpatialData object: {type(e).__name__}: {e}"],
            )
    else:
        path = None

    if element_types is None:
        element_types = ["images", "labels", "points", "shapes", "tables"]

    results: List[ElementResult] = []
    all_errors: List[str] = []

    # Check each element type
    for element_type in element_types:
        if not hasattr(sdata, element_type):
            continue

        elements = getattr(sdata, element_type)
        if elements is None:
            continue

        if isinstance(elements, dict):
            # Multiple elements of this type
            for element_name, element in elements.items():
                try:
                    result = check_spatialdata_element(
                        element, element_type, element_name, verbose=verbose
                    )
                    results.append(result)
                except Exception as e:
                    all_errors.append(
                        f"Error checking {element_type} '{element_name}': {type(e).__name__}: {e}"
                    )
                    if verbose:
                        all_errors.append(traceback.format_exc())
        elif elements is not None:
            # Single element (unlikely but possible)
            result = check_spatialdata_element(
                elements, element_type, element_type, verbose=verbose
            )
            results.append(result)

    is_valid = len(all_errors) == 0 and all(r.is_valid for r in results)

    return IntegrityResult(
        path=path,
        is_valid=is_valid,
        elements=results,
        errors=all_errors,
    )

