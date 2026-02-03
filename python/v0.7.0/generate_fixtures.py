#!/usr/bin/env python3
"""
Generate test fixtures using spatialdata library (version 0.7.0).

This script generates spatialdata zarr stores for testing with spatialdata 0.7.0.
It runs in the python/v0.7.0/ environment which has spatialdata==0.7.0 pinned.
"""

import sys
from pathlib import Path

# Add scripts directory to path if we need shared utilities
script_dir = Path(__file__).parent
sys.path.insert(0, str(script_dir.parent / "scripts"))


def generate_fixtures(output_dir: Path):
    """Generate test fixtures for spatialdata version 0.7.0."""
    from spatialdata.datasets import blobs
    import spatialdata as sd
    version = "0.7.0"
    print(f"Generating fixtures for spatialdata version {version}...")
    
    # Verify we're using the correct version
    actual_version = sd.__version__
    if actual_version != version:
        print(f"⚠️  Warning: Expected version {version} but got {actual_version}")
        print("   This may indicate the wrong environment is active.")
    
    # Create output directory
    version_dir = output_dir / f"v{version}"
    version_dir.mkdir(parents=True, exist_ok=True)
    
    # Generate a simple spatialdata object using blobs dataset
    print("Creating spatialdata object with blobs dataset...")
    sdata = blobs()
    
    # Save to zarr store
    store_path = version_dir / "blobs.zarr"
    
    # Remove existing store if it exists (to allow regenerating fixtures)
    import shutil
    if store_path.exists():
        print(f"Removing existing fixture at {store_path}...")
        shutil.rmtree(store_path)
    
    print(f"Saving to {store_path}...")
    
    # Use spatialdata's write method
    # The API may vary by version, so we try different methods
    try:
        # Try the standard write method with overwrite (most common)
        sdata.write(store_path, overwrite=True)
    except TypeError:
        # If overwrite parameter doesn't exist, try without it
        # (older versions might not support it)
        sdata.write(store_path)
    except ValueError as e:
        # Handle "already exists" errors
        if "already exists" in str(e).lower():
            # Shouldn't happen since we removed it, but handle anyway
            shutil.rmtree(store_path)
            sdata.write(store_path)
        else:
            # Re-raise other ValueError exceptions
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
        description="Generate test fixtures for SpatialData.ts using spatialdata 0.7.0"
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

