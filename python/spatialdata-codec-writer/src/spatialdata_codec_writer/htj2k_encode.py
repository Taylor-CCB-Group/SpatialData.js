from __future__ import annotations

import atexit
import base64
import json
import os
import shutil
import struct
import subprocess
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

_VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
_ENCODE_SCRIPT = _VENDOR_DIR / "encode-plane.mjs"


def encode_script_path() -> Path:
    return _ENCODE_SCRIPT


def openjph_vendor_dir() -> Path:
    return _VENDOR_DIR / "openjph"


def openjph_encode_options(encode_options: dict[str, Any]) -> tuple[bool, float]:
    """Map encode options to OpenJPH WASM setQuality(reversible, quality)."""
    reversible = bool(encode_options.get("reversible", True))
    if reversible:
        return True, 0.0
    quality = encode_options.get("quality", encode_options.get("level", 0.0002))
    return False, float(quality)


def _plane_request_payload(
    plane: np.ndarray, *, reversible: bool, quality: float
) -> dict[str, Any]:
    array = np.ascontiguousarray(np.asarray(plane))
    if array.ndim != 2:
        raise ValueError(f"HTJ2K encode expects a 2D plane, got shape {array.shape}.")
    height, width = (int(value) for value in array.shape)
    return {
        "width": width,
        "height": height,
        "dtype": array.dtype.name,
        "reversible": reversible,
        "quality": quality,
        "plane": base64.b64encode(array.tobytes(order="C")).decode("ascii"),
    }


class OpenJphEncoderWorker:
    """Long-lived Node subprocess that loads OpenJPH WASM once."""

    def __init__(self) -> None:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("Node.js is required for HTJ2K encode but was not found on PATH.")
        if not _ENCODE_SCRIPT.is_file():
            raise RuntimeError(f"HTJ2K encode script not found: {_ENCODE_SCRIPT}")
        if not (openjph_vendor_dir() / "openjphjs.wasm").is_file():
            raise RuntimeError(
                f"Vendored OpenJPH WASM not found under {openjph_vendor_dir()}. "
                "Run scripts/vendor-openjph-for-python.mjs before building the package."
            )

        self._lock = threading.Lock()
        self._proc = subprocess.Popen(
            [node, str(_ENCODE_SCRIPT), "--worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        if self._proc.stdin is None or self._proc.stdout is None:
            raise RuntimeError("Failed to open pipes for HTJ2K encoder worker.")

    def close(self) -> None:
        with self._lock:
            assert(self._proc)
            if self._proc.stdin is not None:
                self._proc.stdin.close()
            if self._proc.poll() is None:
                self._proc.wait(timeout=5)
                if self._proc.poll() is None:
                    self._proc.terminate()
                    self._proc.wait(timeout=5)
                    if self._proc.poll() is None:
                        self._proc.kill()
            self._proc = None  # type: ignore[assignment]

    def encode_plane(
        self, plane: np.ndarray, *, reversible: bool = True, quality: float = 0.0
    ) -> bytes:
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                raise RuntimeError("HTJ2K encoder worker is not running.")
            payload = json.dumps(
                _plane_request_payload(plane, reversible=reversible, quality=quality)
            ).encode("utf-8")
            assert self._proc.stdin is not None
            assert self._proc.stdout is not None
            self._proc.stdin.write(struct.pack(">I", len(payload)))
            self._proc.stdin.write(payload)
            self._proc.stdin.flush()

            header = self._read_exact(self._proc.stdout, 5)
            status = header[0]
            length = struct.unpack(">I", header[1:5])[0]
            body = self._read_exact(self._proc.stdout, length)
            if status != 0:
                message = body.decode("utf-8", errors="replace")
                raise RuntimeError(message or "HTJ2K encode failed.")
            return bytes(body)

    @staticmethod
    def _read_exact(stream: Any, length: int) -> bytes:
        chunks: list[bytes] = []
        received = 0
        while received < length:
            chunk = stream.read(length - received)
            if not chunk:
                raise RuntimeError("HTJ2K encoder worker closed stdout unexpectedly.")
            chunks.append(chunk)
            received += len(chunk)
        return b"".join(chunks)


class EncoderPool:
    """Pool of persistent OpenJPH encoder workers."""

    def __init__(self, workers: int | None = None) -> None:
        count = workers if workers is not None else (os.cpu_count() or 1)
        self._workers = [OpenJphEncoderWorker() for _ in range(max(1, count))]
        self._next = 0
        self._lock = threading.Lock()

    def encode_plane(
        self, plane: np.ndarray, *, reversible: bool = True, quality: float = 0.0
    ) -> bytes:
        with self._lock:
            worker = self._workers[self._next]
            self._next = (self._next + 1) % len(self._workers)
        return worker.encode_plane(plane, reversible=reversible, quality=quality)

    def close(self) -> None:
        for worker in self._workers:
            worker.close()


_pool: EncoderPool | None = None
_pool_lock = threading.Lock()
_pool_workers: int | None = None


def configure_encoder_pool(workers: int | None = None) -> None:
    """Configure or replace the global HTJ2K encoder worker pool."""
    global _pool, _pool_workers
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None
        _pool_workers = workers


def get_encoder_pool(workers: int | None = None) -> EncoderPool:
    global _pool, _pool_workers
    with _pool_lock:
        effective_workers = workers if workers is not None else _pool_workers
        if _pool is None or (workers is not None and workers != _pool_workers):
            if _pool is not None:
                _pool.close()
            _pool_workers = effective_workers
            _pool = EncoderPool(workers=effective_workers)
        return _pool


def shutdown_encoder_pool() -> None:
    global _pool, _pool_workers
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None
        _pool_workers = None


atexit.register(shutdown_encoder_pool)


@lru_cache(maxsize=1)
def htj2k_encode_available() -> bool:
    """Return whether the vendored OpenJPH WASM encode helper is usable."""
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
    """Encode one 2D plane through the vendored OpenJPH WASM worker pool."""
    return get_encoder_pool().encode_plane(plane, reversible=reversible, quality=quality)
