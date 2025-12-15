#!/usr/bin/env python3
"""
Validate spatialdata dataset compatibility across different versions.

This script tests loading publicly available spatialdata datasets from
spatialdata.scverse.org against different versions of the spatialdata library
to establish a baseline of what works with each version.
"""

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional
from datetime import datetime
from multiprocessing import Pool, cpu_count


@dataclass
class ValidationResult:
    """Result of validating a dataset with a specific version."""
    dataset_name: str
    dataset_url: str
    spatialdata_version: str
    success: bool
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    elements: Optional[dict] = None
    coordinate_systems: Optional[list] = None

    def to_dict(self):
        """Convert to dictionary for JSON serialization."""
        return asdict(self)


# Dataset definitions from https://spatialdata.scverse.org/en/stable/tutorials/notebooks/datasets/README.html
DATASETS = [
    {
        "name": "Visium HD (Mouse intestin)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_hd_3.0.0_io.zarr/",
    },
    {
        "name": "Visium (Breast cancer)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_associated_xenium_io.zarr/",
    },
    {
        "name": "Xenium (Breast cancer - Rep1)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/xenium_rep1_io.zarr/",
    },
    {
        "name": "Xenium (Breast cancer - Rep2)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/xenium_rep2_io.zarr/",
    },
    {
        "name": "CyCIF (Lung adenocarcinoma)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/mcmicro_io.zarr/",
    },
    {
        "name": "MERFISH (Mouse brain)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/merfish.zarr/",
    },
    {
        "name": "MIBI-TOF (Colorectal carcinoma)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/mibitof.zarr/",
    },
    {
        "name": "Imaging Mass Cytometry (Multiple cancers)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/steinbock_io.zarr/",
    },
    {
        "name": "Molecular Cartography (Mouse Liver)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/mouse_liver.zarr",
    },
    {
        "name": "SpaceM (Hepa/NIH3T3 cells)",
        "url": "https://s3.embl.de/spatialdata/spatialdata-sandbox/spacem_helanih3t3.zarr",
    },
]


def validate_with_version(dataset: dict, version: str, project_root: Path, verbose: bool = False) -> ValidationResult:
    """
    Validate a dataset with a specific spatialdata version.

    This runs a subprocess with the version-specific environment to test loading the dataset.
    """
    env_dir = project_root / "python" / f"v{version}"

    if verbose:
        print(f"    Loading spatialdata library (v{version})...", file=sys.stderr, flush=True)

    # Create a temporary Python script to run in the version-specific environment
    test_script = f"""
import sys
import json
import spatialdata as sd

def test_load():
    try:
        print("Loading dataset...", file=sys.stderr, flush=True)
        # Try to read the dataset
        sdata = sd.read_zarr("{dataset['url']}")

        # Extract basic info
        elements = {{}}
        for element_type in ["images", "labels", "points", "shapes", "tables"]:
            if hasattr(sdata, element_type):
                attr = getattr(sdata, element_type)
                if isinstance(attr, dict):
                    elements[element_type] = list(attr.keys())
                elif attr is not None:
                    elements[element_type] = True

        # Get coordinate systems
        coordinate_systems = None
        if hasattr(sdata, "coordinate_systems"):
            cs = sdata.coordinate_systems
            if isinstance(cs, dict):
                coordinate_systems = list(cs.keys())
            elif isinstance(cs, list):
                coordinate_systems = cs
            elif cs is not None:
                coordinate_systems = [str(cs)]

        result = {{
            "success": True,
            "elements": elements,
            "coordinate_systems": coordinate_systems,
        }}
        print(json.dumps(result))

    except Exception as e:
        error_type = type(e).__name__
        error_message = str(e)
        result = {{
            "success": False,
            "error_type": error_type,
            "error_message": error_message,
        }}
        print(json.dumps(result))
        sys.exit(1)

if __name__ == "__main__":
    test_load()
"""

    # Run the test script in the version-specific environment
    try:
        result = subprocess.run(
            ["uv", "run", "--directory", str(env_dir), "python", "-c", test_script],
            capture_output=True,
            text=True,
            timeout=120,  # 2 minute timeout per dataset
            cwd=project_root,
        )

        # Parse the JSON output
        try:
            output = json.loads(result.stdout.strip().split('\n')[-1])
            return ValidationResult(
                dataset_name=dataset["name"],
                dataset_url=dataset["url"],
                spatialdata_version=version,
                success=output.get("success", False),
                error_type=output.get("error_type"),
                error_message=output.get("error_message"),
                elements=output.get("elements"),
                coordinate_systems=output.get("coordinate_systems"),
            )
        except (json.JSONDecodeError, IndexError) as e:
            # If we couldn't parse the output, something went wrong
            return ValidationResult(
                dataset_name=dataset["name"],
                dataset_url=dataset["url"],
                spatialdata_version=version,
                success=False,
                error_type="ParseError",
                error_message=f"Could not parse output: {result.stdout}\nStderr: {result.stderr}",
            )

    except subprocess.TimeoutExpired:
        return ValidationResult(
            dataset_name=dataset["name"],
            dataset_url=dataset["url"],
            spatialdata_version=version,
            success=False,
            error_type="TimeoutError",
            error_message="Dataset loading timed out after 120 seconds",
        )
    except Exception as e:
        return ValidationResult(
            dataset_name=dataset["name"],
            dataset_url=dataset["url"],
            spatialdata_version=version,
            success=False,
            error_type=type(e).__name__,
            error_message=str(e),
        )


def generate_markdown_table(results: list[ValidationResult]) -> str:
    """Generate a markdown table from validation results."""

    # Group results by dataset
    datasets = {}
    for result in results:
        if result.dataset_name not in datasets:
            datasets[result.dataset_name] = {}
        datasets[result.dataset_name][result.spatialdata_version] = result

    # Generate table
    lines = []
    lines.append("# SpatialData Dataset Compatibility Report")
    lines.append(f"\nGenerated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    lines.append("## Summary")
    lines.append("")
    lines.append("| Dataset | v0.5.0 | v0.6.1 | URL |")
    lines.append("|---------|--------|--------|-----|")

    for dataset_name in sorted(datasets.keys()):
        versions = datasets[dataset_name]
        v050 = versions.get("0.5.0")
        v061 = versions.get("0.6.1")

        v050_status = "✅" if v050 and v050.success else "❌" if v050 else "⏭️"
        v061_status = "✅" if v061 and v061.success else "❌" if v061 else "⏭️"

        # Get URL from first available result
        url = (v050 or v061).dataset_url if (v050 or v061) else ""
        url_short = url.split("spatialdata-sandbox/")[-1] if "spatialdata-sandbox/" in url else url

        lines.append(f"| {dataset_name} | {v050_status} | {v061_status} | `{url_short}` |")

    lines.append("")
    lines.append("Legend: ✅ Success | ❌ Failed | ⏭️ Not tested")
    lines.append("")

    # Add detailed error information
    lines.append("## Detailed Results")
    lines.append("")

    for dataset_name in sorted(datasets.keys()):
        versions = datasets[dataset_name]
        lines.append(f"### {dataset_name}")
        lines.append("")

        for version in ["0.5.0", "0.6.1"]:
            result = versions.get(version)
            if not result:
                continue

            lines.append(f"#### spatialdata v{version}")
            lines.append("")

            if result.success:
                lines.append(f"**Status:** ✅ Success")
                lines.append("")

                if result.elements:
                    lines.append("**Elements:**")
                    for element_type, items in result.elements.items():
                        if isinstance(items, list):
                            lines.append(f"- {element_type}: {', '.join(items)}")
                        else:
                            lines.append(f"- {element_type}: present")
                    lines.append("")

                if result.coordinate_systems:
                    lines.append(f"**Coordinate Systems:** {', '.join(result.coordinate_systems)}")
                    lines.append("")
            else:
                lines.append(f"**Status:** ❌ Failed")
                lines.append("")
                lines.append(f"**Error Type:** `{result.error_type}`")
                lines.append("")
                lines.append(f"**Error Message:**")
                lines.append("```")
                lines.append(result.error_message or "No error message")
                lines.append("```")
                lines.append("")

        lines.append("---")
        lines.append("")

    return "\n".join(lines)


def generate_csv_table(results: list[ValidationResult]) -> str:
    """Generate a CSV table from validation results."""
    import csv
    import io

    output = io.StringIO()
    writer = csv.writer(output)

    # Write header
    writer.writerow([
        "Dataset Name",
        "Dataset URL",
        "SpatialData Version",
        "Success",
        "Error Type",
        "Error Message",
        "Elements",
        "Coordinate Systems",
    ])

    # Write rows
    for result in results:
        elements_str = json.dumps(result.elements) if result.elements else ""
        cs_str = json.dumps(result.coordinate_systems) if result.coordinate_systems else ""

        writer.writerow([
            result.dataset_name,
            result.dataset_url,
            result.spatialdata_version,
            result.success,
            result.error_type or "",
            result.error_message or "",
            elements_str,
            cs_str,
        ])

    return output.getvalue()


def validate_single(args_tuple):
    """Helper function for multiprocessing pool."""
    dataset, version, project_root, verbose = args_tuple
    return validate_with_version(dataset, version, project_root, verbose)


def main():
    parser = argparse.ArgumentParser(
        description="Validate spatialdata dataset compatibility across versions"
    )
    parser.add_argument(
        "--version",
        type=str,
        choices=["0.5.0", "0.6.1"],
        default=None,
        help="SpatialData version to test (default: both)",
    )
    parser.add_argument(
        "--dataset",
        type=str,
        default=None,
        help="Specific dataset name to test (default: all)",
    )
    parser.add_argument(
        "--output-format",
        type=str,
        choices=["markdown", "csv", "json"],
        default="markdown",
        help="Output format (default: markdown)",
    )
    parser.add_argument(
        "--output-file",
        type=str,
        default=None,
        help="Output file path (default: print to stdout)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=min(4, cpu_count()),
        help=f"Number of parallel workers (default: min(4, {cpu_count()}))",
    )
    parser.add_argument(
        "--no-parallel",
        action="store_true",
        help="Disable parallel processing (run sequentially)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show detailed progress information",
    )

    args = parser.parse_args()

    # Get project root
    project_root = Path(__file__).parent.parent.parent

    # Filter datasets if specific one requested
    datasets = DATASETS
    if args.dataset:
        datasets = [d for d in DATASETS if args.dataset.lower() in d["name"].lower()]
        if not datasets:
            print(f"Error: No dataset matching '{args.dataset}' found", file=sys.stderr)
            print("\nAvailable datasets:", file=sys.stderr)
            for d in DATASETS:
                print(f"  - {d['name']}", file=sys.stderr)
            sys.exit(1)

    # Determine versions to test
    versions = [args.version] if args.version else ["0.5.0", "0.6.1"]

    # Ensure environments are set up
    for version in versions:
        env_dir = project_root / "python" / f"v{version}"
        print(f"Setting up environment for spatialdata {version}...", file=sys.stderr)
        result = subprocess.run(
            ["uv", "sync", "--directory", str(env_dir)],
            cwd=project_root,
            capture_output=True,
        )
        if result.returncode != 0:
            print(f"Error setting up environment for version {version}", file=sys.stderr)
            print(result.stderr.decode(), file=sys.stderr)
            sys.exit(1)

    # Run validation
    results = []
    total = len(datasets) * len(versions)

    print(f"\nValidating {len(datasets)} dataset(s) with {len(versions)} version(s)...", file=sys.stderr)

    if args.no_parallel:
        print("Running sequentially (parallel processing disabled)", file=sys.stderr)
    else:
        print(f"Using {args.workers} parallel worker(s)", file=sys.stderr)

    print("Note: Most time is spent importing spatialdata, not downloading datasets", file=sys.stderr)
    print("", file=sys.stderr)

    # Prepare arguments for validation
    validation_tasks = [
        (dataset, version, project_root, args.verbose)
        for dataset in datasets
        for version in versions
    ]

    if args.no_parallel:
        # Sequential processing
        for i, task in enumerate(validation_tasks):
            dataset, version, project_root, verbose = task
            print(f"[{i+1}/{total}] Testing {dataset['name']} with spatialdata v{version}...", file=sys.stderr, flush=True)

            result = validate_with_version(dataset, version, project_root, verbose)
            results.append(result)

            status = "✅" if result.success else "❌"
            print(f"        {status} {dataset['name']} (v{version})", file=sys.stderr, flush=True)
            if not result.success:
                print(f"           Error: {result.error_type}", file=sys.stderr, flush=True)
            print("", file=sys.stderr, flush=True)
    else:
        # Parallel processing using process pool
        print("Starting validation pool...", file=sys.stderr, flush=True)
        print("", file=sys.stderr, flush=True)

        with Pool(processes=args.workers) as pool:
            # Use imap to get results as they complete
            for i, result in enumerate(pool.imap(validate_single, validation_tasks)):
                results.append(result)

                status = "✅" if result.success else "❌"
                print(f"[{i+1}/{total}] {status} {result.dataset_name} (v{result.spatialdata_version})", file=sys.stderr, flush=True)
                if not result.success and args.verbose:
                    print(f"          Error: {result.error_type}", file=sys.stderr, flush=True)

    print("", file=sys.stderr)
    print("Validation complete!", file=sys.stderr)
    print("", file=sys.stderr)

    # Generate output
    if args.output_format == "markdown":
        output = generate_markdown_table(results)
    elif args.output_format == "csv":
        output = generate_csv_table(results)
    elif args.output_format == "json":
        output = json.dumps([r.to_dict() for r in results], indent=2)
    else:
        output = ""

    # Write output
    if args.output_file:
        output_path = Path(args.output_file)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output)
        print(f"Results written to: {output_path}", file=sys.stderr)
    else:
        print(output)


if __name__ == "__main__":
    main()
