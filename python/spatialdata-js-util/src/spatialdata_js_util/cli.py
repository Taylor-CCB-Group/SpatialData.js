"""Unified `spatialdata-js-util` command line.

Subcommands are grouped by what they act on:

    images   recompress rasters with browser-readable codecs
    points   Morton-index Points elements
    tables   convert table matrices to CSC
    codecs   inspect codec backend availability
    tui      interactive workflow UI
"""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .errors import WriterCommandError

_EPILOG = """\
examples:
  # Recompress every image in a store as lossy HTJ2K siblings
  spatialdata-js-util images recompress in.zarr out.zarr \\
    --codec experimental.openjph_htj2k --quality 0.0005 --sibling --overwrite

  # Morton-sort transcripts in place
  spatialdata-js-util points morton-from-zarr ~/data/xenium.zarr --points-key transcripts

  # Convert table matrices to CSC for fast per-gene reads in the browser
  spatialdata-js-util tables to-csc ~/data/xenium.zarr

  # Show which HTJ2K backend is in use
  spatialdata-js-util codecs info
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


# --------------------------------------------------------------------------- images


def _recompress_chunks(value: list[str] | None):
    if value is None:
        return None
    if len(value) == 1 and value[0] == "auto":
        return "auto"
    try:
        return tuple(int(part) for part in value)
    except ValueError as exc:
        # Called from the command body rather than as an argparse `type=`, so an
        # ArgumentTypeError here would surface as a traceback rather than a usage
        # error. Match how the rest of the command reports bad arguments.
        raise SystemExit("error: chunks must be 'auto' or integer axis sizes") from exc


def _images_recompress(args: argparse.Namespace) -> None:
    from .images import recompress_spatialdata

    if args.quality is not None and args.reversible:
        raise SystemExit("error: --quality cannot be used with --reversible")
    if args.quality is not None and args.codec != "experimental.openjph_htj2k":
        raise SystemExit(
            "error: --quality is for HTJ2K only; use --codec experimental.openjph_htj2k"
        )

    result = recompress_spatialdata(
        args.source,
        args.dest,
        config=args.config,
        overwrite=args.overwrite,
        image_key=args.image_key,
        codec=args.codec,
        preset=args.preset,
        chunks=_recompress_chunks(args.chunks),
        quality=args.quality,
        reversible=True if args.reversible else None,
        sibling=args.sibling,
        workers=args.workers,
        # Any explicit --pyramid-* option means the user wants pyramids, so the
        # bare --pyramid flag is a convenience rather than a requirement.
        pyramid=args.pyramid
        or args.pyramid_levels != "auto"
        or args.pyramid_downscale != 2
        or args.pyramid_min_size != 1024
        or args.pyramid_force,
        pyramid_levels=args.pyramid_levels,
        pyramid_downscale=args.pyramid_downscale,
        pyramid_min_size=args.pyramid_min_size,
        pyramid_force=args.pyramid_force,
    )
    _print_json(result.manifest)


def _pyramid_levels(value: str) -> int | str:
    if value == "auto":
        return "auto"
    try:
        parsed = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("--pyramid-levels must be 'auto' or an integer") from None
    if parsed < 1:
        raise argparse.ArgumentTypeError("--pyramid-levels must be at least 1")
    return parsed


def _add_pyramid_args(parser: argparse.ArgumentParser, *, with_flag: bool) -> None:
    if with_flag:
        parser.add_argument(
            "--pyramid",
            action="store_true",
            help=(
                "Build a multiscale pyramid for any image that has only one resolution "
                "level, before recompressing. Implied by the other --pyramid-* options."
            ),
        )
    parser.add_argument(
        "--pyramid-levels",
        type=_pyramid_levels,
        default="auto",
        metavar="N",
        help=(
            "Total resolution levels including full res, or 'auto' to halve until the "
            "largest spatial axis fits --pyramid-min-size (default: auto)"
        ),
    )
    parser.add_argument(
        "--pyramid-downscale",
        type=_positive_int,
        default=2,
        metavar="K",
        help="Downscale factor between levels (default: 2)",
    )
    parser.add_argument(
        "--pyramid-min-size",
        type=_positive_int,
        default=1024,
        metavar="PX",
        help="Stop 'auto' once the largest spatial axis is this size or smaller (default: 1024)",
    )
    parser.add_argument(
        "--pyramid-force",
        action="store_true",
        help="Rebuild pyramids for images that already have more than one level",
    )


def _images_add_pyramid(args: argparse.Namespace) -> None:
    from .pyramids import add_pyramids

    def command() -> dict[str, Any]:
        return add_pyramids(
            args.source,
            args.dest,
            image_keys=args.image_key.split(",") if args.image_key else None,
            include_labels=args.labels,
            levels=args.pyramid_levels,
            downscale=args.pyramid_downscale,
            min_size=args.pyramid_min_size,
            force=args.pyramid_force,
            overwrite=args.overwrite,
        ).manifest

    _run_command(command)


def _images_inspect(args: argparse.Namespace) -> None:
    manifest_path = Path(args.path)
    if manifest_path.is_dir():
        manifest_path = manifest_path.with_suffix(".manifest.json")
    print(manifest_path.read_text())


def _add_images_commands(subparsers: argparse._SubParsersAction) -> None:
    images = subparsers.add_parser(
        "images",
        help="recompress rasters with browser-readable codecs",
        description="Recompress SpatialData/OME-Zarr image stores.",
    )
    image_commands = images.add_subparsers(dest="images_command", required=True, metavar="command")

    recompress = image_commands.add_parser(
        "recompress",
        help="rewrite image rasters with JPEG 2000 or HTJ2K",
        description=(
            "Copy a SpatialData store and recompress configured image rasters. "
            "Tables, shapes, points, and unconfigured rasters are preserved."
        ),
    )
    recompress.add_argument("source", help="Existing SpatialData Zarr store")
    recompress.add_argument("dest", help="Output SpatialData Zarr store")
    recompress.add_argument("--config", help="JSON recompression config")
    recompress.add_argument(
        "--image-key",
        help="Apply convenience flags to one image only (default: all images)",
    )
    recompress.add_argument(
        "--codec",
        choices=["imagecodecs_jpeg2k", "experimental.openjph_htj2k"],
        help="Image codec (all images unless --image-key is set)",
    )
    recompress.add_argument(
        "--preset",
        choices=["lossless", "balanced", "small"],
        help="Named image preset (ignored when --quality is set)",
    )
    recompress.add_argument(
        "--quality",
        type=float,
        metavar="Q",
        help=(
            "HTJ2K quantization step, relative to the dtype's full range "
            "(lower = better fidelity, larger output). Implies lossy encoding; use "
            "with --codec experimental.openjph_htj2k. Overrides preset quality. "
            "Below one input LSB (1/256 for 8-bit, 1/65536 for 16-bit) the output "
            "is bit-identical but LARGER than --preset lossless; that warns."
        ),
    )
    recompress.add_argument(
        "--reversible",
        action="store_true",
        help="Force lossless HTJ2K (cannot be combined with --quality)",
    )
    recompress.add_argument(
        "--chunks",
        nargs="+",
        metavar="CHUNK",
        help="Use 'auto' or pass one integer per raster axis",
    )
    recompress.add_argument("--overwrite", action="store_true")
    recompress.add_argument(
        "--sibling",
        action="store_true",
        help=(
            "Write compressed images as new sibling groups (e.g. morphology_focus:jp2k_lossless) "
            "instead of replacing the originals in-place"
        ),
    )
    recompress.add_argument(
        "--workers",
        type=_positive_int,
        default=os.cpu_count() or 1,
        help="Parallel encoder workers (default: CPU count)",
    )
    _add_pyramid_args(recompress, with_flag=True)
    recompress.set_defaults(func=_images_recompress)

    add_pyramid = image_commands.add_parser(
        "add-pyramid",
        help="give single-resolution rasters a multiscale pyramid",
        description=(
            "Copy a store and add multiscale pyramids to rasters that have only one "
            "resolution level, so a zoomed-out browser view does not have to read "
            "full-resolution chunks. Codecs are left unchanged; use "
            "'images recompress --pyramid' to do both in one pass."
        ),
    )
    add_pyramid.add_argument("source", help="Existing SpatialData Zarr store")
    add_pyramid.add_argument("dest", help="Output SpatialData Zarr store")
    add_pyramid.add_argument(
        "--image-key",
        metavar="KEYS",
        help="Comma-separated image element names (default: all images)",
    )
    add_pyramid.add_argument(
        "--labels",
        action="store_true",
        help="Also build pyramids for labels (downsampled without inventing label ids)",
    )
    add_pyramid.add_argument("--overwrite", action="store_true")
    _add_pyramid_args(add_pyramid, with_flag=False)
    add_pyramid.set_defaults(func=_images_add_pyramid)

    inspect = image_commands.add_parser(
        "inspect",
        help="print a recompression manifest",
    )
    inspect.add_argument("path")
    inspect.set_defaults(func=_images_inspect)


# --------------------------------------------------------------------------- points


def _points_list(args: argparse.Namespace) -> None:
    from .runners import run_list_points

    _run_command(lambda: run_list_points(args.zarr))


def _points_morton(args: argparse.Namespace) -> None:
    from .runners import run_morton_points

    _run_command(
        lambda: run_morton_points(
            args.input,
            args.output,
            feature_key=args.feature_key,
            row_group_size=args.row_group_size,
            compression=args.compression,
        )
    )


def _points_multiscale(args: argparse.Namespace) -> None:
    from .runners import run_multiscale_points

    _run_command(
        lambda: run_multiscale_points(
            args.input,
            args.output,
            metadata_json=args.metadata_json,
            row_group_size=args.row_group_size,
            compression=args.compression,
        )
    )


def _points_morton_from_zarr(args: argparse.Namespace) -> None:
    from .runners import run_morton_points_from_zarr

    _run_command(
        lambda: run_morton_points_from_zarr(
            args.zarr,
            points_key=args.points_key,
            experimental=args.experimental,
            output=args.output,
            output_points_key=args.output_points_key,
            feature_key=args.feature_key,
            overwrite=args.overwrite,
            row_group_size=args.row_group_size,
            compression=args.compression,
        )
    )


def _points_index_permutations(args: argparse.Namespace) -> None:
    from .runners import run_write_index_permutations

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


def _add_row_group_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--row-group-size",
        type=_positive_int,
        default=50_000,
        metavar="N",
        help="Target row-group size after sentinel rows (default: 50000)",
    )
    parser.add_argument(
        "--compression",
        default="zstd",
        help="Parquet compression codec (default: zstd)",
    )


def _add_points_commands(subparsers: argparse._SubParsersAction) -> None:
    points = subparsers.add_parser(
        "points",
        help="Morton-index Points elements for spatial browser reads",
        description=(
            "Write browser-oriented Points artifacts: Morton-sorted Parquet with "
            "sentinel bounding-box rows and controlled row groups."
        ),
    )
    point_commands = points.add_subparsers(dest="points_command", required=True, metavar="command")

    list_points = point_commands.add_parser(
        "list",
        help="list Points element keys in a store",
        description="List Points element keys under <zarr>/points/.",
    )
    list_points.add_argument("zarr", metavar="ZARR", help="Path to a SpatialData Zarr store")
    list_points.set_defaults(func=_points_list)

    morton_from_zarr = point_commands.add_parser(
        "morton-from-zarr",
        help="Morton-sort a Points element from a store",
        description=(
            "Read points/<key>/points.parquet from a SpatialData Zarr store, "
            "add morton_code_2d sentinel rows, and write Vitessce-compatible Parquet. "
            "Defaults to in-place replacement of points/<key>/points.parquet."
        ),
    )
    morton_from_zarr.add_argument("zarr", metavar="ZARR", help="Path to a SpatialData Zarr store")
    morton_from_zarr.add_argument(
        "--experimental",
        action="store_true",
        help="Write to points.experimental/<key>/points.parquet instead of the canonical path",
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
        "--output-points-key",
        metavar="KEY",
        help=(
            "Output Points element name under points/ (for example transcripts_morton). "
            "Cannot be combined with --output."
        ),
    )
    morton_from_zarr.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow overwriting an existing explicit output path or output Points element.",
    )
    morton_from_zarr.add_argument(
        "--feature-key",
        metavar="COLUMN",
        help=(
            "Column used to derive <feature_key>_codes (default: spatialdata_attrs.feature_key "
            "from the element zarr.json)"
        ),
    )
    _add_row_group_args(morton_from_zarr)
    morton_from_zarr.set_defaults(func=_points_morton_from_zarr)

    morton = point_commands.add_parser(
        "morton",
        help="Morton-sort points from CSV or Parquet",
        description=(
            "Sort x/y points by 2D Morton order, prepend sentinel bbox rows, "
            "and write Vitessce-compatible Parquet."
        ),
    )
    morton.add_argument(
        "input", metavar="INPUT", help="Input .csv, .parquet file, or directory of Parquet parts"
    )
    morton.add_argument("output", metavar="OUTPUT", help="Output .parquet file")
    morton.add_argument(
        "--feature-key",
        metavar="COLUMN",
        help="Column used to derive <feature_key>_codes for categorical features",
    )
    _add_row_group_args(morton)
    morton.set_defaults(func=_points_morton)

    multiscale = point_commands.add_parser(
        "multiscale",
        help="write multiscale Points Parquet with spatialdata_multiscale metadata",
        description=(
            "Write Points Parquet with Padua-style spatialdata_multiscale JSON "
            "stored in the file schema metadata."
        ),
    )
    multiscale.add_argument(
        "input", metavar="INPUT", help="Input .csv, .parquet file, or directory of Parquet parts"
    )
    multiscale.add_argument("output", metavar="OUTPUT", help="Output .parquet file")
    multiscale.add_argument(
        "--metadata-json",
        metavar="PATH",
        help="Optional spatialdata_multiscale metadata JSON (default: inferred from input)",
    )
    _add_row_group_args(multiscale)
    multiscale.set_defaults(func=_points_multiscale)

    index_permutations = point_commands.add_parser(
        "index-permutations",
        help="write a derivative store with transcript index sort permutations",
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
        "--conditions", metavar="IDS", help="Comma-separated condition ids (default: all)"
    )
    index_permutations.add_argument("--overwrite", action="store_true")
    _add_row_group_args(index_permutations)
    index_permutations.set_defaults(func=_points_index_permutations)


# --------------------------------------------------------------------------- tables


def _tables_list(args: argparse.Namespace) -> None:
    from .runners import run_list_tables

    _run_command(lambda: run_list_tables(args.zarr))


def _tables_to_csc(args: argparse.Namespace) -> None:
    from .runners import run_tables_to_csc

    _run_command(
        lambda: run_tables_to_csc(
            args.source,
            args.dest,
            tables=args.table.split(",") if args.table else None,
            layers=not args.no_layers,
            densify=args.densify,
            overwrite=args.overwrite,
        )
    )


def _add_tables_commands(subparsers: argparse._SubParsersAction) -> None:
    tables = subparsers.add_parser(
        "tables",
        help="convert table matrices to CSC",
        description="Rewrite AnnData table matrices for fast per-variable browser reads.",
    )
    table_commands = tables.add_subparsers(dest="tables_command", required=True, metavar="command")

    list_tables = table_commands.add_parser(
        "list", help="list table element keys in a store"
    )
    list_tables.add_argument("zarr", metavar="ZARR", help="Path to a SpatialData Zarr store")
    list_tables.set_defaults(func=_tables_list)

    to_csc = table_commands.add_parser(
        "to-csc",
        help="convert X (and layers) to CSC",
        description=(
            "Convert table matrices from CSR to CSC so that reading one variable "
            "(gene) is a single contiguous range read instead of a scan of every row. "
            "Values are unchanged and the result stays readable by any AnnData client."
        ),
    )
    to_csc.add_argument("source", metavar="SOURCE", help="SpatialData Zarr store")
    to_csc.add_argument(
        "dest",
        metavar="DEST",
        nargs="?",
        help="Output store (default: rewrite SOURCE in place)",
    )
    to_csc.add_argument(
        "--table",
        metavar="KEYS",
        help="Comma-separated table element names (default: all tables)",
    )
    to_csc.add_argument(
        "--no-layers",
        action="store_true",
        help="Convert X only, leaving adata.layers untouched",
    )
    to_csc.add_argument(
        "--densify",
        action="store_true",
        help=(
            "Also convert dense matrices to CSC. Off by default because sparsifying "
            "a dense matrix can make it larger."
        ),
    )
    to_csc.add_argument("--overwrite", action="store_true", help="Replace an existing DEST")
    to_csc.set_defaults(func=_tables_to_csc)


# --------------------------------------------------------------------------- codecs


def _codecs_info(_args: argparse.Namespace) -> None:
    from .codecs.backends import backend_report

    _print_json(backend_report())


def _add_codecs_commands(subparsers: argparse._SubParsersAction) -> None:
    codecs = subparsers.add_parser(
        "codecs",
        help="inspect image codec backends",
        description="Report which HTJ2K backends are installed and which one is selected.",
    )
    codec_commands = codecs.add_subparsers(dest="codecs_command", required=True, metavar="command")

    info = codec_commands.add_parser(
        "info",
        help="show HTJ2K backend availability and probe results",
        description=(
            "Show each HTJ2K backend's availability and whether it decodes the bundled "
            "multi-component probe codestream correctly, plus which one is selected."
        ),
    )
    info.set_defaults(func=_codecs_info)


# --------------------------------------------------------------------------- tui


def _tui(args: argparse.Namespace) -> None:
    try:
        from .tui.app import run_tui
    except ImportError as exc:
        raise SystemExit(
            "TUI dependencies are not installed. Install with: pip install 'spatialdata-js-util[tui]'"
        ) from exc
    run_tui(initial_zarr=args.zarr)


def _add_tui_command(subparsers: argparse._SubParsersAction) -> None:
    tui = subparsers.add_parser(
        "tui",
        help="interactive terminal UI for every command",
        description=(
            "Launch the interactive workflow UI. It covers image recompression, "
            "Points indexing, table CSC conversion, and codec backend info, with "
            "guided forms, confirmation before any in-place write, and post-write "
            "verification. Requires the 'tui' extra: "
            "pip install 'spatialdata-js-util[tui]'"
        ),
    )
    tui.add_argument(
        "zarr",
        nargs="?",
        metavar="ZARR",
        help="Optional SpatialData Zarr store path (skips initial store picker)",
    )
    tui.set_defaults(func=_tui)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="spatialdata-js-util",
        description=(
            "Read/write utilities for browser-oriented SpatialData stores: image "
            "codecs, Morton-indexed points, and CSC table matrices."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_EPILOG,
    )
    subparsers = parser.add_subparsers(dest="group", required=True, metavar="group")
    _add_images_commands(subparsers)
    _add_points_commands(subparsers)
    _add_tables_commands(subparsers)
    _add_codecs_commands(subparsers)
    _add_tui_command(subparsers)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
