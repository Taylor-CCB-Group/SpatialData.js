/**
 * Whether an ArrayBuffer was detached by a transfer. `ArrayBuffer.prototype.detached`
 * is ES2024 and this package's lib stops at ES2022, so it is read through a guard
 * rather than a cast.
 */
export function isDetached(buffer: ArrayBufferLike | undefined): boolean {
  return buffer !== undefined && 'detached' in buffer && buffer.detached === true;
}
