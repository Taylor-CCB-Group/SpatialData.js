"""Convert SpatialData table matrices to CSC.

Browser clients read expression data one *variable* at a time — colour cells by
one gene, then another. In CSR (AnnData's default on disk) a single gene's values
are scattered across every row's slice, so one gene costs a read of essentially
the whole matrix. In CSC that gene is one contiguous run of `indptr[j]:indptr[j+1]`,
so it is a single ranged read.

The conversion is lossless and reversible: only the sparse layout changes, not
the values, and `scipy`/`anndata` read either layout transparently. It is
therefore safe to apply to a store that other tools also read.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence

from .errors import WriterCommandError
from .provenance import package_version
from .store import (
    list_element_keys,
    read_json,
    refresh_consolidated_metadata,
    write_json,
    zarr_format_of,
)

if TYPE_CHECKING:
    from anndata import AnnData

#: Matrix keys converted by default: `X` plus every entry of `layers`.
DEFAULT_MATRIX_KEYS = ("X", "layers")


@dataclass(frozen=True)
class CscConversion:
    store_path: Path
    manifest_path: Path | None
    manifest: dict[str, Any]


def _sparse_format(matrix: Any) -> str | None:
    """Return the scipy sparse format string ('csr', 'csc', …) or None if dense."""
    return getattr(matrix, "format", None)


def to_csc(matrix: Any, *, densify: bool = False) -> Any:
    """Return *matrix* in CSC layout.

    Already-CSC input is returned unchanged. Dense input is only converted when
    *densify* is set, because making a dense matrix sparse can multiply its size
    rather than shrink it.
    """
    import scipy.sparse as sp

    fmt = _sparse_format(matrix)
    if fmt == "csc":
        return matrix
    if fmt is not None:
        return matrix.tocsc()
    if densify:
        return sp.csc_matrix(matrix)
    return matrix


def anndata_to_csc(
    adata: "AnnData",
    *,
    layers: bool = True,
    densify: bool = False,
) -> dict[str, str]:
    """Convert `adata.X` (and optionally `adata.layers`) to CSC in place.

    Returns a per-matrix report of ``{key: "csr->csc" | "already-csc" | …}``.
    """
    report: dict[str, str] = {}

    before = _sparse_format(adata.X)
    converted = to_csc(adata.X, densify=densify)
    if converted is not adata.X:
        adata.X = converted
    report["X"] = _describe(before, _sparse_format(adata.X))

    if layers:
        for key in list(adata.layers.keys()):
            # anndata >=0.12 exposes `X` as a `None`-keyed layer alias; converting
            # it again would double-report (and rewrite) the matrix handled above.
            if key is None:
                continue
            layer_before = _sparse_format(adata.layers[key])
            layer_converted = to_csc(adata.layers[key], densify=densify)
            if layer_converted is not adata.layers[key]:
                adata.layers[key] = layer_converted
            report[f"layers/{key}"] = _describe(
                layer_before, _sparse_format(adata.layers[key])
            )
    return report


def _describe(before: str | None, after: str | None) -> str:
    if before is None and after is None:
        return "dense (unchanged)"
    if before == after:
        return f"already-{after}"
    return f"{before or 'dense'}->{after}"


def _read_table(path: Path) -> "AnnData":
    import anndata as ad

    return ad.read_zarr(path)


#: Group attributes owned by AnnData's own encoding, which it rewrites itself.
_ANNDATA_OWNED_ATTRS = frozenset({"encoding-type", "encoding-version"})


def _group_attrs_path(path: Path) -> tuple[Path, str | None]:
    """Return the metadata file holding a group's attributes, and its nesting key."""
    if (path / "zarr.json").is_file():
        return path / "zarr.json", "attributes"
    if (path / ".zattrs").is_file():
        return path / ".zattrs", None
    raise FileNotFoundError(f"No zarr group attributes found at {path}")


def _read_group_attrs(path: Path) -> dict[str, Any]:
    meta_path, key = _group_attrs_path(path)
    doc = read_json(meta_path)
    return dict(doc.get(key, {})) if key else dict(doc)


def _merge_group_attrs(path: Path, attrs: dict[str, Any]) -> None:
    meta_path, key = _group_attrs_path(path)
    doc = read_json(meta_path)
    if key:
        merged = {**dict(doc.get(key, {})), **attrs}
        doc[key] = merged
    else:
        doc = {**doc, **attrs}
    write_json(meta_path, doc)


def _write_table(adata: "AnnData", path: Path, *, zarr_format: int) -> None:
    """Rewrite a table group, preserving SpatialData's element attributes.

    `AnnData.write_zarr` writes only AnnData's own group attributes, so a plain
    rewrite silently drops the `spatialdata-encoding-type`, `region`,
    `region_key`, `instance_key`, and `version` keys that SpatialData puts on the
    group — and `read_zarr` then fails on the missing version. We therefore
    capture the group's attributes first and merge the non-AnnData ones back.
    """
    import anndata as ad

    preserved = {
        key: value
        for key, value in _read_group_attrs(path).items()
        if key not in _ANNDATA_OWNED_ATTRS
    }

    # AnnData writes whichever zarr format its global setting names; a store must
    # not end up with mixed-format groups, so pin it to the format we read.
    previous = ad.settings.zarr_write_format
    ad.settings.zarr_write_format = zarr_format
    try:
        if path.exists():
            shutil.rmtree(path)
        adata.write_zarr(path)
    finally:
        ad.settings.zarr_write_format = previous

    if preserved:
        _merge_group_attrs(path, preserved)


def convert_store_tables_to_csc(
    source: str | Path,
    dest: str | Path | None = None,
    *,
    tables: Sequence[str] | None = None,
    layers: bool = True,
    densify: bool = False,
    overwrite: bool = False,
    manifest: bool = True,
) -> CscConversion:
    """Rewrite a store's table matrices in CSC layout.

    With *dest*, the store is copied first and the source left untouched; without
    it, tables are rewritten in place. Pass *tables* to restrict which table
    elements are converted (default: all of them).
    """
    source_path = Path(source)
    if not (source_path / "zarr.json").is_file():
        raise WriterCommandError(f"Not a zarr store (no zarr.json): {source_path}")

    if dest is None:
        store_path = source_path
        in_place = True
    else:
        store_path = Path(dest)
        in_place = False
        if store_path.exists():
            if not overwrite:
                raise WriterCommandError(
                    f"Destination already exists: {store_path}\nPass overwrite to replace it."
                )
            shutil.rmtree(store_path)
        shutil.copytree(source_path, store_path)

    available = list_element_keys(store_path, "tables")
    if not available:
        raise WriterCommandError(f"No table elements found under {store_path / 'tables'}")

    selected = list(tables) if tables else available
    unknown = [key for key in selected if key not in available]
    if unknown:
        raise WriterCommandError(
            f"Unknown table element(s): {', '.join(unknown)}. Available: {', '.join(available)}"
        )

    reports: list[dict[str, Any]] = []
    for key in selected:
        table_path = store_path / "tables" / key
        zarr_format = zarr_format_of(table_path)
        adata = _read_table(table_path)
        matrices = anndata_to_csc(adata, layers=layers, densify=densify)
        _write_table(adata, table_path, zarr_format=zarr_format)
        reports.append(
            {
                "path": f"tables/{key}",
                "n_obs": int(adata.n_obs),
                "n_vars": int(adata.n_vars),
                "zarr_format": zarr_format,
                "matrices": matrices,
            }
        )

    refresh_consolidated_metadata(store_path)

    manifest_data = {
        "format": "spatialdata-csc-tables/v1",
        "source": str(source_path),
        "output": str(store_path),
        "in_place": in_place,
        "tables": reports,
        "packages": {
            "anndata": package_version("anndata"),
            "scipy": package_version("scipy"),
            "spatialdata": package_version("spatialdata"),
            "spatialdata-js-util": package_version("spatialdata-js-util"),
            "zarr": package_version("zarr"),
        },
    }
    manifest_path = store_path.with_suffix(".csc-manifest.json") if manifest else None
    if manifest_path is not None:
        write_json(manifest_path, manifest_data)
    return CscConversion(store_path, manifest_path, manifest_data)
