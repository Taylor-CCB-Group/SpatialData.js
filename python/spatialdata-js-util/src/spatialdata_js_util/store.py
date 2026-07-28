"""Filesystem-level helpers for SpatialData Zarr stores.

These operate on the store layout directly rather than through `spatialdata`, so
that copy-then-rewrite workflows can touch one element without materialising the
whole object — and so the reader-facing parts of this package stay importable
without the heavy write dependencies.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Sequence

import pandas as pd
import pyarrow.dataset as ds


def read_json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def json_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(value, indent=2, sort_keys=True).encode("utf-8")


def write_json(path: str | Path, value: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(json_bytes(value))


def drop_consolidated_metadata(group_path: str | Path) -> bool:
    """Remove a group's own inline consolidated metadata, if it has any.

    A nested block is a cache of the metadata below it. Rewriting anything under
    the group leaves that cache describing the old encoding, and readers trust
    the cache over the files — so an array can be rewritten correctly and still
    fail to load. The store root's listing is refreshed separately and remains
    the authoritative one.

    Returns whether a block was actually removed.
    """
    meta_path = Path(group_path) / "zarr.json"
    if not meta_path.is_file():
        return False
    doc = read_json(meta_path)
    if "consolidated_metadata" not in doc:
        return False
    doc.pop("consolidated_metadata")
    write_json(meta_path, doc)
    return True


def _implicit_group(zarr_format: int) -> dict[str, Any]:
    return {"attributes": {}, "node_type": "group", "zarr_format": zarr_format}


def _collect_consolidated_metadata(store_path: Path, *, zarr_format: int = 3) -> dict[str, Any]:
    """Map every node under *store_path* to its metadata document.

    Entries are filled in for intermediate groups that have no `zarr.json` of
    their own. Some writers create element directories without writing metadata
    for the collection that contains them — `points/transcripts/zarr.json` but no
    `points/zarr.json`. Listing the child without its parent leaves an orphan
    that zarr cannot attach to the hierarchy, and it rejects the *whole* store:
    `zarr.open_group` then raises `GroupNotFoundError` at the root, so the store
    stops opening entirely rather than merely missing one element.
    """
    metadata: dict[str, Any] = {}
    for meta_path in store_path.rglob("zarr.json"):
        if meta_path == store_path / "zarr.json":
            continue
        rel = meta_path.parent.relative_to(store_path).as_posix()
        metadata[rel] = read_json(meta_path)

    for rel in list(metadata):
        parts = rel.split("/")
        for depth in range(1, len(parts)):
            parent = "/".join(parts[:depth])
            if parent not in metadata:
                metadata[parent] = _implicit_group(zarr_format)
    return metadata


def consolidated_metadata_orphans(metadata: dict[str, Any]) -> list[str]:
    """Entries whose parent path is absent — these make a store unreadable."""
    return sorted(
        key for key in metadata if "/" in key and key.rsplit("/", 1)[0] not in metadata
    )


def refresh_consolidated_metadata(store_path: str | Path) -> None:
    """Rewrite the store root's inline consolidated metadata from disk.

    Required after any structural rewrite: readers trust the consolidated copy,
    so a stale one hides newly written arrays or reports old codecs.
    """
    root = Path(store_path)
    root_path = root / "zarr.json"
    root_meta = read_json(root_path)
    metadata = _collect_consolidated_metadata(
        root, zarr_format=int(root_meta.get("zarr_format", 3))
    )

    orphans = consolidated_metadata_orphans(metadata)
    if orphans:
        # Never write metadata that would make the store fail to open.
        raise ValueError(
            f"Refusing to write consolidated metadata with orphaned entries for {root}: "
            f"{', '.join(orphans)}"
        )

    root_meta["consolidated_metadata"] = {
        "kind": "inline",
        "must_understand": False,
        "metadata": metadata,
    }
    write_json(root_path, root_meta)


def list_element_keys(zarr_path: str | Path, collection: str) -> list[str]:
    """List element names under a top-level store collection (images, tables, …)."""
    root = Path(zarr_path) / collection
    if not root.is_dir():
        return []
    return sorted(
        child.name
        for child in root.iterdir()
        if child.is_dir() and ((child / "zarr.json").is_file() or (child / ".zgroup").is_file())
    )


def zarr_format_of(path: str | Path) -> int:
    """Return the zarr format (2 or 3) a group on disk was written in.

    AnnData groups inside a store must be rewritten in the format they were read
    in; mixing formats within one store breaks readers.
    """
    node = Path(path)
    if (node / "zarr.json").is_file():
        return int(read_json(node / "zarr.json").get("zarr_format", 3))
    if (node / ".zgroup").is_file():
        return int(read_json(node / ".zgroup").get("zarr_format", 2))
    raise FileNotFoundError(f"No zarr group metadata found at {node}")


def _points_root(zarr_path: Path) -> Path:
    return zarr_path / "points"


def validate_points_key(points_key: str) -> str:
    key = points_key.strip()
    if not key:
        raise ValueError("Points element name cannot be empty.")
    if Path(key).name != key or key in {".", ".."}:
        raise ValueError(
            "Points element name must be a single name under points/, not a path."
        )
    return key


def list_points_keys(zarr_path: str | Path) -> list[str]:
    root = _points_root(Path(zarr_path))
    if not root.is_dir():
        return []
    return sorted(
        child.name
        for child in root.iterdir()
        if child.is_dir() and (child / "zarr.json").is_file()
    )


def read_points_element_attrs(zarr_path: str | Path, points_key: str) -> dict[str, Any]:
    element_json = _points_root(Path(zarr_path)) / points_key / "zarr.json"
    if not element_json.is_file():
        raise FileNotFoundError(f"Points element not found: points/{points_key}")
    attrs = read_json(element_json).get("attributes", {})
    spatialdata_attrs = attrs.get("spatialdata_attrs", {})
    if not isinstance(spatialdata_attrs, dict):
        spatialdata_attrs = {}
    return {
        "axes": attrs.get("axes", []),
        "feature_key": spatialdata_attrs.get("feature_key"),
        "instance_key": spatialdata_attrs.get("instance_key"),
        "version": spatialdata_attrs.get("version"),
    }


def points_parquet_path(zarr_path: str | Path, points_key: str) -> Path:
    return _points_root(Path(zarr_path)) / validate_points_key(points_key) / "points.parquet"


def experimental_points_output_path(zarr_path: str | Path, points_key: str) -> Path:
    return Path(zarr_path) / "points.experimental" / validate_points_key(points_key) / "points.parquet"


def copy_points_element_metadata(
    zarr_path: str | Path,
    *,
    source_key: str,
    dest_key: str,
) -> None:
    source = _points_root(Path(zarr_path)) / validate_points_key(source_key) / "zarr.json"
    dest = _points_root(Path(zarr_path)) / validate_points_key(dest_key) / "zarr.json"
    if not source.is_file():
        raise FileNotFoundError(f"Points element metadata not found: {source}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)


def _points_element_consolidated_entry(
    zarr_path: Path,
    points_key: str,
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if metadata is not None:
        entry = metadata.get(f"points/{points_key}")
        if isinstance(entry, dict):
            return json.loads(json.dumps(entry))
    element_json = _points_root(zarr_path) / points_key / "zarr.json"
    element_doc = read_json(element_json)
    return {
        "attributes": element_doc.get("attributes", {}),
        "node_type": element_doc.get("node_type", "group"),
        "zarr_format": element_doc.get("zarr_format", 3),
    }


def read_store_consolidated_metadata(zarr_path: str | Path) -> dict[str, Any]:
    root_json = Path(zarr_path) / "zarr.json"
    if not root_json.is_file():
        raise FileNotFoundError(f"Missing store metadata: {root_json}")
    doc = read_json(root_json)
    consolidated = doc.get("consolidated_metadata")
    if not isinstance(consolidated, dict):
        raise ValueError(f"Store has no consolidated metadata: {root_json}")
    metadata = consolidated.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError(f"Store consolidated metadata has no metadata map: {root_json}")
    return metadata


def register_points_elements_in_consolidated_metadata(
    zarr_path: str | Path,
    element_keys: Sequence[str],
    *,
    template_key: str,
) -> None:
    """Register sibling points elements in the store root consolidated metadata."""
    store_path = Path(zarr_path)
    root_json = store_path / "zarr.json"
    doc = read_json(root_json)
    consolidated = doc.get("consolidated_metadata")
    if not isinstance(consolidated, dict):
        consolidated = {"kind": "inline", "metadata": {}}
        doc["consolidated_metadata"] = consolidated
    metadata = consolidated.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        consolidated["metadata"] = metadata

    template_entry = _points_element_consolidated_entry(
        store_path,
        template_key,
        metadata=metadata,
    )
    for key in element_keys:
        metadata[f"points/{key}"] = json.loads(json.dumps(template_entry))
    root_json.write_text(json.dumps(doc, indent=2) + "\n")


def read_points_dataframe(parquet_path: str | Path) -> pd.DataFrame:
    path = Path(parquet_path)
    if not path.exists():
        raise FileNotFoundError(f"Points Parquet not found: {path}")
    if path.is_dir():
        table = ds.dataset(path, format="parquet").to_table()
    else:
        table = ds.dataset(path, format="parquet").to_table()
    return table.to_pandas()
