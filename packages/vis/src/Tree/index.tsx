import JsonView from '@uiw/react-json-view';
import { useSpatialData } from '@spatialdata/react';
// todo theme should adapt automatically - default light theme was illegible in dark site
import { darkTheme } from '@uiw/react-json-view/dark';


export default function SpatialDataTree() {
  const { spatialData, loading, error } = useSpatialData();
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!spatialData) return <div>No spatial data</div>;
  return (
    <JsonView value={spatialData} style={darkTheme} collapsed={true} />
  )
}
