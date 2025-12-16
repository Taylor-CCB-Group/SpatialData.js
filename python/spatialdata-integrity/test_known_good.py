#!/usr/bin/env python3
"""
Test script to verify integrity checking works with known-good data.

This script tests the integrity checker with the blobs dataset,
which should be valid and not have any corrupt chunks.
"""

import sys
from pathlib import Path

# Add src to path for development
sys.path.insert(0, str(Path(__file__).parent / "src"))

from spatialdata_integrity import check_spatialdata


def test_known_good():
    """Test with known-good blobs dataset."""
    # Try to find blobs dataset in test-fixtures
    project_root = Path(__file__).parent.parent.parent
    fixtures_dir = project_root / "test-fixtures"

    # Try v0.6.1 first, then v0.5.0
    test_paths = [
        fixtures_dir / "v0.6.1" / "blobs.zarr",
        fixtures_dir / "v0.5.0" / "blobs.zarr",
    ]

    test_path = None
    for path in test_paths:
        if path.exists():
            test_path = path
            break

    if test_path is None:
        print("Error: Could not find blobs.zarr in test-fixtures")
        print(f"Looked in: {[str(p) for p in test_paths]}")
        return 1

    print(f"Testing with known-good dataset: {test_path}")
    print("=" * 60)

    try:
        result = check_spatialdata(str(test_path), verbose=True)
        print("\n" + str(result))

        if result.is_valid:
            print("\n✓ All checks passed! The integrity checker is working correctly.")
            return 0
        else:
            print("\n✗ Found errors in known-good dataset. This may indicate:")
            print("  1. The dataset is actually corrupted")
            print("  2. There's a bug in the integrity checker")
            return 1

    except Exception as e:
        print(f"\n✗ Error running integrity check: {e}")
        import traceback

        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(test_known_good())

