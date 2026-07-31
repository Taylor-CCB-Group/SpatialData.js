#!/usr/bin/env python3
"""Regenerate the committed multi-component HTJ2K probe fixture.

The fixture gates whether an HTJ2K backend may be used (see
`spatialdata_js_util.codecs.backends`). It is a codestream plus the exact samples
it must decode to — and those samples are computed here in numpy, so the ground
truth never comes from a codec.

What the fixture proves depends on *which* backend encoded it:

- encoded by one backend and decoded by another, it proves the two agree, which
  is what admitting a new backend needs;
- encoded and decoded by the same single backend, it only shows that backend is
  self-consistent. One that mis-ordered components in both directions would pass.

So this script encodes with one backend and then requires **every** available
backend to decode the result exactly, recording which backend produced it in
`multicomponent.json`. With only one backend installed it still writes the
fixture, but says plainly what the fixture is worth in that case.

Run with as many backends installed as possible:

    # optional, for the openjph-wasm backend
    node scripts/vendor-openjph-for-python.mjs
    uv run --directory python/spatialdata-js-util python scripts/build_htj2k_probe.py
"""

from __future__ import annotations

import json
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
    from spatialdata_js_util.codecs.backends import (
        BACKEND_OPENJPH_WASM,
        available_backends,
    )

    backends = available_backends()
    if not backends:
        print(
            "No HTJ2K backend available. Install `imagecodecs` with HTJ2K support, or put\n"
            "Node.js on PATH and run `node scripts/vendor-openjph-for-python.mjs`.",
            file=sys.stderr,
        )
        return 1

    # Prefer the WASM encoder while it exists: it is the same build the browser
    # reader uses, so agreement with it is the property our stores actually need.
    # Any other available backend is a valid producer once that is gone.
    encoder = next(
        (backend for backend in backends if backend.name == BACKEND_OPENJPH_WASM),
        backends[0],
    )

    volume = probe_volume()
    codestream = encoder.encode(volume, reversible=True, quality=0.0)

    for backend in backends:
        try:
            decoded = backend.decode(codestream)
        except Exception as exc:  # noqa: BLE001 - any failure disqualifies the fixture
            print(
                f"Refusing to write a probe fixture {backend.name} cannot decode: {exc}",
                file=sys.stderr,
            )
            return 1
        if decoded.shape != volume.shape or not np.array_equal(decoded, volume):
            print(
                f"Refusing to write a probe fixture {backend.name} decodes incorrectly "
                f"(got shape {decoded.shape}, expected {volume.shape}).",
                file=sys.stderr,
            )
            return 1

    PROBE_DIR.mkdir(parents=True, exist_ok=True)
    (PROBE_DIR / "multicomponent.j2c").write_bytes(codestream)
    np.save(PROBE_DIR / "multicomponent.npy", volume)
    (PROBE_DIR / "multicomponent.json").write_text(
        json.dumps({"encoder": encoder.name}, indent=2, sort_keys=True) + "\n"
    )

    cross_checked = sorted(backend.name for backend in backends if backend.name != encoder.name)
    print(
        f"Wrote probe fixture to {PROBE_DIR}: "
        f"{len(codestream)} byte codestream, {volume.shape} {volume.dtype} expected samples, "
        f"encoded by {encoder.name}"
    )
    if cross_checked:
        print(f"Cross-checked against: {', '.join(cross_checked)}")
    else:
        print(
            f"WARNING: {encoder.name} was the only backend available, so this fixture shows\n"
            "         that it is self-consistent, not that it agrees with another decoder.\n"
            "         Regenerate with a second backend installed before relying on it to\n"
            "         admit one.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
