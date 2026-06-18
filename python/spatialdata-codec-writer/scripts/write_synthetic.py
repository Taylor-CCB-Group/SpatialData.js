#!/usr/bin/env python3
"""Write a synthetic tczyx volume as a SpatialData codec store."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = Path(__file__).resolve().parent
_SRC_DIR = str(_SCRIPTS_DIR.parent / "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from spatialdata_codec_writer.codecs import CODEC_HTJ2K_OPENJPH, CODEC_JPEG2K, CodecName
from spatialdata_codec_writer.htj2k_encode import htj2k_encode_available

from fixture_writer import WrittenFixture, write_codec_spatialdata
from synthetic_images import fractal_tczyx_image, mandelbrot_plane, volume_tczyx


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _tczyx_chunks(values: list[int]) -> tuple[int, int, int, int, int]:
    if len(values) != 5:
        raise argparse.ArgumentTypeError("chunks must contain exactly five integers: t c z y x")
    return (values[0], values[1], values[2], values[3], values[4])


def _default_spatial_chunk(size: int) -> int:
    if size >= 512:
        return 256
    if size >= 128:
        return 128
    return max(32, size)


def _build_volume(args: argparse.Namespace):
    pattern = args.pattern
    if pattern == "mandelbrot":
        plane = mandelbrot_plane(args.size)
        return plane.reshape(1, 1, 1, args.size, args.size)
    if pattern == "fractal":
        return fractal_tczyx_image(args.size)
    return volume_tczyx(
        args.size,
        t=args.t,
        c=args.c,
        z=args.z,
        pattern=pattern,
    )


def _encode_options(args: argparse.Namespace) -> dict[str, Any] | None:
    if args.codec != CODEC_HTJ2K_OPENJPH:
        return None
    if args.preset == "lossless" or args.reversible:
        return {"reversible": True}
    if args.quality is not None:
        return {"reversible": False, "quality": args.quality}
    preset_quality = {"balanced": 0.0002, "small": 0.001}.get(args.preset)
    if preset_quality is not None:
        return {"reversible": False, "quality": preset_quality}
    return {"reversible": True}


def _write(args: argparse.Namespace) -> WrittenFixture:
    if args.codec == CODEC_HTJ2K_OPENJPH and not htj2k_encode_available():
        raise SystemExit(
            "HTJ2K encode is not available. Install Node.js on PATH and vendor OpenJPH "
            "(node scripts/vendor-openjph-for-python.mjs from the monorepo root)."
        )

    if args.quality is not None and args.reversible:
        raise SystemExit("error: --quality cannot be used with --reversible")
    if args.quality is not None and args.codec != CODEC_HTJ2K_OPENJPH:
        raise SystemExit("error: --quality is for HTJ2K only")

    volume = _build_volume(args)
    chunks = args.chunks or (
        1,
        1,
        1,
        args.chunk_spatial,
        args.chunk_spatial,
    )

    return write_codec_spatialdata(
        args.output,
        codec=args.codec,
        image=volume,
        image_key=args.image_key,
        chunks=chunks,
        multiscale=args.multiscale,
        encode_options=_encode_options(args),
        overwrite=args.overwrite,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate and write a synthetic SpatialData codec image store",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("output", type=Path, help="Output .zarr store path")
    parser.add_argument(
        "--pattern",
        choices=["mandelbulb", "indexed", "mandelbrot", "fractal"],
        default="mandelbulb",
        help="Synthetic pattern (mandelbulb/indexed are multi-dimensional volumes)",
    )
    parser.add_argument("--size", type=_positive_int, default=128, help="Square y/x plane size")
    parser.add_argument("--t", type=_positive_int, default=1, help="Time axis length")
    parser.add_argument("--c", type=_positive_int, default=1, help="Channel axis length")
    parser.add_argument("--z", type=_positive_int, default=1, help="Z axis length")
    parser.add_argument("--image-key", default="synthetic", help="SpatialData image key")
    parser.add_argument(
        "--codec",
        choices=[CODEC_JPEG2K, CODEC_HTJ2K_OPENJPH],
        default=CODEC_HTJ2K_OPENJPH,
        help="Image codec id",
    )
    parser.add_argument(
        "--preset",
        choices=["lossless", "balanced", "small"],
        default="lossless",
        help="HTJ2K preset (ignored for JPEG2K)",
    )
    parser.add_argument(
        "--quality",
        type=float,
        metavar="Q",
        help="HTJ2K quantization factor (implies lossy; overrides --preset)",
    )
    parser.add_argument(
        "--reversible",
        action="store_true",
        help="Force lossless HTJ2K (default for lossless preset)",
    )
    parser.add_argument(
        "--chunk-spatial",
        type=_positive_int,
        help="Square y/x chunk size when --chunks is omitted (default depends on --size)",
    )
    parser.add_argument(
        "--chunks",
        type=int,
        nargs=5,
        metavar=("T", "C", "Z", "Y", "X"),
        help="Explicit tczyx chunk shape",
    )
    parser.add_argument("--multiscale", action="store_true", help="Write a 2× downsampled pyramid level")
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing store")
    parser.set_defaults(func=_write)
    return parser


def _normalize_argv(argv: list[str] | None) -> list[str]:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return argv


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(_normalize_argv(argv))
    if args.chunk_spatial is None:
        args.chunk_spatial = _default_spatial_chunk(args.size)
    if args.chunks is not None:
        args.chunks = _tczyx_chunks(list(args.chunks))
    written = args.func(args)
    print(json.dumps(written.manifest, indent=2, sort_keys=True))
    print(f"Wrote {written.store_path}", file=sys.stderr)
    print(f"Wrote {written.manifest_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
