from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .recompress import recompress_spatialdata


def _recompress_chunks(value: list[str] | None):
    if value is None:
        return None
    if len(value) == 1 and value[0] == "auto":
        return "auto"
    try:
        return tuple(int(part) for part in value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("chunks must be 'auto' or integer axis sizes") from exc


def _recompress(args: argparse.Namespace) -> None:
    if args.quality is not None and args.reversible:
        raise SystemExit("error: --quality cannot be used with --reversible")
    if args.quality is not None and args.codec == "imagecodecs_jpeg2k":
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
    )
    print(json.dumps(result.manifest, indent=2, sort_keys=True))


def _inspect(args: argparse.Namespace) -> None:
    manifest_path = Path(args.path)
    if manifest_path.is_dir():
        manifest_path = manifest_path.with_suffix(".manifest.json")
    print(manifest_path.read_text())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Recompress SpatialData/OME-Zarr image stores with optional codecs"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    recompress = subparsers.add_parser("recompress")
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
            "HTJ2K quantization factor (lower = better fidelity, larger output). "
            "Implies lossy encoding; use with --codec experimental.openjph_htj2k. "
            "Overrides preset quality."
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
        type=int,
        default=os.cpu_count() or 1,
        help="Parallel encoder workers (default: CPU count)",
    )
    recompress.set_defaults(func=_recompress)

    inspect = subparsers.add_parser("inspect")
    inspect.add_argument("path")
    inspect.set_defaults(func=_inspect)

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
