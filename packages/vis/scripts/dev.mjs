import { spawn } from 'node:child_process';

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = [];
let shuttingDown = false;

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

console.log('Starting vis build watch and demo server...');
start('watch', ['vite', 'build', '--watch']);
start('demo', ['vite', '--config', 'vite.config.demo.ts', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
