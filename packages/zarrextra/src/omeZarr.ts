import * as zarr from 'zarrita';
import { getZarrChunk } from './chunkDecode';

export type RasterSelection = Record<string, number> | number[];

export interface VivCompatiblePixelSource {
  labels: string[];
  tileSize: number;
  shape: number[];
  dtype: string;
  meta?: { physicalSizes?: { x?: { size: number; unit: string } } };
  getRaster(props: { selection: RasterSelection; signal?: AbortSignal }): Promise<{
    data: unknown;
    width: number;
    height: number;
  }>;
  getTile(props: {
    x: number;
    y: number;
    selection: RasterSelection;
    signal?: AbortSignal;
  }): Promise<{
    data: unknown;
    width: number;
    height: number;
  }>;
  onTileError(err: Error): void;
}

type OmeAxis = { name: string; type?: string; unit?: string };
type OmeMultiscaleAttrs = {
  datasets?: Array<{ path: string }>;
  axes?: Array<string | OmeAxis>;
};
type OmeRootAttrs = {
  multiscales?: OmeMultiscaleAttrs[];
  omero?: unknown;
  [key: string]: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOmeAxis(value: unknown): value is OmeAxis {
  return isObject(value) && typeof value.name === 'string';
}

function isOmeDataset(value: unknown): value is { path: string } {
  return isObject(value) && typeof value.path === 'string';
}

function isOmeMultiscaleAttrs(value: unknown): value is OmeMultiscaleAttrs {
  if (!isObject(value)) return false;
  const datasets = value.datasets;
  if (datasets !== undefined) {
    if (!Array.isArray(datasets)) return false;
    if (!datasets.every(isOmeDataset)) return false;
  }
  const axes = value.axes;
  if (axes !== undefined) {
    if (!Array.isArray(axes)) return false;
    if (!axes.every((axis) => typeof axis === 'string' || isOmeAxis(axis))) return false;
  }
  return true;
}

function getOmeRootAttrs(attrs: Record<string, unknown>): OmeRootAttrs {
  const candidate = isObject(attrs.ome) ? attrs.ome : attrs;
  if (!('multiscales' in candidate)) {
    return candidate;
  }
  if (!Array.isArray(candidate.multiscales)) {
    throw new Error('OME-Zarr `multiscales` attribute must be an array.');
  }
  if (!candidate.multiscales.every(isOmeMultiscaleAttrs)) {
    throw new Error('OME-Zarr `multiscales` entries must contain valid dataset paths and axes.');
  }
  return candidate;
}

function isInterleaved(shape: number[], labels?: string[]) {
  const lastDimSize = shape[shape.length - 1];
  if (lastDimSize !== 3 && lastDimSize !== 4) {
    return false;
  }
  if (labels?.some((label) => label.toLowerCase() === 'c')) {
    return false;
  }
  return true;
}

function axisIndex(labels: string[], axis: 'x' | 'y'): number {
  const index = labels.findIndex((label) => label.toLowerCase() === axis);
  if (index === -1) {
    throw new Error(`OME-Zarr labels must include '${axis}' axis.`);
  }
  return index;
}

function spatialAxisIndices(shape: number[], labels: string[]): { xIndex: number; yIndex: number } {
  if (isInterleaved(shape, labels)) {
    const len = shape.length;
    return { yIndex: len - 3, xIndex: len - 2 };
  }
  return { yIndex: axisIndex(labels, 'y'), xIndex: axisIndex(labels, 'x') };
}

function spatialDimensions(shape: number[], labels: string[]): [number, number] {
  const { xIndex, yIndex } = spatialAxisIndices(shape, labels);
  return [shape[yIndex] ?? 0, shape[xIndex] ?? 0];
}

function spatialDimensionsFromChunk(
  chunkShape: number[],
  sourceShape: number[],
  labels: string[]
): [number, number] {
  if (isInterleaved(sourceShape, labels)) {
    const [height, width] = chunkShape.slice(-3);
    return [height ?? 0, width ?? 0];
  }
  if (chunkShape.length >= 2) {
    const [height, width] = chunkShape.slice(-2);
    return [height ?? 0, width ?? 0];
  }
  return [chunkShape[0] ?? 0, 0];
}

function getImageSize(source: { shape: number[]; labels: string[] }) {
  const [height, width] = spatialDimensions(source.shape, source.labels);
  return { height, width };
}

function prevPowerOf2(x: number): number {
  return 2 ** Math.floor(Math.log2(x));
}

function guessTileSize(arr: zarr.Array<zarr.DataType>, labels: string[]): number {
  if (isInterleaved(arr.shape, labels)) {
    const [yChunk, xChunk] = arr.chunks.slice(-3);
    return prevPowerOf2(Math.min(yChunk ?? 1, xChunk ?? 1));
  }
  const yChunk = arr.chunks[axisIndex(labels, 'y')];
  const xChunk = arr.chunks[axisIndex(labels, 'x')];
  return prevPowerOf2(Math.min(yChunk ?? 1, xChunk ?? 1));
}

function labelsFromAxes(axes: OmeMultiscaleAttrs['axes'] | undefined): string[] {
  if (!axes) return ['t', 'c', 'z', 'y', 'x'];
  return axes.map((axis) => (typeof axis === 'string' ? axis : axis.name));
}

function normalizeDtype(dtype: string): string {
  const lookup: Record<string, string> = {
    u1: 'Uint8',
    u2: 'Uint16',
    u4: 'Uint32',
    i1: 'Int8',
    i2: 'Int16',
    i4: 'Int32',
    f4: 'Float32',
    f8: 'Float64',
    uint8: 'Uint8',
    uint16: 'Uint16',
    uint32: 'Uint32',
    int8: 'Int8',
    int16: 'Int16',
    int32: 'Int32',
    float32: 'Float32',
    float64: 'Float64',
  };
  return lookup[dtype.toLowerCase()] ?? dtype.charAt(0).toUpperCase() + dtype.slice(1);
}

function getIndexer(labels: string[]) {
  const labelSet = new Set(labels);
  if (labelSet.size !== labels.length) {
    throw new Error('OME-Zarr labels must be unique.');
  }
  return (selection: RasterSelection): Array<number | zarr.Slice | null> => {
    if (Array.isArray(selection)) {
      return [...selection];
    }
    const indexed: Array<number | zarr.Slice | null> = Array(labels.length).fill(0);
    for (const [key, value] of Object.entries(selection)) {
      const index = labels.indexOf(key);
      if (index === -1) {
        throw new Error(`Invalid OME-Zarr selection axis '${key}'.`);
      }
      indexed[index] = value;
    }
    return indexed;
  };
}

class BoundsCheckError extends Error {}

class ZarrPixelSource implements VivCompatiblePixelSource {
  private readonly indexer: ReturnType<typeof getIndexer>;

  constructor(
    private readonly data: zarr.Array<zarr.DataType>,
    public readonly labels: string[],
    public readonly tileSize: number
  ) {
    this.indexer = getIndexer(labels);
  }

  get shape() {
    return this.data.shape;
  }

  get dtype() {
    return normalizeDtype(this.data.dtype);
  }

  private chunkIndex(
    selection: RasterSelection,
    tile: { x: number | zarr.Slice | null; y: number | zarr.Slice | null }
  ) {
    const { xIndex, yIndex } = spatialAxisIndices(this.data.shape, this.labels);
    const sel = this.indexer(selection);
    sel[xIndex] = tile.x;
    sel[yIndex] = tile.y;
    return sel;
  }

  private getSlices(x: number, y: number) {
    const { height, width } = getImageSize(this);
    const xStart = x * this.tileSize;
    const xStop = Math.min((x + 1) * this.tileSize, width);
    const yStart = y * this.tileSize;
    const yStop = Math.min((y + 1) * this.tileSize, height);

    if (xStart >= xStop || yStart >= yStop) {
      throw new BoundsCheckError('Tile slice is zero-sized or inverted.');
    }
    if (xStart < 0 || yStart < 0 || xStop > width || yStop > height) {
      throw new BoundsCheckError('Tile slice is out of bounds.');
    }

    return [zarr.slice(xStart, xStop), zarr.slice(yStart, yStop)];
  }

  private async getRaw(
    selection: Array<number | zarr.Slice | null>,
    signal?: AbortSignal
  ): Promise<zarr.Chunk<zarr.DataType>> {
    return await getZarrChunk(this.data, selection, { signal });
  }

  async getRaster({ selection, signal }: { selection: RasterSelection; signal?: AbortSignal }) {
    const sel = this.chunkIndex(selection, { x: null, y: null });
    const result = await this.getRaw(sel, signal);
    const [height, width] = spatialDimensionsFromChunk(result.shape, this.data.shape, this.labels);
    return { data: result.data, width, height };
  }

  async getTile({
    x,
    y,
    selection,
    signal,
  }: {
    x: number;
    y: number;
    selection: RasterSelection;
    signal?: AbortSignal;
  }) {
    const [xSlice, ySlice] = this.getSlices(x, y);
    const sel = this.chunkIndex(selection, { x: xSlice, y: ySlice });
    const result = await this.getRaw(sel, signal);
    const [height, width] = spatialDimensionsFromChunk(result.shape, this.data.shape, this.labels);
    return { data: result.data, width, height };
  }

  onTileError(err: Error) {
    if (!(err instanceof BoundsCheckError)) {
      throw err;
    }
  }
}

async function loadMultiscales(store: zarr.AsyncReadable) {
  const readable = await zarr.withMaybeConsolidatedMetadata(store);
  const root = zarr.root(readable);
  const group = await zarr.open(root, { kind: 'group' });
  const rootAttrs = getOmeRootAttrs(group.attrs);
  const firstMultiscale = rootAttrs.multiscales?.[0];
  const paths: string[] = firstMultiscale?.datasets?.map((dataset) => dataset.path) ?? ['0'];
  const labels = labelsFromAxes(firstMultiscale?.axes);
  const data: Array<zarr.Array<zarr.DataType>> = await Promise.all(
    paths.map((path: string) => zarr.open(root.resolve(path), { kind: 'array' }))
  );
  return { data, labels, rootAttrs };
}

/** Load an OME-Zarr multiscale image from a Zarrita readable store. */
export async function loadOmeZarrMultiscalesFromStore(
  store: zarr.AsyncReadable
): Promise<VivCompatiblePixelSource[]> {
  const { data, labels } = await loadMultiscales(store);
  if (data.length === 0) {
    throw new Error('OME-Zarr multiscale dataset is empty or has no valid arrays.');
  }
  const tileSize = guessTileSize(data[0], labels);
  return data.map((arr: zarr.Array<zarr.DataType>) => new ZarrPixelSource(arr, labels, tileSize));
}
