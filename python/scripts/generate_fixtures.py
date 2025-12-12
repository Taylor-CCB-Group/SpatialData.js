#!/usr/bin/env python3
"""
Wrapper script to generate test fixtures for all spatialdata versions.

This script coordinates running the version-specific fixture generation scripts
located in python/v0.5.0/ and python/v0.6.1/.
"""

import argparse
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        description="Generate test fixtures for SpatialData.ts"
    )
    parser.add_argument(
        "--version",
        type=str,
        choices=["0.5.0", "0.6.1"],
        default=None,
        help="SpatialData version to generate fixtures for (default: both)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="test-fixtures",
        help="Output directory for fixtures (default: test-fixtures)",
    )
    
    args = parser.parse_args()
    
    # Get project root
    script_path = Path(__file__)
    project_root = script_path.parent.parent.parent
    output_dir = project_root / args.output_dir
    
    versions = [args.version] if args.version else ["0.5.0", "0.6.1"]
    
    success = True
    for version in versions:
        env_dir = project_root / "python" / f"v{version}"
        version_script = env_dir / "generate_fixtures.py"
        
        if not version_script.exists():
            print(f"Error: Script not found at {version_script}")
            print(f"       Make sure the environment directory exists: {env_dir}")
            success = False
            continue
        
        # Ensure the environment is set up
        print(f"\n{'='*60}")
        print(f"Setting up environment for spatialdata {version}...")
        print(f"{'='*60}")
        sync_result = subprocess.run(
            ["uv", "sync", "--directory", str(env_dir)],
            cwd=project_root,
            capture_output=True,
            text=True,
        )
        
        if sync_result.returncode != 0:
            print(f"Error setting up environment for version {version}:")
            print(sync_result.stderr)
            success = False
            continue
        
        # Run the version-specific script in its environment
        print(f"\n{'='*60}")
        print(f"Generating fixtures for spatialdata {version}...")
        print(f"{'='*60}")
        result = subprocess.run(
            [
                "uv", "run",
                "--directory", str(env_dir),
                str(version_script),
                "--output-dir", str(output_dir),
            ],
            cwd=project_root,
        )
        
        if result.returncode != 0:
            print(f"Failed to generate fixtures for version {version}")
            success = False
    
    if success:
        print("\n" + "="*60)
        print("✓ All fixtures generated successfully!")
        print("="*60)
    else:
        print("\n" + "="*60)
        print("✗ Some fixtures failed to generate")
        print("="*60)
        sys.exit(1)


if __name__ == "__main__":
    main()
