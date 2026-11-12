#!/usr/bin/env python3
"""Report what in a local SpatialData store is ready for browser reading.

Reads only the store's consolidated metadata (and Parquet footers, when pyarrow
is installed), so it is fast on any size of store and never modifies it.

    python inspect_store.py path/to/store.zarr

Prints JSON: one entry per element with the facts that decide whether
spatialdata-js-util should touch it, and a `suggest` list naming the command.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BROWSER_CODECS = {"experimental.openjph_htj2k", "imagecodecs_jpeg2k", "imagecodecs_jpeg2k_v2"}
CODEC_DTYPES = {"uint8", "int8", "uint16", "int16"}
PYRAMID_TARGET = 1024  # spatialdata-js-util's default --pyramid-min-size

V2_DTYPES = {"|u1": "uint8", "|i1": "int8", "<u2": "uint16", "<i2": "int16",
             "<u4": "uint32", "<i4": "int32", "<f4": "float32", "<f8": "float64"}


def load_metadata(store: Path) -> tuple[int, dict]:
    """Return (zarr_format, {node_path: metadata}) from consolidated metadata."""
    root = store / "zarr.json"
    if root.exists():
        doc = json.loads(root.read_text())
        consolidated = doc.get("consolidated_metadata") or {}
        if not consolidated.get("metadata"):
            raise SystemExit(f"{store}: no consolidated metadata in zarr.json; "
                             "browsers cannot open it over HTTP until it has some")
        return 3, consolidated["metadata"]
    for name in ("zmetadata", ".zmetadata"):
        path = store / name
        if path.exists():
            flat = json.loads(path.read_text())["metadata"]
            nodes: dict[str, dict] = {}
            for key, value in flat.items():
                node, _, kind = key.rpartition("/")
                entry = nodes.setdefault(node, {})
                if kind == ".zarray":
                    entry.update(node_type="array", **value)
                elif kind == ".zgroup":
                    entry.setdefault("node_type", "group")
                elif kind == ".zattrs":
                    entry["attributes"] = value
            return 2, nodes
    raise SystemExit(f"{store}: no zarr.json or zmetadata; is this a SpatialData .zarr store?")


def codec_names(meta: dict) -> list[str]:
    if "codecs" in meta:  # v3, possibly sharded
        names = []
        for codec in meta["codecs"]:
            names.append(codec["name"])
            names += [c["name"] for c in codec.get("configuration", {}).get("codecs", [])]
        return names
    compressor = meta.get("compressor") or {}  # v2
    return [compressor.get("id", "none")]


def dtype_of(meta: dict) -> str:
    raw = meta.get("data_type") or meta.get("dtype")
    return V2_DTYPES.get(raw, raw) if isinstance(raw, str) else str(raw)


def raster_report(name: str, kind: str, nodes: dict) -> dict:
    group = nodes.get(f"{kind}/{name}", {})
    attrs = group.get("attributes", {})
    multiscales = (attrs.get("ome") or attrs).get("multiscales") or [{}]
    paths = [d["path"] for d in multiscales[0].get("datasets", [])] or [""]
    levels = [nodes.get(f"{kind}/{name}/{p}".rstrip("/"), {}) for p in paths]
    full = levels[0]
    shape = full.get("shape", [])
    axes = [a["name"] if isinstance(a, dict) else a for a in multiscales[0].get("axes", [])]
    coarsest = levels[-1].get("shape", shape)
    spatial = [n for n, a in zip(coarsest, axes) if a in ("x", "y")] or coarsest[-2:]
    dtype = dtype_of(full)
    codecs = codec_names(full)
    report = {"element": f"{kind}/{name}", "dtype": dtype, "shape": shape, "axes": axes,
              "levels": len(paths), "codecs": codecs, "suggest": []}
    # Mirrors spatialdata-js-util >= 0.3: shallow pyramids are extended too.
    if spatial and max(spatial) > PYRAMID_TARGET:
        report["suggest"].append("add pyramid (images recompress --pyramid, or images add-pyramid"
                                 + (" --labels" if kind == "labels" else "") + ")")
    if kind == "images":
        if not BROWSER_CODECS & set(codecs):
            if dtype in CODEC_DTYPES:
                report["suggest"].append("recompress (images recompress --codec ...)")
            else:
                report["note"] = (f"{dtype} is not eligible for the browser image codecs "
                                  f"({', '.join(sorted(CODEC_DTYPES))}); leave it out with --image-key or a config")
    return report


def points_report(name: str, store: Path, nodes: dict) -> dict:
    attrs = nodes.get(f"points/{name}", {}).get("attributes", {})
    sd_attrs = attrs.get("spatialdata_attrs", {})
    report = {"element": f"points/{name}", "feature_key": sd_attrs.get("feature_key"),
              "instance_key": sd_attrs.get("instance_key"), "suggest": []}
    parquet = store / "points" / name / "points.parquet"
    try:
        import pyarrow.parquet as pq
    except ImportError:
        report["note"] = "pyarrow not installed; cannot read the Parquet footer"
        return report
    files = sorted(parquet.glob("*.parquet")) if parquet.is_dir() else [parquet]
    if not files or not files[0].exists():
        report["note"] = f"no Parquet found at {parquet}"
        return report
    metas = [pq.ParquetFile(f).metadata for f in files]
    columns = metas[0].schema.names
    report.update(parts=len(files), rows=sum(m.num_rows for m in metas),
                  row_groups=sum(m.num_row_groups for m in metas),
                  morton_sorted="morton_code_2d" in columns, columns=columns)
    if report["morton_sorted"]:
        report["note"] = ("row group 0 holds only the sentinel bounding-box rows, "
                          "so row_groups is one more than the data needs")
    else:
        report["suggest"].append(f"morton-sort (points morton-from-zarr <store> --points-key {name})")
    return report


def table_report(name: str, nodes: dict) -> dict:
    x = nodes.get(f"tables/{name}/X", {})
    encoding = x.get("attributes", {}).get("encoding-type") or ("dense" if x.get("node_type") == "array" else "missing")
    report = {"element": f"tables/{name}", "X": encoding,
              "shape": x.get("attributes", {}).get("shape") or x.get("shape"), "suggest": []}
    if encoding == "csr_matrix":
        report["suggest"].append(f"convert to CSC (tables to-csc <store> --table {name})")
    return report


def children(nodes: dict, kind: str) -> list[str]:
    return sorted({k.split("/")[1] for k in nodes if k.startswith(f"{kind}/") and k.count("/") >= 1})


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    store = Path(sys.argv[1]).expanduser()
    zarr_format, nodes = load_metadata(store)
    elements = (
        [raster_report(n, "images", nodes) for n in children(nodes, "images")]
        + [raster_report(n, "labels", nodes) for n in children(nodes, "labels")]
        + [points_report(n, store, nodes) for n in children(nodes, "points")]
        + [table_report(n, nodes) for n in children(nodes, "tables")]
    )
    out = {"store": str(store), "zarr_format": zarr_format,
           "shapes": children(nodes, "shapes"), "elements": elements}
    if zarr_format == 2:
        out["note"] = ("zarr v2 store. spatialdata-js-util targets stores written by spatialdata>=0.8; "
                       "if a command fails, re-save first: sd.read_zarr(old).write(new)")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
