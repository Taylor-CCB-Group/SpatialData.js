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


def wasm_encode_options(encode_options: dict[str, Any]) -> tuple[bool, int]:
    """Map writer/recompress encode options to OpenJPH WASM (quality, reversible)."""
    reversible = bool(encode_options.get("reversible", False))
    if reversible:
        return True, 100
    quality = encode_options.get("quality", encode_options.get("level", 100))
    return False, int(quality)


@lru_cache(maxsize=1)
def htj2k_wasm_encode_available() -> bool:
    """Return whether the repo Node HTJ2K WASM encode helper is usable."""
    node = shutil.which("node")
    if node is None or not _ENCODE_SCRIPT.is_file():
        return False
    try:
        plane = np.zeros((4, 4), dtype=np.uint16)
        encode_htj2k_plane_wasm(plane, reversible=True, quality=100)
    except Exception:
        return False
    return True


def encode_htj2k_plane_wasm(
    plane: np.ndarray,
    *,
    reversible: bool = True,
    quality: int = 100,
) -> bytes:
    """Encode one 2D plane through the Node OpenJPH WASM helper."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js is required for HTJ2K WASM encode but was not found on PATH.")
    if not _ENCODE_SCRIPT.is_file():
        raise RuntimeError(f"HTJ2K WASM encode script not found: {_ENCODE_SCRIPT}")

    array = np.ascontiguousarray(np.asarray(plane))
    if array.ndim != 2:
        raise ValueError(f"HTJ2K WASM encode expects a 2D plane, got shape {array.shape}.")
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
        raise RuntimeError(message or "HTJ2K WASM encode failed.")
    return bytes(result.stdout)
