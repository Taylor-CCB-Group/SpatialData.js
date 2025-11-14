import { useSpatialData } from "@spatialdata/react";
import { useEffect, useMemo, useState, useId, type CSSProperties } from "react";
import { useMeasure } from "@uidotdev/usehooks";
import { createVivStores, useChannelsStore, useLoader, useViewerStore, useViewerStoreApi, VivProvider } from "./avivatorish/state";
import { DetailView, VivViewer, getDefaultInitialViewState } from "@vivjs-experimental/viv";
import { useImage } from "./avivatorish/hooks";

function _isValidImage(image: ReturnType<typeof useLoader>) {
  if (!image) return false;
  // when trying to getDefaultInitialViewState, it'll do something a bit like this internally...
  // the conditions under which this function returns false are conditions where internally it would have pixelWidth undefined, etc.
  const source = Array.isArray(image) ? image[0] : image;
  return source.shape.length > 0;
}

function VivImage({url, width, height}: {url?: string | URL, width: number, height: number}) {
  //TODO: fix viewState... seems like this should be simpler than it is.

  const loader = useLoader(); //could do with typing this...
  const channels = useChannelsStore(({colors, contrastLimits, channelsVisible, selections}) => ({colors, contrastLimits, channelsVisible, selections}));
  const layerConfig = useMemo(() => ({loader, ...channels}), [loader, channels]);
  const id = useId();
  const detailId = `${id}detail-react`;
  const viewState = useViewerStore((state) => state.viewState);
  const isViewerLoading = useViewerStore((store) => store.isViewerLoading);
  const detailView = useMemo(() => {
    return new DetailView({
      id: detailId,
      snapScaleBar: true,
      width,
      height,
    })
  }, [detailId, width, height]);
  const deckProps = useMemo(() => ({
    style: {
      position: 'relative',
    }
  }), []);
  const viewerStore = useViewerStoreApi();
  useEffect(() => {
    if (!url) return;
    const source = { urlOrFile: url.toString(), description: 'image' };
    console.log('setting source', source);
    viewerStore.setState({ source });
  }, [url, viewerStore]);
  useEffect(() => {
    if (!_isValidImage(loader)) return;
    if (width === 0 || height === 0) return;
    if (!viewState) {
      const zoomBackOff = 0.2;
      const viewState = getDefaultInitialViewState(loader, {width, height}, zoomBackOff);
      console.log('setting viewState', viewState);
      viewerStore.setState({ viewState });
    }
  }, [loader, viewState, viewerStore, viewerStore.setState, width, height]);
  const source = useViewerStore((state) => state.source);
  useImage(source);
  if (isViewerLoading) return <div>Loading...</div>;
  return (
  <VivViewer 
    deckProps={deckProps}
    layerProps={[layerConfig]} 
    views={[detailView]} 
    viewStates={[{ ...viewState, id: detailId }]} 
  />);
}

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  height: '40vh',
  border: '1px solid gray',
  borderRadius: 10,
  padding: 10,
};

export default function ImageView() {
  const { spatialData } = useSpatialData();
  const [selectedImage, setSelectedImage] = useState<string>('');
  const [ref, { width, height }] = useMeasure();

  const vivStores = useMemo(() => {
    return createVivStores();
  }, []);
  const image = useMemo(() => {
    return spatialData?.images?.[selectedImage];
  }, [selectedImage, spatialData?.images]);
  const [imageUrl, setImageUrl] = useState<string | URL>();
  useEffect(() => {
    if (image) {
      image().then(i => setImageUrl(i.store.url));
    } else {
      setImageUrl("");
    }
  }, [image]);
  return (
    <div ref={ref} style={containerStyle}>
      {spatialData?.images && (
        <select value={selectedImage || ''} onChange={(e) => setSelectedImage(e.target.value)}>
          {Object.keys(spatialData.images).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      )}
      <VivProvider vivStores={vivStores}>
        <VivImage url={imageUrl} width={width || 0} height={height || 0} />
      </VivProvider>
      
    </div>
  )
}