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

let storeUrl: string | undefined;
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

async function probe(url: string): Promise<ProbeRecord> {
  storeUrl = url;
  const results: ProbeRecord = { host: hostReport() };
  lastResults = results;
  for await (const [name, result] of runProbes(url)) {
    summaryEl.textContent = `Probing against ${url}… finished ${name}`;
    results[name] = result;
    renderTable(results);
  }
  const verdicts = summarize(results);
  summaryEl.textContent = verdicts.join('\n');
  summaryEl.style.whiteSpace = 'pre';
  // The agent cannot see the tile or its console; this is how the results reach it.
  await app
    .updateModelContext({
      content: [{ type: 'text', text: `SpatialData probe (${url}):\n${verdicts.join('\n')}` }],
      structuredContent: results,
    })
    .catch((e: unknown) => console.warn('updateModelContext failed', e));
  return results;
}

function start(url: string): Promise<ProbeRecord> {
  if (running && url === storeUrl) return running;
  running = probe(url).finally(() => {
    running = undefined;
  });
  return running;
}

const toolArguments = z.object({ store_url: z.string().optional() });
const toolResult = z.object({ store_url: z.string() });

// The input arrives first; it may omit store_url, in which case the server's
// default comes back in the result.
app.ontoolinput = ({ arguments: args }) => {
  const parsed = toolArguments.safeParse(args ?? {});
  if (parsed.success && parsed.data.store_url) void start(parsed.data.store_url);
};
app.ontoolresult = (result) => {
  const parsed = toolResult.safeParse(result.structuredContent);
  if (parsed.success) void start(parsed.data.store_url);
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
    description: 'Re-run the probe, optionally against a different store URL.',
    inputSchema: z.object({ store_url: z.string().url().optional() }),
  },
  async ({ store_url }) => {
    const url = store_url ?? storeUrl;
    if (!url) {
      return { content: [{ type: 'text', text: 'No store URL yet.' }], isError: true };
    }
    const results = await probe(url);
    return {
      content: [{ type: 'text', text: summarize(results).join('\n') }],
      structuredContent: results,
    };
  }
);

rerunButton.addEventListener('click', () => {
  if (storeUrl) void probe(storeUrl);
});
sendButton.addEventListener('click', () => {
  void app.callServerTool({ name: 'report_probe', arguments: { results: lastResults } });
});

await app.connect();
