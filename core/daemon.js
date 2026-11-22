// The board server in the background: one per repository, started by `qb up` or by a Claude Code session
// opening in the repository, stopped by `qb down`. Where it runs is kept in `.queuebox/live/server.json`.
// Node only.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const FIRST_PORT = 4477;
const LAST_PORT = 4520;

const infoFile = (boardDir) => path.join(boardDir, 'live', 'server.json');
const logFile = (boardDir) => path.join(boardDir, 'live', 'server.log');

function readInfo(boardDir) {
  try {
    return JSON.parse(fs.readFileSync(infoFile(boardDir), 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Whether a QueueBox server for this board answers on the port.
async function answers(port, boardDir, timeout = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/board`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return false;
    const board = await res.json();
    const ours = JSON.parse(fs.readFileSync(path.join(boardDir, 'board.json'), 'utf8'));
    return board?.name === ours.name;
  } catch {
    return false;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

// The running server for this board, or null.
export async function runningServer(boardDir) {
  const info = readInfo(boardDir);
  if (!info?.pid || !info?.port || !alive(info.pid)) return null;
  return (await answers(info.port, boardDir)) ? info : null;
}

// Starts the server unless it runs already. `wait: false` returns right after spawning (the hooks use it, so a
// session never waits on the board); otherwise it waits until the page answers.
export async function ensureServer(boardDir, { port, wait = true } = {}) {
  const running = await runningServer(boardDir);
  if (running) return { ...running, started: false };
  const prev = readInfo(boardDir);
  const wanted = [port, prev?.port, ...Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, i) => FIRST_PORT + i)].filter(Boolean);
  let chosen = null;
  for (const p of new Set(wanted)) {
    if (await portFree(p)) {
      chosen = p;
      break;
    }
  }
  if (!chosen) throw new Error(`No free port between ${FIRST_PORT} and ${LAST_PORT} for the board.`);
  fs.mkdirSync(path.join(boardDir, 'live'), { recursive: true });
  const log = fs.openSync(logFile(boardDir), 'a');
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(chosen)], {
    cwd: path.dirname(boardDir),
    env: { ...process.env, QUEUEBOX_DIR: boardDir },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  fs.closeSync(log);
  const info = { pid: child.pid, port: chosen, url: `http://127.0.0.1:${chosen}`, startedAt: new Date().toISOString() };
  fs.writeFileSync(infoFile(boardDir), `${JSON.stringify(info, null, 2)}\n`);
  if (wait) {
    for (let i = 0; i < 50 && !(await answers(chosen, boardDir, 300)); i++) {
      if (!alive(child.pid)) throw new Error(`The board server stopped right away; see ${logFile(boardDir)}.`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { ...info, started: true };
}

export async function stopServer(boardDir) {
  const info = readInfo(boardDir);
  if (!info?.pid || !alive(info.pid)) {
    if (info?.pid) forget(boardDir, info);
    return false;
  }
  process.kill(info.pid, 'SIGTERM');
  for (let i = 0; i < 30 && alive(info.pid); i++) await new Promise((r) => setTimeout(r, 100));
  forget(boardDir, info);
  return true;
}

// Stopped, but the port is remembered, so the next `qb up` serves the board where its tabs and briefings point (B15).
function forget(boardDir, info) {
  try {
    fs.writeFileSync(infoFile(boardDir), `${JSON.stringify({ ...info, pid: null, stoppedAt: new Date().toISOString() }, null, 2)}\n`);
  } catch {
    // No live folder: nothing to remember.
  }
}

// A server that closes clears its own record (only its own), keeping the port for the next start.
export function forgetServer(boardDir, pid) {
  const info = readInfo(boardDir);
  if (info?.pid === pid) forget(boardDir, info);
}

// A server records where it serves once it listens, however it was started (`qb up` or `qb serve --port`), unless
// another live server already holds the record.
export function recordServer(boardDir, { pid, port }) {
  const prev = readInfo(boardDir);
  if (prev?.pid && prev.pid !== pid && alive(prev.pid)) return false;
  fs.mkdirSync(path.join(boardDir, 'live'), { recursive: true });
  fs.writeFileSync(infoFile(boardDir), `${JSON.stringify({ pid, port, url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString() }, null, 2)}\n`);
  return true;
}

// The URL the board was last served at, without checking it still answers (for briefings).
export function lastUrl(boardDir) {
  return readInfo(boardDir)?.url || null;
}
