#!/usr/bin/env node
import {
  classifyDevProcess,
  describeProcess,
  isSpatialDataOwned,
  isWindows,
  killPids,
  listProcesses,
  pidCwd,
  portListeners,
} from './dev-process-utils.mjs';
/**
 * Stop SpatialData dev processes left running in the background.
 *
 * Finds and kills this project's dev-stack processes across *all* local
 * checkouts/worktrees (the usual cause of port conflicts): the vis dev
 * orchestrator, fixture server, cors proxy, demo server, package build
 * watchers, the docs site, and `pnpm (-r --parallel) dev` orchestrators.
 *
 * It is deliberately scoped to SpatialData — processes from other projects
 * (and foreign processes that merely hold one of our ports) are reported but
 * never killed.
 *
 * Usage: pnpm dev:stop [--dry-run]
 */
import { FIXTURE_SERVER_PORT } from './fixture-server-port.mjs';

if (isWindows) {
  console.error('pnpm dev:stop is only supported on macOS/Linux for now.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

// Known fixed dev ports (docs/docusaurus picks a dynamic port, so it is matched
// by command token instead).
const DEV_PORTS = [...new Set([5173, FIXTURE_SERVER_PORT, 8081])];

const processes = listProcesses();
const byPid = new Map(processes.map((p) => [p.pid, p]));
const selfPid = process.pid;

// 1. Match SpatialData dev processes by command token / orchestrator.
const targets = new Map(); // pid -> { pid, command, reason }
for (const proc of processes) {
  if (proc.pid === selfPid) continue;
  const hit = classifyDevProcess(proc);
  if (hit) targets.set(hit.pid, hit);
}

// 2. Port backstop: catch anything holding a dev port. Kill only if it is ours;
//    otherwise report it as a foreign holder so the user knows what is blocking.
const foreign = [];
for (const port of DEV_PORTS) {
  for (const pid of portListeners(port)) {
    if (pid === selfPid || targets.has(pid)) continue;
    const proc = byPid.get(pid) ?? { pid, command: '(unknown)' };
    if (isSpatialDataOwned(proc)) {
      targets.set(pid, { ...proc, reason: `port ${port}` });
    } else {
      foreign.push({ port, ...proc, cwd: pidCwd(pid) });
    }
  }
}

const targetList = [...targets.values()].sort((a, b) => a.pid - b.pid);

if (targetList.length === 0) {
  console.log('No SpatialData dev processes are running.');
} else {
  console.log(
    `${dryRun ? 'Would stop' : 'Stopping'} ${targetList.length} SpatialData dev process${
      targetList.length === 1 ? '' : 'es'
    }:`
  );
  for (const proc of targetList) {
    console.log(`  • ${describeProcess(proc)}  (${proc.reason})`);
  }

  if (!dryRun) {
    const { killed, survivors } = await killPids(targetList.map((p) => p.pid));
    console.log(`\nStopped ${killed.length} process${killed.length === 1 ? '' : 'es'}.`);
    if (survivors.length > 0) {
      console.log(`Force-killed ${survivors.length}: ${survivors.join(', ')}`);
    }
  }
}

if (foreign.length > 0) {
  console.log('\nDev ports held by non-SpatialData processes (left untouched):');
  for (const f of foreign) {
    const command = f.command.length > 90 ? `${f.command.slice(0, 87)}...` : f.command;
    console.log(`  • port ${f.port}: pid ${f.pid}  [${f.cwd || '?'}]  ${command}`);
  }
  console.log('Stop those manually or use a different port if they conflict.');
}
