#!/usr/bin/env python3
"""Benchmark points index permutations using index-manifest.json."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq


def _load_bounds(manifest: dict, scenario_id: str | None) -> dict[str, float]:
    scenarios = manifest.get("benchmark_scenarios") or []
    if scenario_id:
        for scenario in scenarios:
            if scenario.get("id") == scenario_id:
                return scenario["bounds"]
        raise SystemExit(f"Unknown scenario id: {scenario_id}")
    if scenarios:
        return scenarios[0]["bounds"]
    raise SystemExit("Manifest has no benchmark_scenarios")


def _feature_codes(manifest: dict, scenario_id: str | None) -> list[int] | None:
    scenarios = manifest.get("benchmark_scenarios") or []
    if not scenario_id:
        return None
    for scenario in scenarios:
        if scenario.get("id") == scenario_id:
            codes = scenario.get("feature_codes")
            return list(codes) if codes is not None else None
    return None


def _parquet_path(store: Path, element_path: str) -> Path:
    return store / element_path / "points.parquet"


def _read_rows_in_bounds(
    parquet_path: Path,
    bounds: dict[str, float],
    feature_codes: list[int] | None,
    feature_key: str | None,
) -> tuple[int, int]:
    if parquet_path.is_dir():
        parts = sorted(parquet_path.glob("part.*.parquet"))
        if not parts:
            raise FileNotFoundError(f"No parquet parts under {parquet_path}")
        frames = [pd.read_parquet(part) for part in parts]
        df = pd.concat(frames, ignore_index=True)
        bytes_read = sum(part.stat().st_size for part in parts)
    else:
        bytes_read = parquet_path.stat().st_size
        df = pd.read_parquet(parquet_path)

    mask = (
        (df["x"] >= bounds["minX"])
        & (df["x"] <= bounds["maxX"])
        & (df["y"] >= bounds["minY"])
        & (df["y"] <= bounds["maxY"])
    )
    if feature_codes is not None:
        code_column = f"{feature_key}_codes" if feature_key else "feature_name_codes"
        if code_column not in df.columns:
            raise KeyError(f"Missing feature code column {code_column!r}")
        mask &= df[code_column].isin(feature_codes)
    return int(mask.sum()), int(bytes_read)


def _estimate_row_group_bytes(parquet_path: Path, bounds: dict[str, float]) -> int | None:
    if not parquet_path.is_file():
        return None
    if "morton_code_2d" not in pq.ParquetFile(parquet_path).schema_arrow.names:
        return None
    # Upper bound only: full file size when row-group APIs are unavailable in this script.
    return parquet_path.stat().st_size


def benchmark_store(
    store: Path,
    *,
    scenario_id: str | None,
    conditions: list[str] | None,
) -> list[dict]:
    manifest_path = store / "index-manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Missing index-manifest.json under {store}")
    manifest = json.loads(manifest_path.read_text())
    bounds = _load_bounds(manifest, scenario_id)
    feature_codes = _feature_codes(manifest, scenario_id)
    feature_key = manifest.get("feature_key")
    selected = conditions or [entry["id"] for entry in manifest.get("conditions", [])]

    results: list[dict] = []
    for condition in manifest.get("conditions", []):
        condition_id = condition["id"]
        if condition_id not in selected:
            continue
        element_path = condition["element_path"]
        parquet_path = _parquet_path(store, element_path)
        started = time.perf_counter()
        try:
            rows, bytes_read = _read_rows_in_bounds(
                parquet_path, bounds, feature_codes, feature_key
            )
            row_group_hint = _estimate_row_group_bytes(parquet_path, bounds)
        except Exception as error:  # noqa: BLE001 - report per condition
            results.append(
                {
                    "condition": condition_id,
                    "element_path": element_path,
                    "error": str(error),
                }
            )
            continue
        elapsed_ms = (time.perf_counter() - started) * 1000
        results.append(
            {
                "condition": condition_id,
                "element_path": element_path,
                "sort_order": condition.get("sort_order"),
                "tiling_kind": condition.get("tiling_kind"),
                "rows_in_bounds": rows,
                "bytes_read_estimate": bytes_read,
                "morton_row_group_bytes_upper_bound": row_group_hint,
                "latency_ms": round(elapsed_ms, 2),
                "bounds": bounds,
                "feature_codes": feature_codes,
            }
        )
    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark points index permutations from index-manifest.json"
    )
    parser.add_argument("store", type=Path, help="Derivative Zarr store path")
    parser.add_argument("--scenario", metavar="ID", help="benchmark_scenarios id")
    parser.add_argument(
        "--conditions",
        metavar="IDS",
        help="Comma-separated condition ids (default: all in manifest)",
    )
    args = parser.parse_args()
    condition_ids = args.conditions.split(",") if args.conditions else None
    results = benchmark_store(args.store, scenario_id=args.scenario, conditions=condition_ids)
    print(json.dumps({"store": str(args.store), "results": results}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
