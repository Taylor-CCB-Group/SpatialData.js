from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Literal


class CommandId(str, Enum):
    """Values mirror the `spatialdata-js-util` CLI paths the screens wrap."""

    # images
    RECOMPRESS = "images recompress"
    # points
    LIST_POINTS = "points list"
    MORTON_FROM_ZARR = "points morton-from-zarr"
    MORTON_POINTS = "points morton"
    MULTISCALE_POINTS = "points multiscale"
    INDEX_PERMUTATIONS = "points index-permutations"
    # tables
    LIST_TABLES = "tables list"
    TABLES_TO_CSC = "tables to-csc"
    # codecs
    CODECS_INFO = "codecs info"


VerifyKind = Literal["none", "morton", "multiscale", "manifest"]


@dataclass
class TaskSpec:
    command: CommandId
    title: str
    runner: Callable[[], dict[str, Any]]
    verify_kind: VerifyKind = "none"
    verify_paths: list[Path] = field(default_factory=list)
    requires_confirm: bool = False
    confirm_message: str = ""
    log_lines: list[str] = field(default_factory=list)


@dataclass
class WriterContext:
    zarr_path: str | None = None
    points_key: str | None = None
