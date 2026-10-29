"""The declared `imagecodecs` floor must encode HTJ2K natively, without Node.js.

CI also runs this file with every direct dependency at its declared minimum
(`--resolution lowest-direct`) on each platform we ship for, so a floor that
admits an `imagecodecs` without HTJ2K wheels fails here rather than silently
leaving encodes dependent on Node.
"""

from __future__ import annotations

import pytest

from spatialdata_js_util.codecs import backends
from spatialdata_js_util.codecs.backends import (
    BACKEND_IMAGECODECS,
    BACKEND_OPENJPH_WASM,
    backend_report,
    reset_backend_cache,
)


@pytest.fixture
def fresh_backend_selection(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv(backends._BACKEND_ENV_VAR, raising=False)
    reset_backend_cache()
    yield
    monkeypatch.undo()
    reset_backend_cache()


def test_imagecodecs_is_selected_without_node(
    monkeypatch: pytest.MonkeyPatch, fresh_backend_selection: None
) -> None:
    # An empty PATH hides Node, so only the native backend can be selected.
    monkeypatch.setenv("PATH", "")
    report = backend_report()
    assert report["backends"][BACKEND_OPENJPH_WASM]["available"] is False
    assert report["backends"][BACKEND_IMAGECODECS] == {
        "available": True,
        "passes_multicomponent_probe": True,
    }
    assert report["selected"] == BACKEND_IMAGECODECS


def test_falling_back_to_wasm_warns(
    monkeypatch: pytest.MonkeyPatch, fresh_backend_selection: None
) -> None:
    monkeypatch.setattr(backends._BACKENDS[BACKEND_IMAGECODECS], "available", lambda: False)
    monkeypatch.setattr(backends._BACKENDS[BACKEND_OPENJPH_WASM], "available", lambda: True)
    with pytest.warns(RuntimeWarning, match="openjph-wasm"):
        assert backends.resolve_backend() is backends._BACKENDS[BACKEND_OPENJPH_WASM]
