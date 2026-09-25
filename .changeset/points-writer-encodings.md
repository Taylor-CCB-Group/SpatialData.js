---
'@spatialdata/core': patch
---

Choose parquet column encodings per column in the Python points writer

No runtime change in this package; it changes the artifacts `spatialdata-js-util`
produces, which the tiled reader consumes. Choosing encodings from the data instead of
pyarrow's dictionary-by-default takes a 200k-row Xenium-shaped frame from 8.54 MB and
22 ms to **4.98 MB and 12 ms**.
