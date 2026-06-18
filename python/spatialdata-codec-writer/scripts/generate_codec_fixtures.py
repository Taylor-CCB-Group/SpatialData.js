#!/usr/bin/env python3
"""Generate codec test fixtures for the SpatialData.ts monorepo (dev-only)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow imports from this scripts package when run via uv/python -m
_SCRIPTS_DIR = Path(__file__).resolve().parent
_SRC_DIR = str(_SCRIPTS_DIR.parent / "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from spatialdata_codec_writer.htj2k_encode import htj2k_encode_available

from fixture_writer import write_jpeg2k_fixture
from htj2k_fixtures import (
    write_htj2k_encode_demo_fixtures,
    write_htj2k_fixture,
    write_htj2k_quality_sweep_manifest,
)
from mandelbulb_fixtures import write_mandelbulb_fixture


def _chunks(value: list[int]) -> tuple[int, int, int, int, int]:
    if len(value) != 5:
        raise argparse.ArgumentTypeError("chunks must contain exactly five integers: t c z y x")
    return (value[0], value[1], value[2], value[3], value[4])


def _generate_fixtures(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    written = [write_jpeg2k_fixture(output_dir / "jpeg2k.zarr", overwrite=args.overwrite)]
    if args.experimental_htj2k:
        if htj2k_encode_available():
            written.append(
                write_mandelbulb_fixture(output_dir / "mandelbulb.zarr", overwrite=args.overwrite)
            )
            written.append(write_htj2k_fixture(output_dir / "htj2k.zarr", overwrite=args.overwrite))
            sweep_path = write_htj2k_quality_sweep_manifest(
                output_dir / "htj2k-quality-sweep.manifest.json"
            )
            print(f"Wrote {sweep_path}")
            demo_path = write_htj2k_encode_demo_fixtures(output_dir, overwrite=args.overwrite)
            print(f"Wrote {demo_path}")
        else:
            print(
                "Skipping mandelbulb.zarr and htj2k.zarr: OpenJPH WASM HTJ2K encoder is not available.",
                file=sys.stderr,
            )

    for fixture in written:
        print(f"Wrote {fixture.store_path}")
        print(f"Wrote {fixture.manifest_path}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate SpatialData codec test fixtures")
    parser.add_argument("--output-dir", default="test-fixtures/codecs")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--experimental-htj2k", action="store_true")
    parser.set_defaults(func=_generate_fixtures)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
