/**
 * The Resource Resolver's shared contracts.
 *
 * See ADR 0004 (Resource Resolver Owned By Core) and `CONTEXT.md`.
 */

export type {
  EntryNotice,
  SpatialEntryError,
  SpatialEntryErrorContext,
  SpatialEntryErrorFallbackKind,
  SpatialEntryErrorKind,
  SpatialEntryKind,
} from './errors.js';
export { isCancellation, toSpatialEntryError } from './errors.js';
export type { ResolutionProgress } from './resolution.js';
// `Resolution` is both the type and its constructor namespace — one export carries both.
export { fromResult, Resolution } from './resolution.js';
