from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import pandas as pd

from .points import MORTON_CODE_2D_COLUMN, write_morton_points_parquet
from .zarr import (
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
        else:
            sort_order = _condition_sort_order(condition, feature_key)
            write_morton_points_parquet(
                df,
                output_parquet,
                feature_key=feature_key,
                sort_order=sort_order,
                row_group_size=row_group_size,
                compression=compression,
            )

        manifest_conditions.append(
            {
                "id": condition.id,
                "element_path": f"points/{element_key}",
                "sort_order": list(condition.sort_order) if condition.sort_order else None,
                "tiling_kind": condition.tiling_kind,
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
