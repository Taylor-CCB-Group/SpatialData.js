from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from spatialdata_js_util.cli import main
from spatialdata_js_util.errors import WriterCommandError
from spatialdata_js_util.physical_size import record_physical_size

XENIUM_SCALE = 1 / 0.2125


def _space(name: str, axes: str) -> dict[str, Any]:
    return {"name": name, "axes": [{"name": a, "type": "space", "unit": "unit"} for a in axes]}


def _scale(scale: list[float], axes: str = "xy", cs: str = "global") -> dict[str, Any]:
    return {"type": "scale", "scale": scale, "input": _space(axes, axes), "output": _space(cs, axes)}


def _write(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc))


def _group(attrs: dict[str, Any]) -> dict[str, Any]:
    return {"zarr_format": 3, "node_type": "group", "attributes": attrs}


def _store(
    tmp_path: Path,
    *,
    root_attrs: dict[str, Any] | None = None,
    cells: dict[str, Any] | None = None,
) -> Path:
    """The layout spatialdata-io's xenium reader writes: µm points/shapes scaled into pixels."""
    store = tmp_path / "s.zarr"
    elements = {
        "points/transcripts": {
            "coordinateTransformations": [_scale([XENIUM_SCALE, XENIUM_SCALE, 1.0], "xyz")]
        },
        "shapes/cells": {
            "coordinateTransformations": [cells or _scale([XENIUM_SCALE, XENIUM_SCALE])]
        },
        "images/morphology": {
            "ome": {
                "multiscales": [
                    {
                        "coordinateTransformations": [
                            {"type": "identity", "input": _space("yx", "yx"), "output": _space("global", "yx")}
                        ]
                    }
                ]
            }
        },
    }
    for path, attrs in elements.items():
        _write(store / path / "zarr.json", _group(attrs))
    root = _group(root_attrs or {})
    root["consolidated_metadata"] = {
        "kind": "inline",
        "must_understand": False,
        "metadata": {path: _group(attrs) for path, attrs in elements.items()},
    }
    _write(store / "zarr.json", root)
    return store


def _root_attrs(store: Path) -> dict[str, Any]:
    return json.loads((store / "zarr.json").read_text())["attributes"]


def test_reader_convention_records_inverse_shared_scale(tmp_path: Path) -> None:
    store = _store(tmp_path, root_attrs={"spatialdata_io_reader": "xenium"})
    before = json.loads((store / "zarr.json").read_text())["consolidated_metadata"]

    record_physical_size(store)

    attrs = _root_attrs(store)
    assert attrs["physical_size"] == {"global": {"size": 0.2125, "unit": "micrometer"}}
    why = attrs["spatialdata_js_util"]["physical_size"]["coordinate_systems"]["global"]
    assert why["source"] == "reader-convention"
    assert why["reader"] == "xenium"
    assert why["reader_from"] == "spatialdata_io_reader"
    assert why["elements"] == ["points/transcripts", "shapes/cells"]
    # Only the root's attributes change.
    assert attrs["spatialdata_io_reader"] == "xenium"
    assert json.loads((store / "zarr.json").read_text())["consolidated_metadata"] == before


def test_pre_070_stores_need_the_reader_assumed(tmp_path: Path) -> None:
    store = _store(tmp_path)

    result = record_physical_size(store)
    assert result.manifest["coordinate_systems"]["global"]["action"] == "skipped"
    assert "physical_size" not in _root_attrs(store)

    record_physical_size(store, assume_reader="xenium")
    attrs = _root_attrs(store)
    assert attrs["physical_size"]["global"]["size"] == 0.2125
    assert attrs["spatialdata_js_util"]["physical_size"]["coordinate_systems"]["global"][
        "reader_from"
    ] == "assumed"


def test_assumed_reader_must_match_a_recorded_one(tmp_path: Path) -> None:
    store = _store(tmp_path, root_attrs={"spatialdata_io_reader": "visium_hd"})
    with pytest.raises(WriterCommandError, match="visium_hd"):
        record_physical_size(store, assume_reader="xenium")


def test_disagreeing_scales_fall_back_to_atera_pixel_size(tmp_path: Path) -> None:
    disagreeing = _scale([2.0, 2.0])
    xenium = _store(tmp_path / "x", root_attrs={"spatialdata_io_reader": "xenium"}, cells=disagreeing)
    report = record_physical_size(xenium).manifest["coordinate_systems"]["global"]
    assert report == {"action": "skipped", "reason": "points and shapes are scaled differently"}

    atera = _store(
        tmp_path / "a",
        root_attrs={"spatialdata_io_reader": "atera", "pixel_size": 0.2125},
        cells=disagreeing,
    )
    record_physical_size(atera)
    attrs = _root_attrs(atera)
    assert attrs["physical_size"] == {"global": {"size": 0.2125, "unit": "micrometer"}}
    assert attrs["spatialdata_js_util"]["physical_size"]["coordinate_systems"]["global"][
        "source"
    ] == "pixel_size-attr"


def test_sheared_transforms_are_not_a_uniform_scale(tmp_path: Path) -> None:
    sheared = {
        "type": "affine",
        "affine": [[4.0, 0.5, 0.0], [0.0, 4.0, 0.0]],
        "input": _space("xy", "xy"),
        "output": _space("global", "xy"),
    }
    store = _store(tmp_path, root_attrs={"spatialdata_io_reader": "xenium"}, cells=sheared)
    report = record_physical_size(store).manifest["coordinate_systems"]["global"]
    assert report["reason"] == "shapes/cells: not a uniform xy scale"


def test_sequences_compose(tmp_path: Path) -> None:
    sequence = {
        "type": "sequence",
        "transformations": [_scale([2.0, 2.0]), {"type": "translation", "translation": [5.0, 7.0]}, _scale([XENIUM_SCALE / 2] * 2)],
        "input": _space("xy", "xy"),
        "output": _space("global", "xy"),
    }
    store = _store(tmp_path, root_attrs={"spatialdata_io_reader": "xenium"}, cells=sequence)
    record_physical_size(store)
    assert _root_attrs(store)["physical_size"]["global"]["size"] == 0.2125


def test_explicit_size_wins_and_existing_entries_are_kept(tmp_path: Path) -> None:
    store = _store(tmp_path, root_attrs={"spatialdata_io_reader": "xenium"})
    record_physical_size(store, sizes={"global": 212.5}, unit="nm")
    assert _root_attrs(store)["physical_size"]["global"] == {"size": 212.5, "unit": "nanometer"}

    # A later inferring run leaves it alone unless told to replace it.
    record_physical_size(store)
    assert _root_attrs(store)["physical_size"]["global"]["unit"] == "nanometer"
    record_physical_size(store, overwrite=True)
    assert _root_attrs(store)["physical_size"]["global"] == {"size": 0.2125, "unit": "micrometer"}


def test_rejects_unknown_coordinate_systems_and_units(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(WriterCommandError, match="Unknown coordinate system"):
        record_physical_size(store, sizes={"aligned": 1.0})
    with pytest.raises(WriterCommandError, match="Not a length unit"):
        record_physical_size(store, sizes={"global": 1.0}, unit="pixel")


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    store = _store(tmp_path, root_attrs={"spatialdata_io_reader": "xenium"})
    before = (store / "zarr.json").read_bytes()
    result = record_physical_size(store, dry_run=True)
    assert result.physical_size == {"global": {"size": 0.2125, "unit": "micrometer"}}
    assert (store / "zarr.json").read_bytes() == before


def test_zarr_v2_updates_zattrs_and_zmetadata(tmp_path: Path) -> None:
    store = tmp_path / "v2.zarr"
    _write(store / ".zgroup", {"zarr_format": 2})
    _write(store / ".zattrs", {"spatialdata_io_reader": "xenium"})
    _write(store / ".zmetadata", {"metadata": {".zgroup": {"zarr_format": 2}}, "zarr_consolidated_format": 1})
    _write(store / "shapes/cells/.zgroup", {"zarr_format": 2})
    _write(store / "shapes/cells/.zattrs", {"coordinateTransformations": [_scale([XENIUM_SCALE] * 2)]})

    record_physical_size(store)

    expected = {"global": {"size": 0.2125, "unit": "micrometer"}}
    assert json.loads((store / ".zattrs").read_text())["physical_size"] == expected
    zmetadata = json.loads((store / ".zmetadata").read_text())
    assert zmetadata["metadata"][".zattrs"]["physical_size"] == expected


def test_cli(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    store = _store(tmp_path)
    main(["physical-size", str(store), "--size", "global=0.5", "--unit", "µm"])
    output = json.loads(capsys.readouterr().out)
    assert output["physical_size"] == {"global": {"size": 0.5, "unit": "micrometer"}}
    assert _root_attrs(store)["physical_size"] == output["physical_size"]

    with pytest.raises(SystemExit):
        main(["physical-size", str(store), "--size", "global"])


def test_spatialdata_reads_the_patched_store(tmp_path: Path) -> None:
    sd = pytest.importorskip("spatialdata")
    geopandas = pytest.importorskip("geopandas")
    from shapely.geometry import Point
    from spatialdata.models import ShapesModel
    from spatialdata.transformations import Scale

    circles = geopandas.GeoDataFrame({"radius": [1.0]}, geometry=[Point(0, 0)])
    shapes = ShapesModel.parse(
        circles, transformations={"global": Scale([XENIUM_SCALE] * 2, axes=("x", "y"))}
    )
    store = tmp_path / "s.zarr"
    sd.SpatialData(shapes={"cells": shapes}).write(store)

    record_physical_size(store, assume_reader="xenium")

    read = sd.read_zarr(store)
    assert read.attrs["physical_size"] == {"global": {"size": 0.2125, "unit": "micrometer"}}
    assert list(read.shapes) == ["cells"]
