import { spawn } from 'node:child_process';
import {
  describeProcess,
  isPortInUse,
  listProcesses,
  portListeners,
} from '../../../scripts/dev-process-utils.mjs';
import { FIXTURE_SERVER_PORT } from '../../../scripts/fixture-server-port.mjs';

const DEMO_PORT = 5173;
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = [];
let shuttingDown = false;

/** One-line description of whoever is listening on a port, if we can find it. */
function describePortHolder(port) {
  const [pid] = portListeners(port);
  if (!pid) return '';
  const proc = listProcesses().find((p) => p.pid === pid);
  return proc ? describeProcess(proc) : `pid ${pid}`;
}

/** Is the server on `port` our own fixture server (vs. a foreign process)? */
async function fixtureServerIsOurs(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__fixture-health__`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok && res.headers.get('x-spatialdata-fixture-server') === '1';
  } catch {
    return false;
  }
}

/**
 * Check the ports we need before spawning anything: a busy demo port just gets a
 * heads-up (Vite falls back to a free one), while a foreign process on the fixed
 * fixture port is fatal. Returns whether we still need to start the fixture server.
 */
async function preflight() {
  if (await isPortInUse(DEMO_PORT)) {
    const holder = describePortHolder(DEMO_PORT);
    console.log(
      `[dev] Demo port ${DEMO_PORT} is already in use${
        holder ? ` (${holder})` : ''
      }; Vite will fall back to the next free port.`
    );
  }

  if (await isPortInUse(FIXTURE_SERVER_PORT)) {
    if (await fixtureServerIsOurs(FIXTURE_SERVER_PORT)) {
      console.log(`[dev] Reusing the fixture server already running on :${FIXTURE_SERVER_PORT}.`);
      return { startFixtures: false };
    }
    const holder = describePortHolder(FIXTURE_SERVER_PORT);
    console.error(
      `\n[dev] Fixture port ${FIXTURE_SERVER_PORT} is in use by a non-SpatialData process${
        holder ? `:\n  ${holder}` : '.'
      }`
    );
    console.error('[dev] Stop it, or set SPATIALDATA_FIXTURE_PORT to another port, then retry.\n');
    process.exit(1);
  }

  return { startFixtures: true };
}

function start(name, args) {
  const child = spawn(pnpmCommand, ['exec', ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    if (shuttingDown) {
      return;
    }

    console.error(`[${name}] failed to start:`, error);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (code === 0 && !signal) {
      shutdown(0);
      return;
    }

    console.error(`[${name}] exited with ${signal ?? `code ${code ?? 1}`}`);
    shutdown(code ?? 1);
  });

  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    child.kill();
  }

  const timer = setTimeout(() => {
    process.exit(code);
  }, 500);
  timer.unref();
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

const { startFixtures } = await preflight();

const startedParts = ['vis build watch', 'demo server'];
if (startFixtures) {
  start('fixtures', ['node', '../../scripts/test-server.js']);
  startedParts.unshift('fixture server');
}
console.log(`Starting ${startedParts.join(', ')}...`);
start('watch', ['vite', 'build', '--watch']);
// Host/port (and the free-port fallback) are owned by vite.config.demo.ts so
// the port selection stays in one place; honour PORT if the caller pins it.
start('demo', ['vite', '--config', 'vite.config.demo.ts']);
