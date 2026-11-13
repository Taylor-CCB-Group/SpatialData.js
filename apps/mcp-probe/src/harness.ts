/**
 * A minimal MCP Apps host for checking the View without Claude. It does what a
 * host does: reads the `ui://` resource from the running server, mounts it in a
 * sandboxed iframe, calls `open_spatial_probe`, and relays the input and result.
 *
 * `?csp=spec` (default) applies the policy the spec requires of a host for the
 * domains the resource declares; `?csp=none` applies none. A probe that reports
 * the same in both modes is not measuring anything. `?sandbox=` is described below.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { z } from 'zod';

const RESOURCE_URI = 'ui://spatialdata/probe.html';

const params = new URLSearchParams(location.search);
const cspMode = params.get('csp') ?? 'spec';
const mcpUrl = params.get('mcp') ?? 'http://127.0.0.1:3001/mcp';
const storeUrls = params.getAll('store');
// Claude serves a View from its own real origin, which `same-origin` approximates
// (here it shares the harness origin). `opaque` is a sandbox without
// allow-same-origin, as some hosts use.
const sandboxMode = params.get('sandbox') ?? 'same-origin';

const resourceMeta = z.object({
  ui: z
    .object({ csp: z.object({ connectDomains: z.array(z.string()).optional() }).optional() })
    .optional(),
});

/** What the spec requires a host to apply when a resource declares only `connectDomains`. */
function specCsp(connectDomains: string[]): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' data:",
    `connect-src ${connectDomains.length > 0 ? connectDomains.join(' ') : "'none'"}`,
    "object-src 'none'",
  ].join('; ');
}

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return el;
}

const frame = element('view', HTMLIFrameElement);
const contextEl = element('model-context', HTMLPreElement);
const callsEl = element('server-calls', HTMLPreElement);
const modeEl = element('mode', HTMLSpanElement);

const client = new Client({ name: 'spatialdata-probe-harness', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

const resource = await client.readResource({ uri: RESOURCE_URI });
const view = resource.contents[0];
if (!view || !('text' in view)) throw new Error(`${RESOURCE_URI} returned no HTML text`);
const connectDomains = resourceMeta.parse(view._meta ?? {}).ui?.csp?.connectDomains ?? [];
const csp = specCsp(connectDomains);
modeEl.textContent = `csp=${cspMode} sandbox=${sandboxMode} · ${mcpUrl}${cspMode === 'spec' ? ` · ${csp}` : ''}`;

// With a client, the bridge forwards the View's tools/call to the server itself.
const bridge = new AppBridge(
  client,
  { name: 'spatialdata-probe-harness', version: '0.0.0' },
  { serverTools: {}, logging: {}, updateModelContext: { text: {}, structuredContent: {} } },
  { hostContext: { theme: 'light', platform: 'web', displayMode: 'inline' } }
);
bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
  const text = (content ?? [])
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
  contextEl.textContent = `${text}\n\n${JSON.stringify(structuredContent, null, 2)}`;
  return {};
};
bridge.onsizechange = ({ height }) => {
  if (height) frame.style.height = `${height}px`;
};
bridge.oninitialized = async () => {
  const args = storeUrls.length > 0 ? { store_urls: storeUrls } : {};
  void bridge.sendToolInput({ arguments: args });
  const result = await client.callTool({ name: 'open_spatial_probe', arguments: args });
  callsEl.textContent += `open_spatial_probe → ${JSON.stringify(result.content)}\n`;
  void bridge.sendToolResult(result);
};

// Listen before the View exists: its App.connect() sends ui/initialize as its script
// runs, which can be before the iframe's load event. The iframe keeps one WindowProxy
// across the srcdoc navigation, so the transport recognises the View's messages.
const target = frame.contentWindow;
if (!target) throw new Error('iframe has no window');
await bridge.connect(new PostMessageTransport(target, target));
frame.sandbox.value =
  sandboxMode === 'opaque' ? 'allow-scripts' : 'allow-scripts allow-same-origin';
const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
frame.srcdoc = cspMode === 'spec' ? view.text.replace(/<head>/i, `<head>${meta}`) : view.text;
