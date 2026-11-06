"""Filesystem-level helpers for SpatialData Zarr stores.

These operate on the store layout directly rather than through `spatialdata`, so
that copy-then-rewrite workflows can touch one element without materialising the
whole object — and so the reader-facing parts of this package stay importable
without the heavy write dependencies.
"""

from __future__ import annotations

import json
import os
import shutil
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence

import pandas as pd
import pyarrow.dataset as ds

if TYPE_CHECKING:
    from spatialdata import SpatialData


#: Working memory the out-of-core rewrites (points sort, CSC tables) aim to stay within.
DEFAULT_MEMORY_BUDGET = 4 * 1024**3


def remove_tree(path: str | Path) -> None:
    """`shutil.rmtree` that tolerates entries vanishing while it walks.

    On an exFAT volume macOS keeps a `._name` AppleDouble companion for each
    file and deletes it together with `name`, so the walk's later `unlink` of
    `._name` finds nothing there and `shutil.rmtree` raises. A path that is
    already gone is not an error either.
    """

    def ignore_vanished(function: Any, failed_path: str, error: BaseException) -> None:
        if not isinstance(error, FileNotFoundError):
            raise error

    shutil.rmtree(path, onexc=ignore_vanished)


def check_dest_not_ancestor(source: str | Path, dest: str | Path) -> None:
    """Refuse a *dest* that is *source* or contains it: overwriting it would delete the source."""
    resolved_source = Path(source).resolve()
    if resolved_source.is_relative_to(Path(dest).resolve()):
        raise ValueError(f"Destination would delete the source store: {dest}")


def replace_keeping_original(staged: Path, target: Path) -> None:
    """Move *staged* to *target*; *target*'s old contents survive until that succeeds.

    A file is replaced atomically. A directory (a partitioned Parquet element, a
    zarr group) is first renamed aside, and restored if the move fails.
    """
    if not target.is_dir():
        os.replace(staged, target)
        return
    previous = target.with_name(f".{target.name}.previous")
    if previous.exists():
        remove_tree(previous)
    target.rename(previous)
    try:
        os.replace(staged, target)
    except BaseException:
        previous.rename(target)
        raise
    remove_tree(previous)


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

    _fill_implicit_parents(metadata, zarr_format)
    return metadata


def _fill_implicit_parents(metadata: dict[str, Any], zarr_format: int) -> None:
    """Add a group entry for every ancestor path that has none, in place.

    Listing `points/transcripts` without `points` leaves an orphan that zarr
    cannot attach to the hierarchy, and it rejects the *whole* store rather than
    the one element — so every writer of this map has to close the gap.
    """
    for rel in list(metadata):
        parts = rel.split("/")
        for depth in range(1, len(parts)):
            parent = "/".join(parts[:depth])
            if parent not in metadata:
                metadata[parent] = _implicit_group(zarr_format)


def consolidated_metadata_orphans(metadata: dict[str, Any]) -> list[str]:
    """Entries whose parent path is absent — these make a store unreadable."""
    return sorted(
        key for key in metadata if "/" in key and key.rsplit("/", 1)[0] not in metadata
    )


def consolidated_metadata_is_current(store_path: str | Path) -> bool:
    """Whether the store root's inline listing still matches the metadata on disk.

    A store with no inline listing has nothing to go stale, so counts as current.
    Group entries are compared without their own nested `consolidated_metadata`
    block: zarr writes an empty one into the listing that the files never carry.
    """
    root = Path(store_path)
    root_meta = read_json(root / "zarr.json")
    declared = (root_meta.get("consolidated_metadata") or {}).get("metadata")
    if declared is None:
        return True
    on_disk = _collect_consolidated_metadata(
        root, zarr_format=int(root_meta.get("zarr_format", 3))
    )

    def strip(documents: dict[str, Any]) -> dict[str, Any]:
        return {
            key: {field: value for field, value in doc.items() if field != "consolidated_metadata"}
            for key, doc in documents.items()
        }

    return strip(declared) == strip(on_disk)


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
            return deepcopy(entry)
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
        metadata[f"points/{key}"] = deepcopy(template_entry)

    # Adding `points/<key>` to a listing with no `points` entry orphans it, and
    # zarr then refuses the whole store — the same failure `refresh_consolidated_
    # metadata` guards against, reachable here because this writes the map
    # directly. A source store missing the parent is exactly the case this module
    # exists to handle, so it cannot be assumed away.
    _fill_implicit_parents(metadata, int(doc.get("zarr_format", 3)))
    orphans = consolidated_metadata_orphans(metadata)
    if orphans:
        raise ValueError(
            f"Refusing to write consolidated metadata with orphaned entries for {store_path}: "
            f"{', '.join(orphans)}"
        )
    write_json(root_json, doc)


def read_points_dataframe(parquet_path: str | Path) -> pd.DataFrame:
    path = Path(parquet_path)
    if not path.exists():
        raise FileNotFoundError(f"Points Parquet not found: {path}")
    # `ds.dataset` handles a single file and a partitioned directory alike.
    table = ds.dataset(path, format="parquet").to_table()
    return table.to_pandas()


def write_spatialdata(
    sdata: SpatialData, path: str | Path, *, overwrite: bool = False
) -> None:
    """Write *sdata* to a Zarr store, copying unchanged points as files.

    `SpatialData.write` re-encodes every points partition through dask, a thread
    per partition. Partitions of transcript-scale points are around 1 GB of
    Parquet and several times that in memory, so a store read from disk and
    written back can need tens of GB of RAM. A points element that is still
    exactly what `sdata.path` holds is copied with the filesystem instead; every
    other element goes through `SpatialData.write` as usual.

    Nullable string columns, which 10x Genomics and SpatialData.js stores carry,
    are written as such instead of failing the way plain `write` does.

    With *overwrite* an existing *path* is replaced, but never the store *sdata*
    was read from, nor a directory containing it: both back its lazy elements.
    Like `SpatialData.write`, a successful write leaves `sdata.path` at *path*.
    """
    import anndata
    import zarr
    from spatialdata import SpatialData

    target = Path(path)
    unchanged = _unmodified_points(sdata)
    if target.exists():
        if not overwrite:
            raise FileExistsError(target)
        if sdata.path is not None and Path(sdata.path).resolve().is_relative_to(target.resolve()):
            raise ValueError(f"Cannot overwrite {target}: it backs the SpatialData being written.")
        remove_tree(target)

    with anndata.settings.override(allow_write_nullable_strings=True):
        if not unchanged:
            sdata.write(target)
            return
        rest = SpatialData(
            images=dict(sdata.images),
            labels=dict(sdata.labels),
            points={key: points for key, points in sdata.points.items() if key not in unchanged},
            shapes=dict(sdata.shapes),
            tables=dict(sdata.tables),
            attrs=dict(sdata.attrs),
        )
        rest.write(target)
        zarr.open_group(target, mode="r+", use_consolidated=False).require_group("points")
        for key, source in unchanged.items():
            shutil.copytree(source, target / "points" / key)
        rest.write_consolidated_metadata()
        sdata.path = target


def _unmodified_points(sdata: SpatialData) -> dict[str, Path]:
    """Points elements that are exactly what the store *sdata* was read from holds, by key."""
    if sdata.path is None:
        return {}
    from spatialdata._io.io_points import _get_transformations_from_ngff_dict
    from spatialdata.transformations import get_transformation

    store = Path(sdata.path)
    unchanged = {}
    for key, points in sdata.points.items():
        source = store / "points" / key
        # An untouched element is a bare parquet read; anything layered on top of it
        # (a new column, a filter) changes what a write must produce.
        expr = points.expr
        if not (
            type(expr).__name__.startswith("ReadParquet")
            and Path(str(expr.operand("path"))) == source / "points.parquet"
        ):
            continue
        # The copy brings the stored coordinate transformations with it, so an
        # element whose transformations were edited in memory has to be written.
        try:
            stored = _get_transformations_from_ngff_dict(
                read_json(source / "zarr.json")["attributes"]["coordinateTransformations"]
            )
        except (OSError, KeyError, ValueError):
            continue
        if stored == get_transformation(points, get_all=True):
            unchanged[key] = source
    return unchanged


def zip_directory(source: str | Path, zip_path: str | Path) -> None:
    """Pack the contents of *source* into an uncompressed zip, at the archive root.

    Zarr chunks are already compressed, and a stored (uncompressed) zip lets a
    browser read any one of them with a single range request, which is what
    zarrextra's `ZipStore` does. File contents are streamed, so memory grows with
    the number of files, not their size. The archive is built beside *zip_path*
    (and left out of itself if that is inside *source*) and renamed into place
    only once complete.
    """
    root = Path(source)
    if not root.is_dir():
        raise NotADirectoryError(root)
    target = Path(zip_path)
    partial = target.with_name(f".{target.name}.partial")
    skip = {target.resolve(), partial.resolve()}
    try:
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
            for path in sorted(root.rglob("*")):
                if path.is_file() and path.resolve() not in skip:
                    archive.write(path, path.relative_to(root).as_posix())
        partial.replace(target)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
