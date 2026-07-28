"""CSC conversion of SpatialData table matrices."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from spatialdata_js_util.errors import WriterCommandError
from spatialdata_js_util.tables import (
    anndata_to_csc,
    convert_store_tables_to_csc,
    to_csc,
)

anndata = pytest.importorskip("anndata")
sparse = pytest.importorskip("scipy.sparse")
sd = pytest.importorskip("spatialdata")


def _table(n_obs: int = 30, n_vars: int = 8, *, fmt: str = "csr"):
    from spatialdata.models import TableModel

    matrix = sparse.random(
        n_obs, n_vars, density=0.4, format=fmt, random_state=0, dtype=np.float32
    )
    adata = anndata.AnnData(X=matrix)
    adata.obs["region"] = "img"
    adata.obs["region"] = adata.obs["region"].astype("category")
    adata.obs["instance_id"] = np.arange(n_obs)
    return TableModel.parse(
        adata, region="img", region_key="region", instance_key="instance_id"
    )


def _store(path: Path, **tables):
    store = sd.SpatialData(tables=tables or {"table": _table()})
    store.write(path, overwrite=True)
    return path


class TestToCsc:
    def test_converts_csr(self) -> None:
        matrix = sparse.random(10, 4, density=0.5, format="csr", random_state=0)
        assert to_csc(matrix).format == "csc"

    def test_returns_csc_unchanged(self) -> None:
        matrix = sparse.random(10, 4, density=0.5, format="csc", random_state=0)
        assert to_csc(matrix) is matrix

    def test_leaves_dense_alone_by_default(self) -> None:
        """Sparsifying a dense matrix can grow it, so it is opt-in."""
        dense = np.arange(12, dtype=np.float32).reshape(3, 4)
        assert to_csc(dense) is dense

    def test_densify_converts_dense(self) -> None:
        dense = np.arange(12, dtype=np.float32).reshape(3, 4)
        assert to_csc(dense, densify=True).format == "csc"

    def test_preserves_values(self) -> None:
        matrix = sparse.random(20, 6, density=0.5, format="csr", random_state=1)
        assert np.allclose(to_csc(matrix).todense(), matrix.todense())


class TestAnndataToCsc:
    def test_converts_x_and_reports(self) -> None:
        adata = _table()
        report = anndata_to_csc(adata)
        assert adata.X.format == "csc"
        assert report["X"] == "csr->csc"

    def test_skips_the_none_layer_alias(self) -> None:
        """anndata >=0.12 exposes X as a None-keyed layer; it must not be re-reported."""
        adata = _table()
        report = anndata_to_csc(adata)
        assert not any(key.endswith("/None") for key in report)

    def test_converts_named_layers(self) -> None:
        adata = _table()
        adata.layers["counts"] = sparse.random(
            adata.n_obs, adata.n_vars, density=0.4, format="csr", random_state=2
        )
        report = anndata_to_csc(adata)
        assert adata.layers["counts"].format == "csc"
        assert report["layers/counts"] == "csr->csc"

    def test_no_layers_flag_leaves_layers_untouched(self) -> None:
        adata = _table()
        adata.layers["counts"] = sparse.random(
            adata.n_obs, adata.n_vars, density=0.4, format="csr", random_state=2
        )
        anndata_to_csc(adata, layers=False)
        assert adata.layers["counts"].format == "csr"


class TestConvertStoreTablesToCsc:
    def test_in_place_conversion_is_readable_by_spatialdata(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        before = sd.read_zarr(store).tables["table"].X.todense()

        result = convert_store_tables_to_csc(store)

        reopened = sd.read_zarr(store).tables["table"]
        assert reopened.X.format == "csc"
        assert np.allclose(reopened.X.todense(), before)
        assert result.manifest["tables"][0]["matrices"]["X"] == "csr->csc"

    def test_preserves_spatialdata_element_attrs(self, tmp_path: Path) -> None:
        """AnnData's writer drops these; losing them makes read_zarr fail."""
        store = _store(tmp_path / "s.zarr")
        attrs_path = store / "tables" / "table" / "zarr.json"
        before = json.loads(attrs_path.read_text())["attributes"]

        convert_store_tables_to_csc(store)

        after = json.loads(attrs_path.read_text())["attributes"]
        for key in ("spatialdata-encoding-type", "region", "region_key", "instance_key", "version"):
            assert after.get(key) == before.get(key), f"lost table attribute {key!r}"

    def test_copies_to_dest_leaving_source_untouched(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        dest = tmp_path / "csc.zarr"

        convert_store_tables_to_csc(store, dest)

        assert sd.read_zarr(dest).tables["table"].X.format == "csc"
        assert sd.read_zarr(store).tables["table"].X.format == "csr"

    def test_writes_a_manifest(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        result = convert_store_tables_to_csc(store)
        assert result.manifest_path is not None
        assert result.manifest_path.is_file()
        assert result.manifest["format"] == "spatialdata-csc-tables/v1"

    def test_rejects_existing_dest_without_overwrite(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        dest = tmp_path / "csc.zarr"
        dest.mkdir()
        with pytest.raises(WriterCommandError, match="already exists"):
            convert_store_tables_to_csc(store, dest)

    def test_rejects_unknown_table_key(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        with pytest.raises(WriterCommandError, match="Unknown table"):
            convert_store_tables_to_csc(store, tables=["nope"])

    def test_rejects_a_non_store_path(self, tmp_path: Path) -> None:
        with pytest.raises(WriterCommandError, match="Not a zarr store"):
            convert_store_tables_to_csc(tmp_path)

    def test_selects_a_single_table(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr", first=_table(), second=_table())

        convert_store_tables_to_csc(store, tables=["first"])

        reopened = sd.read_zarr(store)
        assert reopened.tables["first"].X.format == "csc"
        assert reopened.tables["second"].X.format == "csr"
