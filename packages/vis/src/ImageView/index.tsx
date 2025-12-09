import { useSpatialData } from '@spatialdata/react';
import { useEffect, useMemo, useState, useId, type CSSProperties, useCallback } from 'react';
import { useMeasure } from '@uidotdev/usehooks';
import {
  createVivStores,
  useChannelsStore,
  useLoader,
  useViewerStore,
  useViewerStoreApi,
  VivProvider,
  useChannelsStoreApi,
  DEFAULT_CHANNEL_STATE,
} from './avivatorish/state';
import { DetailView, VivViewer, getDefaultInitialViewState } from '@vivjs-experimental/viv';
import { useImage } from './avivatorish/hooks';

/**
 * when trying to getDefaultInitialViewState, it'll do something a bit like this internally...
 * the conditions under which this function returns false are conditions where internally it would have pixelWidth undefined, etc.
 */
function _isValidImage(image: ReturnType<typeof useLoader>) {
  if (!image) return false;
  const source = Array.isArray(image) ? image[0] : image;
  return source.shape.length > 0;
}

function VivImage({ url, width, height }: { url?: string | URL; width: number; height: number }) {
  const loader = useLoader(); //could do with typing this...
  const channels = useChannelsStore(({ colors, contrastLimits, channelsVisible, selections }) => ({
    colors,
    contrastLimits,
    channelsVisible,
    selections,
  }));
  const layerConfig = useMemo(() => ({ loader, ...channels }), [loader, channels]);
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
    });
  }, [detailId, width, height]);
  const deckProps = useMemo(
    () => ({
      style: {
        position: 'relative',
      },
    }),
    []
  );
  const viewerStore = useViewerStoreApi();
  const channelsStore = useChannelsStoreApi();

  const resetViewState = useCallback(() => {
    if (!_isValidImage(loader) || width === 0 || height === 0) return;
    const zoomBackOff = 0.2;
    const newViewState = getDefaultInitialViewState(loader, { width, height }, zoomBackOff);
    viewerStore.setState({ viewState: newViewState });
  }, [loader, width, height, viewerStore]);

  useEffect(() => {
    if (!url) return;
    const source = { urlOrFile: url.toString(), description: 'image' };
    viewerStore.setState({ source, viewState: null });
    channelsStore.setState({ loader: DEFAULT_CHANNEL_STATE.loader });
  }, [url, viewerStore, channelsStore]);

  useEffect(() => {
    if (viewState === null && _isValidImage(loader)) {
      resetViewState();
    }
  }, [viewState, resetViewState, loader]);

  // useEffect(() => {
  // 	const listener = (e: KeyboardEvent) => {
  // 		if (e.key === ".") {
  // 			resetViewState();
  // 		}
  // 	};
  // 	window.addEventListener("keydown", listener);
  // 	return () => window.removeEventListener("keydown", listener);
  // }, [resetViewState]);

  const source = useViewerStore((state) => state.source);
  useImage(source);
  if (isViewerLoading || !viewState) return <div>Loading...</div>;
  return (
    <VivViewer
      deckProps={deckProps}
      layerProps={[layerConfig]}
      views={[detailView]}
      viewStates={[{ ...viewState, id: detailId }]}
      onViewStateChange={({ viewState: newViewState }) => {
        viewerStore.setState({ viewState: newViewState });
      }}
    />
  );
}

// todo better styling to customise, easily fit into application layout etc.
const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  height: '40vh',
  border: '1px solid gray',
  borderRadius: 10,
  padding: 10,
};

/**
 * This component can be used within a `SpatialDataContext` and provides a UI for selecting
 * images from the loaded object to be viewed with Viv.
 *
 * It internally manages 'Avivator-ish' zustand state, with a React context that is independent
 * of any other instances (which also entails not being able to share image data between components).
 *
 * As of writing, it doesn't expose any public API for interacting with these stores, customisation etc.
 * That should be changed - but the API will probably not be stable, particularly initially.
 */
export default function ImageView() {
  // todo decide what public API should like etc
  // - particularly with more complex spatial layers arrangement
  // enough tools to do useful things
  const { spatialData } = useSpatialData();
  const [selectedImage, setSelectedImage] = useState<string>('');
  const [ref, { width, height }] = useMeasure();

  useEffect(() => {
    if (!spatialData?.images) return;
    if (selectedImage === '' || !spatialData.images[selectedImage]) {
      setSelectedImage(Object.keys(spatialData.images)[0]);
    }
  }, [spatialData?.images, selectedImage]);

  const vivStores = useMemo(() => {
    return createVivStores();
  }, []);
  const image = useMemo(() => {
    return spatialData?.images?.[selectedImage];
  }, [selectedImage, spatialData?.images]);
  const [imageUrl, setImageUrl] = useState<string | URL>();
  useEffect(() => {
    if (image) {
      setImageUrl(image.url);
    } else {
      setImageUrl('');
    }
  }, [image]);
  return (
    <div ref={ref} style={containerStyle}>
      {spatialData?.images && (
        <select value={selectedImage || ''} onChange={(e) => setSelectedImage(e.target.value)}>
          {Object.keys(spatialData.images).map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      )}
      <VivProvider vivStores={vivStores}>
        <VivImage url={imageUrl} width={width || 0} height={height || 0} />
      </VivProvider>
    </div>
  );
}
