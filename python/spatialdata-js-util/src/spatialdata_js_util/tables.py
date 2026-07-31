"""Convert SpatialData table matrices to CSC.

Browser clients read expression data one *variable* at a time — colour cells by
one gene, then another. In CSR (AnnData's default on disk) a single gene's values
are scattered across every row's slice, so one gene costs a read of essentially
the whole matrix. In CSC that gene is one contiguous run of `indptr[j]:indptr[j+1]`,
so it is a single ranged read.

The conversion is lossless and reversible: only the sparse layout changes, not
the values, and `scipy`/`anndata` read either layout transparently. It is
therefore safe to apply to a store that other tools also read.

Only the matrices themselves are rewritten. An earlier version re-serialised the
whole AnnData, which quietly re-encoded `obs` and `var` with the installed
AnnData's current conventions — turning the index into a `nullable-string-array`
group and sharding the arrays — so readers that had been fine with the store
suddenly could not find the variable names. Everything written here is therefore
scoped to the matrix being converted, and pinned to the older encodings.
"""

from __future__ import annotations

import shutil
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator, Sequence

from .errors import WriterCommandError
from .provenance import package_version
from .store import (
    drop_consolidated_metadata,
    list_element_keys,
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


#: AnnData settings pinned while writing, so a matrix we rewrite is encoded the
#: way the rest of the store already is. Names absent from the installed AnnData
#: are skipped.
#:
#: `auto_shard_zarr_v3` wraps arrays in `sharding_indexed`, and
#: `allow_write_nullable_strings` stores a string column as a
#: `nullable-string-array` *group* of `values`/`mask` instead of a plain string
#: array. Both are newer AnnData defaults that older readers — including the
#: JS runtime this package targets — do not understand.
_PINNED_WRITE_SETTINGS: dict[str, Any] = {
    "auto_shard_zarr_v3": False,
    "allow_write_nullable_strings": False,
}


@contextmanager
def _anndata_write_settings(*, zarr_format: int) -> Iterator[None]:
    import anndata as ad

    settings = ad.settings
    pinned = {**_PINNED_WRITE_SETTINGS, "zarr_write_format": zarr_format}
    previous = {
        name: getattr(settings, name) for name in pinned if hasattr(settings, name)
    }
    try:
        for name, value in pinned.items():
            if name in previous:
                setattr(settings, name, value)
        yield
    finally:
        for name, value in previous.items():
            setattr(settings, name, value)


def _convert_group_matrix(group: Any, name: str, *, densify: bool) -> str:
    """Convert one matrix child of a zarr group in place, reporting what changed."""
    from anndata.io import read_elem, write_elem

    matrix = read_elem(group[name])
    before = _sparse_format(matrix)
    converted = to_csc(matrix, densify=densify)
    if converted is not matrix:
        write_elem(group, name, converted)
    return _describe(before, _sparse_format(converted))


def _convert_table_matrices(
    table_path: Path, *, layers: bool, densify: bool
) -> dict[str, str]:
    """Rewrite a table's matrices in place, touching nothing else.

    Only the matrix children are rewritten. Re-serialising the whole AnnData
    would re-encode `obs`, `var`, `uns` and friends with whatever conventions the
    installed AnnData currently prefers, silently changing parts of the store the
    conversion has no business touching.
    """
    import zarr

    # Consolidated metadata makes the group read-only; the store root's copy is
    # refreshed once at the end of the conversion instead.
    root = zarr.open_group(str(table_path), mode="a", use_consolidated=False)
    report: dict[str, str] = {}

    with _anndata_write_settings(zarr_format=zarr_format_of(table_path)):
        # `X` is optional in AnnData — a table may carry only `layers`, or only
        # annotations. Converting what is there beats refusing the whole table.
        if "X" in root:
            report["X"] = _convert_group_matrix(root, "X", densify=densify)
        else:
            report["X"] = "absent"
        if layers and "layers" in root:
            layers_group = root["layers"]
            for name in sorted(layers_group.keys()):
                report[f"layers/{name}"] = _convert_group_matrix(
                    layers_group, name, densify=densify
                )

    # The table group may carry its own consolidated listing, which now describes
    # the pre-conversion encoding. Readers trust it over the files, so a matrix
    # rewritten correctly would still fail to load.
    drop_consolidated_metadata(table_path)
    return report


def _table_dimensions(table_path: Path) -> tuple[int, int]:
    """Report `(n_obs, n_vars)`, or `(0, 0)` for a table with no `X`.

    Only used for the manifest, so an absent matrix is worth reporting as zero
    rather than failing a conversion that has nothing to do with dimensions.
    """
    import zarr

    root = zarr.open_group(str(table_path), mode="r", use_consolidated=False)
    if "X" not in root:
        return 0, 0
    shape = root["X"].attrs.get("shape")
    if shape is None:  # dense X is a plain array
        shape = root["X"].shape
    return int(shape[0]), int(shape[1])


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
        # The overwrite branch below deletes the destination before copying, so a
        # destination that *is* the source — or contains it — would delete the
        # store we are about to read. Checked against resolved paths so a symlink
        # or `.` in the argument cannot slip past.
        resolved_source = source_path.resolve()
        resolved_dest = store_path.resolve()
        if resolved_dest == resolved_source or resolved_dest in resolved_source.parents:
            raise WriterCommandError(
                f"Destination would delete the source store: {store_path}\n"
                "Pass no destination to convert in place."
            )
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
        n_obs, n_vars = _table_dimensions(table_path)
        matrices = _convert_table_matrices(table_path, layers=layers, densify=densify)
        reports.append(
            {
                "path": f"tables/{key}",
                "n_obs": n_obs,
                "n_vars": n_vars,
                "zarr_format": zarr_format_of(table_path),
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
