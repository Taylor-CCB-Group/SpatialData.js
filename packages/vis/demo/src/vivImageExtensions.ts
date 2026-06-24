import { ColorPaletteExtension } from '@hms-dbmi/viv';
import VivContrastExtension from './VivContrastExtension';

/** Same extension stack as MDV `VivScatterComponent` (ColorPalette + contrast tone). */
export function createMdvStyleVivImageExtensions(): unknown[] {
  return [new ColorPaletteExtension(), new VivContrastExtension()];
}
