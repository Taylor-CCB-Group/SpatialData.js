# How minimal should the core dependencies be?

Given that the idea is to have something analogous to the Python library, that would mean that each type of `SpatialElement` would return something somewhat equivalent to the corresponding library in Python - to characterise the dependencies of that package as 'minimalist', even without the batteries-included `[extras]`, seems disingenious... Perhaps the philosophy is not so much that these will be minimal, but they should avoid needless bloat and especially any likelihood of tricky conflicts to manage (*`<cough>deck.gl</cough>`*).

Here is an approximate summary of the ways in which these are typed in Python:

```python
class Elements(UserDict[str, T])
  ...
class Images(Elements[DataArray | DataTree])
class Labels(Elements[DataArray | DataTree])
class Tables(Elements[AnnData])
class Shapes(Elements[GeoDataFrame])
class Points(Elements[DaskDataFrame])
```

## Images / Labels (`DataArray | DataTree`)

It is probably reasonably fair to assume that - at least in the immediate term - the priority for these raster elements is that they will primarily be used for visualisation. For viewing images in viv/MDV, it is already possible just by passing the correct path to `viv`. More work will be required in order to be able to correctly use transformations, with multiple layers etc... but that doesn't necessarily entail the need in the immediate term to have any very particularly special method for loading these parts of the stores in `@spatialdata/core`.

It may be that we are likely to use [loaders.gl](https://loaders.gl/) for integration into other parts of the ecosystem - perhaps contributing where relevant if there exist gaps.

It would be nice to have well-formed and typed ergonomic definitions for this - we may use the [OME-NGFF schema](https://github.com/ome/ngff) with `zod` to validate and provide de-facto accurate types for this data.

We should at least have simple canonical ways of querying various aspects of the metadata, shape etc sooner rather than later, along with working examples of using this to view images.

## Tables (`AnnData`)

We have added [AnnData.js](https://github.com/ilan-gold/anndata.js) for this purpose. Some parts of it don't feel entirely ergonomic - but we can always make suggestions/contributions if appropriate (and that feeling may be at least partly of my not having done enough to familiarise myself with it).

The Vitessce `SpatialDataTableSource` is also relevant to look at particularly given that it is the parent for their implementations of Shapes and Points are based on it.

> because when a table annotates points and shapes, it can be helpful to have all of the required functionality to load the table data and the parquet data.


## Shapes (`GeoDataFrame`)

This is an instance where it probably makes most sense to use a similar implementation to Vitessce's [`SpatialDataShapesSource`](https://github.com/vitessce/vitessce/blob/main/packages/file-types/spatial-zarr/src/SpatialDataShapesSource.js), with Arrow tables.

If we do that - that means that the code we need to borrow/port from vitessce leaks significantly. As of this writing, I'm in the process of copying `SpatialDataShapesSource` from there, and following through the imports to port whatever else is necessary... for now, I'm naming files with a `V` at the start, like `VShapesSource` corresponds to `SpatialDataShapesSource` - the `SpatialData` part seems redundant here.

It is likely that we may end up with something similar to essentially having a version of their `file-types/(spatial-)zarr` package(s).

If we do continue to make use of this code, we should also make sure that equivalent tests are also ported etc.

## Points (`DaskDataFrame`)

There is some discussion about potential different ways in which point transcript data may be represented - we think that we may want to propose new evolutions of the spec in order to facilitate the kind of interactive web-based visualisation we do in Vitessce/MDV.

In terms of a direct JS-analog to `Dask` in Python - this is something we need to think about more. Again, the reference-point for initial implementation is Vitessce's [`SpatialDataPointsSource`](https://github.com/vitessce/vitessce/blob/main/packages/file-types/spatial-zarr/src/SpatialDataPointsSource.js)