from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import pandas as pd

from .index_permutations import DEFAULT_CONDITIONS, write_index_permutations
from .points import (
    build_spatialdata_multiscale_metadata,
    write_morton_points_parquet,
    write_multiscale_points_parquet,
)
from .zarr import (
    list_points_keys,
    points_parquet_path,
    read_points_dataframe,
    read_points_element_attrs,
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
"""


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _read_dataframe(path: str) -> pd.DataFrame:
    input_path = Path(path)
    if input_path.is_dir():
        return read_points_dataframe(input_path)
    suffix = input_path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(input_path)
    if suffix in {".parquet", ".pq"}:
        return pd.read_parquet(input_path)
    raise SystemExit(
        f"Unsupported input: {path}\n"
        "Expected a .csv file, .parquet file, or a directory of Parquet parts."
    )


def _morton_points(args: argparse.Namespace) -> None:
    df = _read_dataframe(args.input)
    sorted_df = write_morton_points_parquet(
        df,
        args.output,
        feature_key=args.feature_key,
        row_group_size=args.row_group_size,
        compression=args.compression,
    )
    print(
        json.dumps(
            {
                "format": "morton-points",
                "rows": int(len(sorted_df)),
                "output": str(args.output),
                "row_group_size": args.row_group_size,
            },
            indent=2,
            sort_keys=True,
        )
    )


def _multiscale_points(args: argparse.Namespace) -> None:
    df = _read_dataframe(args.input)
    if args.metadata_json:
        metadata = json.loads(Path(args.metadata_json).read_text())
    else:
        metadata = build_spatialdata_multiscale_metadata(df)
    write_multiscale_points_parquet(
        df,
        args.output,
        metadata=metadata,
        row_group_size=args.row_group_size,
        compression=args.compression,
    )
    print(
        json.dumps(
            {
                "format": "spatialdata_multiscale_points",
                "rows": int(len(df)),
                "output": str(args.output),
                "row_group_size": args.row_group_size,
            },
            indent=2,
            sort_keys=True,
        )
    )


def _list_points(args: argparse.Namespace) -> None:
    keys = list_points_keys(args.zarr)
    if not keys:
        raise SystemExit(f"No Points elements found under {Path(args.zarr) / 'points'}")
    print(json.dumps({"zarr": str(args.zarr), "points_keys": keys}, indent=2, sort_keys=True))


def _morton_points_from_zarr(args: argparse.Namespace) -> None:
    zarr_path = Path(args.zarr)
    keys = list_points_keys(zarr_path)
    if not keys:
        raise SystemExit(f"No Points elements found under {zarr_path / 'points'}")

    points_key = args.points_key
    if points_key is None:
        if len(keys) == 1:
            points_key = keys[0]
        else:
            raise SystemExit(
                "Multiple Points elements found; pass --points-key.\n"
                f"Available keys: {', '.join(keys)}"
            )
    if points_key not in keys:
        raise SystemExit(
            f"Unknown Points element {points_key!r}.\nAvailable keys: {', '.join(keys)}"
        )

    attrs = read_points_element_attrs(zarr_path, points_key)
    feature_key = args.feature_key or attrs.get("feature_key")
    source_parquet = points_parquet_path(zarr_path, points_key)
    if args.output:
        output = Path(args.output)
    elif args.experimental:
        output = zarr_path / "points.experimental" / points_key / "points.parquet"
    else:
        output = source_parquet

    df = read_points_dataframe(source_parquet)
    if output.exists():
        if output.is_dir():
            shutil.rmtree(output)
        else:
            output.unlink()
    sorted_df = write_morton_points_parquet(
        df,
        output,
        feature_key=feature_key,
        row_group_size=args.row_group_size,
        compression=args.compression,
    )
    print(
        json.dumps(
            {
                "format": "morton-points",
                "zarr": str(zarr_path),
                "points_key": points_key,
                "source": str(source_parquet),
                "output": str(output),
                "in_place": not args.experimental and args.output is None,
                "feature_key": feature_key,
                "rows": int(len(sorted_df)),
                "row_group_size": args.row_group_size,
            },
            indent=2,
            sort_keys=True,
        )
    )


def _write_index_permutations(args: argparse.Namespace) -> None:
    condition_ids = args.conditions.split(",") if args.conditions else None
    selected = None
    if condition_ids:
        by_id = {condition.id: condition for condition in DEFAULT_CONDITIONS}
        missing = [value for value in condition_ids if value not in by_id]
        if missing:
            raise SystemExit(f"Unknown conditions: {', '.join(missing)}")
        selected = tuple(by_id[value] for value in condition_ids)

    manifest = write_index_permutations(
        args.source_zarr,
        args.dest_zarr,
        points_key=args.points_key,
        max_rows=args.max_rows,
        conditions=selected,
        overwrite=args.overwrite,
        row_group_size=args.row_group_size,
        compression=args.compression,
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))


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

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
