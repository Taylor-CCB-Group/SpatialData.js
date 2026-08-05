/**
 * Memory accounting for resident caches.
 *
 * See [ADR 0005](../../../../docs/adr/0005-memory-accounting-before-management.md):
 * accounting first, management only where something is already unbounded.
 */

export type { ByteLruCacheOptions } from './byteLruCache.js';
export { ByteLruCache } from './byteLruCache.js';
export type { MemoryReporting } from './memoryReporting.js';
