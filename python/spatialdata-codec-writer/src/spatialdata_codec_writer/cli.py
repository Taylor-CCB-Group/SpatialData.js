from __future__ import annotations

import argparse
import json
from pathlib import Path

from .writer import write_codec_spatialdata, write_htj2k_fixture, write_jpeg2k_fixture


def _generate_fixtures(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    written = [write_jpeg2k_fixture(output_dir / "jpeg2k.zarr", overwrite=args.overwrite)]
    if args.experimental_htj2k:
        written.append(write_htj2k_fixture(output_dir / "htj2k.zarr", overwrite=args.overwrite))

    for fixture in written:
        print(f"Wrote {fixture.store_path}")
        print(f"Wrote {fixture.manifest_path}")


def _write(args: argparse.Namespace) -> None:
    fixture = write_codec_spatialdata(
        args.path,
        codec=args.codec,
        overwrite=args.overwrite,
        multiscale=not args.single_scale,
    )
    print(json.dumps(fixture.manifest, indent=2, sort_keys=True))


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
    write.add_argument(
        "--codec",
        choices=["imagecodecs_jpeg2k", "experimental.imagecodecs_htj2k"],
        default="imagecodecs_jpeg2k",
    )
    write.add_argument("--single-scale", action="store_true")
    write.add_argument("--overwrite", action="store_true")
    write.set_defaults(func=_write)

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

