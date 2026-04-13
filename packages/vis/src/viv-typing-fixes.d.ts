import type { Matrix4 } from '@math.gl/core';

declare module '@hms-dbmi/viv' {
  export function getDefaultInitialViewState(
    loader: object,
    viewSize: { width: number; height: number },
    zoomBackOff?: number,
    use3d?: boolean,
    modelMatrix?: Matrix4
  ): { target: [number, number, number]; zoom: number };
}
