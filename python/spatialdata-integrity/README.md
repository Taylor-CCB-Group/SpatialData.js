# spatialdata-integrity

Utilities for checking the integrity of SpatialData Zarr stores, detecting corrupt chunks, and validating data completeness.

This is - as of now - a somewhat throwaway AI generated and untested set of scripts that might be useful later. I'm not sure if they should live here, but I wanted something I could potentially get back to later, and possibly publish to pypi if it's turned into anything more substantial.

During development and testing of various permutations of SpatialData object and library versions, at some point I had an error saving an object which at first I wrongly attributed to a `spatialdata` bug - but appears to have been because I had some partial copy of the object I was working on.


## Features

- **Zarr Array Integrity Checking**: Verify that all chunks in zarr arrays can be decompressed and read
- **Blosc Decompression Validation**: Detect corrupt blosc-compressed chunks
- **SpatialData Object Validation**: Check all elements (images, labels, points, shapes, tables) in a SpatialData object
- **Progress Reporting**: Detailed reporting of which elements/chunks are problematic
- **CLI Tool**: Easy-to-use command-line interface

## Installation

The package can be installed in development mode for use in both SpatialData.js and MDV projects:

```bash
# Using uv (recommended)
cd python/spatialdata-integrity
uv pip install -e .

# Or using pip
cd python/spatialdata-integrity
pip install -e .
```

For use in a specific project's environment (e.g., SpatialData.ts v0.6.1):

```bash
# Install in SpatialData.ts v0.6.1 environment
cd python/v0.6.1
uv pip install -e ../spatialdata-integrity

# Or in MDV
cd python
pip install -e ../SpatialData.ts/python/spatialdata-integrity
```

## Usage

### CLI

```bash
# Check a SpatialData zarr store
check-spatialdata /path/to/spatialdata.zarr

# Verbose output
check-spatialdata /path/to/spatialdata.zarr --verbose

# Check only specific element types
check-spatialdata /path/to/spatialdata.zarr --elements images labels

# Output results to JSON
check-spatialdata /path/to/spatialdata.zarr --output results.json
```

### Python API

```python
from spatialdata_integrity import check_spatialdata, check_zarr_array
import spatialdata as sd

# Check a full SpatialData object
sdata = sd.read_zarr("path/to/spatialdata.zarr")
results = check_spatialdata(sdata)
if results.is_valid:
    print("All checks passed!")
else:
    print(f"Found {len(results.errors)} errors")
    for error in results.errors:
        print(f"  - {error}")

# Check a specific zarr array
import zarr
arr = zarr.open("path/to/array.zarr")
results = check_zarr_array(arr)
```

## Example Output

```
Checking SpatialData object: /path/to/spatialdata.zarr
✓ Images: 'image1' (3 chunks checked)
✓ Labels: 'labels1' (12 chunks checked)
✗ Images: 'image2' - Blosc decompression error at chunk (0, 0, 0)
✓ Points: 'points1' (1 chunk checked)
✓ Tables: 'table1' (validated)

Summary: 1 error found in 1 element
```

