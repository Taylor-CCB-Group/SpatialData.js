// earcut v3 ships no type declarations. We use only the default triangulation call.
declare module 'earcut' {
  /**
   * Triangulate a flat coordinate array into triangle vertex indices.
   * @param data Flat vertex coordinates (x0,y0,x1,y1,…).
   * @param holeIndices Ring start indices for holes (unused for exterior-only rings).
   * @param dim Coordinates per vertex (default 2).
   */
  function earcut(
    data: ArrayLike<number>,
    holeIndices?: ArrayLike<number> | null,
    dim?: number
  ): number[];
  export default earcut;
}
