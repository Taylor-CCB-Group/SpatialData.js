/**
 * Shared helpers for inspecting and stopping this repo's dev processes.
 *
 * The goal is to be *scoped to SpatialData* — a `vite build --watch` or
 * `pnpm dev` belonging to a different project (or a foreign process that merely
 * grabbed one of our ports) must never be matched or killed. Process matching
 * therefore requires both a known dev-command token AND ownership by a
 * SpatialData checkout (the repo name appears in the command line or the
 * process cwd).
 *
 * POSIX only (macOS/Linux); relies on `ps` and `lsof`.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

export const isWindows = process.platform === 'win32';

/** Repo-name marker present in every SpatialData checkout path. */
export const SPATIALDATA_MARKER = /SpatialData/i;

/** Command substrings that identify a SpatialData dev-stack process. */
export const DEV_TOKENS = [
  'scripts/dev.mjs', // vis dev orchestrator
  'scripts/test-server.js', // fixture server
  'scripts/cors-proxy.js', // cors proxy
  'vite.config.demo', // vis demo server
  'vite/bin/vite.js build --watch', // package build watchers
  '@docusaurus/core/bin/docusaurus', // docs site
];

/**
 * `pnpm ... dev` / `pnpm -r --parallel dev` orchestrators.
 *
 * Matches the pnpm binary actually being *invoked* (preceded by `/` or start,
 * then whitespace + args + a `dev` argument) — not paths that merely contain
 * the `.pnpm` store directory.
 */
const PNPM_DEV = /(?:^|\/)pnpm(?:\.cjs|\.js)?\s+(?:[^\s]+\s+)*dev(?:\s|$)/;

/** List running processes as `{ pid, command }`. POSIX only. */
export function listProcesses() {
  if (isWindows) return [];
  let out = '';
  try {
    out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const procs = [];
  for (const line of out.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match) procs.push({ pid: Number(match[1]), command: match[2].trim() });
  }
  return procs;
}

/** Working directory of a pid via `lsof`. Returns '' if unknown. */
export function pidCwd(pid) {
  if (isWindows) return '';
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : '';
  } catch {
    return '';
  }
}

/** PIDs listening on a TCP port via `lsof`. */
export function portListeners(port) {
  if (isWindows || !port) return [];
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [
      ...new Set(
        out
          .split('\n')
          .filter((l) => l.startsWith('p'))
          .map((l) => Number(l.slice(1)))
      ),
    ];
  } catch {
    // lsof exits non-zero when nothing is listening on the port.
    return [];
  }
}

/** Whether a TCP port is already bound (best-effort, checks one host). */
export function isPortInUse(port, host = '127.0.0.1') {
  return new Promise((resolvePromise) => {
    const tester = createServer()
      .once('error', (err) => resolvePromise(err.code === 'EADDRINUSE'))
      .once('listening', () => tester.close(() => resolvePromise(false)))
      .listen(port, host);
  });
}

/** True when a process clearly belongs to a SpatialData checkout. */
export function isSpatialDataOwned({ pid, command }) {
  if (SPATIALDATA_MARKER.test(command)) return true;
  return SPATIALDATA_MARKER.test(pidCwd(pid));
}

/** File-consuming tools that may take a dev-script path as an argument. */
const NON_DEV_RUNNERS = /\b(?:biome|eslint|prettier|vitest|jest|tsc|tsx|tail|grep|less|bat)\b/;

/** Whether the command is a real `node ...` invocation (argv0 is the node binary). */
function isNodeInvocation(command) {
  const first = command.trim().split(/\s+/, 1)[0] ?? '';
  const base = first.split('/').pop();
  return base === 'node' || base === 'node.exe';
}

/**
 * Classify a process as a SpatialData dev process, or return null.
 *
 * Requires a real `node` dev invocation (so shell wrappers, editors, and
 * file-tools that merely mention a dev-script path are never matched), a known
 * dev-command token (or `pnpm dev` orchestrator), AND SpatialData ownership.
 */
export function classifyDevProcess(proc) {
  if (!isNodeInvocation(proc.command) || NON_DEV_RUNNERS.test(proc.command)) {
    return null;
  }
  const token = DEV_TOKENS.find((t) => proc.command.includes(t));
  if (token && isSpatialDataOwned(proc)) {
    return { ...proc, reason: token };
  }
  if (PNPM_DEV.test(proc.command) && isSpatialDataOwned(proc)) {
    return { ...proc, reason: 'pnpm dev' };
  }
  return null;
}

/** One-line description of a process for logging. */
export function describeProcess(proc) {
  const cwd = pidCwd(proc.pid);
  const command = proc.command.length > 100 ? `${proc.command.slice(0, 97)}...` : proc.command;
  return `pid ${proc.pid}  [${cwd || '?'}]  ${command}`;
}

/**
 * SIGTERM the given pids, wait, then SIGKILL any survivors.
 * Returns `{ killed, survivors }` (arrays of pids).
 */
export async function killPids(pids, { graceMs = 800 } = {}) {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 1);
  for (const pid of unique) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (unique.length > 0) {
    await new Promise((r) => setTimeout(r, graceMs));
  }
  const survivors = unique.filter((pid) => {
    try {
      process.kill(pid, 0); // probe: throws if the process is gone
      return true;
    } catch {
      return false;
    }
  });
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* race: gone between probe and kill */
    }
  }
  return { killed: unique.filter((pid) => !survivors.includes(pid)), survivors };
}
