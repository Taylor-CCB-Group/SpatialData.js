from __future__ import annotations

import base64
import json
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parents[4]
_ENCODE_SCRIPT = _REPO_ROOT / "scripts" / "encode-htj2k-plane.mjs"


def openjph_encode_options(encode_options: dict[str, Any]) -> tuple[bool, float]:
    """Map encode options to OpenJPH WASM setQuality(reversible, quality)."""
    reversible = bool(encode_options.get("reversible", True))
    if reversible:
        return True, 0.0
    quality = encode_options.get("quality", encode_options.get("level", 0.0002))
    return False, float(quality)


@lru_cache(maxsize=1)
def htj2k_encode_available() -> bool:
    """Return whether the OpenJPH WASM encode helper is usable."""
    node = shutil.which("node")
    if node is None or not _ENCODE_SCRIPT.is_file():
        return False
    try:
        plane = np.zeros((4, 4), dtype=np.uint16)
        encode_htj2k_plane(plane, reversible=True, quality=0.0)
    except Exception:
        return False
    return True


def encode_htj2k_plane(
    plane: np.ndarray,
    *,
    reversible: bool = True,
    quality: float = 0.0,
) -> bytes:
    """Encode one 2D plane through the OpenJPH WASM helper."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js is required for HTJ2K encode but was not found on PATH.")
    if not _ENCODE_SCRIPT.is_file():
        raise RuntimeError(f"HTJ2K encode script not found: {_ENCODE_SCRIPT}")

    array = np.ascontiguousarray(np.asarray(plane))
    if array.ndim != 2:
        raise ValueError(f"HTJ2K encode expects a 2D plane, got shape {array.shape}.")
    height, width = (int(value) for value in array.shape)
    payload = {
        "width": width,
        "height": height,
        "dtype": array.dtype.name,
        "reversible": reversible,
        "quality": quality,
        "plane": base64.b64encode(array.tobytes(order="C")).decode("ascii"),
    }
    result = subprocess.run(
        [node, str(_ENCODE_SCRIPT)],
        input=json.dumps(payload).encode("utf-8"),
        capture_output=True,
        cwd=_REPO_ROOT,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(message or "HTJ2K encode failed.")
    return bytes(result.stdout)
