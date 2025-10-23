import { useState, useEffect } from 'react';
import { readZarr, SpatialData, type Table } from '@spatialdata/core';
import type { Shapes } from '@spatialdata/core/store';

const useSpatialData = (url: string) => {
  const [data, setData] = useState<SpatialData | Error>();

  useEffect(() => {
    readZarr(url).then(setData).catch((error) => {
      console.error('Error loading spatial data:', error);
      setData(error);
    });
  }, [url]);

  return data;
};
const defaultUrl = 'https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr';

const useFirstAvailableTable = (data: SpatialData | Error | undefined) => {
  const [table, setTable] = useState<Table>();
  useEffect(() => {
    if (data instanceof SpatialData && data.tables) {
      Object.entries(data.tables)[0][1]().then(setTable).catch((error) => {
        console.error('Error loading table:', error);
        // setTable(error);
      });
    }
  }, [data]);
  console.log('table', table);
  return table;
}

const useFirstAvailableShape = (data: SpatialData | Error | undefined) => {
  const [shape, setShape] = useState<Shapes>();
  useEffect(() => {
    if (data instanceof SpatialData && data.shapes) {
      Object.entries(data.shapes)[0][1]().then(setShape).catch((error) => {
        console.error('Error loading shape:', error);
      });
    }
  }, [data]);
  console.log('shape', shape);
  return shape;
}

function TableViewer({ table }: { table: Table }) {
  const [repr, setRepr] = useState('Loading...');
  useEffect(() => {
    // if (!table.X) return;
    // get(table.X, [zarr.slice(0, 10), zarr.slice(0, 10)]).then((val) => {
    //   console.log('val', val);
    //   setRepr(JSON.stringify(val));
    // }).catch((error) => {
    //   console.error('Error getting spatial:', error);
    //   setRepr('Error getting spatial');
    // });

    table.var.has('feature_types').then(async hasFeatureTypes => {
      if (hasFeatureTypes) {
        //type BackedArray<S extends Readable> = zarr.Array<zarr.DataType, S> | SparseArray<zarr.NumberDataType, IndexType, S> | LazyCategoricalArray<UIntType, zarr.DataType, S> | AxisArrays<Readable>;
        const featureTypes = await table.var.get('feature_types');
        try {
          //@ts-expect-error - how should we check type here?
          const vals = await featureTypes.getChunk([0]);
          // > zarrita introduces the zarr.Array.is type guard to achieve just that:
          // if (featureTypes.is("v2:object"))
          // but apparently the type we have here is not one that is known to have `is`

          // also, it seems to return a string[], which is well and good and easier a lot of the time...
          // but in MDV we would have a column object with `{ data: Uint8Array, values: string[] }` - to reconstruct
          // that from the string[] would be expensive and probably redundant (the string[] here probably came from an approximately inverse operation)
          // this comes from zarrita
          // `get_ctr` if (data_type === "v2:object") return globalThis.Array as unknown as TypedArrayConstructor<D>;
          // https://github.com/pydata/xarray/issues/8463 ilan-gold comments on similar issue
          // https://github.com/pydata/xarray/pull/8723 implementation in xarray
          // https://docs.xarray.dev/en/latest/internals/zarr-encoding-spec.html docs on xarray storage in zarr
          // setRepr(JSON.stringify(vals));
        } catch (error) {
          setRepr(`Error getting feature_types: ${error}`);
        }
      } else {
        setRepr('No feature_types');
      }
    });
    
    // table.varNames().then(async (val) => {
    //   //type DataType = NumberDataType | BigintDataType | StringDataType | ObjectType | Bool;
    //   //varNames.dtype is `type ObjectType: 'v2:object'`
    //   console.log('varNames shape:', val.shape, val.dtype);
    //   if (val.dtype !== 'v2:object') {
    //     console.log('varNames dtype is not v2:object as expected');
    //     setRepr(JSON.stringify({shape: val.shape, dataType: val.dtype}));
    //     return;
    //   }
    //   val.getChunk([0, 0]).then((v) => {
    //     const {data, ...rest} = v;
    //     const valSet = new Set(data); // why is this empty? expecting {0} (or something more interesting).
    //     setRepr(JSON.stringify({valSet, dataType: data.constructor.name, ...rest}));
    //   }).catch((error) => {
    //     console.error('Error getting varNames:', error);
    //     setRepr('Error getting varNames');
    //   });

    //   /// error here: Cannot read properties of undefined (reading 'TypedArray')
    //   // get(val, [10]).then((val) => {
    //   //   console.log('val', val);
    //   //   setRepr(JSON.stringify(val));
    //   // }).catch((error) => {
    //   //   console.error('Error getting varNames:', error);
    //   //   setRepr('Error getting varNames');
    //   // });
      
    //   // setRepr(JSON.stringify(val.shape));
    // }).catch((error) => {
    //   console.error('Error getting varNames:', error);
    //   setRepr('Error getting varNames');
    // });

    // table.obsm.get('spatial').then(async (val) => {
    //   const v = await get(val, null);
    //   setRepr(JSON.stringify(val));
    // }).catch((error) => {
    //   console.error('Error getting spatial:', error);
    //   setRepr('Error getting spatial');
    // });
  }, [table]);
  return <div>{repr}</div>;
}

function ShapeViewer({ shape }: { shape: Shapes }) {
  const len = shape.data.length;
  const [repr, setRepr] = useState(shape ? `${len} polygons` : 'Loading...');
  return <div>{repr}</div>;
}

const TestParsed = ({ data }: { data: SpatialData | Error }) => {
  if (data instanceof Error) {
    return <div>Error: {data.message}</div>;
  }
  const tableNames = Object.keys(data.parsed?.tables ?? {});
  if (data.parsed?.tables) {
    const tables = data.parsed.tables;
    // we should have a util type-guard for this
    if (tables instanceof Function) {
      return <div>Error: tables is a function, not expected</div>;
    }
    const adata = tables[tableNames[0]];
    if (adata instanceof Function || !adata) {
      return <div>Error: not expected table type</div>;
    }
    const vars = adata.var;
    if (vars instanceof Function || !vars) {
      return <div>Error: not expected missing var</div>;
    }
    const featureTypes = vars.feature_types;// as LazyZarrArray<zarr.StringDataType>;
    if (!(featureTypes instanceof Function) || !featureTypes) {
      console.error('featureTypes', featureTypes);
      return <div>Error: not expected missing featureTypes</div>;
    }
    featureTypes().then?.(async featureTypes => {
      console.log('featureTypes', featureTypes);
      const vals = await featureTypes.getChunk([0, 10]);
      // const vals = await get(featureTypes, zarr.slice(10));
      console.log('feature_types vals', vals);
    });
  }
  if (data.parsed?.images) {
    const images = data.parsed.images;
    if (images instanceof Function) {
      return <div>Error: images is a function, not expected</div>;
    }
    const image = images[Object.keys(images)[0]];
  }
  return <div>{tableNames.map(name => <div key={name}>{name}</div>)}</div>;
}

export default function Sketch() {
  const [url, setUrl] = useState(defaultUrl);
  const data = useSpatialData(url);
  const table = useFirstAvailableTable(data);
  // as of writing - this will load all of the shapes into memory, and probably crash if it's large (as per default demo data)
  // const shape = useFirstAvailableShape(data);
  const [repr, setRepr] = useState('Loading...');
  useEffect(() => {
    if (data && !(data instanceof Error)) {
      data.representation().then(setRepr).catch((error) => {
        console.error('Error getting representation:', error);
        setRepr('Error getting representation');
      });
    } else if (data instanceof Error) {
      setRepr(`Error loading data: ${data.message}`);
    } else {
      setRepr('Loading...');
    }
  }, [data]);

  return (
    <div>
      <h2>Sketching out some functionality</h2>
      
      <h3>SpatialData URL:</h3>
      <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
      {data && <TestParsed data={data} />}
      <h3>String representation:</h3>
      <pre>
        {repr}
      </pre>
      <h3>Full data object:</h3>
      <pre>{JSON.stringify(data, null, 2)}</pre>
      {table && <TableViewer table={table} />}
      {/* {shape && <ShapeViewer shape={shape} />} */}
    </div>
  );
}
