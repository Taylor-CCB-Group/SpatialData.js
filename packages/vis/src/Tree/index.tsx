import { useSpatialData } from '@spatialdata/react';
import JsonView from '@uiw/react-json-view';
// todo theme should adapt automatically - default light theme was illegible in dark site
import { darkTheme } from '@uiw/react-json-view/dark';

export default function SpatialDataTree() {
  const { spatialData, loading, error } = useSpatialData();
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!spatialData) return <div>No spatial data</div>;
  // Resolve the value to display before rendering: JSX is lazy, so wrapping the
  // returned <JsonView/> in try/catch would not catch a throw from toJSON().
  let value: object = spatialData;
  try {
    const json = spatialData.toJSON();
    if (json) {
      value = json;
    }
  } catch {
    value = spatialData;
  }
  return <JsonView value={value} style={darkTheme} collapsed={true} />;
}
