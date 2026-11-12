#!/usr/bin/env python3
"""Measure how far recompressed images are from the originals.

Compares the full-resolution level of each image present in both stores, block
by block through dask, so it works on images far larger than memory.

    python compare_images.py original.zarr converted.zarr
    python compare_images.py original.zarr converted.zarr --image morphology_focus

Prints JSON per image: max and mean absolute error, the source value range, and
whether the two are bit-identical. With --sibling output, pass --pair
original_key=converted_key.
Needs spatialdata, plus spatialdata-js-util installed so HTJ2K/JPEG 2000 decode.
"""

from __future__ import annotations

import argparse
import json

import dask.array as da
import spatialdata as sd


def full_resolution(element):
    """The level-0 array of a single-scale DataArray or a multiscale DataTree."""
    if hasattr(element, "children") and element.children:
        first = sorted(element.children)[0]
        return next(iter(element[first].data_vars.values())).data
    return element.data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("original")
    parser.add_argument("converted")
    parser.add_argument("--image", action="append", default=[], help="Limit to these image keys")
    parser.add_argument("--pair", action="append", default=[], help="original_key=converted_key")
    args = parser.parse_args()

    # Images only: shapes would be materialised in full, which large segmentations cannot afford.
    a = sd.read_zarr(args.original, selection=("images",))
    b = sd.read_zarr(args.converted, selection=("images",))
    pairs = dict(p.split("=", 1) for p in args.pair) or {k: k for k in a.images if k in b.images}
    if args.image:
        pairs = {k: v for k, v in pairs.items() if k in args.image}

    out = {}
    for src_key, dst_key in pairs.items():
        x, y = full_resolution(a.images[src_key]), full_resolution(b.images[dst_key])
        if x.shape != y.shape:
            out[src_key] = {"error": f"shape {x.shape} vs {y.shape}"}
            continue
        diff = da.absolute(x.astype("float64") - y.astype("float64"))
        max_err, mean_err, lo, hi = da.compute(diff.max(), diff.mean(), x.min(), x.max())
        out[src_key] = {
            "compared_with": dst_key,
            "dtype": str(x.dtype),
            "identical": bool(max_err == 0),
            "max_abs_error": float(max_err),
            "mean_abs_error": round(float(mean_err), 4),
            "source_range": [float(lo), float(hi)],
        }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
