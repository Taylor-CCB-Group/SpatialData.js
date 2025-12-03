# Transformations, `attrs`, metadata versions, testing oh my!

## Should consolidated metadata be considered the source of truth?

Short answer to the above question is probably "no" in the long term, and "I don't see why not, as long as we're clear that we expect stores to be treated as immutable for now". I'd welcome any feedback on my stance there.

In the meanwhile, some thoughts on breaking out of my current procrastination loop.

{/* truncate */}

Development has felt somewhat stalled as I've been in a protracted procrastination loop about how to process and represent metadata, which is something of a pre-requisite to parsing transformations, which in turn is a pretty essential aspect of getting the library to actually be capable of doing anything useful or interesting.

Perfectionism and other distractions with MDV demos etc have somewhat disrupted my focus on this. At the same time, I've been doing a bit more work on `avivatorish` state in the demo `ImageView` component and I'm not really convinced that the way I'm modelling state there is right - and also haven't thought very much about how this'll be exposed as a public API. That's not what I want to address here, but I suppose it has been another detriment to focus.

I wasn't quite sure why `zarrita` had chosen to make the raw consolidated metadata so private... I've been allowing this to block me more than I should. Somehow, despite me having made a stated decision weeks ago to separately parse `zmetadata` and get on with life, it still hasn't quite been sitting right that it wasn't exposed so I [raised an issue](https://github.com/manzt/zarrita.js/issues/322). I think my brain has been somewhat more focused on the question of "we need a coherent representation of the hierarchy and associated metadata" than "can we display an image with cell segmentation shapes overlaid, even if it does involve a few more `decode(await store.get(...))` than I'd like". I am very wary of releasing a version of this library that bakes in technical debt in the form of unergomic patterns for users.

My default stance is that I still have a relatively limited understanding of `zarr` and that others like Trevor Manz probably know better. There clearly is a rationale for the design of `zarrita`, and hopefully it will evolve to more comprehensively and ergonomically expose relevant things. That said, I find myself wanting to expand some of the things in `zarrUtils.ts` into a more generally re-usable `"zarrextra"` package built on top of it.

It should be stated that as of this writing, none of the data I have been using has been generated with the latest version of `spatialdata` (0.6.x) and corresponding `zarr v3` (with the associated changes to consolidated metadata, which in `v3` are still not entirely stable as far as I understand). So the requirements of supporting each of those has been somewhat on my mind, and hopefully will not be too difficult, but for the sake of breaking procrastination cycles it should be clearly stated that the initial implementation will work against the older specification. On the MDV side, this difference first came to my attention when a collaborator tried to use the `mdvtools.spatial.conversion` script with outputs from 0.6.0, and they failed to open with 0.5.0 that is currently used there.

We should aim to support both versions soon, and related to that, establish a set of test fixtures associated with them. The `defaultUrl = 'https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr'` used by the demo app is actually not able to be opened with the version of `spatialdata` we have in the MDV environment currently.

```
>>> import spatialdata as sd
>>> sdata = sd.read_zarr('https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr')
...
pyarrow.lib.ArrowInvalid: Unrecognized filesystem type in URI: https:/storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr/shapes/Visium_HD_Mouse_Small_Intestine_square_002um/shapes.parquet
```

Given that this is my go-to default datasource when working on this, that's not really a very reassuring thing to have lingering in the back of my mind.

Also as of this writing, there is no testing in place here to speak of, and limited coverage in MDV. While I don't necessarily want to go full TDD, the intention is definitely to have good coverage - and for that to stand as a useful reference as to the implementation status and use of various features. We might use Python in the `spatialdata.js` repo for the purposes of using `spatialdata` mock-data features for generating test fixtures. Given the known vagueries of output from different versions, there may even be a case to be made for swallowing the added test-environment-complexity of having tests based around different versions.

I do intend to update the version used in MDV at some point soon - particularly as this will clear up some issues we currently have with older python dependencies being brought in from there. It will make sense from my point of view to align `spatialdata.js` with `MDV` - and this is quite likely to mean that an initial `0.0.1` release of this will still be tied to older outputs, followed shortly after by an update aimed at supporting both. Alternatively, it may be that we prioritise support for the newer version to allow us to update the MDV dependency sooner rather than later.

## Immediate plans

Wrap up how we parse consolidated metadata in `zarrUtils.ts` and try to follow Mark's recommendations:

> Mark Keller: We should be able to use https://github.com/hms-dbmi/zod-ome-ngff, either directly, or by exporting sub-schemas that can be reused via composition of zod schemas https://github.com/hms-dbmi/zod-ome-ngff/issues/23
> Mark Keller: I recently updated the schemas there to support OME-NGFF v0.5
> Mark Keller: A long time ago I started to implement typescript types for the transforms [here](https://github.com/vitessce/vitessce/blob/a1e4ffddb5b75fb44d5402cf7d27374c127f6f28/packages/types/src/ngff-types.ts#L35). They are probably out of date now that the transformations proposals have evolved but maybe worth using as a starting point.

I had a few sketchy things in my working copy that are probably mostly redundant WRT that but may be worth stashing somewhere... the `zod-ome-ngff` should be a good approach on the face of it.


## Further future considerations for mutable stores.

The initial version of this library and its use in MDV will be explicitly limited to stores that are considered effectively immutable - but this is actually not something that is likely to align with our goals for MDV in the mid-term. From my current understanding, consolidated metadata should support this use-case well.

Mutable stores of course open a whole new set of rabbit-holes... on the face of it, I think we'll need to seriously investigate [icechunk](https://icechunk.io/) if and when the time comes for this. Ideally, we'd be able to support workflows where a user makes a new project (with an associated empty `spatialdata` store), adds some image data, invokes a cell-segmentation job which after some time leads to more elements in that coordinate-system, annotates some of the data thus produced, etc etc. This is of course not to be taken at all lightly when it may involve multiple simultaneous users working with the same underlying store.