from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .recompress import recompress_spatialdata
from .writer import (
    htj2k_encode_available,
    write_codec_spatialdata,
    write_codec_spatialdata_image,
    write_htj2k_fixture,
    write_jpeg2k_fixture,
)


def _chunks(value: list[int]) -> tuple[int, int, int, int, int]:
    if len(value) != 5:
        raise argparse.ArgumentTypeError("chunks must contain exactly five integers: t c z y x")
    return (value[0], value[1], value[2], value[3], value[4])


def _recompress_chunks(value: list[str] | None):
    if value is None:
        return None
    if len(value) == 1 and value[0] == "auto":
        return "auto"
    try:
        return tuple(int(part) for part in value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("chunks must be 'auto' or integer axis sizes") from exc


def _generate_fixtures(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    written = [write_jpeg2k_fixture(output_dir / "jpeg2k.zarr", overwrite=args.overwrite)]
    if args.experimental_htj2k:
        if htj2k_encode_available():
            written.append(write_htj2k_fixture(output_dir / "htj2k.zarr", overwrite=args.overwrite))
        else:
            print(
                "Skipping htj2k.zarr: imagecodecs HTJ2K encode is not available in this environment.",
                file=sys.stderr,
            )

    for fixture in written:
        print(f"Wrote {fixture.store_path}")
        print(f"Wrote {fixture.manifest_path}")


def _write(args: argparse.Namespace) -> None:
    fixture = write_codec_spatialdata(
        args.path,
        codec=args.codec,
        image_key=args.image_key,
        chunks=_chunks(args.chunks),
        overwrite=args.overwrite,
        multiscale=not args.single_scale,
    )
    print(json.dumps(fixture.manifest, indent=2, sort_keys=True))


def _write_image(args: argparse.Namespace) -> None:
    fixture = write_codec_spatialdata_image(
        args.path,
        args.source,
        image_key=args.image_key,
        codec=args.codec,
        chunks=_chunks(args.chunks),
        overwrite=args.overwrite,
        multiscale=not args.single_scale,
    )
    print(json.dumps(fixture.manifest, indent=2, sort_keys=True))


def _recompress(args: argparse.Namespace) -> None:
    result = recompress_spatialdata(
        args.source,
        args.dest,
        config=args.config,
        overwrite=args.overwrite,
        image_key=args.image_key,
        codec=args.codec,
        preset=args.preset,
        chunks=_recompress_chunks(args.chunks),
        sibling=args.sibling,
    )
    print(json.dumps(result.manifest, indent=2, sort_keys=True))


def _inspect(args: argparse.Namespace) -> None:
    manifest_path = Path(args.path)
    if manifest_path.is_dir():
        manifest_path = manifest_path.with_suffix(".manifest.json")
    print(manifest_path.read_text())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Write SpatialData codec fixtures")
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate-fixtures")
    generate.add_argument("--output-dir", default="test-fixtures/codecs")
    generate.add_argument("--overwrite", action="store_true")
    generate.add_argument("--experimental-htj2k", action="store_true")
    generate.set_defaults(func=_generate_fixtures)

    write = subparsers.add_parser("write")
    write.add_argument("path")
    write.add_argument("--image-key", default="codec_image")
    write.add_argument(
        "--codec",
        choices=["imagecodecs_jpeg2k", "experimental.imagecodecs_htj2k"],
        default="imagecodecs_jpeg2k",
    )
    write.add_argument(
        "--chunks",
        nargs=5,
        type=int,
        default=[1, 1, 1, 32, 32],
        metavar=("T", "C", "Z", "Y", "X"),
    )
    write.add_argument("--single-scale", action="store_true")
    write.add_argument("--overwrite", action="store_true")
    write.set_defaults(func=_write)

    write_image = subparsers.add_parser("write-image")
    write_image.add_argument("source", help="Existing SpatialData Zarr store")
    write_image.add_argument("path", help="Output SpatialData Zarr store")
    write_image.add_argument("--image-key", required=True)
    write_image.add_argument(
        "--codec",
        choices=["imagecodecs_jpeg2k", "experimental.imagecodecs_htj2k"],
        default="imagecodecs_jpeg2k",
    )
    write_image.add_argument(
        "--chunks",
        nargs=5,
        type=int,
        default=[1, 1, 1, 32, 32],
        metavar=("T", "C", "Z", "Y", "X"),
    )
    write_image.add_argument("--single-scale", action="store_true")
    write_image.add_argument("--overwrite", action="store_true")
    write_image.set_defaults(func=_write_image)

    recompress = subparsers.add_parser("recompress")
    recompress.add_argument("source", help="Existing SpatialData Zarr store")
    recompress.add_argument("dest", help="Output SpatialData Zarr store")
    recompress.add_argument("--config", help="JSON recompression config")
    recompress.add_argument("--image-key", help="Convenience shortcut for one image")
    recompress.add_argument(
        "--codec",
        choices=["imagecodecs_jpeg2k", "experimental.imagecodecs_htj2k"],
        help="Image codec for --image-key",
    )
    recompress.add_argument(
        "--preset",
        choices=["lossless", "balanced", "small"],
        help="Image preset for --image-key",
    )
    recompress.add_argument(
        "--chunks",
        nargs="+",
        metavar="CHUNK",
        help="Use 'auto' or pass one integer per raster axis for --image-key",
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
