from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any, Sequence, TypeVar

import pandas as pd

from .errors import WriterCommandError
from .index_permutations import DEFAULT_CONDITIONS, IndexCondition, write_index_permutations
from .points import (
    build_spatialdata_multiscale_metadata,
    write_morton_points_parquet,
    write_multiscale_points_parquet,
)
from .zarr import (
    list_points_keys,
    points_parquet_path,
    read_points_dataframe,
    read_points_element_attrs,
)

_T = TypeVar("_T")


def _as_command_error(action: Callable[[], _T]) -> _T:
    try:
        return action()
    except WriterCommandError:
        raise
    except (FileNotFoundError, ValueError) as exc:
        raise WriterCommandError(str(exc)) from exc


def read_input_dataframe(path: str | Path) -> pd.DataFrame:
    input_path = Path(path)
    if input_path.is_dir():
        return read_points_dataframe(input_path)
    suffix = input_path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(input_path)
    if suffix in {".parquet", ".pq"}:
        return pd.read_parquet(input_path)
    raise WriterCommandError(
        f"Unsupported input: {path}\n"
        "Expected a .csv file, .parquet file, or a directory of Parquet parts."
    )


def run_list_points(zarr: str | Path) -> dict[str, Any]:
    keys = list_points_keys(zarr)
    if not keys:
        raise WriterCommandError(f"No Points elements found under {Path(zarr) / 'points'}")
    return {"zarr": str(zarr), "points_keys": keys}


def run_morton_points(
    input_path: str | Path,
    output_path: str | Path,
    *,
    feature_key: str | None = None,
    row_group_size: int = 50_000,
    compression: str = "zstd",
) -> dict[str, Any]:
    df = _as_command_error(lambda: read_input_dataframe(input_path))
    sorted_df = _as_command_error(
        lambda: write_morton_points_parquet(
            df,
            output_path,
            feature_key=feature_key,
            row_group_size=row_group_size,
            compression=compression,
        )
    )
    return {
        "format": "morton-points",
        "rows": int(len(sorted_df)),
        "output": str(output_path),
        "row_group_size": row_group_size,
    }


def run_multiscale_points(
    input_path: str | Path,
    output_path: str | Path,
    *,
    metadata_json: str | Path | None = None,
    row_group_size: int = 50_000,
    compression: str = "zstd",
) -> dict[str, Any]:
    df = _as_command_error(lambda: read_input_dataframe(input_path))
    if metadata_json:
        metadata = _as_command_error(lambda: json.loads(Path(metadata_json).read_text()))
    else:
        metadata = _as_command_error(lambda: build_spatialdata_multiscale_metadata(df))
    _as_command_error(
        lambda: write_multiscale_points_parquet(
            df,
            output_path,
            metadata=metadata,
            row_group_size=row_group_size,
            compression=compression,
        )
    )
    return {
        "format": "spatialdata_multiscale_points",
        "rows": int(len(df)),
        "output": str(output_path),
        "row_group_size": row_group_size,
    }


def resolve_morton_from_zarr_output(
    zarr_path: Path,
    points_key: str,
    *,
    output: str | Path | None = None,
    experimental: bool = False,
) -> tuple[Path, Path, bool]:
    source_parquet = points_parquet_path(zarr_path, points_key)
    if output:
        resolved_output = Path(output)
    elif experimental:
        resolved_output = zarr_path / "points.experimental" / points_key / "points.parquet"
    else:
        resolved_output = source_parquet
    in_place = not experimental and output is None
    return source_parquet, resolved_output, in_place


def run_morton_points_from_zarr(
    zarr: str | Path,
    *,
    points_key: str | None = None,
    experimental: bool = False,
    output: str | Path | None = None,
    feature_key: str | None = None,
    row_group_size: int = 50_000,
    compression: str = "zstd",
) -> dict[str, Any]:
    zarr_path = Path(zarr)
    keys = list_points_keys(zarr_path)
    if not keys:
        raise WriterCommandError(f"No Points elements found under {zarr_path / 'points'}")

    resolved_key = points_key
    if resolved_key is None:
        if len(keys) == 1:
            resolved_key = keys[0]
        else:
            raise WriterCommandError(
                "Multiple Points elements found; pass points_key. "
                f"Available keys: {', '.join(keys)}"
            )
    if resolved_key not in keys:
        raise WriterCommandError(
            f"Unknown Points element {resolved_key!r}. Available: {', '.join(keys)}"
        )

    attrs = _as_command_error(lambda: read_points_element_attrs(zarr_path, resolved_key))
    resolved_feature_key = feature_key or attrs.get("feature_key")
    source_parquet, resolved_output, in_place = resolve_morton_from_zarr_output(
        zarr_path,
        resolved_key,
        output=output,
        experimental=experimental,
    )

    df = _as_command_error(lambda: read_points_dataframe(source_parquet))
    if resolved_output.exists():
        if resolved_output.is_dir():
            shutil.rmtree(resolved_output)
        else:
            resolved_output.unlink()
    sorted_df = _as_command_error(
        lambda: write_morton_points_parquet(
            df,
            resolved_output,
            feature_key=resolved_feature_key,
            row_group_size=row_group_size,
            compression=compression,
        )
    )
    return {
        "format": "morton-points",
        "zarr": str(zarr_path),
        "points_key": resolved_key,
        "source": str(source_parquet),
        "output": str(resolved_output),
        "in_place": in_place,
        "feature_key": resolved_feature_key,
        "rows": int(len(sorted_df)),
        "row_group_size": row_group_size,
    }


def run_write_index_permutations(
    source_zarr: str | Path,
    dest_zarr: str | Path,
    *,
    points_key: str | None = None,
    max_rows: int | None = None,
    condition_ids: Sequence[str] | None = None,
    overwrite: bool = False,
    row_group_size: int = 50_000,
    compression: str = "zstd",
) -> dict[str, Any]:
    selected: tuple[IndexCondition, ...] | None = None
    if condition_ids:
        by_id = {condition.id: condition for condition in DEFAULT_CONDITIONS}
        missing = [value for value in condition_ids if value not in by_id]
        if missing:
            raise WriterCommandError(f"Unknown conditions: {', '.join(missing)}")
        selected = tuple(by_id[value] for value in condition_ids)

    return _as_command_error(
        lambda: write_index_permutations(
            source_zarr,
            dest_zarr,
            points_key=points_key,
            max_rows=max_rows,
            conditions=selected,
            overwrite=overwrite,
            row_group_size=row_group_size,
            compression=compression,
        )
    )
