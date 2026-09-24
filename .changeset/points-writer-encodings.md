---
'@spatialdata/core': patch
---

Choose parquet column encodings per column in the Python points writer

No runtime change in this package; it changes the artifacts `spatialdata-js-util`
produces, which the tiled reader consumes. pyarrow's dictionary-by-default left `x`, `y`,
`z` and `morton_code_2d` larger compressed than raw; choosing per column from the data
takes a 200k-row Xenium-shaped frame from 8.54 MB and 22 ms to **4.98 MB and 12 ms**.
