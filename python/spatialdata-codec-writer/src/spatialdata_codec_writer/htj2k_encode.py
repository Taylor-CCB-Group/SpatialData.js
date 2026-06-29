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


def _encode_request_payload(
    volume: np.ndarray, *, reversible: bool, quality: float
) -> dict[str, Any]:
    """Build an encode request for a 2D plane or a 3D (components, y, x) volume.

    The samples are sent planar / component-major (C-order of the array), which
    is exactly the layout openjph-wasm expects for multi-component codestreams.
    """
    array = np.ascontiguousarray(np.asarray(volume))
    if array.ndim == 2:
        components, (height, width) = 1, (int(array.shape[0]), int(array.shape[1]))
    elif array.ndim == 3:
        components, height, width = (int(value) for value in array.shape)
    else:
        raise ValueError(
            f"HTJ2K encode expects a 2D plane or 3D (components, y, x) volume, got shape {array.shape}."
        )
    return {
        "width": width,
        "height": height,
        "components": components,
        "dtype": array.dtype.name,
        "reversible": reversible,
        "quality": quality,
        "plane": base64.b64encode(array.tobytes(order="C")).decode("ascii"),
    }


# Decode response header (see vendor/encode-plane.mjs): little-endian
# u32 components, u32 height, u32 width, u8 bytesPerSample, u8 isSigned.
_DECODE_HEADER = struct.Struct("<IIIBB")


def _decode_response_to_array(resp: bytes) -> np.ndarray:
    components, height, width, bytes_per_sample, is_signed = _DECODE_HEADER.unpack_from(resp, 0)
    body = resp[_DECODE_HEADER.size :]
    dtype = np.dtype(f"{'i' if is_signed else 'u'}{bytes_per_sample}")
    return np.frombuffer(body, dtype=dtype).reshape(components, height, width)


class OpenJphEncoderWorker:
    """Long-lived Node subprocess that loads OpenJPH WASM once."""

    def __init__(self) -> None:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("Node.js is required for HTJ2K encode but was not found on PATH.")
        if not _ENCODE_SCRIPT.is_file():
            raise RuntimeError(f"HTJ2K encode script not found: {_ENCODE_SCRIPT}")
        vendor_dir = openjph_vendor_dir()
        missing = [
            str(path.relative_to(vendor_dir))
            for path in (vendor_dir / "index.mjs", vendor_dir / "wasm" / "libopenjph.wasm")
            if not path.is_file()
        ]
        if missing:
            raise RuntimeError(
                f"Vendored openjph-wasm assets missing under {vendor_dir}: {', '.join(missing)}. "
                "Both index.mjs and wasm/libopenjph.wasm are required; "
                "run scripts/vendor-openjph-for-python.mjs before building the package."
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

    def _request(self, payload: dict[str, Any]) -> bytes:
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                raise RuntimeError("HTJ2K worker is not running.")
            body = json.dumps(payload).encode("utf-8")
            assert self._proc.stdin is not None
            assert self._proc.stdout is not None
            self._proc.stdin.write(struct.pack(">I", len(body)))
            self._proc.stdin.write(body)
            self._proc.stdin.flush()

            header = self._read_exact(self._proc.stdout, 5)
            status = header[0]
            length = struct.unpack(">I", header[1:5])[0]
            resp = self._read_exact(self._proc.stdout, length)
            if status != 0:
                message = resp.decode("utf-8", errors="replace")
                raise RuntimeError(message or "HTJ2K worker failed.")
            return bytes(resp)

    def encode(self, volume: np.ndarray, *, reversible: bool = True, quality: float = 0.0) -> bytes:
        return self._request(
            _encode_request_payload(volume, reversible=reversible, quality=quality)
        )

    def decode(self, codestream: bytes | bytearray) -> np.ndarray:
        payload = {
            "op": "decode",
            "codestream": base64.b64encode(bytes(codestream)).decode("ascii"),
        }
        return _decode_response_to_array(self._request(payload))

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

    def _next_worker(self) -> OpenJphEncoderWorker:
        with self._lock:
            worker = self._workers[self._next]
            self._next = (self._next + 1) % len(self._workers)
        return worker

    def encode(self, volume: np.ndarray, *, reversible: bool = True, quality: float = 0.0) -> bytes:
        return self._next_worker().encode(volume, reversible=reversible, quality=quality)

    def decode(self, codestream: bytes | bytearray) -> np.ndarray:
        return self._next_worker().decode(codestream)

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


def encode_htj2k(
    volume: np.ndarray,
    *,
    reversible: bool = True,
    quality: float = 0.0,
) -> bytes:
    """Encode a 2D plane or 3D (components, y, x) volume to an HTJ2K codestream."""
    return get_encoder_pool().encode(volume, reversible=reversible, quality=quality)


def encode_htj2k_plane(
    plane: np.ndarray,
    *,
    reversible: bool = True,
    quality: float = 0.0,
) -> bytes:
    """Encode one 2D plane through the vendored OpenJPH WASM worker pool."""
    return encode_htj2k(plane, reversible=reversible, quality=quality)


def decode_htj2k(codestream: bytes | bytearray) -> np.ndarray:
    """Decode an HTJ2K codestream to a (components, y, x) array via openjph-wasm."""
    return get_encoder_pool().decode(codestream)
