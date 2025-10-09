# Initial Design Notes

This project is a TypeScript implementation of the [SpatialData](https://spatialdata.scverse.org/en/stable/) library.

It is a collaborative effort by the [Taylor CCB Group](https://github.com/Taylor-CCB-Group) at the Center for Human Genetics, Oxford University and the Gihlenborg Group at the Harvard Medical School - Department of Biomedical Informatics.

The approach taken to the design is to follow the structure of the original Python library, adapting it to TypeScript with the intention that it should be familiar to users of the original library and aligned with best practices in frontend development. It should be usable in a server-side environment as well, and some consideration will be given to this, but it is not the primary focus of the project and at this stage isn't something that is anticipated to be a priority.

Once it has reached a state in which a useful subset of the functionality has been implemented, it will be released in an 'alpha' state as a package on npm.

The aim is to do this soon, such that [MDV](https://mdv.ndm.ox.ac.uk/) can have a new type of `DataLoader` based on this. Actually, without getting too derailed into MDV-specifics, it may be that the first use of the library will be for accessing and rendering things like `Points` transcripts, in a way that sits-beside the main data at least for the time-being.

There is a lot of overlap between MDV and [vitessce](https://vitessce.io/). It is anticipated that substantial portions of this codebase will be based on existing implementations in vitessce. We had discussed approaches to refactoring their code such that the data-loading functionality could be exposed as something to be exposed as a separate package - I wasn't quite clear how we'd adapt each-others idioms about what kind of common interface we'd use that would allow our MDV idioms to map to theirs.

The intention is that as this becomes mature, both projects will make use of it, and it will be a useful part of the ecosystem more generally.

## How complete should it aim to be?

Hopefully, it will not require a huge amount of effort to be able to get at least a useful subset of the core data-loading functionality working well.

Some functionality that will be a lower priority are things like utilities for converting between raster `labels` and vector `shapes`. As of this writing, I don't have comprehensive knowledge of the original spec; writing this is a helpful exercise in better understanding it, but it could be that there are aspects of it I haven't

The very first version will likely not include any methods for altering the data - and it may require some careful consideration of how persistence should end up working, particularly from a frontend perspective. This is a somewhat high priority: from an MDV perspective, we likely want to use zarr stores rather than HDF5 for project data in the near future.

## What should the API look like?

The guiding principle is to make it such that Python code would translate in a direct way to JS/TS - so where in Python you have something like this:

```python
import spatialdata as sd

sdata = sd.read_zarr("path/to/zarr")
```

You would write something like this:

```ts
import * as sd from 'spatialdata';

const sdata = await sd.readZarr("path/to/zarr");
```

`sdata` should be an object with a similar interface to the Python version (i.e. `class SpatialData` in both cases).

In the context of JS accessing remote data, this inevitably means a lot of `async` operations, and potentially complex data structures, that should use JavaScript equivalents of the packages used by `spatialdata` in Python.

I'm not so sure whether we want to mirror the ability to do things like

```python
sdata["some_arbitrary_name"] = sdata["table"]
```

I suppose it would be possible to use a `Proxy` for this, and it may not be a terrible idea... but at least in a first-pass, the data will be read-only, and access will likely be via somewhat more explicit/verbose interfaces. Certainly it would be a mistake to try to introduce too much clever meta-programming before at least having a working MVP.


Looking at the Python `repr` returned by a `SpatialData` object (names changed to protect the innocent):

```
SpatialData object, with associated Zarr store: /path/to/spatialdata.zarr
├── Images
│     └── 'Run3-14-7-23_Output_region_1_z3': DataTree[cyx] (5, 53066, 55984), (5, 26533, 27992), (5, 13266, 13996), (5, 6633, 6998), (5, 3316, 3499)
├── Points
│     └── 'Run3-14-7-23_Output_region_1_transcripts': DataFrame with shape: (<Delayed>, 9) (2D points)
├── Shapes
│     └── 'Run3-14-7-23_Output_region_1_polygons': GeoDataFrame shape: (23961, 9) (2D shapes)
└── Tables
      └── 'table': AnnData (23961, 466)
with coordinate systems:
    ▸ 'global', with elements:
        Run3-14-7-23_Output_region_1_z3 (Images), Run3-14-7-23_Output_region_1_transcripts (Points), Run3-14-7-23_Output_region_1_polygons (Shapes)
```

There are elements represented by `DataTree`, `dask.DataFrame`, `GeoDataFrame`, and `AnnData`... this is not an exhaustive list.

In most cases, a combination of `zarrita`, `AnnData.js`, and some of the methods implemented in `vitessce` should be able to represent these various models.


## Validation and exception handling

### Images and Labels - OME-NGFF Schema

The [OME-NGFF specification](https://github.com/ome/ngff) should be able to drive validation of these, perhaps via something like [`zod-from-json-schema`](https://www.npmjs.com/package/zod-from-json-schema).

## Visualization and experimental features

The core module should avoid any dependencies on the `vis.gl` ecosystem that both MDV and vitessce/viv use.

Re-usable visual elements are out of the scope of what we've discussed for immediate plans. It may make sense to have some `@deck.gl/community-layers` type package that could have some common utilities for rendering, annotating etc...

I believe it will be particularly useful to have at least some sample visualizations that can be used for testing and demonstration purposes within this documentation. That means that while we are editing the code, we can have interactively updated feedback on the work as it progresses.

Perhaps rather than letting the `/docs` package in the monorepo get bloated, it'd be worth having some `packages/layers`, `packages/hooks` sooner rather than later...

Part of the shared interests we have as collaborators are around potential different ways of representing points in the SpatialData spec itself, and it may be that we have a package relating to experimental prototypes around such features.
