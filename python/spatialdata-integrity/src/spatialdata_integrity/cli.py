"""
Command-line interface for spatialdata-integrity.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

from .checker import check_spatialdata, IntegrityResult


def format_json_result(result: IntegrityResult) -> str:
    """Format result as JSON."""
    output = {
        "path": result.path,
        "is_valid": result.is_valid,
        "elements": [
            {
                "element_type": e.element_type,
                "element_name": e.element_name,
                "is_valid": e.is_valid,
                "chunks_checked": e.chunks_checked,
                "errors": [
                    {
                        "chunk_index": list(e.chunk_index),
                        "error_type": e.error_type,
                        "error_message": e.error_message,
                        "array_path": e.array_path,
                    }
                    for e in element.errors
                ],
                "warning": e.warning,
            }
            for e in result.elements
        ],
        "errors": result.errors,
    }
    return json.dumps(output, indent=2)


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Check integrity of SpatialData Zarr stores",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Check a SpatialData store
  check-spatialdata /path/to/spatialdata.zarr

  # Verbose output
  check-spatialdata /path/to/spatialdata.zarr --verbose

  # Check only images and labels
  check-spatialdata /path/to/spatialdata.zarr --elements images labels

  # Output to JSON file
  check-spatialdata /path/to/spatialdata.zarr --output results.json
        """,
    )

    parser.add_argument(
        "path",
        type=str,
        help="Path to SpatialData Zarr store",
    )

    parser.add_argument(
        "--elements",
        nargs="+",
        choices=["images", "labels", "points", "shapes", "tables"],
        default=None,
        help="Element types to check (default: all)",
    )

    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Verbose output",
    )

    parser.add_argument(
        "--output",
        "-o",
        type=str,
        default=None,
        help="Output file path (JSON format). If not specified, prints to stdout.",
    )

    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format (default: text)",
    )

    args = parser.parse_args()

    # Check if path exists
    path = Path(args.path)
    if not path.exists():
        print(f"Error: Path does not exist: {path}", file=sys.stderr)
        sys.exit(1)

    # Run integrity check
    try:
        result = check_spatialdata(
            str(path),
            element_types=args.elements,
            verbose=args.verbose,
        )
    except Exception as e:
        print(f"Error: Failed to check SpatialData object: {e}", file=sys.stderr)
        if args.verbose:
            import traceback

            traceback.print_exc()
        sys.exit(1)

    # Format output
    if args.format == "json":
        output = format_json_result(result)
    else:
        output = str(result)

    # Write output
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output)
        print(f"Results written to: {output_path}", file=sys.stderr)
    else:
        print(output)

    # Exit with error code if validation failed
    if not result.is_valid:
        sys.exit(1)


if __name__ == "__main__":
    main()

