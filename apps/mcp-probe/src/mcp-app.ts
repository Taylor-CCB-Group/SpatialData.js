import { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { type ProbeRecord, runProbes, summarize, watchCspViolations } from './probes.ts';

watchCspViolations();

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return el;
}

const summaryEl = element('summary', HTMLParagraphElement);
const tableEl = element('results', HTMLTableElement);
const rerunButton = element('rerun', HTMLButtonElement);
const sendButton = element('send', HTMLButtonElement);

const app = new App({ name: 'SpatialData probe', version: '0.1.0' }, {}, { autoResize: true });

let storeUrls: string[] = [];
let lastResults: ProbeRecord = {};
let running: Promise<ProbeRecord> | undefined;

function hostReport(): ProbeRecord {
  const { styles: _styles, ...context } = app.getHostContext() ?? {};
  return {
    version: app.getHostVersion(),
    capabilities: app.getHostCapabilities(),
    context,
  };
}

function renderTable(results: ProbeRecord): void {
  const rows: HTMLTableRowElement[] = [];
  const walk = (value: unknown, key: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}.${k}` : k);
      return;
    }
    const row = document.createElement('tr');
    const name = row.insertCell();
    const cell = row.insertCell();
    name.textContent = key;
    // Values include URLs and error text from the network; never parse them as HTML.
    cell.textContent = Array.isArray(value) ? JSON.stringify(value) : String(value);
    if (value === true) cell.className = 'ok';
    if (value === false) cell.className = 'bad';
    rows.push(row);
  };
  walk(results, '');
  tableEl.replaceChildren(...rows);
}

async function probe(urls: string[]): Promise<ProbeRecord> {
  storeUrls = urls;
  const results: ProbeRecord = { host: hostReport() };
  lastResults = results;
  for await (const [name, result] of runProbes(urls)) {
    summaryEl.textContent = `Probing… finished ${name}`;
    results[name] = result;
    renderTable(results);
  }
  const verdicts = summarize(results);
  summaryEl.textContent = verdicts.join('\n');
  summaryEl.style.whiteSpace = 'pre';
  // The agent cannot see the tile or its console; this is how the results reach it.
  await app
    .updateModelContext({
      content: [{ type: 'text', text: `SpatialData probe:\n${verdicts.join('\n')}` }],
      structuredContent: results,
    })
    .catch((e: unknown) => console.warn('updateModelContext failed', e));
  return results;
}

function start(urls: string[]): Promise<ProbeRecord> {
  if (running && urls.join() === storeUrls.join()) return running;
  running = probe(urls).finally(() => {
    running = undefined;
  });
  return running;
}

const toolArguments = z.object({ store_urls: z.array(z.string()).optional() });
const toolResult = z.object({ store_urls: z.array(z.string()) });

// The input arrives first; it may omit store_urls, in which case the server's
// defaults come back in the result.
app.ontoolinput = ({ arguments: args }) => {
  const parsed = toolArguments.safeParse(args ?? {});
  if (parsed.success && parsed.data.store_urls?.length) void start(parsed.data.store_urls);
};
app.ontoolresult = (result) => {
  const parsed = toolResult.safeParse(result.structuredContent);
  if (parsed.success) void start(parsed.data.store_urls);
};

// Tools the agent can call against the live tile.
app.registerTool(
  'get_probe',
  { title: 'Read probe results', description: 'Return the latest probe results.' },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(lastResults, null, 2) }],
    structuredContent: lastResults,
  })
);
app.registerTool(
  'rerun_probe',
  {
    title: 'Re-run probe',
    description: 'Re-run the probe, optionally against different store URLs.',
    inputSchema: z.object({ store_urls: z.array(z.string().url()).optional() }),
  },
  async ({ store_urls }) => {
    const urls = store_urls?.length ? store_urls : storeUrls;
    if (urls.length === 0) {
      return { content: [{ type: 'text', text: 'No store URLs yet.' }], isError: true };
    }
    const results = await probe(urls);
    return {
      content: [{ type: 'text', text: summarize(results).join('\n') }],
      structuredContent: results,
    };
  }
);

rerunButton.addEventListener('click', () => {
  if (storeUrls.length > 0) void probe(storeUrls);
});
sendButton.addEventListener('click', () => {
  void app.callServerTool({ name: 'report_probe', arguments: { results: lastResults } });
});

await app.connect();
