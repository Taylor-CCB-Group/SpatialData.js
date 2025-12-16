#!/usr/bin/env python3
"""
Example usage of spatialdata-integrity checker.

This demonstrates how to use the integrity checker both programmatically
and via the CLI.
"""

import sys
from pathlib import Path

# Add src to path for development
sys.path.insert(0, str(Path(__file__).parent / "src"))

from spatialdata_integrity import check_spatialdata, check_zarr_array
import spatialdata as sd


def example_check_spatialdata():
    """Example: Check a full SpatialData object."""
    print("=" * 60)
    print("Example 1: Checking a SpatialData object")
    print("=" * 60)
    
    # Replace with your path
    path = "path/to/your/spatialdata.zarr"
    
    if not Path(path).exists():
        print(f"Path does not exist: {path}")
        print("Please update the path in this script.")
        return
    
    try:
        result = check_spatialdata(path, verbose=True)
        print("\n" + str(result))
        
        if result.is_valid:
            print("\n✓ All checks passed!")
        else:
            print("\n✗ Found errors:")
            for element in result.elements:
                if not element.is_valid:
                    print(f"  - {element.element_type} '{element.element_name}':")
                    for error in element.errors:
                        print(f"    * Chunk {error.chunk_index}: {error.error_type}")
                        print(f"      {error.error_message}")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()


def example_check_specific_elements():
    """Example: Check only specific element types."""
    print("\n" + "=" * 60)
    print("Example 2: Checking only images and labels")
    print("=" * 60)
    
    path = "path/to/your/spatialdata.zarr"
    
    if not Path(path).exists():
        print(f"Path does not exist: {path}")
        return
    
    try:
        # Check only images and labels
        result = check_spatialdata(
            path,
            element_types=["images", "labels"],
            verbose=True
        )
        print("\n" + str(result))
    except Exception as e:
        print(f"Error: {e}")


def example_check_zarr_array():
    """Example: Check a specific zarr array."""
    print("\n" + "=" * 60)
    print("Example 3: Checking a specific zarr array")
    print("=" * 60)
    
    import zarr
    
    # Open a zarr array directly
    array_path = "path/to/array.zarr"
    
    if not Path(array_path).exists():
        print(f"Path does not exist: {array_path}")
        return
    
    try:
        arr = zarr.open(array_path, mode="r")
        result = check_zarr_array(arr, array_path=array_path)
        
        print(f"\nArray: {array_path}")
        print(f"Shape: {arr.shape}")
        print(f"Chunks: {arr.chunks}")
        print(f"Chunks checked: {result.chunks_checked}")
        
        if result.is_valid:
            print("✓ All chunks are valid")
        else:
            print("✗ Found errors:")
            for error in result.errors:
                print(f"  - Chunk {error.chunk_index}: {error.error_type}")
                print(f"    {error.error_message}")
    except Exception as e:
        print(f"Error: {e}")


def example_find_corrupt_chunks():
    """Example: Find which specific chunks are corrupt."""
    print("\n" + "=" * 60)
    print("Example 4: Finding corrupt chunks")
    print("=" * 60)
    
    path = "path/to/your/spatialdata.zarr"
    
    if not Path(path).exists():
        print(f"Path does not exist: {path}")
        return
    
    try:
        result = check_spatialdata(path)
        
        # Find all corrupt chunks
        corrupt_chunks = []
        for element in result.elements:
            if not element.is_valid:
                for error in element.errors:
                    corrupt_chunks.append({
                        "element": f"{element.element_type}/{element.element_name}",
                        "chunk": error.chunk_index,
                        "error": error.error_type,
                        "message": error.error_message,
                    })
        
        if corrupt_chunks:
            print(f"\nFound {len(corrupt_chunks)} corrupt chunk(s):")
            for chunk_info in corrupt_chunks:
                print(f"\n  Element: {chunk_info['element']}")
                print(f"  Chunk index: {chunk_info['chunk']}")
                print(f"  Error type: {chunk_info['error']}")
                print(f"  Message: {chunk_info['message']}")
        else:
            print("\n✓ No corrupt chunks found")
            
    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    print("SpatialData Integrity Checker - Usage Examples")
    print("=" * 60)
    print("\nNote: Update the paths in this script to point to your data.")
    print("\nUncomment the example you want to run:\n")
    
    # Uncomment the example you want to run:
    # example_check_spatialdata()
    # example_check_specific_elements()
    # example_check_zarr_array()
    # example_find_corrupt_chunks()
    
    print("\nTo run examples, uncomment them in the script.")

