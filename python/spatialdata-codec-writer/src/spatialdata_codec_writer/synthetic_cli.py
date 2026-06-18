"""Console entry for repo-local synthetic image writer scripts."""

from __future__ import annotations

import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> None:
    scripts_dir = Path(__file__).resolve().parents[2] / "scripts"
    scripts_path = str(scripts_dir)
    if scripts_path not in sys.path:
        sys.path.insert(0, scripts_path)

    from write_synthetic import main as write_synthetic_main

    write_synthetic_main(argv)
