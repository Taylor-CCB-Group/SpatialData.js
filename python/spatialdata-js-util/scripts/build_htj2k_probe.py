#!/usr/bin/env python3
"""Regenerate the committed multi-component HTJ2K probe fixture.

The fixture gates whether an HTJ2K backend may be used (see
`spatialdata_js_util.codecs.backends`). It is deliberately produced by the
**openjph-wasm** backend, so passing the probe means "this backend can read what
our writer produces", not merely "this backend is self-consistent".

Requires Node.js and the vendored WASM assets:

    node scripts/vendor-openjph-for-python.mjs
    uv run --directory python/spatialdata-js-util python scripts/build_htj2k_probe.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

PROBE_DIR = Path(__file__).resolve().parent.parent / "src/spatialdata_js_util/codecs/probe"

# Small, but with enough structure that a component mix-up cannot pass by luck:
# every plane has a distinct gradient and a distinct constant offset.
COMPONENTS, HEIGHT, WIDTH = 3, 16, 12


def probe_volume() -> np.ndarray:
    y, x = np.mgrid[0:HEIGHT, 0:WIDTH]
    planes = [
        (x * 7 + y * 13 * (c + 1) + c * 1000 + 1).astype(np.uint16) for c in range(COMPONENTS)
    ]
    return np.ascontiguousarray(np.stack(planes, axis=0))


def main() -> int:
    from spatialdata_js_util.codecs.htj2k_wasm import (
        decode_htj2k_wasm,
        encode_htj2k_wasm,
        wasm_encode_available,
    )

    if not wasm_encode_available():
        print(
            "openjph-wasm backend unavailable. Ensure Node.js is on PATH and run\n"
            "  node scripts/vendor-openjph-for-python.mjs",
            file=sys.stderr,
        )
        return 1

    volume = probe_volume()
    codestream = encode_htj2k_wasm(volume, reversible=True)

    roundtrip = decode_htj2k_wasm(codestream).reshape(volume.shape)
    if not np.array_equal(roundtrip, volume):
        print("Refusing to write a probe fixture the encoder cannot round-trip.", file=sys.stderr)
        return 1

    PROBE_DIR.mkdir(parents=True, exist_ok=True)
    (PROBE_DIR / "multicomponent.j2c").write_bytes(codestream)
    np.save(PROBE_DIR / "multicomponent.npy", volume)
    print(
        f"Wrote probe fixture to {PROBE_DIR}: "
        f"{len(codestream)} byte codestream, {volume.shape} {volume.dtype} expected samples"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
