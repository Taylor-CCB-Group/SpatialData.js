"""HTJ2K backend selection.

Two backends can produce and consume the HTJ2K codestreams this package writes:

``imagecodecs``
    Native OpenJPH via `imagecodecs.htj2k_encode/decode`. Pure `pip install` —
    no Node.js — so it is what makes the reader shim usable from a plain
    SpatialData environment.

``openjph-wasm``
    The vendored WASM build driven through a pool of Node.js worker processes.
    This is the same WASM the JS reader uses, so it is the reference for
    encode/decode agreement with the browser.

Historically only the WASM backend was trusted, because the WASM decoder this
repo previously depended on silently dropped every component but the first (see
`docs/multi-component-codec-findings.md`). That defect is specific to that build,
not to OpenJPH — but "a build of OpenJPH" is not on its own evidence of
correctness. So `imagecodecs` is not trusted on reputation: it is admitted only
if it decodes a committed multi-component codestream to the exact expected
samples. The probe runs once per process and the backend is rejected on any
mismatch.

The fixture's expected samples are generated in numpy rather than by a decoder,
so the ground truth is codec-independent. Which backend *encoded* the codestream
is recorded alongside it and reported by `backend_report()` — probing a backend
against a codestream it produced itself only shows self-consistency, so that
provenance is part of reading the result. See `scripts/build_htj2k_probe.py`.

Set ``SPATIALDATA_JS_UTIL_HTJ2K_BACKEND=imagecodecs|openjph-wasm`` to pin one
backend explicitly (the probe still gates ``imagecodecs``).
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

import numpy as np

BACKEND_IMAGECODECS = "imagecodecs"
BACKEND_OPENJPH_WASM = "openjph-wasm"

_BACKEND_ENV_VAR = "SPATIALDATA_JS_UTIL_HTJ2K_BACKEND"
_PROBE_DIR = Path(__file__).resolve().parent / "probe"
_PROBE_CODESTREAM = _PROBE_DIR / "multicomponent.j2c"
_PROBE_EXPECTED = _PROBE_DIR / "multicomponent.npy"
_PROBE_PROVENANCE = _PROBE_DIR / "multicomponent.json"


class Htj2kBackend(Protocol):
    """Encode/decode HTJ2K codestreams of planar ``(components, y, x)`` volumes."""

    name: str

    def available(self) -> bool: ...

    def encode(self, volume: np.ndarray, *, reversible: bool, quality: float) -> bytes: ...

    def decode(self, codestream: bytes | bytearray) -> np.ndarray: ...


def _as_planar_3d(array: np.ndarray) -> np.ndarray:
    """Normalise a decoded result to ``(components, y, x)``."""
    if array.ndim == 2:
        return array.reshape(1, *array.shape)
    if array.ndim == 3:
        return array
    raise ValueError(f"Expected a 2D or 3D HTJ2K decode result, got shape {array.shape}")


class ImagecodecsHtj2kBackend:
    """Native OpenJPH through `imagecodecs`; no Node.js required."""

    name = BACKEND_IMAGECODECS

    def available(self) -> bool:
        try:
            import imagecodecs
        except ImportError:
            return False
        return bool(getattr(imagecodecs, "HTJ2K", None) and imagecodecs.HTJ2K.available)

    def encode(self, volume: np.ndarray, *, reversible: bool, quality: float) -> bytes:
        import imagecodecs

        array = np.ascontiguousarray(np.asarray(volume))
        planar = array.ndim == 3 and array.shape[0] > 1
        if array.ndim == 3 and array.shape[0] == 1:
            array = array.reshape(array.shape[1], array.shape[2])
        if reversible:
            # `level` is the OpenJPH quantization step; omitting it selects the
            # reversible (5/3) transform.
            return bytes(imagecodecs.htj2k_encode(array, reversible=True, planar=planar, rgb=False))
        return bytes(
            imagecodecs.htj2k_encode(
                array, level=float(quality), reversible=False, planar=planar, rgb=False
            )
        )

    def decode(self, codestream: bytes | bytearray) -> np.ndarray:
        import imagecodecs

        return _as_planar_3d(np.asarray(imagecodecs.htj2k_decode(bytes(codestream), planar=True)))


class OpenJphWasmHtj2kBackend:
    """Vendored openjph-wasm driven by Node.js worker processes."""

    name = BACKEND_OPENJPH_WASM

    def available(self) -> bool:
        from .htj2k_wasm import wasm_encode_available

        return wasm_encode_available()

    def encode(self, volume: np.ndarray, *, reversible: bool, quality: float) -> bytes:
        from .htj2k_wasm import encode_htj2k_wasm

        return encode_htj2k_wasm(volume, reversible=reversible, quality=quality)

    def decode(self, codestream: bytes | bytearray) -> np.ndarray:
        from .htj2k_wasm import decode_htj2k_wasm

        return _as_planar_3d(decode_htj2k_wasm(codestream))


_BACKENDS: dict[str, Htj2kBackend] = {
    BACKEND_IMAGECODECS: ImagecodecsHtj2kBackend(),
    BACKEND_OPENJPH_WASM: OpenJphWasmHtj2kBackend(),
}

# `imagecodecs` first so that a plain `pip install` can both read and write
# without Node.js. The probe below is what makes that safe.
_PREFERENCE = (BACKEND_IMAGECODECS, BACKEND_OPENJPH_WASM)


def probe_fixture() -> tuple[bytes, np.ndarray]:
    """Return the committed multi-component codestream and its expected samples."""
    if not _PROBE_CODESTREAM.is_file() or not _PROBE_EXPECTED.is_file():
        raise FileNotFoundError(
            f"HTJ2K probe fixture missing under {_PROBE_DIR}. "
            "Regenerate it with scripts/build_htj2k_probe.py."
        )
    return _PROBE_CODESTREAM.read_bytes(), np.load(_PROBE_EXPECTED)


def probe_encoder() -> str | None:
    """Which backend encoded the committed fixture, or `None` if unrecorded.

    A backend probed against a codestream it produced itself has only shown that
    it is self-consistent, so this is needed to read a probe result correctly.
    """
    if not _PROBE_PROVENANCE.is_file():
        return None
    try:
        encoder = json.loads(_PROBE_PROVENANCE.read_text()).get("encoder")
    except (OSError, ValueError):
        return None
    return encoder if isinstance(encoder, str) else None


def available_backends() -> list[Htj2kBackend]:
    """Every installed backend, in preference order.

    Exposed for the probe builder, which has to encode with one backend and
    check the result against the others rather than take the single selected one.
    """
    return [_BACKENDS[name] for name in _PREFERENCE if _BACKENDS[name].available()]


@lru_cache(maxsize=None)
def backend_passes_probe(name: str) -> bool:
    """Whether *name* decodes the committed multi-component fixture exactly.

    A backend that raises, returns the wrong shape, or returns wrong samples
    fails. Multi-component correctness cannot be assumed from the library name:
    the WASM build previously used here decoded every component as component 0.
    """
    backend = _BACKENDS.get(name)
    if backend is None or not backend.available():
        return False
    try:
        codestream, expected = probe_fixture()
        decoded = backend.decode(codestream)
    except Exception:
        return False
    return decoded.shape == expected.shape and np.array_equal(decoded, expected)


@lru_cache(maxsize=1)
def resolve_backend() -> Htj2kBackend | None:
    """Return the HTJ2K backend to use, or ``None`` if none is usable."""
    requested = os.environ.get(_BACKEND_ENV_VAR)
    candidates = (requested,) if requested else _PREFERENCE
    if requested and requested not in _BACKENDS:
        raise ValueError(
            f"Unknown {_BACKEND_ENV_VAR}={requested!r}; expected one of {sorted(_BACKENDS)}"
        )
    for name in candidates:
        # The WASM backend is the reference the probe fixture was produced with,
        # so it is trusted on availability; every other backend must prove it.
        if name == BACKEND_OPENJPH_WASM:
            if _BACKENDS[name].available():
                return _BACKENDS[name]
        elif backend_passes_probe(name):
            return _BACKENDS[name]
    return None


def reset_backend_cache() -> None:
    """Clear memoized backend selection (used by tests that flip the env var)."""
    resolve_backend.cache_clear()
    backend_passes_probe.cache_clear()


def require_backend() -> Htj2kBackend:
    backend = resolve_backend()
    if backend is None:
        raise RuntimeError(
            "No usable HTJ2K backend. Install `imagecodecs` with HTJ2K support "
            "(pip install 'spatialdata-js-util'), or put Node.js on PATH to use the "
            "vendored openjph-wasm backend."
        )
    return backend


def htj2k_available() -> bool:
    return resolve_backend() is not None


def backend_report() -> dict[str, Any]:
    """Describe backend availability — used by manifests and `codecs info`."""
    selected = resolve_backend()
    return {
        "selected": selected.name if selected else None,
        # Reading a probe result needs to know who produced the codestream: a
        # backend that encoded it has only proved self-consistency by decoding it.
        "probe_encoder": probe_encoder(),
        "backends": {
            name: {
                "available": backend.available(),
                "passes_multicomponent_probe": backend_passes_probe(name),
            }
            for name, backend in _BACKENDS.items()
        },
    }
