/**
 * The capability probe as an anywidget, for marimo and Jupyter. Results go
 * back to Python through the synced `results` trait, so a marimo cell that
 * reads them re-runs when the probe finishes.
 */
import { type ProbeRecord, runProbes, summarize, watchCspViolations } from './probes.ts';

/** The slice of anywidget's model this widget uses. */
interface WidgetModel {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  save_changes(): void;
  on(event: string, callback: () => void): void;
  off(event: string, callback: () => void): void;
}

let watching = false;

/** What decides how a bundled widget can find its worker and WASM files. */
function moduleReport(el: HTMLElement): ProbeRecord {
  const url = import.meta.url;
  let relative: string;
  try {
    relative = new URL('./worker.js', url).href;
  } catch (e) {
    relative = `unresolvable: ${String(e)}`;
  }
  return {
    importMetaUrl: url.length > 120 ? `${url.slice(0, 120)}…` : url,
    scheme: url.slice(0, url.indexOf(':') + 1),
    relativeWorkerUrl: relative.length > 120 ? `${relative.slice(0, 120)}…` : relative,
    inShadowRoot: el.getRootNode() instanceof ShadowRoot,
    inIframe: window.self !== window.top,
  };
}

export default {
  render({ model, el }: { model: WidgetModel; el: HTMLElement }) {
    if (!watching) {
      watchCspViolations();
      watching = true;
    }
    const pre = document.createElement('pre');
    pre.style.cssText = 'font: 12px/1.45 ui-monospace, monospace; margin: 0; white-space: pre-wrap';
    el.replaceChildren(pre);
    let current = 0;

    const run = async () => {
      const id = ++current;
      const value = model.get('store_urls');
      const storeUrls = Array.isArray(value)
        ? value.filter((u): u is string => typeof u === 'string')
        : [];
      if (storeUrls.length === 0) {
        pre.textContent = 'Set store_urls to probe stores.';
        return;
      }
      const results: ProbeRecord = { module: moduleReport(el) };
      for await (const [name, result] of runProbes(storeUrls)) {
        if (id !== current) return;
        results[name] = result;
        pre.textContent = `Probing… finished ${name}`;
      }
      pre.textContent = ['SpatialData probe', ...summarize(results)].join('\n');
      model.set('results', results);
      model.save_changes();
    };

    model.on('change:store_urls', run);
    void run();
    return () => {
      current++;
      model.off('change:store_urls', run);
    };
  },
};
