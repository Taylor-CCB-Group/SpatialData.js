import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The package dependency boundaries, as a test.
 *
 * ADR 0004's definition of done opens with two boxes that read "Still true":
 *
 *   - `@spatialdata/core` has no `react`, no `deck.gl`, no `@hms-dbmi/viv` import.
 *   - `@spatialdata/layers` has no `react` import.
 *
 * A box that says "still true" is a box that rots. These are the constraints the
 * whole Resource Resolver design rests on — `core` is the dependency root for
 * `tgpu-htj2k`, whose engine core is deliberately dependency-free, and it is what
 * makes the resolver testable headless with no GL context. Encode them so they
 * cannot quietly stop being true.
 */

const REPO = resolve(__dirname, '../../..');

function sourceFiles(pkg: string): string[] {
  const root = join(REPO, 'packages', pkg, 'src');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
  };
  walk(root);
  return out;
}

/** Module specifiers this file imports from — `import … from 'x'` and `export … from 'x'`. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    specifiers.push(match[1] as string);
    match = re.exec(source);
  }
  // Bare side-effect imports: `import 'x'`
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  let bareMatch: RegExpExecArray | null = bare.exec(source);
  while (bareMatch !== null) {
    specifiers.push(bareMatch[1] as string);
    bareMatch = bare.exec(source);
  }
  return specifiers;
}

/** Does `specifier` resolve to `pkg`, or a subpath of it? */
const isFrom = (specifier: string, pkg: string) =>
  specifier === pkg || specifier.startsWith(`${pkg}/`);

function offenders(pkg: string, forbidden: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(pkg)) {
    for (const specifier of importsOf(file)) {
      const hit = forbidden.find((f) => isFrom(specifier, f));
      if (hit) found.push(`${relative(REPO, file)} imports '${specifier}'`);
    }
  }
  return found;
}

describe('@spatialdata/core is framework-free (ADR 0004 §1)', () => {
  // core is the dependency root for tgpu-htj2k (three.js/WebGPU, separate repo),
  // which excludes deck.gl and React from its render path by name. Break this and
  // the second consumer cannot use the resolver at all — which is the entire
  // reason it moved here.
  it('imports no React', () => {
    expect(offenders('core', ['react', 'react-dom'])).toEqual([]);
  });

  it('imports no deck.gl', () => {
    expect(offenders('core', ['deck.gl', '@deck.gl', '@geoarrow/deck.gl-geoarrow'])).toEqual([]);
  });

  it('imports no Viv', () => {
    expect(offenders('core', ['@hms-dbmi/viv'])).toEqual([]);
  });

  it('imports no avivatorish', () => {
    // avivatorish pulls in BOTH React and Viv, and is a de-vendoring holding pen
    // for code that also lives upstream in Viv and MDV, with an evolving image
    // state model. core must not be shaped around it. See ADR 0004's amendment.
    expect(offenders('core', ['@spatialdata/avivatorish'])).toEqual([]);
  });

  it('does not depend on any sibling @spatialdata package', () => {
    // core is the root. Anything else is a cycle waiting to happen.
    expect(
      offenders('core', ['@spatialdata/layers', '@spatialdata/vis', '@spatialdata/react'])
    ).toEqual([]);
  });
});

describe('@spatialdata/layers is React-free (ADR 0004 §4)', () => {
  // layers owns the deck Renderer Adapter. Deck layers are not React components;
  // the moment React appears here, the adapter has become a component and the
  // headless consumer is gone.
  it('imports no React', () => {
    expect(offenders('layers', ['react', 'react-dom'])).toEqual([]);
  });
});

describe('the detector itself', () => {
  // Every assertion above is `toEqual([])`. An import scanner with a broken regex
  // returns [] for everything and every boundary test passes vacuously — which
  // would be strictly worse than having no test at all, because it would read as
  // proof. So point it at imports we KNOW exist and require it to find them.
  it('finds deck.gl in layers, which certainly imports it', () => {
    expect(offenders('layers', ['deck.gl', '@deck.gl']).length).toBeGreaterThan(0);
  });

  it('finds React in vis, which certainly imports it', () => {
    expect(offenders('vis', ['react']).length).toBeGreaterThan(0);
  });

  it('finds core imported by layers — so sibling detection works too', () => {
    expect(offenders('layers', ['@spatialdata/core']).length).toBeGreaterThan(0);
  });

  it('sees `export … from` re-exports, not just `import`', () => {
    // layers/src/index.ts reaches core ONLY via `export … from '@spatialdata/core'`
    // (the render-stack compat shim). If the scanner missed export-from, a future
    // forbidden dependency could enter core through a re-export unseen.
    const viaExport = offenders('layers', ['@spatialdata/core']).filter((o) =>
      o.startsWith('packages/layers/src/index.ts')
    );
    expect(viaExport.length).toBeGreaterThan(0);
  });
});
