import type { EntryNotice } from './engine/errors.js';
import type { RasterLayoutIssue } from './rasterLayout.js';

/**
 * What would fix an {@link ElementIssue}, as data: a host words it its own way, and a
 * tool could act on it. Describes the operation, not how any particular tool spells it.
 */
export type Remedy =
  | { op: 'build-pyramid'; factor: number; coarsestAtMostPixels: number }
  | {
      op: 'rechunk';
      chunkPixels: { min: number; max: number };
      /** Over all dimensions, not just y and x, so channels and a wide dtype count. */
      decodedBytesAtMost: number;
    };

/**
 * A property of how an element is stored that will make it slow or awkward to use
 * however well the client behaves. `element.getIssues()` reports those judged from
 * consolidated metadata alone, synchronously; `element.assessIssues()` also reports
 * those that need a read (a parquet footer, say).
 *
 * A static fact about the element, queryable without a resolver — as opposed to an
 * {@link EntryNotice}, which a resolver raises about a layer. Resolvers wrap these in
 * one `element-issues` notice. Other element types add their members here.
 */
export type ElementIssue = RasterLayoutIssue;

/** An {@link ElementIssue} with the path of the element it is about, e.g. `images/he`. */
export type StoreIssue = { readonly path: string; readonly issue: ElementIssue };

export const NO_ISSUES: readonly ElementIssue[] = [];

/** The notice for an element with issues, or `undefined` if there are none. */
export function elementIssuesNotice(
  issues: readonly ElementIssue[],
  describe: (issue: ElementIssue) => string
): Extract<EntryNotice, { kind: 'element-issues' }> | undefined {
  if (issues.length === 0) return undefined;
  return { kind: 'element-issues', message: issues.map(describe).join(' '), issues };
}
