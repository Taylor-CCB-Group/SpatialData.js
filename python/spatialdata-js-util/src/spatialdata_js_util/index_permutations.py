from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


from .points import (
    ENCODING_PLAN_ATTR,
    MORTON_CODE_2D_COLUMN,
    MORTON_COARSE_COLUMN,
    ColumnEncodingPlan,
    EncodingPolicy,
    write_morton_points_parquet,
)
from .store import (
    list_points_keys,
    points_parquet_path,
    read_points_dataframe,
    read_points_element_attrs,
    register_points_elements_in_consolidated_metadata,
)


@dataclass(frozen=True)
class IndexCondition:
    id: str
    element_suffix: str
    sort_order: tuple[str, ...] | None
    tiling_kind: str | None
    #: Row-group size for this condition, overriding the call's default.
    #: **This is the feature-selectivity knob.** A reader skips row groups, never
    #: pages — parquet-wasm exposes no column-chunk offsets and cannot decode a
    #: relocated subset of a row group (`docs/parquet-wasm-limitations.md`) — so
    #: how nearly single-feature a row group is decides what a feature selection
    #: can avoid fetching. At 50k rows and 541 features it can avoid nothing.
    row_group_size: int | None = None
    #: Quadtree levels of Morton coarsening for the leading sort key. See
    #: {@link spatialdata_js_util.points.morton_sort_points}.
    morton_coarsen_levels: int | None = None


DEFAULT_CONDITIONS: tuple[IndexCondition, ...] = (
    IndexCondition("canonical", "", None, None),
    IndexCondition("morton", "_morton", (MORTON_CODE_2D_COLUMN,), "morton-points"),
    IndexCondition(
        "morton-then-feature",
        "_morton_then_feature",
        (MORTON_CODE_2D_COLUMN, "feature_name_codes"),
        "morton-points",
    ),
    IndexCondition(
        "feature-then-morton",
        "_feature_then_morton",
        ("feature_name_codes", MORTON_CODE_2D_COLUMN),
        "experimental",
    ),
)
"""The four landed conditions. `morton-then-feature` is measurably degenerate —
Morton is 16 bits per axis, so at 12.17M points only ~0.14% of rows share a code
and the secondary key is almost never consulted. It is kept because the store's
element keys are a published contract and because it is the worked example of a
*harmless* secondary key (`points-morton-tiled-viewport-loading.md`)."""


def _coarsened_condition(levels: int, row_group_size: int) -> IndexCondition:
    return IndexCondition(
        id=f"morton-k{levels}-then-feature-rg{row_group_size}",
        element_suffix=f"_morton_k{levels}_then_feature_rg{row_group_size}",
        sort_order=(MORTON_COARSE_COLUMN, "feature_name_codes", MORTON_CODE_2D_COLUMN),
        tiling_kind="experimental",
        row_group_size=row_group_size,
        morton_coarsen_levels=levels,
    )


FEATURE_SELECTIVITY_CONDITIONS: tuple[IndexCondition, ...] = (
    IndexCondition(
        "feature-then-morton-rg5000",
        "_feature_then_morton_rg5000",
        ("feature_name_codes", MORTON_CODE_2D_COLUMN),
        "experimental",
        row_group_size=5_000,
    ),
    _coarsened_condition(levels=4, row_group_size=5_000),
    _coarsened_condition(levels=6, row_group_size=5_000),
    _coarsened_condition(levels=6, row_group_size=25_000),
)
"""The sweep decision 11's cost model needs in order to have a crossover to find.

Two axes, deliberately crossed rather than chosen: how coarse the spatial bucket
is (`levels`) and how many rows a row group holds. Coarsening trades spatial
selectivity for feature selectivity — at `levels=6` a bucket is 4096 leaf cells
wide — and the row-group size decides whether that feature contiguity is fine
enough for the reader to act on. Both ends matter and neither is guessable, which
is why these are written and measured rather than reasoned about."""


def _resolve_feature_code_column(feature_key: str | None) -> str:
    if feature_key:
        return f"{feature_key}_codes"
    return "feature_name_codes"


def _condition_sort_order(
    condition: IndexCondition, feature_key: str | None
) -> list[str] | None:
    if condition.sort_order is None:
        return None
    feature_code_column = _resolve_feature_code_column(feature_key)
    return [
        feature_code_column if column == "feature_name_codes" else column
        for column in condition.sort_order
    ]


def _copy_store_shell(source: Path, dest: Path, *, overwrite: bool) -> None:
    if dest.exists():
        if not overwrite:
            raise FileExistsError(f"Destination already exists: {dest}")
        shutil.rmtree(dest)

    def ignore_points(directory: str, names: list[str]) -> set[str]:
        if Path(directory) == source:
            return {"points"} if "points" in names else set()
        return set()

    shutil.copytree(source, dest, ignore=ignore_points)


def _write_element_zarr_json(source_element_dir: Path, dest_element_dir: Path) -> None:
    source_json = source_element_dir / "zarr.json"
    dest_element_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_json, dest_element_dir / "zarr.json")


def _write_points_collection_zarr_json(source_path: Path, dest_path: Path) -> None:
    """Recreate the `points/` group metadata that `_copy_store_shell` skipped.

    Without it the collection exists as a directory with no node metadata, so its
    elements are listed in consolidated metadata under a parent that is not — an
    orphan that stops the whole store from opening once anything rebuilds that
    metadata from disk.
    """
    dest_json = dest_path / "points" / "zarr.json"
    if dest_json.is_file():
        return
    dest_json.parent.mkdir(parents=True, exist_ok=True)
    source_json = source_path / "points" / "zarr.json"
    if source_json.is_file():
        shutil.copy2(source_json, dest_json)
        return
    dest_json.write_text(
        json.dumps({"attributes": {}, "zarr_format": 3, "node_type": "group"}, indent=2) + "\n"
    )


def _copy_canonical_parquet(source_parquet: Path, dest_parquet: Path) -> None:
    dest_parquet.parent.mkdir(parents=True, exist_ok=True)
    if source_parquet.is_dir():
        if dest_parquet.exists():
            shutil.rmtree(dest_parquet)
        shutil.copytree(source_parquet, dest_parquet)
    else:
        shutil.copy2(source_parquet, dest_parquet)


def write_index_permutations(
    source_zarr: str | Path,
    dest_zarr: str | Path,
    *,
    points_key: str | None = None,
    max_rows: int | None = None,
    conditions: Sequence[IndexCondition] | None = None,
    overwrite: bool = False,
    row_group_size: int = 50_000,
    compression: str = "zstd",
    encodings: EncodingPolicy = "auto",
    write_page_index: bool = True,
) -> dict[str, Any]:
    source_path = Path(source_zarr)
    dest_path = Path(dest_zarr)
    keys = list_points_keys(source_path)
    if not keys:
        raise FileNotFoundError(f"No Points elements found under {source_path / 'points'}")

    resolved_key = points_key or (keys[0] if len(keys) == 1 else None)
    if resolved_key is None:
        raise ValueError(
            "Multiple Points elements found; pass points_key. "
            f"Available keys: {', '.join(keys)}"
        )
    if resolved_key not in keys:
        raise ValueError(f"Unknown points key {resolved_key!r}. Available: {', '.join(keys)}")

    attrs = read_points_element_attrs(source_path, resolved_key)
    feature_key = attrs.get("feature_key")
    source_element_dir = source_path / "points" / resolved_key
    source_parquet = points_parquet_path(source_path, resolved_key)

    _copy_store_shell(source_path, dest_path, overwrite=overwrite)
    _write_points_collection_zarr_json(source_path, dest_path)

    df = read_points_dataframe(source_parquet)
    if max_rows is not None and len(df) > max_rows:
        df = df.sample(n=max_rows, random_state=0).reset_index(drop=True)

    selected = tuple(conditions or DEFAULT_CONDITIONS)
    manifest_conditions: list[dict[str, Any]] = []

    for condition in selected:
        element_key = (
            resolved_key if condition.id == "canonical" else f"{resolved_key}{condition.element_suffix}"
        )
        element_dir = dest_path / "points" / element_key
        output_parquet = element_dir / "points.parquet"
        _write_element_zarr_json(source_element_dir, element_dir)

        if condition.sort_order is None:
            if max_rows is not None:
                output_parquet.parent.mkdir(parents=True, exist_ok=True)
                if output_parquet.exists():
                    if output_parquet.is_dir():
                        shutil.rmtree(output_parquet)
                    else:
                        output_parquet.unlink()
                df.to_parquet(output_parquet, index=False)
            else:
                _copy_canonical_parquet(source_parquet, output_parquet)
            condition_row_group_size = None
            encoding_plan = None
        else:
            sort_order = _condition_sort_order(condition, feature_key)
            condition_row_group_size = condition.row_group_size or row_group_size
            written = write_morton_points_parquet(
                df,
                output_parquet,
                feature_key=feature_key,
                sort_order=sort_order,
                row_group_size=condition_row_group_size,
                compression=compression,
                encodings=encodings,
                write_page_index=write_page_index,
                morton_coarsen_levels=condition.morton_coarsen_levels,
            )
            plan = written.attrs.get(ENCODING_PLAN_ATTR)
            encoding_plan = plan.as_manifest() if isinstance(plan, ColumnEncodingPlan) else None

        manifest_conditions.append(
            {
                "id": condition.id,
                "element_path": f"points/{element_key}",
                "sort_order": list(condition.sort_order) if condition.sort_order else None,
                "tiling_kind": condition.tiling_kind,
                "row_group_size": condition_row_group_size,
                "morton_coarsen_levels": condition.morton_coarsen_levels,
                "encodings": encoding_plan,
                "page_index": write_page_index if condition.sort_order else None,
            }
        )

    manifest = {
        "version": "0.1",
        "store_path": str(dest_path),
        "source_store": str(source_path),
        "source_element": f"points/{resolved_key}",
        "feature_key": feature_key,
        "n_points": int(len(df)),
        "conditions": manifest_conditions,
        "benchmark_scenarios": [
            {
                "id": "center-tile",
                "bounds": {
                    "minX": float(df["x"].quantile(0.25)),
                    "maxX": float(df["x"].quantile(0.75)),
                    "minY": float(df["y"].quantile(0.25)),
                    "maxY": float(df["y"].quantile(0.75)),
                },
            }
        ],
    }
    element_keys = [
        (
            resolved_key
            if condition.id == "canonical"
            else f"{resolved_key}{condition.element_suffix}"
        )
        for condition in selected
    ]
    register_points_elements_in_consolidated_metadata(
        dest_path,
        element_keys,
        template_key=resolved_key,
    )

    manifest_path = dest_path / "index-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest
