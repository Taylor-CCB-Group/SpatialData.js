#!/usr/bin/env python3
"""
Generate test fixtures using spatialdata library (version 0.5.0).

This script generates spatialdata zarr stores for testing with spatialdata 0.5.0.
It runs in the python/v0.5.0/ environment which has spatialdata==0.5.0 pinned.
"""

import sys
from pathlib import Path

# Add scripts directory to path if we need shared utilities
script_dir = Path(__file__).parent
sys.path.insert(0, str(script_dir.parent / "scripts"))

from spatialdata.datasets import blobs
import spatialdata as sd


def generate_fixtures(output_dir: Path):
    """Generate test fixtures for spatialdata version 0.5.0."""
    version = "0.5.0"
    print(f"Generating fixtures for spatialdata version {version}...")
    
    # Verify we're using the correct version
    actual_version = sd.__version__
    if actual_version != version:
        print(f"⚠️  Warning: Expected version {version} but got {actual_version}")
        print(f"   This may indicate the wrong environment is active.")
    
    # Create output directory
    version_dir = output_dir / f"v{version}"
    version_dir.mkdir(parents=True, exist_ok=True)
    
    # Generate a simple spatialdata object using blobs dataset
    print("Creating spatialdata object with blobs dataset...")
    sdata = blobs()
    
    # Workaround for spatialdata 0.5.0 bug: Remove points that have Identity transformations
    # which can't be serialized to JSON. This is a known issue in 0.5.0.
    if hasattr(sdata, "points") and sdata.points:
        print("Removing points data (workaround for spatialdata 0.5.0 JSON serialization bug)...")
        # Clear points - handle both dict and list cases
        if isinstance(sdata.points, dict):
            sdata.points.clear()
        elif isinstance(sdata.points, list):
            sdata.points.clear()
        else:
            # Try to delete the attribute
            try:
                delattr(sdata, "points")
            except:
                # If that fails, set to empty dict
                sdata.points = {}
    
    # Save to zarr store
    store_path = version_dir / "blobs.zarr"
    
    # Remove existing store if it exists (to allow regenerating fixtures)
    import shutil
    import os
    if os.path.exists(store_path) or os.path.isdir(store_path):
        print(f"Removing existing fixture at {store_path}...")
        try:
            if os.path.isdir(store_path):
                shutil.rmtree(store_path)
            elif os.path.isfile(store_path):
                os.remove(store_path)
        except Exception as e:
            print(f"Warning: Could not remove existing fixture: {e}")
    
    # Double-check it's gone
    if os.path.exists(store_path):
        print(f"Warning: Store path still exists after removal attempt: {store_path}")
        # Force remove
        try:
            shutil.rmtree(store_path, ignore_errors=True)
        except:
            pass
    
    print(f"Saving to {store_path}...")
    
    # Use spatialdata's write method
    # Note: spatialdata 0.5.0 has a known issue with JSON serialization of Identity
    # transformations when writing points. We'll catch this and clean up.
    try:
        # Try with overwrite first (for newer versions)
        try:
            sdata.write(store_path, overwrite=True)
        except TypeError:
            # If overwrite parameter doesn't exist, try without it
            sdata.write(store_path)
    except Exception as e:
        # Clean up any partially written store
        if os.path.exists(store_path):
            try:
                if os.path.isdir(store_path):
                    shutil.rmtree(store_path)
                else:
                    os.remove(store_path)
            except:
                pass
        
        error_msg = str(e)
        error_type = type(e).__name__
        
        # Check for JSON serialization issues (known bug in spatialdata 0.5.0)
        if "JSON" in error_msg or "serializable" in error_msg.lower() or "Identity" in error_msg:
            print(f"\n⚠️  Error: {error_type}: {error_msg}")
            print("\nThis appears to be a known issue with spatialdata 0.5.0 where")
            print("Identity transformations cannot be serialized to JSON when writing points.")
            raise RuntimeError(
                f"Failed to generate fixtures due to spatialdata 0.5.0 bug: {error_msg}"
            ) from e
        else:
            # Re-raise other errors
            raise
    
    print(f"✓ Generated fixture at {store_path}")
    
    # Print some metadata about what was generated
    print("\nGenerated elements:")
    for element_type in ["images", "labels", "points", "shapes", "tables"]:
        elements = getattr(sdata, element_type, None)
        if elements:
            # Handle both dict and list cases
            if isinstance(elements, dict):
                print(f"  - {element_type}: {len(elements)} element(s)")
                for name in elements.keys():
                    print(f"    * {name}")
            elif isinstance(elements, list):
                print(f"  - {element_type}: {len(elements)} element(s)")
                for i, elem in enumerate(elements):
                    print(f"    * element_{i}")
            else:
                print(f"  - {element_type}: present")
    
    if hasattr(sdata, "coordinate_systems"):
        if isinstance(sdata.coordinate_systems, dict):
            print(f"\nCoordinate systems: {list(sdata.coordinate_systems.keys())}")
        elif isinstance(sdata.coordinate_systems, list):
            print(f"\nCoordinate systems: {sdata.coordinate_systems}")
        else:
            print(f"\nCoordinate systems: {sdata.coordinate_systems}")
    
    print(f"\nUsing spatialdata version {actual_version}")
    
    return store_path


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Generate test fixtures for SpatialData.ts using spatialdata 0.5.0"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="test-fixtures",
        help="Output directory for fixtures (default: test-fixtures)",
    )
    
    args = parser.parse_args()
    
    # Get project root (parent of python/ directory)
    project_root = Path(__file__).parent.parent.parent
    output_dir = project_root / args.output_dir
    
    generate_fixtures(output_dir)
    print("\n✓ Fixtures generated successfully!")


if __name__ == "__main__":
    main()

