import { useSpatialData } from "@spatialdata/react";
import { useEffect, useMemo, useState, useId, useRef } from "react";
import { createVivStores, useChannelsStore, useLoader, useViewerStore, useViewerStoreApi, VivProvider } from "./avivatorish/state";
import { DetailView, VivViewer } from "@vivjs-experimental/viv";
import { useImage } from "./avivatorish/hooks";

function VivImage({url}: {url?: string | URL}) {
  //TODO: fix sizing... seems like this should be simpler than it is.
  const width = 200;
  const height = 200;
  const loader = useLoader();
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
  }, [detailId]);
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
  const source = useViewerStore((state) => state.source);
  useImage(source);
  if (isViewerLoading) return <div>Loading...</div>;
  return (<VivViewer 
    deckProps={deckProps}
    layerProps={[layerConfig]} 
    views={[detailView]} 
    viewStates={[{ ...viewState, id: detailId }]} 
  />);
}


export default function ImageView() {
  const { spatialData } = useSpatialData();
  const [selectedImage, setSelectedImage] = useState<string>('');
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '40vh' }}>
      {spatialData?.images && 
        <select value={selectedImage || ''} onChange={(e) => setSelectedImage(e.target.value)}>
          {Object.keys(spatialData.images).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      }
      <VivProvider vivStores={vivStores}>
        <VivImage url={imageUrl} />
      </VivProvider>
      
    </div>
  )
}