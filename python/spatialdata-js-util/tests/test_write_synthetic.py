from __future__ import annotations

import json
from pathlib import Path

import pytest

from spatialdata_js_util.codecs import htj2k_available


@pytest.mark.skipif(
    not htj2k_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
def test_write_synthetic_cli(tmp_path: Path) -> None:
    from write_synthetic import main

    output = tmp_path / "indexed.zarr"
    main(
        [
            str(output),
            "--pattern",
            "indexed",
            "--size",
            "16",
            "--t",
            "2",
            "--z",
            "3",
            "--image-key",
            "synthetic",
            "--chunks",
            "1",
            "1",
            "1",
            "16",
            "16",
        ]
    )

    manifest = json.loads(output.with_suffix(".manifest.json").read_text())
    assert manifest["shape"] == [2, 1, 3, 16, 16]
    assert manifest["codec"] == "experimental.openjph_htj2k"
