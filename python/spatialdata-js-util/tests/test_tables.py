"""CSC conversion of SpatialData table matrices."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from spatialdata_js_util.errors import WriterCommandError
from spatialdata_js_util.store import drop_consolidated_metadata
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

    def test_refuses_a_destination_that_would_delete_the_source(self, tmp_path: Path) -> None:
        # The overwrite branch rmtree's the destination first, so a destination
        # equal to (or containing) the source destroys the store being read.
        store = _store(tmp_path / "s.zarr")
        for dest in (store, store.parent):
            with pytest.raises(WriterCommandError, match="delete the source"):
                convert_store_tables_to_csc(store, dest, overwrite=True)
        assert (store / "tables" / "table").is_dir()

    def test_converts_a_table_with_no_x(self, tmp_path: Path) -> None:
        # `X` is optional in AnnData; the layers still convert.
        store = _store(tmp_path / "s.zarr")
        shutil.rmtree(store / "tables" / "table" / "X")
        drop_consolidated_metadata(store / "tables" / "table")

        result = convert_store_tables_to_csc(store)

        assert result.manifest["tables"][0]["matrices"]["X"] == "absent"
        assert result.manifest["tables"][0]["n_obs"] == 0

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


class TestConsolidatedMetadataSurvivesConversion:
    """Regression: a CSC conversion must not make the store unopenable.

    An index-permutations store has `points/<key>/` directories but historically
    no `points/zarr.json`. Rebuilding consolidated metadata purely from on-disk
    metadata files dropped the `points` parent, orphaning its children, and zarr
    then refused to open the store *at all* — which looked like element data loss
    rather than a metadata fault.
    """

    @staticmethod
    def _store_with_points(path: Path) -> Path:
        import pandas as pd
        from spatialdata.models import PointsModel

        rng = np.random.default_rng(0)
        points = PointsModel.parse(
            pd.DataFrame(
                {
                    "x": rng.uniform(0, 100, 500),
                    "y": rng.uniform(0, 100, 500),
                    "feature_name": pd.Categorical(rng.choice(["a", "b", "c"], 500)),
                }
            ),
            feature_key="feature_name",
        )
        sd.SpatialData(tables={"table": _table()}, points={"transcripts": points}).write(
            path, overwrite=True
        )
        return path

    def test_csc_conversion_keeps_an_index_permutations_store_readable(
        self, tmp_path: Path
    ) -> None:
        from spatialdata_js_util.index_permutations import write_index_permutations

        source = self._store_with_points(tmp_path / "src.zarr")
        permuted = tmp_path / "perm.zarr"
        write_index_permutations(source, permuted, points_key="transcripts")

        # Readable before the conversion...
        assert sd.read_zarr(permuted) is not None

        convert_store_tables_to_csc(permuted)

        # ...and still readable after it.
        reopened = sd.read_zarr(permuted)
        assert reopened.tables["table"].X.format == "csc"
        assert "transcripts" in reopened.points

    def test_index_permutations_writes_the_points_group(self, tmp_path: Path) -> None:
        from spatialdata_js_util.index_permutations import write_index_permutations

        source = self._store_with_points(tmp_path / "src.zarr")
        permuted = tmp_path / "perm.zarr"
        write_index_permutations(source, permuted, points_key="transcripts")

        assert (permuted / "points" / "zarr.json").is_file()

    def test_refresh_reconstructs_a_missing_collection_parent(self, tmp_path: Path) -> None:
        """The repair that keeps a store openable when its parent group is absent."""
        import json

        from spatialdata_js_util.store import (
            consolidated_metadata_orphans,
            refresh_consolidated_metadata,
        )

        store = self._store_with_points(tmp_path / "src.zarr")
        # Simulate the writer that produced the broken store.
        (store / "points" / "zarr.json").unlink()

        refresh_consolidated_metadata(store)

        meta = json.loads((store / "zarr.json").read_text())["consolidated_metadata"]["metadata"]
        assert consolidated_metadata_orphans(meta) == []
        # The missing parent is filled in rather than dropped.
        assert meta["points"]["node_type"] == "group"
        assert sd.read_zarr(store) is not None

    def test_refresh_refuses_to_write_orphaned_entries(self, monkeypatch, tmp_path: Path) -> None:
        """The guard itself — an orphan that reconstruction cannot fill in.

        Reconstruction covers every orphan reachable from a disk walk, so the
        `ValueError` branch is only reachable if that ever stops holding. Pinning
        it means a change to `_collect_consolidated_metadata` cannot quietly start
        writing a listing that makes the store unopenable.
        """
        from spatialdata_js_util import store as store_module

        store = self._store_with_points(tmp_path / "src.zarr")

        def _orphaned(*_args, **_kwargs):
            return {"points/transcripts": {"node_type": "group", "zarr_format": 3}}

        monkeypatch.setattr(store_module, "_collect_consolidated_metadata", _orphaned)

        with pytest.raises(ValueError, match="orphaned entries"):
            store_module.refresh_consolidated_metadata(store)


class TestConversionDoesNotReEncodeTheRestOfTheTable:
    """Regression: the conversion must touch the matrices and nothing else.

    Re-serialising the whole AnnData re-encoded `obs`/`var` with the installed
    AnnData's current conventions — a `nullable-string-array` group instead of a
    plain string array for the index, and `sharding_indexed` on every array. The
    values were all still there, but readers looking for `var/_index` as an array
    found a group and fell back to synthetic `var0..varN` names.
    """

    @staticmethod
    def _node_encoding(path: Path) -> str:
        doc = json.loads((path / "zarr.json").read_text())
        if doc.get("node_type") == "group":
            return f"group[{doc.get('attributes', {}).get('encoding-type')}]"
        return f"array[{doc.get('data_type')}] {[c['name'] for c in doc.get('codecs', [])]}"

    @staticmethod
    def _named_table(n_obs: int = 40, n_vars: int = 6):
        from spatialdata.models import TableModel

        matrix = sparse.random(
            n_obs, n_vars, density=0.4, format="csr", random_state=0, dtype=np.float32
        )
        adata = anndata.AnnData(X=matrix)
        adata.var.index = [f"GENE{i}" for i in range(n_vars)]
        adata.obs.index = [f"cell{i}" for i in range(n_obs)]
        adata.obs["region"] = "img"
        adata.obs["region"] = adata.obs["region"].astype("category")
        adata.obs["instance_id"] = np.arange(n_obs)
        return TableModel.parse(
            adata, region="img", region_key="region", instance_key="instance_id"
        )

    def _store(self, path: Path) -> Path:
        sd.SpatialData(tables={"table": self._named_table()}).write(path, overwrite=True)
        return path

    def test_var_and_obs_encoding_is_byte_identical(self, tmp_path: Path) -> None:
        store = self._store(tmp_path / "s.zarr")
        table = store / "tables" / "table"
        before = {
            str(p.parent.relative_to(table)): p.read_bytes()
            for p in sorted(table.rglob("zarr.json"))
            if p.parent.name != "X" and "X/" not in str(p.parent.relative_to(table))
        }

        convert_store_tables_to_csc(store)

        after = {
            str(p.parent.relative_to(table)): p.read_bytes()
            for p in sorted(table.rglob("zarr.json"))
            if p.parent.name != "X" and "X/" not in str(p.parent.relative_to(table))
        }
        changed = [k for k in before if before.get(k) != after.get(k)]
        assert changed == [], f"conversion re-encoded non-matrix nodes: {changed}"

    def test_var_index_encoding_is_preserved(self, tmp_path: Path) -> None:
        store = self._store(tmp_path / "s.zarr")
        index_path = store / "tables" / "table" / "var" / "_index"
        before = self._node_encoding(index_path)

        convert_store_tables_to_csc(store)

        assert self._node_encoding(index_path) == before

    def test_a_plain_string_index_is_not_upgraded(self, tmp_path: Path) -> None:
        """The case that broke: an older store must not gain the newer encoding.

        Stores written by earlier stacks hold `var/_index` as a plain string
        array. Newer AnnData writes a `nullable-string-array` group instead, and
        a conversion that re-encodes the index silently upgrades the store out
        from under readers that only understand the array form.
        """
        import anndata as ad

        store = self._store(tmp_path / "s.zarr")
        index_path = store / "tables" / "table" / "var" / "_index"

        # Rewrite the index the way an older stack would have.
        if not hasattr(ad.settings, "allow_write_nullable_strings"):
            pytest.skip("This AnnData has no nullable-string setting to pin.")
        import zarr
        from anndata.io import read_elem, write_elem

        root = zarr.open_group(str(store / "tables" / "table"), mode="a", use_consolidated=False)
        var = read_elem(root["var"])
        previous = ad.settings.allow_write_nullable_strings
        ad.settings.allow_write_nullable_strings = False
        try:
            write_elem(root, "var", var)
        finally:
            ad.settings.allow_write_nullable_strings = previous

        legacy = self._node_encoding(index_path)
        assert legacy.startswith("array["), f"failed to build the legacy layout: {legacy}"

        convert_store_tables_to_csc(store)

        assert self._node_encoding(index_path) == legacy
        assert list(sd.read_zarr(store).tables["table"].var.index) == [
            f"GENE{i}" for i in range(6)
        ]

    def test_var_names_are_readable_after_conversion(self, tmp_path: Path) -> None:
        store = self._store(tmp_path / "s.zarr")
        convert_store_tables_to_csc(store)
        table = sd.read_zarr(store).tables["table"]
        assert list(table.var.index) == [f"GENE{i}" for i in range(6)]
        assert list(table.obs.index) == [f"cell{i}" for i in range(40)]

    def test_matrix_is_not_sharded(self, tmp_path: Path) -> None:
        """Sharded chunks are a newer zarr feature older readers cannot decode."""
        store = self._store(tmp_path / "s.zarr")

        convert_store_tables_to_csc(store)

        for part in ("data", "indices", "indptr"):
            encoding = self._node_encoding(store / "tables" / "table" / "X" / part)
            assert "sharding_indexed" not in encoding, f"X/{part} was sharded: {encoding}"

    def test_var_dtypes_are_not_normalised(self, tmp_path: Path) -> None:
        """object->category drift was harmless but still an unasked-for change."""
        store = self._store(tmp_path / "s.zarr")
        table_path = store / "tables" / "table"
        import zarr

        root = zarr.open_group(str(table_path), mode="a", use_consolidated=False)
        from anndata.io import write_elem

        import pandas as pd

        var = pd.DataFrame(
            {"genome": pd.Series(["GRCh38"] * 6, dtype=object)},
            index=[f"GENE{i}" for i in range(6)],
        )
        write_elem(root, "var", var)
        before = json.loads((table_path / "var" / "genome" / "zarr.json").read_text())

        convert_store_tables_to_csc(store)

        after = json.loads((table_path / "var" / "genome" / "zarr.json").read_text())
        assert after == before


class TestNestedConsolidatedMetadata:
    """A table group's own consolidated listing must not survive a rewrite.

    It caches the encoding of everything below it. Left in place after the
    matrices are rewritten it describes the old codecs, and zarr trusts it over
    the actual files — the array reads back as a checksum failure even though
    the bytes on disk are correct.
    """

    def test_stale_nested_listing_is_dropped(self, tmp_path: Path) -> None:
        import zarr

        store = _store(tmp_path / "s.zarr")
        table_path = store / "tables" / "table"

        # Give the table group a consolidated listing, as older writers did.
        zarr.consolidate_metadata(zarr.open_group(str(table_path), mode="a").store)
        assert "consolidated_metadata" in json.loads((table_path / "zarr.json").read_text())

        convert_store_tables_to_csc(store)

        assert "consolidated_metadata" not in json.loads(
            (table_path / "zarr.json").read_text()
        )
        assert sd.read_zarr(store).tables["table"].X.format == "csc"

    def test_conversion_is_readable_with_a_pre_existing_nested_listing(
        self, tmp_path: Path
    ) -> None:
        import zarr

        store = _store(tmp_path / "s.zarr")
        table_path = store / "tables" / "table"
        zarr.consolidate_metadata(zarr.open_group(str(table_path), mode="a").store)

        convert_store_tables_to_csc(store)

        table = sd.read_zarr(store).tables["table"]
        assert table.X.format == "csc"
        assert table.X.nnz > 0
