import {
  type EntryNotice,
  type EntryResources,
  type SpatialData,
  type SpatialEntryError,
  type SpatialEntryKind,
  toSpatialEntryError,
} from '@spatialdata/core';
import type { LayerType } from './types';

export interface EntryStatusError {
  /** The failed resource: 'element', 'geometry', 'loader', 'tooltip', 'fillColor', 'preload', … */
  readonly resource: string;
  readonly error: SpatialEntryError;
}

/**
 * What a host can tell a user about one layer: why it failed, and what is degraded
 * but still drawing. Each resource fails independently, so a layer can have both.
 */
export interface EntryStatus {
  readonly errors: readonly EntryStatusError[];
  readonly notices: readonly EntryNotice[];
}

const ENTRY_KIND: Record<LayerType, SpatialEntryKind> = {
  image: 'images',
  shapes: 'shapes',
  points: 'points',
  labels: 'labels',
};

/**
 * Why a layer's element could not be resolved: missing from the store, or present
 * without a transform to the active coordinate system.
 */
export function describeUnresolvedElement(
  spatialData: SpatialData,
  coordinateSystem: string,
  type: LayerType,
  elementKey: string
): SpatialEntryError {
  const kind = ENTRY_KIND[type];
  const element = spatialData[kind]?.[elementKey];
  if (element) {
    const transform = element.getTransformation(coordinateSystem);
    if (!transform.ok) {
      return toSpatialEntryError(transform.error, {
        elementKey,
        kind,
        resource: 'element',
        fallback: 'load-failed',
      });
    }
  }
  return toSpatialEntryError(new Error(`No ${type} element "${elementKey}" in this SpatialData`), {
    elementKey,
    kind,
    resource: 'element',
    fallback: 'element-not-found',
  });
}

function sameNotice(a: EntryNotice, b: EntryNotice): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Reflect.get(a, key) === Reflect.get(b, key))
  );
}

function sameStatus(a: EntryStatus, b: EntryStatus): boolean {
  return (
    a.errors.length === b.errors.length &&
    a.notices.length === b.notices.length &&
    // Errors are built when a load fails and held by reference, so identity is enough.
    a.errors.every(
      (e, i) => e.resource === b.errors[i]?.resource && e.error === b.errors[i]?.error
    ) &&
    // Notices are rebuilt with each snapshot, so compare their fields.
    a.notices.every((n, i) => {
      const other = b.notices[i];
      return other !== undefined && sameNotice(n, other);
    })
  );
}

/**
 * Derives each layer's {@link EntryStatus}, keeping one identity per layer until
 * the status changes. Resolver snapshots are re-created whenever any entry of that
 * kind mutates, so without this a host would see every layer "change" on each load.
 */
export class EntryStatusCache {
  private readonly bySnapshot = new WeakMap<EntryResources, EntryStatus | undefined>();
  private readonly last = new Map<string, EntryStatus>();
  private readonly unresolved = new Map<
    string,
    { spatialData: SpatialData; signature: string; status: EntryStatus }
  >();

  /** `undefined` when the entry has nothing to report. */
  fromSnapshot(snapshot: EntryResources): EntryStatus | undefined {
    if (this.bySnapshot.has(snapshot)) return this.bySnapshot.get(snapshot);
    this.unresolved.delete(snapshot.entryId);

    const errors: EntryStatusError[] = [];
    const notices: EntryNotice[] = [...snapshot.notices];
    for (const [resource, resolution] of Object.entries(snapshot.resources)) {
      if (resolution.status === 'failed') errors.push({ resource, error: resolution.error });
      else if (resolution.status === 'ready' && resolution.notices) {
        notices.push(...resolution.notices);
      }
    }
    const status = this.settle(snapshot.entryId, { errors, notices });
    this.bySnapshot.set(snapshot, status);
    return status;
  }

  fromUnresolved(
    entryId: string,
    spatialData: SpatialData,
    coordinateSystem: string,
    type: LayerType,
    elementKey: string
  ): EntryStatus {
    const signature = `${type}\u0000${elementKey}\u0000${coordinateSystem}`;
    const held = this.unresolved.get(entryId);
    if (held && held.spatialData === spatialData && held.signature === signature) {
      return held.status;
    }
    const error = describeUnresolvedElement(spatialData, coordinateSystem, type, elementKey);
    const status: EntryStatus = { errors: [{ resource: 'element', error }], notices: [] };
    this.unresolved.set(entryId, { spatialData, signature, status });
    this.last.set(entryId, status);
    return status;
  }

  private settle(entryId: string, next: EntryStatus): EntryStatus | undefined {
    if (next.errors.length === 0 && next.notices.length === 0) {
      this.last.delete(entryId);
      return undefined;
    }
    const previous = this.last.get(entryId);
    if (previous && sameStatus(previous, next)) return previous;
    this.last.set(entryId, next);
    return next;
  }
}
