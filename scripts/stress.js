// A board under load, written the same way every time: 20 agents, 5,000 items in one hot block (3,500 of them
// done), 200 queued, one agent with 80 lined up, and enough edits to make about 48,000 events. The smoke test
// loads it to check the page's layout holds (T57); serve it to look at it yourself.
//
//   node scripts/stress.js --out <dir>     write <dir>/.queuebox (board.json and live/events.jsonl)
//   node scripts/stress.js --keep          write it to a temporary folder and serve it; Ctrl+C stops it

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUMAN, apply, checkEvent, createState, makeEvent } from '../core/model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOT = 'side';

// A small, seeded random source, so the board is the same every run.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stressBoard({ end = Date.UTC(2026, 10, 22, 12, 0, 0) } = {}) {
  const board = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'test', 'fixtures', 'session.board.json'), 'utf8'));
  const rand = seeded(57);
  const state = createState({ ...board, items: [] });
  const events = [];
  let t = end - 8 * 3600_000;
  const put = (type, by, payload) => {
    t += 1 + Math.floor(rand() * 400);
    const e = makeEvent(state, type, by, payload, t, rand);
    const why = checkEvent(state, e, t);
    if (why) throw new Error(`stress: ${type} refused: ${why}`);
    apply(state, e);
    events.push(e);
    return e;
  };
  const blocks = board.blocks.map((b) => b.id);
  const agents = Array.from({ length: 20 }, (_, i) => `cc-5${String(i).padStart(7, '0')}`);
  agents.forEach((id, i) => put('agent.join', id, { agent: { id, name: `Agent ${String(i + 1).padStart(2, '0')}` } }));
  // 5,000 items in the hot block, filed by the person and the agents.
  const items = [];
  for (let i = 0; i < 5000; i++) {
    const by = i % 3 ? agents[i % agents.length] : HUMAN;
    const kind = i % 4 === 0 ? 'bug' : 'task';
    items.push(put('item.add', by, { item: { kind, title: `${kind === 'bug' ? 'Fix' : 'Do'} thing ${i + 1} in the hot block, with a title long enough to wrap twice in a narrow column`, block: HOT } }).item.id);
  }
  // 3,500 done.
  for (let i = 0; i < 3500; i++) put('item.update', HUMAN, { item: items[i], status: 'done' });
  // One agent with 80 lined up, given by the person.
  for (let i = 3500; i < 3580; i++) put('item.update', HUMAN, { item: items[i], assignee: agents[0] });
  // 200 queued, one entry each.
  for (let i = 3600; i < 3800; i++) put('block.queue', HUMAN, { block: HOT, item: items[i] });
  // The crew works: reservations of the other blocks and edits, until the log is about 48,000 events long.
  const others = blocks.filter((b) => b !== HOT);
  agents.slice(1, 1 + others.length).forEach((id, i) => put('block.reserve', id, { block: others[i], take: [] }));
  while (events.length < 48_000) {
    const id = agents[Math.floor(rand() * agents.length)];
    const a = state.agents[id];
    const block = a.held[0];
    if (!block) {
      put('agent.status', id, { status: 'working', doing: 'Looking around' });
      continue;
    }
    const meta = board.blocks.find((b) => b.id === block);
    const file = String(meta.paths[0]).replace(/[{*].*$/, '').replace(/\/$/, '/x.js');
    put('touch', id, { files: [file], op: 'edit', add: 1 + Math.floor(rand() * 20), del: Math.floor(rand() * 8) });
  }
  // Everything ends a minute before `end`.
  const shift = end - 60_000 - events.at(-1).ts;
  for (const e of events) e.ts += shift;
  return { board, events };
}

export function writeStress(dir, opts) {
  const { board, events } = stressBoard(opts);
  const boardDir = path.join(dir, '.queuebox');
  fs.mkdirSync(path.join(boardDir, 'live'), { recursive: true });
  fs.writeFileSync(path.join(boardDir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
  fs.writeFileSync(path.join(boardDir, 'live', 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return { boardDir, events: events.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--keep')) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-stress-'));
    const { boardDir, events } = writeStress(dir, { end: Date.now() });
    process.env.QUEUEBOX_DIR = boardDir;
    process.env.QUEUEBOX_WAKE = 'off';
    delete process.env.QUEUEBOX_LIVE;
    const { serve } = await import('../server.js');
    const server = await serve({ port: 0, quiet: true });
    console.log(`stress: ${events} events at http://127.0.0.1:${server.address().port}/ (Ctrl+C stops it)`);
    const stop = () => {
      fs.rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else {
    const i = args.indexOf('--out');
    const dir = path.resolve(i >= 0 ? args[i + 1] : 'queuebox-stress');
    const { boardDir, events } = writeStress(dir);
    console.log(`stress: wrote ${events} events to ${boardDir}`);
  }
}
