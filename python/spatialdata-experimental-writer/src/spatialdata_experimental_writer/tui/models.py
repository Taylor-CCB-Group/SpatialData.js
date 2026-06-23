from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Literal


class CommandId(str, Enum):
    LIST_POINTS = "list-points"
    MORTON_FROM_ZARR = "morton-points-from-zarr"
    MORTON_POINTS = "morton-points"
    MULTISCALE_POINTS = "multiscale-points"
    INDEX_PERMUTATIONS = "write-index-permutations"


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
