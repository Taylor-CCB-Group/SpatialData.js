---
'@spatialdata/core': patch
---

No runtime change. Recorded here because it changes the artifacts the Python writer
(`spatialdata-js-util`) produces, which the tiled reader consumes.

pyarrow dictionary-encodes every column by default, which is wrong for transcript
coordinates: on the 12.17M-point Xenium permutations store `x`, `y`, `z` and
`morton_code_2d` were all **larger compressed than raw** (`x`: 5.40 B/value against a
4 B float). The writer now chooses per column from the data — `BYTE_STREAM_SPLIT` for
floats, `DELTA_BINARY_PACKED` for high-cardinality ascending integers, `PLAIN` for
unordered identifiers, dictionary kept only where cardinality earns it.

Measured on a 200k-row Xenium-shaped frame, decoded through the vendored parquet-wasm:

| | file | decode |
| --- | --- | --- |
| pyarrow defaults | 8.54 MB | 22 ms |
| chosen per column | **4.98 MB** | **12 ms** |

Smaller *and* faster to decode, and it compounds on the tiled path, which fetches
whole row groups.
