// `qb up`'s background server: started once, found again, stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureServer, runningServer, stopServer } from '../core/daemon.js';

test('the background server starts once, is found again, and stops', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-daemon-'));
  const boardDir = path.join(root, '.queuebox');
  fs.mkdirSync(boardDir);
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ name: 'Daemon test', districts: [{ id: 'd', name: 'D' }], blocks: [{ id: 'b', name: 'B', district: 'd', paths: ['**'] }] }));
  try {
    const first = await ensureServer(boardDir);
    assert.equal(first.started, true);
    const again = await ensureServer(boardDir);
    assert.equal(again.started, false);
    assert.equal(again.pid, first.pid);
    assert.ok(await runningServer(boardDir));
    assert.equal(await stopServer(boardDir), true);
    assert.equal(await runningServer(boardDir), null);
  } finally {
    await stopServer(boardDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a board keeps its port across qb down and qb up, and a server started by hand records its own (B15)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-port-'));
  const boardDir = path.join(root, '.queuebox');
  fs.mkdirSync(boardDir);
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ name: 'Port test', districts: [{ id: 'd', name: 'D' }], blocks: [{ id: 'b', name: 'B', district: 'd', paths: ['**'] }] }));
  const info = () => JSON.parse(fs.readFileSync(path.join(boardDir, 'live', 'server.json'), 'utf8'));
  try {
    // Started on a port of its choosing, as \`qb serve --port\` does; the next free one is lower, so a forgetful
    // restart would move.
    const net = await import('node:net');
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const first = await ensureServer(boardDir, { port });
    assert.equal(first.port, port);
    assert.equal(await stopServer(boardDir), true);
    assert.equal(info().pid, null);
    assert.equal(info().port, port);
    assert.equal(await runningServer(boardDir), null);
    const again = await ensureServer(boardDir);
    assert.equal(again.started, true);
    assert.equal(again.port, port);
    await stopServer(boardDir);
    // A server started directly writes the record itself.
    const { serve } = await import('../server.js');
    const saved = { ...process.env };
    process.env.QUEUEBOX_DIR = boardDir;
    process.env.QUEUEBOX_WAKE = 'off';
    delete process.env.QUEUEBOX_LIVE;
    const server = await serve({ port: 0, quiet: true });
    try {
      assert.deepEqual([info().pid, info().port], [process.pid, server.address().port]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  } finally {
    await stopServer(boardDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
