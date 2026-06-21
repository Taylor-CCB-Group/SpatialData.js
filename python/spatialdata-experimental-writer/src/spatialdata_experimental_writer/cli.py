from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from typing import Any

from .errors import WriterCommandError
from .runners import (
    run_list_points,
    run_morton_points,
    run_morton_points_from_zarr,
    run_multiscale_points,
    run_write_index_permutations,
)

_EPILOG = """\
examples:
  # List Points elements in a SpatialData Zarr store
  spatialdata-experimental-writer list-points ~/data/xenium.zarr

  # Morton-sort transcripts in-place on the canonical points element
  spatialdata-experimental-writer morton-points-from-zarr \\
    ~/data/xenium.zarr --points-key transcripts

  # Build a derivative store with transcript index permutations
  spatialdata-experimental-writer write-index-permutations \\
    ~/data/xenium_rep1_io.zarr ~/data/xenium_rep1_index-permutations.zarr

  # Morton-sort a CSV or single Parquet file
  spatialdata-experimental-writer morton-points input.csv output.parquet \\
    --feature-key feature_name

  # Write multiscale Parquet with embedded spatialdata_multiscale metadata
  spatialdata-experimental-writer multiscale-points input.parquet output.parquet

  # Interactive workflow TUI
  uv sync --group tui
  spatialdata-experimental-writer tui ~/data/xenium.zarr
"""


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def _run_command(command: Callable[[], dict[str, Any]]) -> None:
    try:
        _print_json(command())
    except WriterCommandError as exc:
        raise SystemExit(str(exc)) from exc


def _list_points(args: argparse.Namespace) -> None:
    _run_command(lambda: run_list_points(args.zarr))


def _morton_points(args: argparse.Namespace) -> None:
    _run_command(
        lambda: run_morton_points(
            args.input,
            args.output,
            feature_key=args.feature_key,
            row_group_size=args.row_group_size,
            compression=args.compression,
        )
    )


def _multiscale_points(args: argparse.Namespace) -> None:
    _run_command(
        lambda: run_multiscale_points(
            args.input,
            args.output,
            metadata_json=args.metadata_json,
            row_group_size=args.row_group_size,
            compression=args.compression,
        )
    )


def _morton_points_from_zarr(args: argparse.Namespace) -> None:
    _run_command(
        lambda: run_morton_points_from_zarr(
            args.zarr,
            points_key=args.points_key,
            experimental=args.experimental,
            output=args.output,
            feature_key=args.feature_key,
            row_group_size=args.row_group_size,
            compression=args.compression,
        )
    )


def _write_index_permutations(args: argparse.Namespace) -> None:
    condition_ids = args.conditions.split(",") if args.conditions else None
    _run_command(
        lambda: run_write_index_permutations(
            args.source_zarr,
            args.dest_zarr,
            points_key=args.points_key,
            max_rows=args.max_rows,
            condition_ids=condition_ids,
            overwrite=args.overwrite,
            row_group_size=args.row_group_size,
            compression=args.compression,
        )
    )


def _tui(args: argparse.Namespace) -> None:
    try:
        from .tui.app import run_tui
    except ImportError as exc:
        raise SystemExit(
            "TUI dependencies are not installed. Run: uv sync --group tui"
        ) from exc
    run_tui(initial_zarr=args.zarr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Write browser-oriented SpatialData vector optimization artifacts "
            "(Morton-sorted Points Parquet and multiscale metadata)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_EPILOG,
    )
    subparsers = parser.add_subparsers(dest="command", required=True, metavar="command")

    list_points = subparsers.add_parser(
        "list-points",
        help="list Points element keys in a SpatialData Zarr store",
        description="List Points element keys under <zarr>/points/.",
    )
    list_points.add_argument(
        "zarr",
        metavar="ZARR",
        help="Path to a SpatialData Zarr store (directory containing points/)",
    )
    list_points.set_defaults(func=_list_points)

    morton_from_zarr = subparsers.add_parser(
        "morton-points-from-zarr",
        help="Morton-sort a Points element from a SpatialData Zarr store",
        description=(
            "Read points/<key>/points.parquet from a SpatialData Zarr store, "
            "add morton_code_2d sentinel rows, and write Vitessce-compatible Parquet. "
            "Defaults to in-place replacement of points/<key>/points.parquet."
        ),
    )
    morton_from_zarr.add_argument(
        "zarr",
        metavar="ZARR",
        help="Path to a SpatialData Zarr store",
    )
    morton_from_zarr.add_argument(
        "--experimental",
        action="store_true",
        help="Write to points.experimental/<key>/points.parquet instead of canonical path",
    )
    morton_from_zarr.add_argument(
        "--points-key",
        metavar="KEY",
        help=(
            "Points element name under points/ (for example transcripts). "
            "Required when the store has more than one Points element."
        ),
    )
    morton_from_zarr.add_argument(
        "--output",
        metavar="PATH",
        help=(
            "Output Parquet path (default: in-place on points/<key>/points.parquet, "
            "or points.experimental/<key>/points.parquet with --experimental)"
        ),
    )
    morton_from_zarr.add_argument(
        "--feature-key",
        metavar="COLUMN",
        help=(
            "Column used to derive <feature_key>_codes (default: spatialdata_attrs.feature_key "
            "from the element zarr.json)"
        ),
    )
    morton_from_zarr.add_argument(
        "--row-group-size",
        type=_positive_int,
        default=50_000,
        metavar="N",
        help="Target row-group size after sentinel rows (default: 50000)",
    )
    morton_from_zarr.add_argument(
        "--compression",
        default="zstd",
        help="Parquet compression codec (default: zstd)",
    )
    morton_from_zarr.set_defaults(func=_morton_points_from_zarr)

    morton = subparsers.add_parser(
        "morton-points",
        help="Morton-sort points from CSV or Parquet",
        description=(
            "Sort x/y points by 2D Morton order, prepend sentinel bbox rows, "
            "and write Vitessce-compatible Parquet."
        ),
    )
    morton.add_argument(
        "input",
        metavar="INPUT",
        help="Input .csv, .parquet file, or directory of Parquet parts",
    )
    morton.add_argument(
        "output",
        metavar="OUTPUT",
        help="Output .parquet file",
    )
    morton.add_argument(
        "--feature-key",
        metavar="COLUMN",
        help="Column used to derive <feature_key>_codes for categorical features",
    )
    morton.add_argument(
        "--row-group-size",
        type=_positive_int,
        default=50_000,
        metavar="N",
        help="Target row-group size after sentinel rows (default: 50000)",
    )
    morton.add_argument(
        "--compression",
        default="zstd",
        help="Parquet compression codec (default: zstd)",
    )
    morton.set_defaults(func=_morton_points)

    multiscale = subparsers.add_parser(
        "multiscale-points",
        help="write multiscale Points Parquet with spatialdata_multiscale metadata",
        description=(
            "Write Points Parquet with Padua-style spatialdata_multiscale JSON "
            "stored in the file schema metadata."
        ),
    )
    multiscale.add_argument(
        "input",
        metavar="INPUT",
        help="Input .csv, .parquet file, or directory of Parquet parts",
    )
    multiscale.add_argument(
        "output",
        metavar="OUTPUT",
        help="Output .parquet file",
    )
    multiscale.add_argument(
        "--metadata-json",
        metavar="PATH",
        help="Optional spatialdata_multiscale metadata JSON (default: inferred from input)",
    )
    multiscale.add_argument(
        "--row-group-size",
        type=_positive_int,
        default=50_000,
        metavar="N",
        help="Target row-group size (default: 50000)",
    )
    multiscale.add_argument(
        "--compression",
        default="zstd",
        help="Parquet compression codec (default: zstd)",
    )
    multiscale.set_defaults(func=_multiscale_points)

    index_permutations = subparsers.add_parser(
        "write-index-permutations",
        help="write derivative Zarr with transcript index sort permutations",
        description=(
            "Copy a SpatialData Zarr store and add sibling points elements with "
            "different transcript sort/index layouts plus index-manifest.json."
        ),
    )
    index_permutations.add_argument("source_zarr", metavar="SOURCE_ZARR")
    index_permutations.add_argument("dest_zarr", metavar="DEST_ZARR")
    index_permutations.add_argument("--points-key", metavar="KEY")
    index_permutations.add_argument("--max-rows", type=_positive_int, metavar="N")
    index_permutations.add_argument(
        "--conditions",
        metavar="IDS",
        help="Comma-separated condition ids (default: all)",
    )
    index_permutations.add_argument("--overwrite", action="store_true")
    index_permutations.add_argument(
        "--row-group-size",
        type=_positive_int,
        default=50_000,
        metavar="N",
    )
    index_permutations.add_argument("--compression", default="zstd")
    index_permutations.set_defaults(func=_write_index_permutations)

    tui = subparsers.add_parser(
        "tui",
        help="interactive terminal workflow for writer commands",
        description="Launch a Textual workflow UI for SpatialData experimental writer commands.",
    )
    tui.add_argument(
        "zarr",
        nargs="?",
        metavar="ZARR",
        help="Optional SpatialData Zarr store path (skips initial store picker)",
    )
    tui.set_defaults(func=_tui)

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
