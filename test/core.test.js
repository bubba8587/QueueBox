// The core: path matching, the fold, the reservation rules, the importer and the store's lock.
// `node --test test/`

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expandBraces, compileIndex, blockForPath } from '../core/glob.js';
import { HUMAN, reduce, apply, createState, makeEvent, checkEvent, alerts, presence, needsHuman, isStale, findBlock, itemCounts } from '../core/model.js';
import { lineCounts, testVerdict } from '../hooks/lines.js';
import { importChecklist } from '../adapters/markdown-checklist.js';
import { openStore, findBoardDir } from '../core/store.js';
import { draftBoard } from '../scripts/init.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Servers started here never ask the real Claude Code about sessions; the wake test turns it back on with a stand-in.
process.env.QUEUEBOX_WAKE = 'off';

const BOARD = {
  name: 'Test',
  staleAfterMin: 30,
  districts: [{ id: 'd', name: 'D' }],
  blocks: [
    { id: 'engine', name: 'Engine', district: 'd', paths: ['src/engine/', 'src/{pass,session}.ts'], keywords: ['compute'] },
    { id: 'pass', name: 'The pass', district: 'd', paths: ['src/engine/pass.ts'], keywords: ['pass'] },
    { id: 'tables', name: 'Tables', district: 'd', paths: ['src/**/*table*', 'README.md'], keywords: ['table', 'pivot'] },
  ],
  items: [],
};

let clock = 1_000_000;
const at = (min) => clock + min * 60_000;
function ev(state, type, by, payload, min) {
  const e = makeEvent(state, type, by, payload, at(min));
  return { e, why: checkEvent(state, e, at(min)) };
}
function run(state, type, by, payload, min) {
  const { e, why } = ev(state, type, by, payload, min);
  assert.equal(why, null, `${type} refused: ${why}`);
  apply(state, e);
  return e;
}

// A board in a fresh folder, outside any git checkout, with its own live log.
function tmpBoard(board = BOARD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-test-'));
  fs.mkdirSync(path.join(dir, '.queuebox'));
  fs.writeFileSync(path.join(dir, '.queuebox', 'board.json'), JSON.stringify(board));
  return { dir, boardDir: path.join(dir, '.queuebox'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const HOOK = path.join(HERE, '..', 'hooks', 'claude-code.js');
function hookEnv(dir) {
  // QUEUEBOX_SERVE=off: a SessionStart hook would otherwise start a detached board server for every test board.
  // A Stop hook that holds for work or an answer gives up after a moment here.
  const env = { ...process.env, QUEUEBOX_LIVE: path.join(dir, '.queuebox', 'live'), QUEUEBOX_SERVE: 'off', QUEUEBOX_ANSWER_WAIT_S: '0.3', QUEUEBOX_POLL_MS: '50' };
  delete env.QUEUEBOX_AGENT;
  delete env.QUEUEBOX_DIR;
  return env;
}

test('braces expand into separate patterns', () => {
  assert.deepEqual(expandBraces('a/{b,c}/{d,e}.ts'), ['a/b/d.ts', 'a/b/e.ts', 'a/c/d.ts', 'a/c/e.ts']);
  assert.deepEqual(expandBraces('x/{a,{b,c}}'), ['x/a', 'x/b', 'x/c']);
});

test('the most specific pattern claims a path', () => {
  const index = compileIndex(BOARD.blocks);
  assert.equal(blockForPath(index, 'src/engine/pass.ts'), 'pass');
  assert.equal(blockForPath(index, 'src/engine/dataflow.ts'), 'engine');
  assert.equal(blockForPath(index, 'src/session.ts'), 'engine');
  assert.equal(blockForPath(index, 'src/ui/TablePopup.tsx'), 'tables');
  assert.equal(blockForPath(index, './README.md'), 'tables');
  assert.equal(blockForPath(index, 'docs/other.md'), null);
});

test('a reservation refuses a second agent until the holder goes quiet', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 0);
  run(st, 'block.reserve', 'a1', { block: 'engine', intent: 'fix the pass' }, 1);
  assert.equal(st.blocks.engine.holder, 'a1');
  assert.deepEqual(st.agents.a1.held, ['engine']);
  assert.match(ev(st, 'block.reserve', 'a2', { block: 'engine' }, 2).why, /reserved by Heron/);
  assert.match(ev(st, 'block.release', 'a2', { block: 'engine' }, 2).why, /not you/);
  // Forty minutes of silence from Heron: Basalt may take over, and the history says so.
  const late = ev(st, 'block.reserve', 'a2', { block: 'engine' }, 45);
  assert.equal(late.why, null);
  apply(st, late.e);
  assert.equal(st.blocks.engine.holder, 'a2');
  assert.equal(st.blocks.engine.history.at(-1).outcome, 'taken');
  assert.deepEqual(st.agents.a1.held, []);
});

test('the human can give, take back and freeze blocks; agents respect it', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1' } }, 0);
  run(st, 'block.reserve', HUMAN, { block: 'tables', agent: 'a1' }, 1);
  assert.equal(st.blocks.tables.holder, 'a1');
  run(st, 'block.release', HUMAN, { block: 'tables', agent: 'a1', outcome: 'parked' }, 2);
  assert.equal(st.blocks.tables.holder, null);
  run(st, 'block.reserve', HUMAN, { block: 'tables' }, 3);
  assert.match(ev(st, 'block.reserve', 'a1', { block: 'tables' }, 4).why, /the human/);
  run(st, 'block.release', HUMAN, { block: 'tables' }, 5);
  run(st, 'block.freeze', HUMAN, { block: 'tables', on: true, note: 'release prep' }, 6);
  assert.match(ev(st, 'block.reserve', 'a1', { block: 'tables' }, 7).why, /frozen \(release prep\)/);
  run(st, 'block.freeze', HUMAN, { block: 'tables', on: false }, 8);
  run(st, 'block.reserve', 'a1', { block: 'tables' }, 9);
});

test('editing inside another agent\'s block raises a trespass alert', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 0);
  run(st, 'block.reserve', 'a1', { block: 'pass' }, 1);
  run(st, 'touch', 'a2', { files: ['src/engine/pass.ts'], op: 'edit' }, 2);
  const al = alerts(st, at(3));
  assert.equal(al[0].kind, 'trespass');
  assert.match(al[0].text, /Basalt edited pass\.ts in Heron's The pass/);
  assert.equal(st.blocks.pass.touches.length, 1);
});

test('a question makes its agent wait; the answer lands in its inbox', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1' } }, 0);
  const q = run(st, 'item.add', 'a1', { item: { kind: 'question', title: 'Excel or ours?', block: 'engine' } }, 1);
  assert.equal(q.item.id, 'Q1');
  assert.equal(presence(st, 'a1', at(2)), 'waiting');
  run(st, 'item.update', HUMAN, { item: 'Q1', answer: 'Follow Excel.' }, 3);
  assert.equal(st.items.Q1.status, 'done');
  assert.equal(presence(st, 'a1', at(3)), 'working');
  assert.match(st.agents.a1.inbox[0].text, /Follow Excel/);
  run(st, 'msg.read', 'a1', { ids: st.agents.a1.inbox.map((m) => m.id) }, 4);
  assert.equal(st.agents.a1.inbox.length, 0);
  const bug = run(st, 'item.add', 'a1', { item: { kind: 'bug', title: 'x', block: 'engine' } }, 5);
  assert.equal(bug.item.id, 'B1');
  assert.equal(itemCounts(st, 'engine').bug, 1);
});

test('leaving releases everything; replay folds to any moment', () => {
  const events = [];
  const st = createState(BOARD);
  events.push(run(st, 'agent.join', 'a1', { agent: { id: 'a1' } }, 0));
  events.push(run(st, 'block.reserve', 'a1', { block: 'engine' }, 1));
  events.push(run(st, 'block.reserve', 'a1', { block: 'tables' }, 2));
  events.push(run(st, 'agent.leave', 'a1', {}, 3));
  assert.equal(st.blocks.engine.holder, null);
  assert.equal(st.blocks.tables.history[0].outcome, 'parked');
  const past = reduce(BOARD, events, at(2));
  assert.deepEqual(past.agents.a1.held, ['engine', 'tables']);
});

test('findBlock takes ids, names and close misses', () => {
  const st = createState(BOARD);
  assert.equal(findBlock(st, 'Tables').block.id, 'tables');
  assert.equal(findBlock(st, 'pivot').block.id, 'tables');
  assert.match(findBlock(st, 'engin').error ?? '', /^$/);
  assert.match(findBlock(st, 'tablez').error, /Closest: tables/);
});

test('the checklist importer keeps titles, kinds, routes and stable ids', () => {
  const md = [
    '# Backlog',
    '## Tables (author)',
    '- [ ] **Pivot drops the year** when grouping by quarter.',
    '- [ ] A plain item about the compute pass; it has no bold title',
    '## From the audit (each needs the author\'s call)',
    '- [ ] **Should a blank table read as zero?** It changes the pass.',
    '- plain bullets are notes, not items',
  ].join('\n');
  const src = { file: 'backlog.md', prefix: 'BL', route: { Tables: 'tables', "needs the author's call": 'auto' }, kinds: [{ match: "needs the author's call", kind: 'decision' }] };
  const items = importChecklist(md, src, BOARD);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Pivot drops the year');
  assert.equal(items[0].block, 'tables');
  assert.equal(items[1].title, 'A plain item about the compute pass');
  assert.equal(items[2].kind, 'decision');
  assert.equal(items[2].block, 'tables');
  assert.equal(importChecklist(md, src, BOARD)[0].id, items[0].id);
  assert.match(items[0].id, /^BL-/);
});

test('the store refuses the second of two racing reservations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-test-'));
  fs.mkdirSync(path.join(dir, '.queuebox'));
  fs.writeFileSync(path.join(dir, '.queuebox', 'board.json'), JSON.stringify(BOARD));
  const prev = process.env.QUEUEBOX_LIVE;
  delete process.env.QUEUEBOX_LIVE;
  try {
    const store = openStore(path.join(dir, '.queuebox'));
    const snapshot = store.state();
    const a = makeEvent(snapshot, 'block.reserve', 'a1', { block: 'engine' });
    const b = makeEvent(snapshot, 'block.reserve', 'a2', { block: 'engine' });
    store.commit([a]);
    assert.throws(() => store.commit([b]), /reserved by/);
    assert.equal(store.readEvents().length, 1);
    assert.equal(store.state().blocks.engine.holder, 'a1');
  } finally {
    if (prev) process.env.QUEUEBOX_LIVE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook refuses an edit inside another agent\'s block and reserves a free one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-hook-'));
  fs.mkdirSync(path.join(dir, '.queuebox'));
  fs.writeFileSync(path.join(dir, '.queuebox', 'board.json'), JSON.stringify(BOARD));
  const hook = path.join(HERE, '..', 'hooks', 'claude-code.js');
  const env = { ...process.env, QUEUEBOX_LIVE: path.join(dir, '.queuebox', 'live'), QUEUEBOX_AGENT: '', QUEUEBOX_SERVE: 'off' };
  delete env.QUEUEBOX_AGENT;
  const call = (payload) => execFileSync('node', [hook], { input: JSON.stringify({ cwd: dir, ...payload }), env, encoding: 'utf8' });
  try {
    call({ hook_event_name: 'SessionStart', session_id: 'aaaa0000' });
    const reserve = call({ hook_event_name: 'PreToolUse', session_id: 'aaaa0000', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/engine/pass.ts') } });
    assert.equal(reserve, '');
    const after = call({ hook_event_name: 'PostToolUse', session_id: 'aaaa0000', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/engine/pass.ts') } });
    assert.match(JSON.parse(after).hookSpecificOutput.additionalContext, /reserved The pass/);
    const denied = JSON.parse(call({ hook_event_name: 'PreToolUse', session_id: 'bbbb0000', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/engine/pass.ts') } }));
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /reserved by/);
    const broken = execFileSync('node', [hook], { input: '{not json', env, encoding: 'utf8' });
    assert.equal(broken, '');
    call({ hook_event_name: 'Notification', session_id: 'aaaa0000', message: 'Claude needs your permission to use Bash' });
    const store = openStore(path.join(dir, '.queuebox'));
    let st = store.state();
    assert.equal(st.agents['cc-aaaa0000'].status, 'waiting');
    assert.equal(st.agents['cc-aaaa0000'].doing, 'Claude needs your permission to use Bash');
    call({ hook_event_name: 'Stop', session_id: 'aaaa0000' });
    st = store.state();
    assert.equal(st.agents['cc-aaaa0000'].status, 'review');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qb init drafts districts and splits big folders', () => {
  const files = [...Array.from({ length: 120 }, (_, i) => `src/a/f${i}.ts`), ...Array.from({ length: 30 }, (_, i) => `src/b/g${i}.ts`), 'src/index.ts', 'README.md', 'docs/x.md'];
  const board = draftBoard(files, 'demo');
  assert.deepEqual(board.districts.map((d) => d.id).sort(), ['docs', 'root', 'src']);
  const ids = board.blocks.map((b) => b.id);
  assert.ok(ids.includes('src-a') && ids.includes('src-b') && ids.includes('src-files'), ids.join(','));
  const index = compileIndex(board.blocks);
  for (const f of files) assert.ok(blockForPath(index, f), `${f} is unclaimed`);
});

test('the recorded session in test/fixtures folds cleanly, every event one the rules accept, in order', () => {
  const dir = path.join(HERE, 'fixtures');
  const board = JSON.parse(fs.readFileSync(path.join(dir, 'session.board.json'), 'utf8'));
  const events = fs.readFileSync(path.join(dir, 'session.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events.length > 500);
  const st = createState({ ...board, items: [] });
  for (const e of events) {
    assert.equal(checkEvent(st, e, e.ts), null, `${e.type} at ${e.ts}`);
    apply(st, e);
  }
  for (let i = 1; i < events.length; i++) assert.ok(events[i].ts > events[i - 1].ts);
  // It shows the parts of the page: several agents, reserved blocks, branches queued to merge, items.
  assert.ok(Object.values(st.agents).filter((a) => a.id !== HUMAN).length >= 4);
  assert.ok(Object.keys(st.merges).length > 0 && Object.keys(st.items).length > 0);
});

test('qb snapshot writes a standalone page of the session: the page, its modules, the board and the log', () => {
  const t = tmpBoard();
  try {
    const human = cliIn(t.dir);
    human('task', 'Fix the pass', '--block', 'engine');
    const out = path.join(t.dir, 'snap');
    const r = human('snapshot', '--out', out);
    assert.equal(r.code, 0, r.err);
    for (const f of ['index.html', 'board.json', 'events.json', 'ui/app.js', 'ui/source.js', 'core/model.js', 'core/glob.js', 'core/merges.js']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.ok(!fs.existsSync(path.join(out, 'ui', 'sim.js')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'events.json'), 'utf8')).length, 1);
    assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /<title>Test QueueBox<\/title>/);
  } finally {
    t.done();
  }
});
test('an agent waiting on the human keeps its blocks four times as long', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'block.reserve', 'a1', { block: 'engine' }, 1);
  run(st, 'agent.status', 'a1', { status: 'review', doing: 'Finished the turn' }, 2);
  // A finished turn isn't Needs you (B11), but it still keeps its blocks the longer time: it is waiting on the person.
  assert.equal(needsHuman(st, 'a1', at(3)), false);
  assert.equal(isStale(st, 'a1', at(60)), false);
  assert.match(ev(st, 'block.reserve', 'a2', { block: 'engine' }, 60).why, /reserved by Heron/);
  assert.equal(isStale(st, 'a1', at(125)), true);
  run(st, 'agent.status', 'a1', { status: 'waiting', doing: 'Claude needs your permission to use Bash' }, 126);
  assert.equal(needsHuman(st, 'a1', at(127)), true);
  run(st, 'agent.status', 'a1', { status: 'working' }, 128);
  assert.equal(needsHuman(st, 'a1', at(129)), false);
});

test('edits carry the lines they added and removed', () => {
  assert.deepEqual(lineCounts('Edit', { old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' }), { add: 2, del: 1 });
  assert.deepEqual(lineCounts('Write', { content: 'x\ny\nz' }), { add: 3, del: 0 });
  assert.deepEqual(lineCounts('Edit', {}, { structuredPatch: [{ lines: [' a', '-b', '+B', '+d'] }] }), { add: 2, del: 1 });
  // Lines match one to one, so repeated lines never make a count negative.
  assert.deepEqual(lineCounts('Edit', { old_string: '}\n}\n}\n}', new_string: '}' }), { add: 0, del: 3 });
  assert.deepEqual(lineCounts('Edit', { old_string: '}', new_string: '}\n}\n}' }), { add: 2, del: 0 });
  assert.deepEqual(lineCounts('MultiEdit', { edits: [{ old_string: 'x\nx', new_string: 'x' }, { old_string: '', new_string: 'y' }] }), { add: 1, del: 1 });
  const st = createState(BOARD);
  run(st, 'touch', 'a1', { files: ['src/engine/pass.ts'], op: 'edit', add: 12, del: 4 }, 1);
  run(st, 'touch', 'a1', { files: ['src/engine/x.ts'], op: 'edit', add: 3, del: 0 }, 2);
  assert.equal(st.agents.a1.added, 15);
  assert.equal(st.blocks.pass.added, 12);
  assert.equal(st.blocks.engine.removed, 0);
});

test('worktrees are read from git: conflicts, uncommitted work, identity', async () => {
  const { worktreeSnapshot } = await import('../core/worktrees.js');
  const { whoAmI } = await import('../core/identity.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-wt-'));
  const repo = path.join(dir, 'repo');
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.email', 't@t');
    sh(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'init');
    sh(repo, 'worktree', 'add', '-q', '-b', 'agent-a', path.join(dir, 'agent-a'));
    fs.writeFileSync(path.join(dir, 'agent-a', 'a.txt'), 'one\nTWO A\nthree\n');
    sh(path.join(dir, 'agent-a'), 'commit', '-qam', 'a');
    fs.writeFileSync(path.join(dir, 'agent-a', 'new.txt'), 'x\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO MAIN\nthree\n');
    sh(repo, 'commit', '-qam', 'main');
    const snap = await worktreeSnapshot(repo);
    assert.equal(snap.base, 'main');
    const a = snap.list.find((w) => w.name === 'agent-a');
    assert.deepEqual([a.ahead, a.behind, a.dirty], [1, 1, 1]);
    assert.deepEqual(a.files.sort(), ['a.txt', 'new.txt']);
    assert.deepEqual(a.conflicts, ['a.txt']);
    // Paths come back as written, accents and spaces included, renames under their new name.
    const agentA = path.join(dir, 'agent-a');
    fs.writeFileSync(path.join(agentA, 'données à voir.txt'), 'y\n');
    sh(agentA, 'mv', 'a.txt', 'é.txt');
    const moved = (await worktreeSnapshot(repo)).list.find((w) => w.name === 'agent-a');
    assert.deepEqual(moved.files.sort(), ['données à voir.txt', 'new.txt', 'é.txt']);
    assert.equal(moved.dirty, 3);
    sh(agentA, 'mv', 'é.txt', 'a.txt');
    fs.rmSync(path.join(agentA, 'données à voir.txt'));
    // A linked worktree folds the log over the main checkout's board, even when its branch has its own copy.
    fs.mkdirSync(path.join(repo, '.queuebox'));
    fs.writeFileSync(path.join(repo, '.queuebox', 'board.json'), JSON.stringify({ ...BOARD, blocks: [...BOARD.blocks, { id: 'mainonly', name: 'Main only', district: 'd', paths: ['m/'] }] }));
    fs.mkdirSync(path.join(agentA, '.queuebox'));
    fs.writeFileSync(path.join(agentA, '.queuebox', 'board.json'), JSON.stringify(BOARD));
    assert.equal(findBoardDir(agentA), path.join(repo, '.queuebox'));
    const prevLive = process.env.QUEUEBOX_LIVE;
    const prevDir = process.env.QUEUEBOX_DIR;
    delete process.env.QUEUEBOX_LIVE;
    delete process.env.QUEUEBOX_DIR;
    try {
      const wtStore = openStore(findBoardDir(agentA), { cwd: path.join(agentA, 'src') });
      assert.equal(wtStore.root, agentA);
      assert.equal(wtStore.home, repo);
      assert.equal(wtStore.live, path.join(repo, '.queuebox', 'live'));
      assert.ok(wtStore.state().blocks.mainonly);
      // `qb ready` refuses a branch with nothing committed ahead of the base.
      sh(repo, 'worktree', 'add', '-q', '-b', 'agent-b', path.join(dir, 'agent-b'));
      const env = { ...process.env };
      for (const k of ['QUEUEBOX_AGENT', 'QUEUEBOX_URL', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) delete env[k];
      const ready = spawnSync(process.execPath, [path.join(HERE, '..', 'cli.js'), 'ready'], { cwd: path.join(dir, 'agent-b'), env, encoding: 'utf8' });
      assert.equal(ready.status, 3, ready.stderr);
      assert.match(ready.stderr, /Nothing to merge: agent-b has no commits ahead of main/);
      const queued = spawnSync(process.execPath, [path.join(HERE, '..', 'cli.js'), 'ready'], { cwd: agentA, env, encoding: 'utf8' });
      assert.equal(queued.status, 0, queued.stderr);
      assert.equal(wtStore.state().merges['agent-a'].ahead, 1);
    } finally {
      if (prevLive !== undefined) process.env.QUEUEBOX_LIVE = prevLive;
      if (prevDir !== undefined) process.env.QUEUEBOX_DIR = prevDir;
    }
    const prev = { ...process.env };
    delete process.env.QUEUEBOX_AGENT;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    try {
      assert.equal(whoAmI(undefined, path.join(dir, 'agent-a')), 'wt-agent-a');
      assert.equal(whoAmI(undefined, repo), HUMAN);
    } finally {
      Object.assign(process.env, prev);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the merge queue checks conflicts, overlaps with branches ahead, and moves since ready', async () => {
  const { mergeChecks } = await import('../core/merges.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron', worktree: '/w/one' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt', worktree: '/w/two' } }, 0);
  run(st, 'test', 'a1', { ok: true, summary: 'ok' }, 1);
  run(st, 'test', 'a2', { ok: true, summary: 'ok' }, 1);
  run(st, 'merge.ready', 'a1', { worktree: 'one', branch: 'one', commit: 'aaa' }, 2);
  run(st, 'merge.ready', 'a2', { worktree: 'two', branch: 'two', commit: 'bbb' }, 3);
  const snap = {
    base: 'main',
    list: [
      { name: 'one', path: '/w/one', head: 'aaa111', ahead: 2, behind: 0, dirty: 0, files: ['src/engine/pass.ts'], conflicts: [] },
      { name: 'two', path: '/w/two', head: 'ccc', ahead: 1, behind: 3, dirty: 0, files: ['src/engine/pass.ts', 'README.md'], conflicts: [] },
    ],
  };
  const [first, second] = mergeChecks(st, snap, at(4));
  assert.equal(first.verdict, 'Ready');
  assert.equal(first.level, 'ok');
  // Sharing a file with a branch ahead is worth knowing, not a warning; being behind and moving since ready are.
  assert.equal(second.level, 'warn');
  assert.deepEqual(second.checks.map((c) => c.text).sort(), ['3 behind main', 'Moved since ready', 'Shares files with Heron']);
  assert.equal(second.checks.find((c) => c.text === 'Shares files with Heron').level, 'info');
  // A conflict the merge forecast finds between the two branches is danger.
  const clashing = mergeChecks(st, { ...snap, clashes: [{ a: 'one', b: 'two', files: ['src/engine/pass.ts'] }] }, at(4))[1];
  assert.equal(clashing.level, 'danger');
  assert.equal(clashing.verdict, 'Conflicts with Heron');
  snap.list[1].conflicts = ['README.md'];
  assert.equal(mergeChecks(st, snap, at(4))[1].verdict, 'Conflicts with main');
  run(st, 'merge.order', HUMAN, { worktree: 'two', pos: 0.5 }, 5);
  assert.equal(mergeChecks(st, snap, at(5))[0].entry.worktree, 'two');
  apply(st, makeEvent(st, 'merge.landed', 'system', { worktree: 'two' }, at(6)));
  assert.equal(st.merges.two.status, 'landed');
  assert.equal(st.agents.system, undefined);
});

test('a torn last line does not swallow the next event', () => {
  const t = tmpBoard();
  try {
    const store = openStore(t.boardDir);
    store.commit([makeEvent(store.state(), 'agent.join', 'a1', { agent: { id: 'a1' } })]);
    // A writer crashed halfway through its line.
    fs.appendFileSync(store.eventsPath, '{"id":"x","ts":1,"by":"a2","type":"block.res');
    store.commit([makeEvent(store.state(), 'block.reserve', 'a1', { block: 'engine' })]);
    const fresh = openStore(t.boardDir);
    assert.equal(fresh.state().blocks.engine.holder, 'a1');
    assert.deepEqual(fresh.readEvents().map((e) => e.type), ['agent.join', 'block.reserve']);
  } finally {
    t.done();
  }
});

test('the kept fold follows appends from elsewhere and starts over when the log is replaced', () => {
  const t = tmpBoard();
  try {
    const store = openStore(t.boardDir);
    store.commit([makeEvent(store.state(), 'agent.join', 'a1', { agent: { id: 'a1' } })]);
    const other = makeEvent(store.state(), 'block.reserve', 'a1', { block: 'engine' });
    fs.appendFileSync(store.eventsPath, `${JSON.stringify(other)}\n`);
    assert.equal(store.state().blocks.engine.holder, 'a1');
    // A longer log with other contents: the fold notices and folds it from the start.
    const lines = [makeEvent(store.state(), 'agent.join', 'a2', { agent: { id: 'a2' } }), makeEvent(store.state(), 'block.reserve', 'a2', { block: 'tables' }), makeEvent(store.state(), 'note', 'a2', { text: 'x'.repeat(200) })];
    fs.writeFileSync(store.eventsPath, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const st = store.state();
    assert.equal(st.agents.a1, undefined);
    assert.equal(st.blocks.tables.holder, 'a2');
    assert.equal(st.blocks.engine.holder, null);
  } finally {
    t.done();
  }
});

test('the lock is broken only when its holder is gone, and only its owner removes it', () => {
  const t = tmpBoard();
  try {
    const store = openStore(t.boardDir, { lockWaitMs: 300 });
    const join = () => makeEvent(store.state(), 'agent.join', 'a1', { agent: { id: 'a1' } });
    fs.mkdirSync(store.live, { recursive: true });
    const lock = (pid, nonce) => fs.writeFileSync(store.lockPath, JSON.stringify({ pid, host: os.hostname(), nonce, ts: Date.now() }));
    // A running holder keeps its lock, however long it has had it (up to a minute): the writer waits, then gives up.
    lock(process.pid, 'live');
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(store.lockPath, old, old);
    assert.throws(() => store.commit([join()]), /locked/);
    assert.equal(JSON.parse(fs.readFileSync(store.lockPath, 'utf8')).nonce, 'live');
    // A holder that died is taken over at once.
    lock(spawnSync(process.execPath, ['-e', '']).pid, 'dead');
    const t0 = Date.now();
    store.commit([join()]);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(fs.existsSync(store.lockPath), false);
    // A lock someone else holds by the time this writer finishes is theirs to remove.
    store.withLock(() => lock(process.pid, 'theirs'));
    assert.equal(JSON.parse(fs.readFileSync(store.lockPath, 'utf8')).nonce, 'theirs');
  } finally {
    t.done();
  }
});

test('the hook denies the agent that loses a reservation race, and a freeze stops the holder too', async () => {
  const t = tmpBoard();
  const env = hookEnv(t.dir);
  const call = (payload) => execFileSync('node', [HOOK], { input: JSON.stringify({ cwd: t.dir, ...payload }), env, encoding: 'utf8' });
  try {
    call({ hook_event_name: 'SessionStart', session_id: 'bbbb0000' });
    const store = openStore(t.boardDir);
    store.commit([makeEvent(store.state(), 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } })]);
    // Hold the lock, so the hook reads a free block and then waits to reserve it while Heron takes it.
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'test', ts: Date.now() }));
    const child = spawn('node', [HOOK], { env });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const exited = new Promise((resolve) => child.on('close', resolve));
    child.stdin.end(JSON.stringify({ cwd: t.dir, hook_event_name: 'PreToolUse', session_id: 'bbbb0000', tool_name: 'Edit', tool_input: { file_path: path.join(t.dir, 'src/engine/pass.ts') } }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    fs.appendFileSync(store.eventsPath, `${JSON.stringify(makeEvent(store.state(), 'block.reserve', 'a1', { block: 'pass' }))}\n`);
    fs.rmSync(store.lockPath);
    await exited;
    const lost = JSON.parse(out).hookSpecificOutput;
    assert.equal(lost.permissionDecision, 'deny');
    assert.match(lost.permissionDecisionReason, /taken before QueueBox could reserve it for you\. The pass is reserved by Heron/);
    assert.equal(store.state().blocks.pass.holder, 'a1');
    // Heron edits its own block freely, until the human freezes it.
    env.QUEUEBOX_AGENT = 'a1';
    assert.equal(call({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(t.dir, 'src/engine/pass.ts') } }), '');
    store.commit([makeEvent(store.state(), 'block.freeze', HUMAN, { block: 'pass', on: true, note: 'release prep' })]);
    const frozen = JSON.parse(call({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(t.dir, 'src/engine/pass.ts') } })).hookSpecificOutput;
    assert.equal(frozen.permissionDecision, 'deny');
    assert.match(frozen.permissionDecisionReason, /froze \(release prep\)/);
  } finally {
    t.done();
  }
});

test('a test run passes only if every result line does', () => {
  const cargo = (...results) => results.map((r) => `running 3 tests\ntest a ... ok\n\ntest result: ${r}; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n`).join('\n');
  const multi = `${cargo('ok. 3 passed; 0 failed', 'FAILED. 1 passed; 2 failed')}\nerror: test failed, to rerun pass \`--test nodes\``;
  assert.deepEqual(testVerdict({ stdout: multi }), { ok: false, summary: '2 failed, 4 passed' });
  assert.deepEqual(testVerdict({ stdout: cargo('ok. 3 passed; 0 failed', 'ok. 2 passed; 0 failed') }), { ok: true, summary: '5 passed' });
  assert.equal(testVerdict({ stdout: ' Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 40 passed (42)' }).ok, false);
  assert.deepEqual(testVerdict({ stdout: ' Test Files  3 passed (3)\n      Tests  42 passed (42)' }), { ok: true, summary: '42 passed' });
  assert.equal(testVerdict({ stdout: 'Tests:       1 failed, 2 passed, 3 total' }).ok, false);
  assert.equal(testVerdict({ stdout: '==== 3 passed in 0.12s ====' }).ok, true);
  assert.equal(testVerdict({ stdout: '=== 0 failed, 1 error ===\n=== 1 failed, 2 passed in 0.3s ===' }).ok, false);
  assert.equal(testVerdict({ stdout: '  3 passing (20ms)\n  1 failing' }).ok, false);
  assert.equal(testVerdict({ stdout: '--- FAIL: TestX (0.00s)\nFAIL\tpkg\t0.1s' }).ok, false);
  assert.deepEqual(testVerdict({ stdout: '# tests 4\n# pass 4\n# fail 0' }), { ok: true, summary: '4 passed' });
  assert.equal(testVerdict({ stdout: '# tests 4\n# pass 3\n# fail 1' }).ok, false);
  assert.equal(testVerdict({ stdout: 'nothing to see' }), null);
});

test('ids that reach an object\'s prototype, odd times and colors never get into the state', () => {
  const st = createState(BOARD);
  const proto = { id: 'p1', ts: at(1), by: '__proto__', type: 'agent.status', status: 'working', doing: 'x' };
  assert.match(checkEvent(st, proto, at(1)), /isn't a valid agent id/);
  for (const by of ['constructor', 'prototype', 'a b', 'x'.repeat(81)]) assert.ok(checkEvent(st, { ...proto, by }, at(1)), by);
  // A log edited by hand is folded without them.
  apply(st, proto);
  apply(st, { ...proto, by: 'a1', block: '__proto__', type: 'block.reserve' });
  assert.equal(({}).status, undefined);
  assert.equal(Object.keys(st.agents).join(), HUMAN);
  const join = makeEvent(st, 'agent.join', 'a1', { agent: { id: 'a1' } }, at(1));
  assert.match(checkEvent(st, { ...join, ts: '1"><b>' }, at(1)), /needs a time/);
  apply(st, { ...join, ts: '1"><b>' });
  assert.equal(st.agents.a1, undefined);
  assert.match(checkEvent(st, { ...join, ts: at(90) }, at(1)), /in the future/);
  assert.match(checkEvent(st, { ...join, agent: { id: 'a1', color: 'red;background:url(x)' } }, at(1)), /Colors are/);
  assert.equal(checkEvent(st, { ...join, agent: { id: 'a1', color: 'violet' } }, at(1)), null);
  // Enums are checked on the way in.
  assert.match(ev(st, 'block.reserve', 'a1', { block: 'engine', mode: 'steal' }, 1).why, /Modes are/);
  assert.match(ev(st, 'agent.status', 'a1', { status: 'asleep' }, 1).why, /Statuses are/);
  assert.match(ev(st, 'agent.leave', 'a1', { outcome: 'vanished' }, 1).why, /Outcomes are/);
  assert.match(ev(st, 'item.add', 'a1', { item: { kind: 'epic', title: 'x' } }, 1).why, /Kinds are/);
  assert.match(ev(st, 'block.explode', 'a1', {}, 1).why, /No event type/);
  // `qb --as __proto__` is refused before it writes anything.
  const t = tmpBoard();
  try {
    const env = { ...hookEnv(t.dir), QUEUEBOX_DIR: t.boardDir };
    const res = spawnSync(process.execPath, [path.join(HERE, '..', 'cli.js'), 'doing', 'x', '--as', '__proto__'], { env, encoding: 'utf8' });
    assert.equal(res.status, 3);
    assert.match(res.stderr, /isn't a valid agent id/);
  } finally {
    t.done();
  }
});

test('only the human forces a reservation or acts for another agent', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 0);
  run(st, 'block.reserve', HUMAN, { block: 'tables' }, 1);
  run(st, 'block.reserve', 'a1', { block: 'engine' }, 1);
  run(st, 'block.freeze', HUMAN, { block: 'pass', on: true }, 1);
  assert.match(ev(st, 'block.reserve', 'a2', { block: 'tables', force: true }, 2).why, /Only the human can force/);
  assert.match(ev(st, 'block.reserve', 'a2', { block: 'pass', force: true }, 2).why, /Only the human can force/);
  assert.match(ev(st, 'block.release', 'a2', { block: 'engine', agent: 'a1' }, 2).why, /Only the human acts for another agent/);
  assert.match(ev(st, 'agent.leave', 'a2', { agent: 'a1' }, 2).why, /Only the human acts for another agent/);
  // The same moves in a log edited by hand fold as the agent acting for itself.
  apply(st, makeEvent(st, 'block.release', 'a2', { block: 'engine', agent: 'a1', force: true }, at(3)));
  assert.equal(st.blocks.engine.holder, 'a1');
  apply(st, makeEvent(st, 'agent.leave', 'a2', { agent: 'a1' }, at(3)));
  assert.equal(st.agents.a1.leftAt, 0);
  assert.deepEqual(st.agents.a1.held, ['engine']);
  // The human can.
  run(st, 'block.release', HUMAN, { block: 'engine', agent: 'a1', outcome: 'parked' }, 4);
  run(st, 'block.reserve', HUMAN, { block: 'pass', agent: 'a1' }, 5);
  assert.equal(st.blocks.pass.holder, 'a1');
});

test('a branch with nothing ahead of the base is never queued, and a quiet agent gives up its color', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1' } }, 0);
  assert.match(ev(st, 'merge.ready', 'a1', { worktree: 'one', commit: 'aaa', ahead: 0 }, 1).why, /Nothing to merge/);
  run(st, 'merge.ready', 'a1', { worktree: 'one', commit: 'aaa', ahead: 2 }, 1);
  assert.equal(st.merges.one.ahead, 2);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2' } }, 1);
  const first = st.agents.a1.color;
  assert.notEqual(st.agents.a2.color, first);
  // a1's session crashed without leaving; seven hours on, a newcomer may wear its color.
  run(st, 'agent.status', 'a2', { status: 'working' }, 7 * 60);
  run(st, 'agent.join', 'a3', { agent: { id: 'a3' } }, 7 * 60 + 1);
  assert.equal(st.agents.a3.color, first);
});

test('the board carries its base branch through', async () => {
  const { resolveBoard } = await import('../core/resolve.js');
  const b = resolveBoard({ root: os.tmpdir(), readConfig: () => ({ ...BOARD, base: 'develop' }) }, { items: false });
  assert.equal(b.base, 'develop');
});

test('the git watcher primes a new worktree and leaves out what HEAD moved', async () => {
  const { gitEdits } = await import('../server.js');
  let times = { 'a.ts': 1, 'b.ts': 1 };
  const wt = (head) => ({ name: 'w', path: '/w', main: false, head, files: ['a.ts', 'b.ts'] });
  const opts = { mtime: (dir, f) => times[f] ?? -1, headDiff: async () => new Set(['b.ts']) };
  let r = await gitEdits(new Map(), [wt('h1')], opts);
  assert.deepEqual(r.changes, []);
  times['a.ts'] = 2;
  r = await gitEdits(r.next, [wt('h1')], opts);
  assert.deepEqual(r.changes.map((c) => c.files), [['a.ts']]);
  // A checkout rewrote b.ts; a.ts was edited by hand.
  times = { 'a.ts': 3, 'b.ts': 3 };
  r = await gitEdits(r.next, [wt('h2')], opts);
  assert.deepEqual(r.changes.map((c) => c.files), [['a.ts']]);
  // When git can't say what moved, nothing is reported for that poll.
  times = { 'a.ts': 4, 'b.ts': 4 };
  r = await gitEdits(r.next, [wt('h3')], { ...opts, headDiff: async () => null });
  assert.deepEqual(r.changes, []);
});

test('the server stamps what it is sent, answers only on localhost, and resumes its stream', async () => {
  const t = tmpBoard();
  const saved = { ...process.env };
  process.env.QUEUEBOX_DIR = t.boardDir;
  for (const k of ['QUEUEBOX_LIVE', 'QUEUEBOX_TOKEN']) delete process.env[k];
  const { serve } = await import('../server.js');
  let server;
  try {
    await assert.rejects(serve({ host: '0.0.0.0', port: 0, quiet: true }), /QUEUEBOX_TOKEN/);
    server = await serve({ port: 0, quiet: true });
    const port = server.address().port;
    const req = (method, p, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'x-queuebox': '1', 'content-type': 'application/json', ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
    const posted = await req('POST', '/api/commit', { body: { events: [{ id: 'mine', ts: '"><img src=x onerror=alert(1)>', by: 'a1', type: 'agent.join', agent: { id: 'a1' } }, { id: 'later', ts: 9e15, by: 'a1', type: 'block.reserve', block: 'engine' }] } });
    assert.equal(posted.status, 200, posted.body);
    const accepted = JSON.parse(posted.body).accepted;
    for (const e of accepted) {
      assert.equal(typeof e.ts, 'number');
      assert.ok(Math.abs(e.ts - Date.now()) < 60_000);
      assert.ok(!['mine', 'later'].includes(e.id));
      assert.equal(e.by, 'a1');
    }
    assert.equal((await req('POST', '/api/commit', { body: { events: [{ by: '__proto__', type: 'agent.status', status: 'working' }] } })).status, 409);
    assert.equal((await req('GET', '/api/board', { headers: { host: 'evil.example:4477' } })).status, 403);
    assert.equal((await req('GET', '/', { headers: { host: 'localhost.evil.example' } })).status, 403);
    const log = await req('GET', '/api/events', { headers: { host: `localhost:${port}` } });
    assert.equal(log.status, 200);
    const offset = Number(log.headers['x-queuebox-offset']);
    assert.equal(offset, fs.statSync(path.join(t.boardDir, 'live', 'events.jsonl')).size);
    // A page that reconnects with the last offset it saw gets what came after, with the new offset as the id.
    const before = JSON.parse(log.body);
    await req('POST', '/api/commit', { body: { events: [{ by: 'a1', type: 'note', text: 'after the read' }] } });
    const chunk = await new Promise((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { 'last-event-id': String(offset) } }, (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (/event: events\n/.test(data) && data.endsWith('\n\n')) {
            r.destroy();
            resolve(data);
          }
        });
      });
      r.on('error', reject);
    });
    const block = chunk.split('\n\n').find((b) => b.includes('event: events'));
    const sent = JSON.parse(/^data: (.*)$/m.exec(block)[1]);
    assert.deepEqual(sent.map((e) => e.text), ['after the read']);
    assert.equal(Number(/^id: (\d+)$/m.exec(block)[1]), fs.statSync(path.join(t.boardDir, 'live', 'events.jsonl')).size);
    assert.equal(before.length, 2);
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    t.done();
  }
});

test('a second review: remote writes, a bad agent id, long worktree names, old queue entries, every loopback', async () => {
  // A board served elsewhere (QUEUEBOX_URL): reading and writing fold what came back.
  const { remoteStore } = await import('../core/store.js');
  const accepted = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/board')) return res.end(JSON.stringify(BOARD));
      if (req.url.startsWith('/api/events')) return res.end('[]');
      const list = JSON.parse(body).events.map((e, i) => ({ ...e, id: `e${i}`, ts: Date.now() }));
      accepted.push(...list);
      return res.end(JSON.stringify({ accepted: list }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const remote = remoteStore(`http://127.0.0.1:${srv.address().port}`);
    assert.ok((await remote.state()).blocks);
    const out = await remote.commit([{ type: 'agent.join', by: 'agent-1', agent: { id: 'agent-1' } }]);
    assert.ok(out.state.agents['agent-1']);
  } finally {
    srv.close();
  }

  // An id the board refuses never blocks an edit: the hooks fail open.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-badid-'));
  fs.mkdirSync(path.join(dir, '.queuebox'));
  fs.writeFileSync(path.join(dir, '.queuebox', 'board.json'), JSON.stringify(BOARD));
  try {
    const hook = path.join(HERE, '..', 'hooks', 'claude-code.js');
    const env = { ...process.env, QUEUEBOX_LIVE: path.join(dir, '.queuebox', 'live'), QUEUEBOX_AGENT: 'agent 1', QUEUEBOX_SERVE: 'off' };
    const out = execFileSync('node', [hook], { input: JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', session_id: 'cccc0000', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/engine/pass.ts') } }), env, encoding: 'utf8' });
    assert.equal(out, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const { worktreeAgentId } = await import('../core/model.js');
  const long = worktreeAgentId('x'.repeat(200));
  assert.ok(long.length <= 80 && long.startsWith('wt-'));
  const state = reduce(BOARD, []);
  assert.equal(checkEvent(state, makeEvent(state, 'agent.join', long, { agent: { id: long } })), null);

  const { isLoopbackHostHeader } = await import('../server.js');
  assert.ok(isLoopbackHostHeader('127.0.0.2:4477'));
  assert.ok(isLoopbackHostHeader('localhost:4477'));
  assert.ok(!isLoopbackHostHeader('attacker.example'));
});

test('a lock put back after its owner finished is not left behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-race-'));
  fs.mkdirSync(path.join(dir, '.queuebox'));
  fs.writeFileSync(path.join(dir, '.queuebox', 'board.json'), JSON.stringify(BOARD));
  const prev = process.env.QUEUEBOX_LIVE;
  process.env.QUEUEBOX_LIVE = path.join(dir, '.queuebox', 'live');
  const rename = fs.renameSync;
  try {
    const store = openStore(path.join(dir, '.queuebox'), { lockWaitMs: 500 });
    fs.mkdirSync(path.dirname(store.lockPath), { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: dead, host: os.hostname(), nonce: 'dead', ts: Date.now() }));
    // The breaker read the dead writer's lock; before it moves it aside a live writer has taken a fresh one, and
    // that writer finishes while its lock is aside (its release finds nothing and leaves its done mark).
    fs.renameSync = (from, to) => {
      if (from === store.lockPath) {
        fs.renameSync = rename;
        fs.writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'live', ts: Date.now() }));
        rename(from, to);
        fs.writeFileSync(`${store.lockPath}.done-live`, '');
        return;
      }
      rename(from, to);
    };
    assert.equal(store.withLock(() => 'took it'), 'took it');
    assert.ok(!fs.existsSync(store.lockPath));
    assert.ok(!fs.existsSync(`${store.lockPath}.done-live`));
  } finally {
    fs.renameSync = rename;
    if (prev === undefined) delete process.env.QUEUEBOX_LIVE;
    else process.env.QUEUEBOX_LIVE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 3e71bc7: several agents in one worktree, develop as the base, items queued one by one

test('a worktree holds several agents: labels, blocks and git-seen edits follow each one', async () => {
  const { agentsInWorktree, agentsInBlock, worktreeLabel, mergeChecks } = await import('../core/merges.js');
  const { lastEditor } = await import('../server.js');
  const st = createState(BOARD);
  const wt = { name: 'one', path: '/w/one' };
  assert.deepEqual(agentsInWorktree(st, wt), []);
  assert.equal(worktreeLabel(st, wt), 'one');
  // The watcher's stand-in speaks for the worktree only until a real agent joins from it.
  run(st, 'agent.join', 'wt-one', { agent: { id: 'wt-one', name: 'one', kind: 'worktree', worktree: '/w/one' } }, 0);
  assert.deepEqual(agentsInWorktree(st, wt), ['wt-one']);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron', worktree: '/w/one' } }, 1);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt', worktree: 'one' } }, 2);
  run(st, 'agent.join', 'a3', { agent: { id: 'a3', name: 'Elsewhere', worktree: '/w/two' } }, 2);
  // Most recently seen first; the worktree is matched by path or by name.
  assert.deepEqual(agentsInWorktree(st, wt), ['a2', 'a1']);
  run(st, 'agent.status', 'a1', { status: 'working' }, 3);
  assert.deepEqual(agentsInWorktree(st, wt), ['a1', 'a2']);
  assert.equal(worktreeLabel(st, wt), 'Heron, Basalt');
  // Nobody's own edits in a block yet: git saw the change, so it is all of theirs.
  assert.deepEqual(agentsInBlock(st, wt, 'tables'), ['a1', 'a2']);
  run(st, 'touch', 'a2', { files: ['README.md'], op: 'edit' }, 4);
  run(st, 'touch', 'a1', { files: ['README.md'], op: 'read' }, 5);
  assert.deepEqual(agentsInBlock(st, wt, 'tables'), ['a2']);
  // A worktree the server already annotated is taken at its word; one agent alone is always the one.
  assert.deepEqual(agentsInBlock(st, { ...wt, agents: ['a1'] }, 'tables'), ['a1']);
  assert.equal(worktreeLabel(st, { ...wt, agents: ['a2'] }), 'Basalt');
  // Git-seen edits go to whoever here last edited that file, reads don't count, else nobody.
  run(st, 'touch', 'a1', { files: ['src/engine/pass.ts'], op: 'edit' }, 6);
  run(st, 'touch', 'a2', { files: ['src/engine/pass.ts'], op: 'edit' }, 7);
  assert.equal(lastEditor(st, ['a1', 'a2'], 'src/engine/pass.ts'), 'a2');
  assert.equal(lastEditor(st, ['a1', 'a2'], 'README.md'), 'a2');
  assert.equal(lastEditor(st, ['a1'], 'README.md'), null);
  assert.equal(lastEditor(st, ['a1', 'a2'], 'src/session.ts'), null);
  // Any agent in the worktree failing its last run fails the branch.
  run(st, 'test', 'a1', { ok: true, summary: 'ok' }, 8);
  run(st, 'test', 'a2', { ok: false, summary: '1 failed' }, 8);
  run(st, 'merge.ready', 'a1', { worktree: 'one', branch: 'one', commit: 'aaa', ahead: 1 }, 9);
  const [check] = mergeChecks(st, { base: 'main', list: [{ ...wt, head: 'aaa', ahead: 1, behind: 0, dirty: 0, files: [], conflicts: [] }] }, at(10));
  assert.equal(check.checks.find((c) => c.text === 'Tests fail').detail, '1 failed');
  // One who leaves is out of the list; when the last real agent goes the stand-in is back.
  run(st, 'agent.leave', 'a2', {}, 11);
  assert.deepEqual(agentsInWorktree(st, wt), ['a1']);
  run(st, 'agent.leave', 'a1', {}, 12);
  assert.deepEqual(agentsInWorktree(st, wt), ['wt-one']);
});

test('develop is the base where there is one; the checkout with the base out is measured against its upstream', async () => {
  const { baseRef, worktreeSnapshot } = await import('../core/worktrees.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-base-'));
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const commitFile = (cwd, file, text) => {
    fs.writeFileSync(path.join(cwd, file), text);
    sh(cwd, 'add', '.');
    sh(cwd, 'commit', '-qm', file);
  };
  try {
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.email', 't@t');
    sh(repo, 'config', 'user.name', 't');
    commitFile(repo, 'a.txt', 'a\n');
    assert.deepEqual(await baseRef(repo), { name: 'main', ref: 'main' });
    sh(repo, 'branch', 'develop');
    assert.deepEqual(await baseRef(repo), { name: 'develop', ref: 'develop' });
    // The board's own base still wins.
    assert.deepEqual(await baseRef(repo, 'main'), { name: 'main', ref: 'main' });
    // The main checkout has develop out with no upstream: nothing is ahead of itself.
    sh(repo, 'checkout', '-q', 'develop');
    commitFile(repo, 'b.txt', 'b\n');
    let main = (await worktreeSnapshot(repo)).list.find((w) => w.main);
    assert.equal(main.branch, 'develop');
    assert.deepEqual([main.ahead, main.behind], [0, 0]);
    // Pushed, then two commits that aren't: those two are ahead of origin/develop, and only their files count.
    sh(dir, 'init', '-q', '--bare', remote);
    sh(repo, 'remote', 'add', 'origin', remote);
    sh(repo, 'push', '-q', '-u', 'origin', 'develop');
    commitFile(repo, 'c.txt', 'c\n');
    commitFile(repo, 'd.txt', 'd\n');
    const snap = await worktreeSnapshot(repo);
    assert.equal(snap.base, 'develop');
    main = snap.list.find((w) => w.main);
    assert.deepEqual([main.ahead, main.behind], [2, 0]);
    assert.deepEqual(main.files.sort(), ['c.txt', 'd.txt']);
    // A linked worktree on its own branch is still measured against develop.
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature', path.join(dir, 'feature'), 'main');
    const feature = (await worktreeSnapshot(repo)).list.find((w) => w.name === 'feature');
    assert.deepEqual([feature.ahead, feature.behind], [0, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each queued item is its own entry with its own place, and goes to one taker (B13)', async () => {
  const { queue, queueEntries, nextFor, queuedIntent, describeEvent } = await import('../core/model.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 0);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Fix the pass', block: 'engine' } }, 0);
  run(st, 'item.add', HUMAN, { item: { kind: 'bug', title: 'Totals drift', block: 'engine' } }, 0);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Pivot', block: 'tables' } }, 0);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Loose end' } }, 0);
  // The item checks: it exists, it belongs to the block, it isn't finished.
  assert.match(ev(st, 'block.queue', HUMAN, { block: 'engine', item: 'T9' }, 1).why, /No item T9/);
  assert.match(ev(st, 'block.queue', HUMAN, { block: 'engine', item: 'T2' }, 1).why, /T2 belongs to tables, not engine/);
  assert.match(ev(st, 'block.queue', HUMAN, { block: 'engine', item: 'T3' }, 1).why, /belongs to no block/);
  assert.match(ev(st, 'block.queue', HUMAN, { block: 'nowhere', item: 'T1' }, 1).why, /No block named/);
  run(st, 'block.queue', HUMAN, { block: 'tables', note: 'after lunch' }, 1);
  const e = run(st, 'block.queue', HUMAN, { block: 'engine', item: 'T1' }, 2);
  assert.match(describeEvent(st, e), /queued T1 in .*: Fix the pass/);
  run(st, 'block.queue', HUMAN, { block: 'engine', item: 'B1' }, 3);
  run(st, 'block.queue', HUMAN, { block: 'engine', item: 'B1' }, 3);
  // Three entries, each with its own place; the page's per-block summary still sums them up.
  assert.deepEqual(queueEntries(st).map((q) => q.item || q.block), ['tables', 'T1', 'B1']);
  assert.deepEqual(queue(st).map((b) => b.id), ['tables', 'engine']);
  assert.deepEqual(st.blocks.engine.queued.items, ['T1', 'B1']);
  assert.equal(queuedIntent(st, st.blocks.engine.queued), 'Fix the pass; Totals drift');
  // Two takers: one item each, never the same one, never the same block in one pass.
  assert.deepEqual(nextFor(st, 'a1'), { kind: 'block', block: 'tables', pos: st.blocks.tables.whole.pos, note: 'after lunch', key: 'block:tables' });
  const first = nextFor(st, 'a1', new Set(['block:tables']));
  assert.equal(first.item, 'T1');
  assert.equal(nextFor(st, 'a2', new Set(['block:tables', 'T1'])), null);
  // Heron takes T1 with Engine; B1 stays queued, Engine is Heron's, so only Heron can take B1 next.
  run(st, 'block.reserve', 'a1', { block: 'engine', take: ['T1'] }, 4);
  assert.deepEqual([st.items.T1.status, st.items.T1.assignee, st.items.T1.queued], ['doing', 'a1', null]);
  assert.deepEqual(st.blocks.engine.queued.items, ['B1']);
  assert.equal(nextFor(st, 'a2', new Set(['block:tables'])), null);
  assert.equal(nextFor(st, 'a1', new Set(['block:tables'])).item, 'B1');
  // A plain reservation (take: []) leaves the queued items in line; it takes the whole-block entry.
  run(st, 'block.reserve', 'a2', { block: 'tables', take: [] }, 5);
  assert.equal(st.blocks.tables.whole, null);
  run(st, 'block.queue', HUMAN, { block: 'tables', item: 'T2' }, 6);
  assert.deepEqual(st.blocks.tables.queued.items, ['T2']);
  // Taken up or given: off the queue. Taking one off leaves the rest.
  run(st, 'item.update', 'a1', { item: 'B1', status: 'doing', assignee: 'a1' }, 7);
  assert.equal(st.blocks.engine.queued, null);
  run(st, 'block.unqueue', HUMAN, { block: 'tables', item: 'T2' }, 8);
  assert.equal(st.blocks.tables.queued, null);
  // A reservation written before B13 (no take) takes every item queued in its block, as it did then.
  run(st, 'block.release', 'a1', { block: 'engine' }, 9);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'A', block: 'engine' } }, 9);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'B', block: 'engine' } }, 9);
  run(st, 'block.queue', HUMAN, { block: 'engine', item: 'T4' }, 9);
  run(st, 'block.queue', HUMAN, { block: 'engine', item: 'T5' }, 9);
  run(st, 'block.reserve', 'a2', { block: 'engine' }, 10);
  assert.deepEqual([st.items.T4.assignee, st.items.T5.assignee], ['a2', 'a2']);
  // A finished item can't be queued.
  run(st, 'item.update', 'a1', { item: 'T1', status: 'done' }, 11);
  assert.match(ev(st, 'block.queue', HUMAN, { block: 'engine', item: 'T1' }, 11).why, /T1 is done/);
});
function cliIn(dir, me) {
  const env = { ...process.env, QUEUEBOX_LIVE: path.join(dir, '.queuebox', 'live'), QUEUEBOX_SERVE: 'off' };
  for (const k of ['QUEUEBOX_AGENT', 'QUEUEBOX_URL', 'QUEUEBOX_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) delete env[k];
  if (me) env.QUEUEBOX_AGENT = me;
  return (...args) => {
    const r = spawnSync(process.execPath, [path.join(HERE, '..', 'cli.js'), ...args], { cwd: dir, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
}

test('qb queue takes an item id, and qb next hands out one entry at a time (B13)', () => {
  const t = tmpBoard();
  try {
    const human = cliIn(t.dir);
    const a1 = cliIn(t.dir, 'a1');
    const a2 = cliIn(t.dir, 'a2');
    assert.match(human('task', 'Fix the pass', '--block', 'engine').out, /Filed T1 in Engine/);
    human('bug', 'Totals drift', '--block', 'engine', '--detail', 'off by one after a pivot');
    human('task', 'Pivot', '--block', 'tables');
    human('task', 'Loose end');
    assert.match(human('queue', 'T1').out, /Queued T1 \(Fix the pass\) with Engine/);
    assert.match(human('queue', 'B1').out, /Queued B1/);
    human('queue', 'T2');
    // An item with no block queues as it is (B31); it's taken off again so the rest of this test reads as before.
    assert.match(human('queue', 'T3').out, /Queued T3 \(.*\), with no block yet/);
    assert.match(human('unqueue', 'T3').out, /T3 is off the queue/);
    assert.equal(human('queue').out.trim(), '#1 T1 Fix the pass, in Engine\n#2 B1 Totals drift, in Engine\n#3 T2 Pivot, in Tables');
    // The first taker gets T1 and Engine; the second can't take B1 (Engine is the first's), so it gets T2.
    const one = a1('next');
    assert.equal(one.code, 0, one.err);
    assert.match(one.out, /Took T1 from the queue; Engine \(engine\) is reserved for you\. It's yours, marked doing .*:\n  T1  task  Fix the pass/);
    assert.match(a2('next').out, /Took T2 from the queue; Tables \(tables\) is reserved for you/);
    let st = openStore(t.boardDir).state();
    assert.deepEqual([st.blocks.engine.holder, st.items.T1.assignee, st.items.B1.assignee, st.items.B1.queued !== null], ['a1', 'a1', undefined, true]);
    assert.equal(st.agents.a1.task, 'T1: Fix the pass');
    assert.match(a2('next').out, /Nothing in the queue you can take/);
    // The first takes B1 next, in the block it already has.
    assert.match(a1('next').out, /Took B1 from the queue \(in Engine, yours already\)[\s\S]*off by one after a pivot/);
    st = openStore(t.boardDir).state();
    assert.deepEqual([st.items.B1.status, st.items.B1.assignee], ['doing', 'a1']);
    assert.match(a1('next').out, /Nothing in the queue/);
  } finally {
    t.done();
  }
});
test('filing, moving an item, messaging and reading the inbox never put an agent on the board', () => {
  const st = createState(BOARD);
  // A session in another repository files a task and messages an agent here: it has a name, not a seat.
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'item.add', 'cc-far', { item: { kind: 'task', title: 'From elsewhere', block: 'engine' } }, 1);
  run(st, 'msg', 'cc-far', { to: 'a1', text: 'T1 is yours' }, 1);
  run(st, 'item.update', 'cc-far', { item: 'T1', status: 'blocked' }, 2);
  const far = st.agents['cc-far'];
  assert.ok(far.leftAt && !far.joinedAt);
  assert.equal(presence(st, 'cc-far', at(2)), 'gone');
  assert.equal(st.items.T1.by, 'cc-far');
  // Messages still reach it, and reading them doesn't seat it either.
  run(st, 'msg', 'a1', { to: 'cc-far', text: 'on it' }, 3);
  run(st, 'msg.read', 'cc-far', { ids: far.inbox.map((m) => m.id) }, 3);
  assert.equal(presence(st, 'cc-far', at(3)), 'gone');
  // An agent that left and then read its inbox stays gone (it used to come back, status done).
  run(st, 'msg', HUMAN, { to: 'a1', text: 'bye' }, 4);
  run(st, 'agent.leave', 'a1', {}, 5);
  run(st, 'msg.read', 'a1', { ids: st.agents.a1.inbox.map((m) => m.id) }, 5);
  assert.equal(presence(st, 'a1', at(5)), 'gone');
  // Asking is working here: the asker waits on the answer. So is any real work.
  run(st, 'item.add', 'cc-ask', { item: { kind: 'question', title: 'Which way?', block: 'engine' } }, 6);
  assert.equal(presence(st, 'cc-ask', at(6)), 'waiting');
  run(st, 'agent.status', 'cc-far', { status: 'working', doing: 'here now' }, 7);
  assert.equal(presence(st, 'cc-far', at(7)), 'working');
  assert.ok(st.agents['cc-far'].joinedAt);
});

test('qb task, bug, item and msg from a session that hasn\'t joined leave it off the board; ask and doing join', () => {
  const t = tmpBoard();
  try {
    const far = cliIn(t.dir, 'cc-far');
    const here = cliIn(t.dir, 'cc-here');
    here('doing', 'working on the pass');
    far('task', 'From elsewhere', '--block', 'engine');
    far('bug', 'Broken', '--block', 'engine');
    far('item', 'T1', 'blocked');
    far('msg', 'cc-here', 'hello');
    let st = openStore(t.boardDir).state();
    assert.equal(st.agents['cc-far'].leftAt > 0, true);
    assert.doesNotMatch(far().out, /cc-far|\(you\)/);
    assert.equal(here('inbox').out.trim().endsWith('hello'), true);
    // Unqueueing an item that isn't queued says so instead of claiming it.
    assert.match(cliIn(t.dir)('unqueue', 'T1').err, /T1 isn't on the queue/);
    far('ask', 'Which way?', '--block', 'engine');
    st = openStore(t.boardDir).state();
    assert.equal(presence(st, 'cc-far', Date.now()), 'waiting');
    const events = openStore(t.boardDir).readEvents().filter((e) => e.type === 'agent.join').map((e) => e.by);
    assert.deepEqual(events, ['cc-here', 'cc-far']);
  } finally {
    t.done();
  }
});

test('the hooks tag what an agent is doing this second, and the tag never repeats its state', async () => {
  const { activityOf } = await import('../core/model.js');
  const { hookConfig } = await import('../hooks/install.js');
  const t = tmpBoard();
  const call = (payload) => execFileSync('node', [HOOK], { input: JSON.stringify({ cwd: t.dir, session_id: 'cccc0000', ...payload }), env: { ...hookEnv(t.dir), QUEUEBOX_SERVE: 'off' }, encoding: 'utf8' });
  const store = openStore(t.boardDir);
  const tag = () => activityOf(store.state(), 'cc-cccc0000', Date.now());
  const pre = (tool_name, tool_input = {}) => call({ hook_event_name: 'PreToolUse', tool_name, tool_input });
  try {
    call({ hook_event_name: 'SessionStart' });
    assert.equal(tag(), '');
    call({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the pass' });
    assert.equal(tag(), 'thinking');
    pre('Read', { file_path: path.join(t.dir, 'README.md') });
    assert.equal(tag(), 'reading');
    // A run of reads is one event.
    const before = store.readEvents().length;
    pre('Grep', { pattern: 'x' });
    pre('Glob', { pattern: '*' });
    assert.equal(store.readEvents().length, before);
    pre('Edit', { file_path: path.join(t.dir, 'src/engine/pass.ts') });
    call({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(t.dir, 'src/engine/pass.ts') } });
    assert.equal(tag(), 'editing');
    pre('Bash', { command: 'node --test test/' });
    assert.equal(tag(), 'testing');
    pre('Bash', { command: 'git status' });
    assert.equal(tag(), 'running');
    pre('WebSearch', { query: 'q' });
    assert.equal(tag(), 'researching');
    pre('Agent', { prompt: 'p' });
    assert.equal(tag(), 'delegating');
    // A tool the hooks don't name leaves the tag alone.
    pre('mcp__thing__do', {});
    assert.equal(tag(), 'delegating');
    // Claude Code's idle notice only says the turn is over: no tag, and not Needs you (B11). A permission prompt is.
    call({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
    assert.equal(presence(store.state(), 'cc-cccc0000', Date.now()), 'review');
    assert.equal(needsHuman(store.state(), 'cc-cccc0000', Date.now()), false);
    assert.equal(tag(), '');
    call({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
    assert.equal(tag(), 'permission');
    // Approved: the next tool puts it back to work.
    pre('Bash', { command: 'ls' });
    assert.equal(presence(store.state(), 'cc-cccc0000', Date.now()), 'working');
    assert.equal(tag(), 'running');
    // An open question it asked is what it waits on.
    const ask = cliIn(t.dir, 'cc-cccc0000');
    ask('ask', 'Which way?', '--block', 'engine');
    assert.equal(tag(), 'question');
    ask('item', 'Q1', 'done');
    call({ hook_event_name: 'Stop' });
    assert.equal(tag(), '');
    assert.equal(store.state().agents['cc-cccc0000'].activity, null);
    // qb shows the tag in a column of its own, only while someone has one.
    call({ hook_event_name: 'UserPromptSubmit', prompt: 'again' });
    assert.match(ask('agents').out, /working\s+thinking\s+/);
    assert.match(ask().out, /\(you\)\s+working\s+thinking\s+pass/);
    // The other tools reach the hook too.
    assert.match(hookConfig().hooks.PreToolUse[0].matcher, /Read\|Grep\|Glob\|Bash\|WebFetch\|WebSearch\|Agent\|Task/);
    // A tag outside the list is refused.
    assert.match(checkEvent(store.state(), makeEvent(store.state(), 'agent.status', 'cc-cccc0000', { activity: 'dancing' })), /Activities are/);
  } finally {
    t.done();
  }
});

// ---------------------------------------------------------------------------------------------
// Reshaping the board (core/board-ops.js, store.writeBoard, POST /api/board, qb board)

const SHAPE = {
  name: 'Shape',
  staleAfterMin: 30,
  districts: [{ id: 'app', name: 'App' }, { id: 'docs', name: 'Docs' }],
  blocks: [
    { id: 'ui', name: 'UI', district: 'app', paths: ['src/ui/'], docs: ['ui.md'], keywords: ['ui'] },
    { id: 'tables', name: 'Tables', district: 'app', paths: ['src/ui/table*.ts', 'src/ui/*/table-*'] },
    { id: 'core', name: 'Core', district: 'app', paths: ['src/core/'] },
    { id: 'readme', name: 'Readme', district: 'docs', paths: ['README.md'] },
  ],
};
const SHAPE_FILES = ['src/ui/app.ts', 'src/ui/table.ts', 'src/ui/widgets/a.ts', 'src/ui/widgets/b.ts', 'src/ui/panes/x.ts', 'src/ui/panes/table-pane.ts', 'src/core/m.ts', 'README.md'];

test('splitting a block drafts its folders into a district of its name, and no file changes block', async () => {
  const { planBoardOp } = await import('../core/board-ops.js');
  const { compileIndex: ci } = await import('../core/glob.js');
  const plan = planBoardOp(SHAPE, { op: 'split', block: 'ui' }, { files: SHAPE_FILES });
  const b = plan.board;
  assert.deepEqual(b.districts.map((d) => [d.id, d.parent || null]), [['app', null], ['ui', 'app'], ['docs', null]]);
  const parts = b.blocks.filter((x) => x.district === 'ui');
  assert.deepEqual(parts.map((x) => x.id), ['ui-widgets', 'ui-panes', 'ui-files']);
  // The files right in src/ui keep a folder pattern: Tables' table*.ts is the more specific, so table.ts stays its.
  assert.deepEqual(parts.find((x) => x.id === 'ui-files').paths, ['src/ui/*']);
  assert.deepEqual(parts.find((x) => x.id === 'ui-widgets').paths, ['src/ui/widgets/']);
  assert.deepEqual(parts.find((x) => x.id === 'ui-widgets').docs, ['ui.md']);
  // ui-panes' folder pattern would take table-pane.ts from Tables: it names its own files instead.
  assert.deepEqual(parts.find((x) => x.id === 'ui-panes').paths, ['src/ui/panes/x.ts']);
  const idx = ci(b.blocks);
  assert.equal(blockForPath(idx, 'src/ui/panes/table-pane.ts'), 'tables');
  assert.equal(blockForPath(idx, 'src/ui/widgets/a.ts'), 'ui-widgets');
  assert.equal(plan.summary, 'split UI into Widgets, Panes, UI (files)');
  // Its open items go to the part with the most files.
  assert.deepEqual(plan.remap, { ui: 'ui-widgets' });
  // The original isn't touched.
  assert.equal(SHAPE.blocks[0].id, 'ui');
  // Nothing to split: no files, or all in one folder with nothing beside it.
  assert.throws(() => planBoardOp(SHAPE, { op: 'split', block: 'core' }, { files: SHAPE_FILES }), (e) => e.code === 'invalid' && /sits in one folder/.test(e.message));
  assert.throws(() => planBoardOp(SHAPE, { op: 'split', block: 'ui' }), (e) => e.code === 'invalid' && /needs the repository's files/.test(e.message));
  // Named parts must cover the block's files exactly.
  assert.throws(
    () => planBoardOp(SHAPE, { op: 'split', block: 'ui', into: [{ name: 'Widgets', paths: ['src/ui/widgets/'] }, { name: 'Rest', paths: ['src/ui/app.ts'] }] }, { files: SHAPE_FILES }),
    (e) => e.code === 'invalid' && /src\/ui\/panes\/x\.ts \(ui to no block\)/.test(e.message),
  );
  const named = planBoardOp(SHAPE, { op: 'split', block: 'ui', into: [{ name: 'Widgets', paths: ['src/ui/widgets/'] }, { id: 'rest', name: 'Rest', paths: ['src/ui/app.ts', 'src/ui/panes/x.ts'] }] }, { files: SHAPE_FILES });
  assert.deepEqual(named.board.blocks.filter((x) => x.district === 'ui').map((x) => x.id), ['ui-widgets', 'rest']);
});

test('dissolving a split block brings it back; joining takes paths together; busy blocks are refused', async () => {
  const { planBoardOp, applyBoardOp, validateBoard } = await import('../core/board-ops.js');
  const split = applyBoardOp(SHAPE, { op: 'split', block: 'ui' }, { files: SHAPE_FILES });
  const back = planBoardOp(split, { op: 'dissolve', district: 'ui' });
  const ui = back.board.blocks.find((x) => x.id === 'ui');
  assert.equal(ui.district, 'app');
  assert.equal(ui.name, 'UI');
  assert.deepEqual(ui.paths.sort(), ['src/ui/*', 'src/ui/panes/x.ts', 'src/ui/widgets/']);
  assert.deepEqual(back.board.districts.map((d) => d.id), ['app', 'docs']);
  assert.deepEqual(back.remap, { 'ui-widgets': 'ui', 'ui-panes': 'ui', 'ui-files': 'ui' });
  assert.deepEqual(back.board.blocks.map((x) => x.id), ['ui', 'tables', 'core', 'readme']);
  // A top-level district stays, holding one block named after it, in its first block's id.
  const top = applyBoardOp(SHAPE, { op: 'dissolve', district: 'app' });
  assert.deepEqual(top.blocks.map((x) => [x.id, x.name, x.district]), [['ui', 'App', 'app'], ['readme', 'Readme', 'docs']]);
  // Join: blocks from anywhere, into a new id, in the first one's district.
  const joined = planBoardOp(SHAPE, { op: 'join', members: ['core', 'readme'], into: 'base', name: 'Base' });
  assert.deepEqual(joined.board.blocks.find((x) => x.id === 'base'), { id: 'base', name: 'Base', district: 'app', about: 'Was Core, Readme.', paths: ['src/core/', 'README.md'], docs: [], keywords: [] });
  assert.throws(() => planBoardOp(SHAPE, { op: 'join', members: ['core', 'readme'], into: 'tables' }), (e) => /already called tables/.test(e.message));
  assert.throws(() => planBoardOp(SHAPE, { op: 'join', members: ['core'], into: 'x' }), (e) => e.code === 'invalid');
  // A block reserved by someone else, queued or frozen can't be reshaped; the one who reserved it can.
  const st = createState(SHAPE);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'block.reserve', 'a1', { block: 'core' }, 1);
  assert.throws(() => planBoardOp(SHAPE, { op: 'join', members: ['core', 'readme'], into: 'base' }, { state: st }), (e) => e.code === 'held' && /Core is reserved by Heron/.test(e.message));
  assert.ok(planBoardOp(SHAPE, { op: 'join', members: ['core', 'readme'], into: 'base' }, { state: st, actor: 'a1' }));
  assert.throws(() => planBoardOp(SHAPE, { op: 'move', block: 'core', district: 'docs' }, { state: st }), (e) => e.code === 'held');
  run(st, 'block.queue', HUMAN, { block: 'readme' }, 2);
  assert.throws(() => planBoardOp(SHAPE, { op: 'rename', id: 'readme', name: 'x' }, { state: st }) && planBoardOp(SHAPE, { op: 'move', block: 'readme', district: 'app' }, { state: st }), (e) => e.code === 'queued');
  run(st, 'block.freeze', HUMAN, { block: 'tables', on: true }, 3);
  assert.throws(() => planBoardOp(SHAPE, { op: 'move', block: 'tables', district: 'docs' }, { state: st }), (e) => e.code === 'frozen');
  // Moving and renaming.
  const moved = applyBoardOp(SHAPE, { op: 'move', block: 'core', district: 'docs', before: 'readme' });
  assert.deepEqual(moved.blocks.map((x) => `${x.district}/${x.id}`), ['app/ui', 'app/tables', 'docs/core', 'docs/readme']);
  assert.deepEqual(applyBoardOp(SHAPE, { op: 'move', block: 'readme', district: 'app' }).blocks.map((x) => x.id), ['ui', 'tables', 'core', 'readme']);
  assert.deepEqual(applyBoardOp(SHAPE, { op: 'move', block: 'ui', district: 'docs' }).blocks.map((x) => x.id), ['tables', 'core', 'readme', 'ui']);
  assert.throws(() => applyBoardOp(SHAPE, { op: 'move', block: 'core', district: 'docs', before: 'ui' }), (e) => /UI isn't in Docs/.test(e.message));
  assert.equal(applyBoardOp(SHAPE, { op: 'rename', id: 'docs', name: 'Writing' }).districts[1].name, 'Writing');
  // Layout: merged, unknown districts dropped, cols whole; null tidies.
  let laid = applyBoardOp(SHAPE, { op: 'layout', districts: { app: { x: 10, y: 20, cols: 3 }, nope: { x: 1, y: 1 } } });
  laid = applyBoardOp(laid, { op: 'layout', districts: { docs: { x: 0, y: 300 } } });
  assert.deepEqual(laid.layout, { districts: { app: { x: 10, y: 20, cols: 3 }, docs: { x: 0, y: 300 } } });
  assert.throws(() => applyBoardOp(SHAPE, { op: 'layout', districts: { app: { x: Infinity, y: 0 } } }), (e) => e.code === 'invalid');
  assert.throws(() => applyBoardOp(SHAPE, { op: 'layout', districts: { app: { x: 0, y: 0, cols: 1.5 } } }), (e) => e.code === 'invalid');
  assert.equal(applyBoardOp(laid, { op: 'layout', districts: null }).layout, undefined);
  // Nesting: unknown parents and cycles are refused.
  assert.throws(() => validateBoard({ ...SHAPE, districts: [{ id: 'app', name: 'App', parent: 'ghost' }, { id: 'docs', name: 'Docs' }] }), (e) => e.code === 'unknown');
  assert.throws(() => validateBoard({ ...SHAPE, districts: [{ id: 'app', name: 'App', parent: 'docs' }, { id: 'docs', name: 'Docs', parent: 'app' }] }), (e) => e.code === 'cycle');
  assert.throws(() => applyBoardOp(SHAPE, { op: 'explode' }), (e) => e.code === 'invalid');
});

test('the board is written under the lock, logged, and its open items follow; the page and qb board both reach it', async () => {
  const t = tmpBoard(SHAPE);
  const saved = { ...process.env };
  try {
    const store = openStore(t.boardDir);
    store.commit([makeEvent(store.state(), 'item.add', HUMAN, { item: { kind: 'bug', title: 'Widget flickers', block: 'ui' } })]);
    store.commit([makeEvent(store.state(), 'item.add', HUMAN, { item: { kind: 'task', title: 'Done already', block: 'ui' } })]);
    store.commit([makeEvent(store.state(), 'item.update', HUMAN, { item: 'T1', status: 'done' })]);
    const res = store.writeBoard({ op: 'split', block: 'ui', into: [{ name: 'Widgets', paths: ['src/ui/widgets/'] }, { name: 'Rest', paths: ['src/ui/*'] }] }, HUMAN);
    const onDisk = JSON.parse(fs.readFileSync(path.join(t.boardDir, 'board.json'), 'utf8'));
    assert.deepEqual(onDisk.districts.map((d) => d.id), ['app', 'ui', 'docs']);
    assert.equal(res.event.type, 'board.change');
    assert.equal(res.event.change.op, 'split');
    const st = store.state();
    assert.ok(st.blocks['ui-widgets'] && !st.blocks.ui);
    assert.equal(st.items.B1.block, 'ui-widgets');
    assert.equal(st.items.T1.block, 'ui');
    const { describeEvent } = await import('../core/model.js');
    assert.equal(describeEvent(st, res.event), 'You split UI into Widgets, Rest');
    // A refusal writes nothing.
    const before = fs.readFileSync(path.join(t.boardDir, 'board.json'), 'utf8');
    const events = store.readEvents().length;
    assert.throws(() => store.writeBoard({ op: 'move', block: 'nope', district: 'app' }), (e) => e.refused && e.code === 'unknown');
    assert.equal(fs.readFileSync(path.join(t.boardDir, 'board.json'), 'utf8'), before);
    assert.equal(store.readEvents().length, events);
    // qb board, as an agent: reshaping doesn't seat it, and a block someone else reserved is refused.
    const agent = cliIn(t.dir, 'cc-shaper');
    assert.match(agent('board', 'rename', 'docs', 'Writing').out, /Board: renamed Docs to Writing\./);
    assert.equal(openStore(t.boardDir).state().agents['cc-shaper'].leftAt > 0, true);
    cliIn(t.dir, 'cc-other')('reserve', 'core');
    assert.match(agent('board', 'join', 'core', 'readme', '--into', 'base').err, /Core is reserved by/);
    assert.match(agent('board', 'move', 'readme', 'app').out, /moved Readme to App/);
    assert.match(agent('board', 'explode').err, /reshapes with split, dissolve, join, move, rename/);
    assert.match(agent('board').out, /Shape: /);
    // The page: POST /api/board, as the human only.
    process.env.QUEUEBOX_DIR = t.boardDir;
    for (const k of ['QUEUEBOX_LIVE', 'QUEUEBOX_TOKEN']) delete process.env[k];
    const { serve } = await import('../server.js');
    const server = await serve({ port: 0, quiet: true });
    try {
      const port = server.address().port;
      const post = (body, headers = { 'x-queuebox': '1' }) => fetch(`http://127.0.0.1:${port}/api/board`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
      let r = await post({ op: 'layout', districts: { app: { x: 5, y: 6, cols: 2 } } });
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.ok, r.body.board.layout], [true, { districts: { app: { x: 5, y: 6, cols: 2 } } }]);
      r = await post({ op: 'dissolve', district: 'ui' });
      assert.equal(r.body.ok, true);
      assert.ok(r.body.board.blocks.some((x) => x.id === 'ui'));
      r = await post({ op: 'move', block: 'core', district: 'app' });
      assert.deepEqual([r.status, r.body.ok, r.body.code], [409, false, 'held']);
      r = await post({ op: 'rename', id: 'nope', name: 'x' });
      assert.deepEqual([r.status, r.body.code], [400, 'unknown']);
      r = await post({ op: 'rename', id: 'app', name: 'x', by: 'cc-other' });
      assert.equal(r.status, 403);
      r = await post({ op: 'rename', id: 'app', name: 'x' }, {});
      assert.equal(r.status, 403);
      assert.equal(openStore(t.boardDir).readEvents().filter((e) => e.type === 'board.change').length, 5);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    t.done();
  }
});

test('an agent is idle with nothing to do only when its turn is over and nothing is its', async () => {
  const { isIdleFree } = await import('../core/model.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1' } }, 0);
  assert.equal(isIdleFree(st, 'a1', at(0)), true);
  run(st, 'agent.status', 'a1', { status: 'working' }, 1);
  assert.equal(isIdleFree(st, 'a1', at(1)), false);
  run(st, 'agent.status', 'a1', { status: 'review' }, 2);
  assert.equal(isIdleFree(st, 'a1', at(2)), true);
  run(st, 'block.reserve', 'a1', { block: 'engine' }, 3);
  run(st, 'agent.status', 'a1', { status: 'review' }, 3);
  assert.equal(isIdleFree(st, 'a1', at(3)), false);
  run(st, 'block.release', 'a1', { block: 'engine' }, 4);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Yours', block: 'engine', assignee: 'a1' } }, 4);
  assert.equal(isIdleFree(st, 'a1', at(4)), false);
  run(st, 'item.update', HUMAN, { item: 'T1', status: 'done' }, 5);
  assert.equal(isIdleFree(st, 'a1', at(5)), true);
  run(st, 'item.add', 'a1', { item: { kind: 'question', title: 'Next?' } }, 6);
  assert.equal(isIdleFree(st, 'a1', at(6)), false);
  assert.equal(isIdleFree(st, HUMAN, at(6)), false);
});

test('the lone block of a district splits back into it, and a bare name never outranks a folder', async () => {
  const { applyBoardOp } = await import('../core/board-ops.js');
  const { compileIndex: ci } = await import('../core/glob.js');
  const one = applyBoardOp(SHAPE, { op: 'dissolve', district: 'app' });
  const back = applyBoardOp(one, { op: 'split', block: 'ui' }, { files: SHAPE_FILES.filter((f) => f !== 'src/ui/table.ts') });
  assert.deepEqual(back.districts.map((d) => d.id), ['app', 'docs']);
  assert.ok(back.blocks.filter((x) => x.district === 'app').length >= 2);
  const idx = ci([{ id: 'docs', paths: ['README.md'] }, { id: 'theme', paths: ['ui/theme/'] }]);
  assert.equal(blockForPath(idx, 'ui/theme/README.md'), 'theme');
  assert.equal(blockForPath(idx, 'README.md'), 'docs');
});

test('the Stop hook only marks the turn ended; agents suggest work rather than reassign it', () => {
  const t = tmpBoard();
  const call = (payload, extra = {}) => {
    const out = execFileSync('node', [HOOK], { input: JSON.stringify({ cwd: t.dir, session_id: 'dddd0000', ...payload }), env: { ...hookEnv(t.dir), ...extra }, encoding: 'utf8' });
    return out ? JSON.parse(out) : null;
  };
  try {
    call({ hook_event_name: 'SessionStart' });
    const human = cliIn(t.dir);
    human('task', 'Fix the pass', '--block', 'engine');
    const agent = cliIn(t.dir, 'cc-dddd0000');
    const store = openStore(t.boardDir);
    // Idle, after the person's prompt or a teammate's: the hook ends the turn and holds nothing (the board wakes it).
    for (const prompt of ['look at the pass', '<cross-session-message from="x">help</cross-session-message>']) {
      call({ hook_event_name: 'UserPromptSubmit', prompt });
      assert.equal(call({ hook_event_name: 'Stop' }), null);
      assert.equal(store.state().agents['cc-dddd0000'].status, 'review');
    }
    // The suggestion: one item for the person, naming who takes what; nothing is reassigned.
    cliIn(t.dir, 'cc-eeee0000')('doing', 'other work');
    human('bug', 'Totals drift', '--block', 'tables');
    const s = agent('suggest', 'cc-eeee0000:T1', `${store.state().agents['cc-dddd0000'].name}:B1`, '--note', 'Tables is free');
    assert.equal(s.code, 0, s.err);
    const st = store.state();
    const sug = Object.values(st.items).find((it) => it.kind === 'suggestion');
    assert.deepEqual(sug.plan, [{ agent: 'cc-eeee0000', item: 'T1' }, { agent: 'cc-dddd0000', item: 'B1' }]);
    assert.match(sug.title, /takes T1 in Engine; .* takes B1 in Tables/);
    assert.equal(sug.id, 'S1');
    assert.equal(st.items.T1.assignee, undefined);
    assert.match(agent('suggest', 'nobody:T1').err, /No agent/);
    assert.match(agent('suggest', 'cc-eeee0000:T9').err, /No item T9/);
    // An agent can't give an item to someone else, or take one that is someone else's.
    assert.match(checkEvent(st, makeEvent(st, 'item.update', 'cc-dddd0000', { item: 'T1', assignee: 'cc-eeee0000' })), /Only the human assigns/);
    assert.equal(checkEvent(st, makeEvent(st, 'item.update', HUMAN, { item: 'T1', assignee: 'cc-eeee0000' })), null);
    assert.match(checkEvent(st, makeEvent(st, 'item.add', 'cc-dddd0000', { item: { title: 'x', assignee: 'cc-eeee0000' } })), /Only the human files work/);
  } finally {
    t.done();
  }
});

test('qb ask --wait blocks until the answer, and a message to an agent that ended its turn waits for its next run', async () => {
  const { readsSoon } = await import('../core/model.js');
  const t = tmpBoard();
  const env = { ...hookEnv(t.dir), QUEUEBOX_POLL_MS: '100' };
  const store = openStore(t.boardDir);
  const until = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  try {
    // qb ask --wait, for agents without hooks: blocks until the answer, or gives up at --timeout.
    const asker = spawn(process.execPath, [path.join(HERE, '..', 'cli.js'), 'ask', 'Ship it?', '--wait', '--timeout', '1'], { cwd: t.dir, env: { ...env, QUEUEBOX_AGENT: 'a-plain' } });
    let said = '';
    asker.stdout.on('data', (c) => (said += c));
    const exited = new Promise((r) => asker.on('close', r));
    await until(() => Object.values(store.state().items).some((it) => it.title === 'Ship it?'));
    const q = Object.values(store.state().items).find((it) => it.title === 'Ship it?');
    store.commit([makeEvent(store.state(), 'item.update', HUMAN, { item: q.id, answer: 'Yes.', status: 'done' })]);
    assert.equal(await exited, 0);
    assert.match(said, new RegExp(`${q.id} answered: Yes\\.`));
    assert.equal(store.state().agents['a-plain'].inbox.length, 0);
    const late = cliIn(t.dir, 'a-plain')('ask', 'Still there?', '--wait', '--timeout', '0.005');
    assert.match(late.err, /No answer to Q\d after 0.005 min/);
    // A message to an agent that has ended its turn waits for its next run.
    store.commit([makeEvent(store.state(), 'agent.status', 'a-plain', { status: 'review' })]);
    assert.equal(readsSoon(store.state(), 'a-plain', Date.now()), false);
  } finally {
    t.done();
  }
});

test('the hooks never overwrite what an agent said it is doing, except a permission prompt, briefly', () => {
  const t = tmpBoard();
  const call = (payload) => execFileSync('node', [HOOK], { input: JSON.stringify({ cwd: t.dir, session_id: 'abab0000', ...payload }), env: hookEnv(t.dir), encoding: 'utf8' });
  const doing = () => openStore(t.boardDir).state().agents['cc-abab0000'].doing;
  try {
    call({ hook_event_name: 'SessionStart' });
    call({ hook_event_name: 'UserPromptSubmit', prompt: 'start' });
    assert.equal(doing(), 'Reading the prompt');
    cliIn(t.dir, 'cc-abab0000')('doing', 'T2: writing the tests');
    // A teammate's message, a finished turn: the agent's own line stays.
    call({ hook_event_name: 'UserPromptSubmit', prompt: '<cross-session-message from="x">hi</cross-session-message>' });
    assert.equal(doing(), 'T2: writing the tests');
    call({ hook_event_name: 'Stop' });
    assert.equal(doing(), 'T2: writing the tests');
    // A permission prompt shows until the next automatic line, which puts the agent's own back.
    call({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
    assert.equal(doing(), 'Claude needs your permission to use Bash');
    call({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
    assert.equal(doing(), 'T2: writing the tests');
    cliIn(t.dir, 'cc-abab0000')('doing', 'T3 now');
    assert.equal(doing(), 'T3 now');
  } finally {
    t.done();
  }
});

test('an agent quiet past the stale limit leaves its worktree unless it still reserves a block', async () => {
  const { agentsInWorktree, mergeChecks } = await import('../core/merges.js');
  const st = createState(BOARD);
  const wt = { name: 'one', path: '/w/one', head: 'aaa', ahead: 1, behind: 0, dirty: 0, files: [], conflicts: [] };
  const snap = { base: 'main', list: [wt] };
  const testsFail = (min) => mergeChecks(st, snap, at(min))[0].checks.some((c) => c.text === 'Tests fail');
  run(st, 'agent.join', 'a', { agent: { id: 'a', name: 'Heron', worktree: '/w/one' } }, 0);
  run(st, 'test', 'a', { ok: false, summary: '2 failed' }, 0);
  run(st, 'merge.ready', 'a', { worktree: 'one', branch: 'one', commit: 'aaa', ahead: 1 }, 0);
  run(st, 'agent.join', 'b', { agent: { id: 'b', name: 'Basalt', worktree: '/w/one' } }, 1);
  run(st, 'block.reserve', 'b', { block: 'engine' }, 1);
  assert.deepEqual(agentsInWorktree(st, wt, at(2)), ['b', 'a']);
  assert.equal(testsFail(2), true);
  // Two hours on, neither has been seen: Heron (a crashed session) is out; Basalt stays while it reserves Engine.
  assert.deepEqual(agentsInWorktree(st, wt, at(120)), ['b']);
  assert.equal(testsFail(120), false);
  // Without a time it is as before: everyone who hasn't left.
  assert.deepEqual(agentsInWorktree(st, wt), ['b', 'a']);
  // Basalt releases, then goes quiet too: nobody is working there, and Heron's old failure fails nothing.
  run(st, 'block.release', 'b', { block: 'engine' }, 120);
  assert.deepEqual(agentsInWorktree(st, wt, at(121)), ['b']);
  assert.deepEqual(agentsInWorktree(st, wt, at(300)), []);
  const [check] = mergeChecks(st, snap, at(300));
  assert.equal(check.entry.worktree, 'one');
  assert.ok(!check.checks.some((c) => c.text === 'Tests fail'));
  assert.ok(check.checks.some((c) => c.text === 'No test run'));
});

test('an agent\'s task line is the newest of its prompts, reservations and the items it takes up (B5, B8)', () => {
  const t = tmpBoard();
  const call = (payload) => execFileSync('node', [HOOK], { input: JSON.stringify({ cwd: t.dir, session_id: 'cdcd0000', ...payload }), env: hookEnv(t.dir), encoding: 'utf8' });
  const task = () => openStore(t.boardDir).state().agents['cc-cdcd0000'].task;
  try {
    call({ hook_event_name: 'SessionStart' });
    call({ hook_event_name: 'UserPromptSubmit', prompt: "you're agent 2, hold for instructions" });
    assert.equal(task(), "you're agent 2, hold for instructions");
    // The newest prompt replaces it, a teammate's message unwrapped; a poke with no words or a system notice doesn't.
    call({ hook_event_name: 'UserPromptSubmit', prompt: '<cross-session-message from="lead" from-name="solenoid">\nT1 is yours: the canvas\nmore detail\n</cross-session-message>' });
    assert.equal(task(), 'T1 is yours: the canvas');
    call({ hook_event_name: 'UserPromptSubmit', prompt: '.' });
    call({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>done</task-notification>' });
    assert.equal(task(), 'T1 is yours: the canvas');
    const agent = cliIn(t.dir, 'cc-cdcd0000');
    agent('reserve', 'engine', '--for', 'T1: pan and tidy the canvas');
    assert.equal(task(), 'T1: pan and tidy the canvas');
    // An edit the hook reserves for says nothing new; a reservation without --for leaves the task alone.
    call({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(t.dir, 'README.md') } });
    assert.equal(openStore(t.boardDir).state().blocks.tables.holder, 'cc-cdcd0000');
    assert.equal(task(), 'T1: pan and tidy the canvas');
    agent('reserve', 'pass');
    assert.equal(task(), 'T1: pan and tidy the canvas');
    // Saying more about a block it already has updates the task too, and so does the person giving it one.
    agent('reserve', 'engine', '--for', 'T1: tidy, now collapse');
    assert.equal(task(), 'T1: tidy, now collapse');
    agent('release', 'engine');
    cliIn(t.dir)('reserve', 'engine', '--for', 'B2: fix the fold');
    const st = openStore(t.boardDir).state();
    const give = makeEvent(st, 'block.reserve', HUMAN, { block: 'engine', agent: 'cc-cdcd0000', intent: 'B2: fix the fold', force: true });
    openStore(t.boardDir).commit([give]);
    assert.equal(task(), 'B2: fix the fold');
    // An item the agent marks doing, or the person gives it, is the task line then.
    cliIn(t.dir)('task', 'Make the map pan', '--block', 'tables');
    cliIn(t.dir, 'cc-cdcd0000')('item', 'T1', 'doing');
    assert.equal(task(), 'T1: Make the map pan');
    openStore(t.boardDir).commit([makeEvent(openStore(t.boardDir).state(), 'item.add', HUMAN, { item: { kind: 'bug', title: 'Totals drift', block: 'tables' } })]);
    openStore(t.boardDir).commit([makeEvent(openStore(t.boardDir).state(), 'item.update', HUMAN, { item: 'B1', assignee: 'cc-cdcd0000' })]);
    assert.equal(task(), 'B1: Totals drift');
    // The board's own wake prompt says what waits, not what the agent is on: the task line stays (B34).
    const before = task();
    call({ hook_event_name: 'UserPromptSubmit', prompt: 'QueueBox woke you: something on the board is waiting for you.\n- 1 message for you on the board' });
    assert.equal(task(), before);
    // A long prompt is cut to one line.
    call({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(200) });
    assert.equal(task().length, 90);
  } finally {
    t.done();
  }
});

test('the person starts an agent in a worktree from the board: a fixed command, logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-launch-'));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const saved = { ...process.env };
  let server;
  try {
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.email', 't@t');
    sh(repo, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(repo, '.queuebox'));
    fs.writeFileSync(path.join(repo, '.queuebox', 'board.json'), JSON.stringify(BOARD));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'init');
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat', path.join(dir, 'feat'));
    // A stand-in for Claude Code that records how it was called.
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "${path.join(dir, 'called')}"\necho "Started in the background. Open it with: claude attach 4f2a9c1e"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.QUEUEBOX_DIR = path.join(repo, '.queuebox');
    for (const k of ['QUEUEBOX_LIVE', 'QUEUEBOX_TOKEN']) delete process.env[k];
    const { serve } = await import('../server.js');
    server = await serve({ port: 0, quiet: true });
    const port = server.address().port;
    const post = (body, headers = { 'x-queuebox': '1' }) => fetch(`http://127.0.0.1:${port}/api/launch`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const r = await post({ op: 'start', worktree: 'feat' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.id, '4f2a9c1e');
    const [cwd, ...args] = fs.readFileSync(path.join(dir, 'called'), 'utf8').trim().split('\n');
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(path.join(dir, 'feat')));
    assert.deepEqual(args.slice(0, 3), ['--bg', '--name', 'Test-feat']);
    assert.match(args.slice(3).join('\n'), /started from the QueueBox board[\s\S]*qb next/);
    const note = openStore(path.join(repo, '.queuebox')).readEvents().find((e) => e.type === 'note' && e.launch);
    assert.equal(note.by, HUMAN);
    assert.deepEqual(note.launch, { how: 'start', worktree: 'feat', id: '4f2a9c1e', name: 'Test-feat' });
    assert.match(note.text, /claude attach 4f2a9c1e/);
    // Only a worktree the server knows, only the person, only with the header, only the one op.
    assert.equal((await post({ op: 'start', worktree: '../../etc' })).status, 400);
    assert.equal((await post({ op: 'start', worktree: 'feat', by: 'cc-x' })).status, 403);
    assert.equal((await post({ op: 'start', worktree: 'feat' }, {})).status, 403);
    assert.equal((await post({ op: 'run', cmd: 'rm -rf /' })).status, 400);
    // No Claude Code on PATH: it says so.
    process.env.PATH = '/nonexistent';
    const none = await post({ op: 'start', worktree: 'feat' });
    assert.equal(none.status, 502);
    assert.match(none.body.message, /isn't on the server's PATH/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('subagent rows: a start needs a description, the run id joins it, the first end wins, twelve are kept', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.sub', 'a1', { sub: 'tu1', desc: 'Find the fold bug', kind: 'Explore', state: 'running' }, 1);
  let [s] = st.agents.a1.subs;
  assert.deepEqual([s.id, s.desc, s.kind, s.state, s.end], ['tu1', 'Find the fold bug', 'Explore', 'running', 0]);
  assert.equal(s.since, at(1));
  // The run id arrives on a later event that is still running; the end comes by run id alone.
  run(st, 'agent.sub', 'a1', { sub: 'tu1', aid: 'run1', state: 'running' }, 2);
  assert.equal(st.agents.a1.subs[0].aid, 'run1');
  run(st, 'agent.sub', 'a1', { aid: 'run1', state: 'done' }, 3);
  s = st.agents.a1.subs[0];
  assert.deepEqual([s.state, s.end], ['done', at(3)]);
  // The first end wins.
  run(st, 'agent.sub', 'a1', { aid: 'run1', state: 'failed' }, 4);
  assert.deepEqual([st.agents.a1.subs[0].state, st.agents.a1.subs[0].end], ['done', at(3)]);
  // A failed one.
  run(st, 'agent.sub', 'a1', { sub: 'tu2', desc: 'Run the tests', state: 'running' }, 5);
  run(st, 'agent.sub', 'a1', { sub: 'tu2', state: 'failed' }, 6);
  assert.equal(st.agents.a1.subs[1].state, 'failed');
  // An end for a run it never saw start makes no row, and neither does a start with no description.
  run(st, 'agent.sub', 'a1', { aid: 'ghost', state: 'done' }, 7);
  run(st, 'agent.sub', 'a1', { sub: 'tu3', state: 'running' }, 7);
  assert.equal(st.agents.a1.subs.length, 2);
  // Thirteen starts keep the last twelve.
  for (let i = 0; i < 13; i++) run(st, 'agent.sub', 'a1', { sub: `many${i}`, desc: `job ${i}`, state: 'running' }, 8);
  assert.equal(st.agents.a1.subs.length, 12);
  assert.equal(st.agents.a1.subs[0].id, 'many1');
  assert.equal(st.agents.a1.subs.at(-1).id, 'many12');
  // Bad states and ids are refused.
  assert.match(ev(st, 'agent.sub', 'a1', { sub: 'x', desc: 'd', state: 'exploded' }, 9).why, /Subagent states/);
  assert.match(ev(st, 'agent.sub', 'a1', { sub: '__proto__', desc: 'd', state: 'running' }, 9).why, /valid subagent id/);
});

test('the board plans whom to wake: idle background sessions with something new waiting, one agent per queued block', async () => {
  const { planWakes, wakePrompt } = await import('../core/launch.js');
  const st = createState(BOARD);
  const sid = (n) => `${n}0000000-0000-4000-8000-000000000000`;
  const agent = (n) => `cc-${n}0000000`;
  for (const n of ['a', 'b', 'c', 'd']) {
    run(st, 'agent.join', agent(n), { agent: { id: agent(n) } }, 0);
    run(st, 'agent.status', agent(n), { status: 'review' }, 1);
  }
  const sessions = ['a', 'b', 'c', 'd'].map((n) => ({ id: `${n}0000000`, sessionId: sid(n), kind: 'background', status: 'idle', cwd: '/r' }));
  sessions.push({ id: 'e0000000', sessionId: sid('e'), kind: 'interactive', status: 'idle', cwd: '/r' });
  const memory = { woken: new Map(), nudged: new Set() };
  // Idle with nothing waiting: each gets the planning nudge, once.
  let plans = planWakes(st, sessions, at(2), memory);
  assert.deepEqual(plans.map((p) => [p.agent, p.reasons.map((r) => r.kind)]), [[agent('a'), ['nudge']], [agent('b'), ['nudge']], [agent('c'), ['nudge']], [agent('d'), ['nudge']]]);
  for (const p of plans) memory.nudged.add(p.agent);
  assert.deepEqual(planWakes(st, sessions, at(3), memory), []);
  // Busy with the planning turn the nudge started, then idle again with no work: no second nudge (B25).
  run(st, 'agent.status', agent('a'), { status: 'working' }, 3.1);
  assert.deepEqual(planWakes(st, sessions, at(3.2), memory), []);
  run(st, 'agent.status', agent('a'), { status: 'review' }, 3.3);
  assert.deepEqual(planWakes(st, sessions, at(3.4), memory), []);
  // One queued block: exactly one of them is planned to take it.
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Fix the pass', block: 'engine' } }, 4);
  run(st, 'block.queue', HUMAN, { block: 'engine', item: 'T1' }, 4);
  plans = planWakes(st, sessions, at(5), memory);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].claim, { block: 'engine', intent: 'T1: Fix the pass', take: ['T1'] });
  assert.match(wakePrompt(plans[0]), /QueueBox woke you[\s\S]*T1 \(Fix the pass\) is yours, with Engine \(engine\) reserved for you/);
  // A message, an item given, a block given: each wakes its agent; something older than the turn's end doesn't.
  run(st, 'msg', HUMAN, { to: agent('b'), text: 'ping' }, 6);
  run(st, 'item.add', HUMAN, { item: { kind: 'bug', title: 'Totals', block: 'tables' } }, 6);
  run(st, 'item.update', HUMAN, { item: 'B1', assignee: agent('c') }, 6);
  run(st, 'block.reserve', HUMAN, { block: 'pass', agent: agent('d') }, 6);
  run(st, 'agent.status', agent('d'), { status: 'review' }, 6);
  memory.woken.set(agent('a'), at(6));
  plans = planWakes(st, sessions, at(6.5), memory);
  const kinds = Object.fromEntries(plans.map((p) => [p.agent, p.reasons.map((r) => r.kind)]));
  assert.deepEqual(kinds[agent('b')].slice(0, 1), ['inbox']);
  assert.deepEqual(kinds[agent('c')], ['given']);
  assert.equal(kinds[agent('d')], undefined, 'the block was given before its turn ended');
  // Woken a moment ago: left to settle. An interactive session is never touched.
  assert.equal(kinds[agent('a')], undefined);
  assert.ok(!plans.some((p) => p.session.kind !== 'background'));
  // The Nudge switch off: no nudge and no queue-taking, but messages still wake.
  st.board = { ...st.board, nudgeIdle: false };
  memory.nudged.clear();
  plans = planWakes(st, sessions, at(10), { woken: new Map(), nudged: new Set() });
  assert.ok(plans.every((p) => p.reasons.every((r) => r.kind !== 'nudge' && r.kind !== 'queue')));
});

test('the server wakes an idle background session for queued work: reserves it first, logs the wake', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-wake-'));
  const bin = path.join(dir, 'bin');
  const t = tmpBoard();
  const saved = { ...process.env };
  let server;
  try {
    const store = openStore(t.boardDir);
    const me = 'cc-feed0000';
    store.commit([makeEvent(store.state(), 'agent.join', me, { agent: { id: me } })]);
    store.commit([makeEvent(store.state(), 'agent.status', me, { status: 'review' })]);
    store.commit([makeEvent(store.state(), 'item.add', HUMAN, { item: { kind: 'task', title: 'Fix the pass', block: 'engine' } })]);
    // A stand-in Claude Code: one idle background session; stop and resume are recorded.
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = agents ]; then echo '[{"id":"feed0000","sessionId":"feed0000-0000-4000-8000-000000000000","kind":"background","status":"idle","cwd":"${t.dir}"}]'; exit 0; fi
printf '%s\\n' "$@" >> "${path.join(dir, 'calls')}"; echo "---" >> "${path.join(dir, 'calls')}"
`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.QUEUEBOX_DIR = t.boardDir;
    process.env.QUEUEBOX_WAKE_MS = '100';
    delete process.env.QUEUEBOX_WAKE;
    for (const k of ['QUEUEBOX_LIVE', 'QUEUEBOX_TOKEN']) delete process.env[k];
    const { serve } = await import('../server.js');
    server = await serve({ port: 0, quiet: true });
    // First the planning nudge; then, once settled, the person queues the block.
    const wakes = () => store.readEvents().filter((e) => e.type === 'note' && e.wake);
    for (let i = 0; i < 100 && wakes().length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(wakes()[0].wake.why, ['nudge']);
    store.commit([makeEvent(store.state(), 'block.queue', HUMAN, { block: 'engine', item: 'T1' })]);
    server.wakeMemory.woken.clear();
    for (let i = 0; i < 100 && wakes().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const [, second] = wakes();
    assert.deepEqual(second.wake.why, ['queue']);
    assert.equal(second.by, HUMAN);
    assert.match(second.text, /Woke .*: queued T1\./);
    const st = store.state();
    assert.equal(st.blocks.engine.holder, me);
    assert.deepEqual([st.items.T1.status, st.items.T1.assignee], ['doing', me]);
    const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('---\n').filter(Boolean).map((c) => c.trim().split('\n'));
    assert.deepEqual(calls[0], ['stop', 'feed0000']);
    assert.deepEqual(calls[1].slice(0, 3), ['--bg', '--resume', 'feed0000-0000-4000-8000-000000000000']);
    assert.match(calls.at(-1).join('\n'), /T1 \(Fix the pass\) is yours, with Engine \(engine\) reserved for you/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
    t.done();
  }
});

test('the Stop hook posts what the agent said last, and an agent can take an item for itself', () => {
  const t = tmpBoard();
  const transcript = path.join(t.dir, 'session.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'a subagent talking' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed B8 in 1ca465c; tests pass.' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n{torn');
  const call = (payload) => execFileSync('node', [HOOK], { input: JSON.stringify({ cwd: t.dir, session_id: 'efef0000', ...payload }), env: hookEnv(t.dir), encoding: 'utf8' });
  try {
    call({ hook_event_name: 'SessionStart' });
    call({ hook_event_name: 'Stop', transcript_path: transcript });
    const a = openStore(t.boardDir).state().agents['cc-efef0000'];
    assert.equal(a.last.text, 'Fixed B8 in 1ca465c; tests pass.');
    assert.equal(a.status, 'review');
    cliIn(t.dir)('task', 'Make the map pan', '--block', 'tables');
    const me = cliIn(t.dir, 'cc-efef0000');
    assert.equal(me('item', 'T1', 'open', '--take').code, 0);
    assert.equal(openStore(t.boardDir).state().items.T1.assignee, 'cc-efef0000');
    // Taking one that is someone else's is refused.
    assert.match(cliIn(t.dir, 'cc-other')('item', 'T1', 'open', '--take').err, /only the human moves it/);
  } finally {
    t.done();
  }
});

test('the person wakes one agent: a background session is woken with its next queued work; a terminal one is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-wake1-'));
  const bin = path.join(dir, 'bin');
  const t = tmpBoard();
  const saved = { ...process.env };
  let server;
  try {
    const store = openStore(t.boardDir);
    for (const id of ['cc-bb000000', 'cc-tt000000', 'cc-ww000000']) {
      store.commit([makeEvent(store.state(), 'agent.join', id, { agent: { id } })]);
      store.commit([makeEvent(store.state(), 'agent.status', id, { status: 'review' })]);
    }
    store.commit([makeEvent(store.state(), 'item.add', HUMAN, { item: { kind: 'task', title: 'Fix the pass', block: 'engine' } })]);
    store.commit([makeEvent(store.state(), 'block.queue', HUMAN, { block: 'engine', item: 'T1' })]);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = agents ]; then echo '[{"id":"bb000000","sessionId":"bb000000-0000-4000-8000-000000000000","kind":"background","status":"idle","cwd":"${t.dir}"},{"id":"tt000000","sessionId":"tt000000-0000-4000-8000-000000000000","kind":"interactive","status":"idle","cwd":"${t.dir}"},{"id":"ww000000","sessionId":"ww000000-0000-4000-8000-000000000000","kind":"background","status":"busy","cwd":"${t.dir}"}]'; exit 0; fi
printf '%s\\n' "$@" >> "${path.join(dir, 'calls')}"; echo "---" >> "${path.join(dir, 'calls')}"
`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.QUEUEBOX_DIR = t.boardDir;
    for (const k of ['QUEUEBOX_LIVE', 'QUEUEBOX_TOKEN']) delete process.env[k];
    const { serve } = await import('../server.js');
    server = await serve({ port: 0, quiet: true });
    const post = (body, headers = { 'x-queuebox': '1' }) => fetch(`http://127.0.0.1:${server.address().port}/api/wake`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    let r = await post({ agent: 'cc-tt000000' });
    assert.deepEqual([r.status, /plain terminal/.test(r.body.message)], [409, true]);
    r = await post({ agent: 'cc-ww000000' });
    assert.deepEqual([r.status, /working already/.test(r.body.message)], [409, true]);
    assert.equal((await post({ agent: 'cc-bb000000', by: 'cc-x' })).status, 403);
    assert.equal((await post({ agent: 'cc-bb000000' }, {})).status, 403);
    assert.equal((await post({ agent: 'nobody' })).status, 400);
    r = await post({ agent: 'cc-bb000000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.message, /Woke .*queued T1/);
    assert.equal(store.state().blocks.engine.holder, 'cc-bb000000');
    const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('---\n').filter(Boolean).map((c) => c.trim().split('\n'));
    assert.deepEqual(calls[0], ['stop', 'bb000000']);
    assert.match(calls[1].join('\n'), /T1 \(Fix the pass\) is yours, with Engine \(engine\) reserved for you/);
    // Woken again with nothing waiting: it is asked to look at the board.
    store.commit([makeEvent(store.state(), 'block.release', 'cc-bb000000', { block: 'engine' })]);
    store.commit([makeEvent(store.state(), 'item.update', HUMAN, { item: 'T1', status: 'done' })]);
    store.commit([makeEvent(store.state(), 'agent.status', 'cc-bb000000', { status: 'review' })]);
    r = await post({ agent: 'cc-bb000000' });
    assert.equal(r.status, 200);
    assert.match(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), /The person woke you/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
    t.done();
  }
});

test('the stream tells a page which version of its code the server has', async () => {
  const t = tmpBoard();
  const saved = { ...process.env };
  let server;
  try {
    process.env.QUEUEBOX_DIR = t.boardDir;
    for (const k of ['QUEUEBOX_LIVE', 'QUEUEBOX_TOKEN']) delete process.env[k];
    const { serve } = await import('../server.js');
    server = await serve({ port: 0, quiet: true });
    const text = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/stream' }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.includes('event: version')) {
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    const v = JSON.parse(/event: version\ndata: (.*)\n/.exec(text)[1]).v;
    // The install's commit (T83), or its package version outside git.
    assert.match(v, /^([0-9a-f]{40}|v[\d.]+)$/);
    assert.equal(v, server.version());
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    t.done();
  }
});

test('a message to an idle agent reaches it soon only mid-turn, or when it is a background session the board wakes (T28)', async () => {
  const { readsSoon } = await import('../core/model.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'cc-aa000000', { agent: { id: 'cc-aa000000' } }, 0);
  run(st, 'agent.status', 'cc-aa000000', { status: 'review' }, 1);
  assert.equal(readsSoon(st, 'cc-aa000000', at(2)), false);
  assert.equal(readsSoon(st, 'cc-aa000000', at(2), { 'cc-aa000000': { kind: 'interactive', status: 'idle' } }), false);
  assert.equal(readsSoon(st, 'cc-aa000000', at(2), { 'cc-aa000000': { kind: 'background', status: 'idle' } }), true);
  st.board = { ...st.board, nudgeIdle: false };
  assert.equal(readsSoon(st, 'cc-aa000000', at(2), { 'cc-aa000000': { kind: 'background', status: 'idle' } }), false);
  run(st, 'agent.status', 'cc-aa000000', { status: 'working' }, 3);
  assert.equal(readsSoon(st, 'cc-aa000000', at(3)), true);
});

test('an older QueueBox folds what it knows of a newer board and log, and skips the rest (T24)', () => {
  // A newer board: a higher schema, a key and a block field this version has never heard of.
  const board = { ...BOARD, schema: 2, futureThing: { x: 1 }, blocks: BOARD.blocks.map((b, i) => (i === 0 ? { ...b, futureField: 'y' } : b)) };
  const events = [
    { id: 'f1', ts: at(1), by: 'cc-aa000000', type: 'agent.join', agent: { id: 'cc-aa000000', name: 'Old' } },
    { id: 'f2', ts: at(2), by: 'cc-aa000000', type: 'block.reserve', agent: 'cc-aa000000', block: 'engine' },
    // A type it doesn't know, and a known one carrying a field it doesn't know.
    { id: 'f3', ts: at(3), by: 'cc-aa000000', type: 'future.thing', payload: { a: 1 } },
    { id: 'f4', ts: at(4), by: 'cc-aa000000', type: 'agent.status', status: 'working', doing: 'after the unknown', newField: [1, 2] },
  ];
  const st = reduce(board, events);
  assert.equal(st.blocks.engine.holder, 'cc-aa000000');
  assert.equal(st.agents['cc-aa000000'].doing, 'after the unknown');
  assert.equal(st.agents['cc-aa000000'].status, 'working');
  // It still won't write what it doesn't know.
  assert.match(checkEvent(st, { type: 'future.thing', ts: at(5), by: 'cc-aa000000' }, at(5)), /No event type/);
});

test('installing the hooks again leaves one copy, whatever the folder is called (B18)', async () => {
  const { installHooks, hooksInstalled } = await import('../hooks/install.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-install-'));
  fs.mkdirSync(path.join(root, '.claude'));
  // Copies left by earlier installs under the old name, beside someone else's hook that must survive.
  const old = (dir) => ({ hooks: [{ type: 'command', command: `node "/home/x/${dir}/hooks/claude-code.js"` }] });
  const theirs = { hooks: [{ type: 'command', command: 'echo mine' }] };
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [old('blockmap'), old('queuebox'), theirs, old('blockmap')] } }));
  installHooks(root, 'install');
  installHooks(root, 'install');
  const hooks = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8')).hooks;
  assert.equal(hooks.Stop.length, 2);
  assert.ok(hooks.Stop.some((e) => e.hooks[0].command === 'echo mine'));
  for (const [event, entries] of Object.entries(hooks)) assert.equal(entries.filter((e) => e.hooks[0].command.includes('claude-code.js')).length, 1, event);
  assert.ok(hooksInstalled(root));
  fs.rmSync(root, { recursive: true, force: true });
});

test('queuing, unqueuing and freezing from an agent session neither seat it nor set its task (B17)', () => {
  const t = tmpBoard();
  try {
    const human = cliIn(t.dir);
    human('task', 'Fix the pass', '--block', 'engine');
    human('task', 'Pivot', '--block', 'tables');
    const lead = cliIn(t.dir, 'cc-1ead0000');
    lead('queue', 'T1');
    lead('queue', 'T2');
    lead('unqueue', 'T2');
    lead('freeze', 'tables', 'release prep');
    const st = openStore(t.boardDir).state();
    const a = st.agents['cc-1ead0000'];
    assert.equal(presence(st, 'cc-1ead0000', Date.now()), 'gone');
    assert.ok(!a.joinedAt);
    assert.equal(a.task, '');
    assert.deepEqual(st.blocks.engine.queued.items, ['T1']);
    assert.ok(st.blocks.tables.frozen);
    // One that is on the board stays as it was.
    const here = cliIn(t.dir, 'cc-4e4e0000');
    here('doing', 'other work');
    here('queue', 'engine');
    const b = openStore(t.boardDir).state().agents['cc-4e4e0000'];
    assert.equal(b.doing, 'other work');
    assert.equal(b.task, '');
  } finally {
    t.done();
  }
});

test("qb run: the board types into an agent's own terminal, and an idle one is planned for a wake", async () => {
  const { typeInto, planWakes } = await import('../core/launch.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-pty-'));
  const sock = path.join(dir, 'ptys', 'a1.sock');
  const out = path.join(dir, 'out.txt');
  // A stand-in agent: reads one line from its terminal and writes it down.
  const relay = spawn('python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'ptyrun.py'), sock, 'sh', '-c', `read line; printf '%s|%s' "$line" "$QUEUEBOX_PTY" > ${out}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 40));
  await typeInto(sock, 'QueueBox woke you:\n- take T1', { enterAfterMs: 50 });
  await new Promise((r) => relay.on('exit', r));
  assert.equal(fs.readFileSync(out, 'utf8'), `QueueBox woke you: - take T1|${sock}`);
  assert.equal(fs.existsSync(sock), false, 'the relay removes its socket when the agent exits');
  await assert.rejects(typeInto(sock, 'x'), /terminal has closed/);

  // An idle agent whose terminal QueueBox owns is woken for a message, like a background session.
  let st = createState({ name: 't', districts: [{ id: 'd', name: 'D' }], blocks: [{ id: 'b', name: 'B', district: 'd', paths: ['b/'] }] });
  const t0 = Date.now() - 600_000;
  st = apply(st, makeEvent(st, 'agent.join', 'codex-1', { agent: { id: 'codex-1', kind: 'codex', pty: sock } }, t0));
  st = apply(st, makeEvent(st, 'agent.status', 'codex-1', { status: 'review' }, t0 + 1));
  st = apply(st, makeEvent(st, 'msg', HUMAN, { to: 'codex-1', text: 'take T1' }, t0 + 2));
  assert.equal(st.agents['codex-1'].pty, sock);
  const plans = planWakes(st, [{ kind: 'pty', status: 'idle', agent: 'codex-1', sock, id: 'pty:codex-1' }], Date.now(), { woken: new Map(), nudged: new Set() });
  assert.deepEqual(plans.map((p) => [p.agent, p.reasons[0].kind]), [['codex-1', 'inbox']]);
  // A pty outside a qb run socket is refused.
  assert.match(checkEvent(st, makeEvent(st, 'agent.join', 'x', { agent: { id: 'x', pty: '/tmp/evil' } }, Date.now()), Date.now()) || '', /qb run socket/);
});

test('an item filed on unmapped files is queued, and dragging it to an agent hands the item over, reserving nothing', () => {
  let st = createState({ name: 't', districts: [{ id: 'd', name: 'D' }], blocks: [{ id: 'b', name: 'B', district: 'd', paths: ['b/'] }] });
  const t = Date.now() - 10_000;
  st = apply(st, makeEvent(st, 'agent.join', 'cc-a', { agent: { id: 'cc-a' } }, t));
  st = apply(st, makeEvent(st, 'item.add', HUMAN, { item: { kind: 'bug', title: 'Loose file breaks', block: '_unmapped' } }, t + 1));
  const id = Object.keys(st.items).find((k) => st.items[k].title === 'Loose file breaks');
  st = apply(st, makeEvent(st, 'block.queue', HUMAN, { block: '_unmapped', item: id }, t + 2));
  assert.ok(st.blocks._unmapped.queued, 'it sits in Up next');
  // The page's drag onto an agent: a reservation for it, with no `take`.
  const drag = makeEvent(st, 'block.reserve', HUMAN, { block: '_unmapped', agent: 'cc-a', intent: '' }, t + 3);
  assert.equal(checkEvent(st, drag, t + 3), null);
  st = apply(st, drag);
  assert.deepEqual([st.items[id].assignee, st.items[id].status, st.blocks._unmapped.holder, st.blocks._unmapped.queued], ['cc-a', 'doing', null, null]);
  // With nothing queued there, it is still no block to reserve.
  assert.match(checkEvent(st, makeEvent(st, 'block.reserve', 'cc-a', { block: '_unmapped' }, t + 4), t + 4), /no block anyone can reserve/);
});

test('an item filed by mistake is deleted: off the queue and out of its asker\'s questions, by the person or its filer (B20)', async () => {
  const { queueEntries } = await import('../core/model.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 0);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Typo task', block: 'engine' } }, 0);
  run(st, 'item.add', 'a1', { item: { kind: 'bug', title: 'Not a bug', block: 'engine' } }, 0);
  run(st, 'item.add', 'a1', { item: { kind: 'question', title: 'Never mind?', block: 'engine' } }, 1);
  run(st, 'block.queue', HUMAN, { block: 'engine', item: 'T1' }, 1);
  assert.deepEqual(queueEntries(st).map((q) => q.item), ['T1']);
  // Someone else's item isn't an agent's to delete; a missing one is refused.
  assert.match(ev(st, 'item.delete', 'a2', { item: 'B1' }, 2).why, /filed by Heron/);
  assert.match(ev(st, 'item.delete', HUMAN, { item: 'T9' }, 2).why, /No item T9/);
  run(st, 'item.delete', HUMAN, { item: 'T1' }, 2);
  assert.equal(st.items.T1, undefined);
  assert.deepEqual(queueEntries(st), []);
  // A deleted id is never handed out again.
  assert.equal(makeEvent(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Next' } }, at(2)).item.id, 'T2');
  assert.equal(st.blocks.engine.queued, null);
  run(st, 'item.delete', 'a1', { item: 'B1' }, 3);
  assert.equal(st.items.B1, undefined);
  assert.equal(presence(st, 'a1', at(4)), 'waiting');
  run(st, 'item.delete', HUMAN, { item: 'Q1' }, 4);
  assert.deepEqual(st.agents.a1.asked, []);
  assert.notEqual(presence(st, 'a1', at(5)), 'waiting');
});

test('queued work goes to the free agent with the most context for it, the same way every time (T53)', async () => {
  const { queuePlan } = await import('../core/model.js');
  const make = () => {
    const st = createState(BOARD);
    run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
    run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 1);
    run(st, 'agent.join', 'a3', { agent: { id: 'a3', name: 'Wren' } }, 2);
    // Basalt edited Tables a while back and reserved it once; Heron edited the engine just now.
    run(st, 'block.reserve', 'a2', { agent: 'a2', block: 'tables' }, 3);
    run(st, 'touch', 'a2', { files: ['src/table.ts'], op: 'edit' }, 4);
    run(st, 'block.release', 'a2', { agent: 'a2', block: 'tables', outcome: 'landed' }, 5);
    run(st, 'touch', 'a1', { files: ['src/engine/x.ts'], op: 'edit' }, 50);
    run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Pivot totals', block: 'tables' } }, 51);
    run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Faster pass', block: 'engine' } }, 51);
    run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Readme', block: 'pass' } }, 51);
    run(st, 'block.queue', HUMAN, { block: 'tables', item: 'T1' }, 52);
    run(st, 'block.queue', HUMAN, { block: 'engine', item: 'T2' }, 52);
    run(st, 'block.queue', HUMAN, { block: 'pass', item: 'T3' }, 52);
    return st;
  };
  const st = make();
  const plan = queuePlan(st, ['a1', 'a2', 'a3'], at(60));
  // Queue order is the priority; each entry goes to whoever knows its block, one entry each.
  assert.deepEqual(plan.map((p) => [p.entry.item, p.agent]), [['T1', 'a2'], ['T2', 'a1'], ['T3', 'a3']]);
  assert.match(plan[0].why, /edited Tables once, reserved it once/);
  assert.match(plan[2].why, /idle longest/);
  // The same log gives the same plan.
  assert.deepEqual(queuePlan(make(), ['a1', 'a2', 'a3'], at(60)).map((p) => p.agent), plan.map((p) => p.agent));
  // Context fades: long enough after, nobody has much left, and ties go to the agent idle longest.
  assert.ok(queuePlan(st, ['a1', 'a2'], at(60))[0].points > queuePlan(st, ['a1', 'a2'], at(60 * 24))[0].points);
  // Only free agents take work; with one free agent, it takes the first entry it can and the rest waits.
  assert.deepEqual(queuePlan(st, ['a3'], at(60)).map((p) => [p.entry.item, p.agent]), [['T1', 'a3']]);
  // A block someone reserves waits for them, whoever knows it better.
  run(st, 'block.reserve', 'a1', { agent: 'a1', block: 'tables' }, 61);
  assert.deepEqual(queuePlan(st, ['a2', 'a3'], at(62)).map((p) => p.entry.item), ['T2', 'T3']);
  assert.equal(queuePlan(st, ['a1', 'a2'], at(62))[0].agent, 'a1');
});

test('the board hands queued work to the free agent who already knows it, the same way every time (T53)', async () => {
  const { planWakes } = await import('../core/launch.js');
  const st = createState(BOARD);
  const sid = (n) => `${n}0000000-0000-4000-8000-000000000000`;
  const agent = (n) => `cc-${n}0000000`;
  for (const n of ['a', 'b']) run(st, 'agent.join', agent(n), { agent: { id: agent(n) } }, 0);
  // b worked in Tables an hour ago; a never did.
  run(st, 'block.reserve', agent('b'), { block: 'tables', take: [] }, 1);
  run(st, 'touch', agent('b'), { files: ['src/ui/table.ts'], op: 'edit' }, 2);
  run(st, 'block.release', agent('b'), { block: 'tables' }, 3);
  for (const n of ['a', 'b']) run(st, 'agent.status', agent(n), { status: 'review' }, 4);
  run(st, 'item.add', HUMAN, { item: { kind: 'bug', title: 'Pivot drifts', block: 'tables' } }, 5);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Fix the pass', block: 'engine' } }, 5);
  run(st, 'block.queue', HUMAN, { block: 'tables', item: 'B1' }, 6);
  run(st, 'block.queue', HUMAN, { block: 'engine', item: 'T1' }, 6);
  const sessions = ['a', 'b'].map((n) => ({ id: `${n}0000000`, sessionId: sid(n), kind: 'background', status: 'idle', cwd: '/r' }));
  const memory = () => ({ woken: new Map(), nudged: new Set([agent('a'), agent('b')]) });
  const plans = planWakes(st, sessions, at(60), memory());
  const got = Object.fromEntries(plans.map((p) => [p.agent, p.claim?.take?.[0]]));
  // B1 is first in line, and b knows Tables: b takes it, though a comes first and has been idle as long.
  assert.deepEqual(got, { [agent('b')]: 'B1', [agent('a')]: 'T1' });
  assert.match(plans.find((p) => p.agent === agent('b')).reasons.find((r) => r.kind === 'queue').text, /It came to you because you /);
  // The same state gives the same assignment.
  assert.deepEqual(planWakes(st, sessions, at(60), memory()).map((p) => [p.agent, p.claim?.take?.[0]]), plans.map((p) => [p.agent, p.claim?.take?.[0]]));
});


test('an agent asked to finish and stop takes nothing new until the person resumes it (T38)', async () => {
  const { nextFor, queuePlan, describeEvent } = await import('../core/model.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'cc-aa000000', { agent: { id: 'cc-aa000000', name: 'Ann' } }, 1);
  run(st, 'block.queue', HUMAN, { block: 'tables' }, 2);
  assert.equal(nextFor(st, 'cc-aa000000')?.block, 'tables');
  // Only the person asks it.
  const own = makeEvent(st, 'agent.finish', 'cc-aa000000', { agent: 'cc-aa000000' }, at(3));
  assert.match(checkEvent(st, own, at(3)), /Only the person/);
  run(st, 'agent.finish', HUMAN, { agent: 'cc-aa000000' }, 3);
  assert.ok(st.agents['cc-aa000000'].finishing);
  assert.equal(nextFor(st, 'cc-aa000000'), null);
  assert.deepEqual(queuePlan(st, ['cc-aa000000'], at(4)), []);
  run(st, 'agent.finish', HUMAN, { agent: 'cc-aa000000', on: false }, 5);
  assert.equal(st.agents['cc-aa000000'].finishing, 0);
  assert.equal(nextFor(st, 'cc-aa000000')?.block, 'tables');
  assert.equal(describeEvent(st, makeEvent(st, 'agent.finish', HUMAN, { agent: 'cc-aa000000' }, at(6))), `${st.agents[HUMAN].name} asked Ann to finish and stop`);
});

test('a branch already changing a block counts as context, and Wait for context holds an entry for a busy agent who knows it (T56)', async () => {
  const { queuePlan } = await import('../core/model.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 1);
  run(st, 'agent.join', 'a3', { agent: { id: 'a3', name: 'Wren' } }, 2);
  // Basalt reserved Tables twice before; reserving a block takes its queued items, so this comes first.
  for (const m of [2, 3]) {
    run(st, 'block.reserve', 'a2', { agent: 'a2', block: 'tables' }, m);
    run(st, 'block.release', 'a2', { agent: 'a2', block: 'tables', outcome: 'landed' }, m);
  }
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Pivot totals', block: 'tables' } }, 3);
  run(st, 'block.queue', HUMAN, { block: 'tables', item: 'T1' }, 4);
  // Among Heron and Wren nobody has context: the one idle longest takes it. Wren's branch changing Tables gives Wren the entry.
  assert.equal(queuePlan(st, ['a1', 'a3'], at(5))[0].agent, 'a1');
  const branches = new Map([['a3', new Set(['tables'])]]);
  const p = queuePlan(st, ['a1', 'a3'], at(5), { branches });
  assert.equal(p[0].agent, 'a3');
  assert.match(p[0].why, /its branch changes it/);
  // Basalt is busy and knows Tables: with Wait for context on, the entry waits for Basalt while it's fresh.
  const waiting = queuePlan(st, ['a1'], at(10), { waitMin: 15 });
  assert.equal(waiting.length, 0);
  assert.deepEqual(waiting.waiting.map((w) => [w.entry.item, w.agent]), [['T1', 'a2']]);
  // Off by default, and once the entry has waited its minutes it goes to a free agent after all.
  assert.equal(queuePlan(st, ['a1'], at(10))[0].agent, 'a1');
  assert.equal(queuePlan(st, ['a1'], at(4 + 16), { waitMin: 15 })[0].agent, 'a1');
});

test('qb next takes the queued work the board would give its caller; work another agent knows better waits for them unless --any (T54)', () => {
  const t = tmpBoard();
  try {
    const human = cliIn(t.dir);
    const heron = cliIn(t.dir, 'cc-4e40a000');
    const wren = cliIn(t.dir, 'cc-3e40a000');
    // Heron worked in Tables; both are idle now.
    heron('reserve', 'tables');
    heron('touch', 'src/ui/table.ts');
    heron('release', 'tables');
    wren('doing', 'something');
    for (const id of ['cc-4e40a000', 'cc-3e40a000']) {
      const store = openStore(t.boardDir);
      store.commit([makeEvent(store.state(), 'agent.status', id, { status: 'review' })]);
    }
    human('task', 'Pivot drifts', '--block', 'tables');
    human('queue', 'T1');
    // Wren asks first, but T1 is Heron's by context: Wren is told who and why, and takes nothing.
    const w = wren('next');
    assert.match(w.out, /Nothing in the queue is yours: T1 goes to .* \(.*edit/);
    assert.equal(openStore(t.boardDir).state().blocks.tables.holder, null);
    // Heron takes it.
    assert.match(heron('next').out, /Took T1 from the queue/);
    // With --any, the first takeable entry is taken regardless.
    human('task', 'Fix the pass', '--block', 'engine');
    human('queue', 'T2');
    const store = openStore(t.boardDir);
    store.commit([makeEvent(store.state(), 'agent.status', 'cc-3e40a000', { status: 'review' })]);
    assert.match(wren('next', '--any').out, /Took T2 from the queue/);
  } finally {
    t.done();
  }
});

test('the stress board is the same every run, and as big as T57 says', async () => {
  const { stressBoard } = await import('../scripts/stress.js');
  const a = stressBoard();
  const b = stressBoard();
  assert.equal(a.events.length, 48_000);
  assert.deepEqual([a.events[100].id, a.events.at(-1).id, a.events.at(-1).ts], [b.events[100].id, b.events.at(-1).id, b.events.at(-1).ts]);
  const st = reduce({ ...a.board, items: [] }, a.events);
  const hot = Object.values(st.items).filter((it) => it.block === 'side');
  assert.equal(hot.length, 5000);
  assert.equal(hot.filter((it) => it.status === 'done').length, 3500);
  assert.equal(Object.values(st.items).filter((it) => it.queued).length, 200);
  assert.equal(Object.values(st.items).filter((it) => it.assignee === 'cc-50000000' && it.status === 'open').length, 80);
  assert.equal(Object.values(st.agents).filter((x) => x.id !== HUMAN).length, 20);
});

test('under Wait for context, qb next leaves an entry to the busy agent who knows it and says so (T58)', () => {
  const t = tmpBoard({ ...BOARD, waitForContext: 10 });
  try {
    const human = cliIn(t.dir);
    const heron = cliIn(t.dir, 'cc-4e40b000');
    const wren = cliIn(t.dir, 'cc-3e40b000');
    heron('reserve', 'tables');
    for (let i = 0; i < 4; i++) heron('touch', 'src/ui/table.ts');
    heron('release', 'tables');
    heron('reserve', 'engine');
    heron('doing', 'busy in Engine');
    wren('doing', 'x');
    const store = openStore(t.boardDir);
    store.commit([makeEvent(store.state(), 'agent.status', 'cc-3e40b000', { status: 'review' })]);
    human('task', 'Pivot drifts', '--block', 'tables');
    human('queue', 'T1');
    const w = wren('next');
    assert.match(w.out, /T1 goes to .* \(waiting for them, busy now: edited/);
    assert.equal(openStore(t.boardDir).state().blocks.tables.holder, null);
    assert.match(wren('next', '--any').out, /Took T1 from the queue/);
  } finally {
    t.done();
  }
});

test('Auto-Apply applies a suggestion as the person would, leaves out work someone is doing, and can be undone (T59)', async () => {
  const { autoApplyEvents, undoApplyEvents, suggestionPlan } = await import('../core/model.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 0);
  run(st, 'agent.join', 'a3', { agent: { id: 'a3', name: 'Wren' } }, 0);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Pivot', block: 'tables' } }, 1);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Pass', block: 'pass' } }, 1);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Engine', block: 'engine' } }, 1);
  // Heron is working in the engine right now.
  run(st, 'block.reserve', 'a1', { agent: 'a1', block: 'engine' }, 2);
  run(st, 'touch', 'a1', { files: ['src/engine/x.ts'], op: 'edit' }, 3);
  run(st, 'item.add', 'a3', { item: { kind: 'suggestion', title: 'split', plan: [{ agent: 'a2', item: 'T1' }, { agent: 'a3', item: 'T2' }, { agent: 'a2', item: 'T3' }] } }, 4);
  const commitAll = (evs, min) => {
    for (const { type, ...payload } of evs) run(st, type, HUMAN, payload, min);
  };
  // The person's Apply takes everything; Auto-Apply leaves T3 (Heron is working in its block) for the person.
  assert.equal(suggestionPlan(st, 'S1').given.length, 3);
  const evs = autoApplyEvents(st, 'S1', at(5));
  assert.ok(evs.at(-1).text.startsWith("Applied Wren's S1: T1 to Basalt, T2 to Wren. Left for you: T3 (Heron is working in Engine)"));
  commitAll(evs, 5);
  assert.equal(st.items.T1.assignee, 'a2');
  assert.equal(st.blocks.tables.holder, 'a2');
  assert.equal(st.items.S1.status, 'open');
  // It isn't applied twice, and a second suggestion can't take back what the first moved.
  assert.equal(autoApplyEvents(st, 'S1', at(6)), null);
  run(st, 'item.add', 'a1', { item: { kind: 'suggestion', title: 'mine', plan: [{ agent: 'a1', item: 'T1' }] } }, 6);
  assert.match(autoApplyEvents(st, 'S2', at(7)).at(-1).text, /Left for you: T1 \(another suggestion moved it first\)/);
  // Undo puts it all back and tells the agents.
  const note = st.notes.at(-1);
  assert.deepEqual(note.applied.reserved.map((r) => r.block).sort(), ['pass', 'tables']);
  commitAll(undoApplyEvents(st, note), 8);
  assert.equal(st.items.T1.assignee, null);
  assert.equal(st.blocks.tables.holder, null);
  assert.match(st.agents.a2.inbox.at(-1).text, /undid S1: drop T1/);
  assert.equal(st.items.S1.status, 'open');
  assert.equal(autoApplyEvents(st, 'S1', at(9)), null);
  // Only the board records an Auto-Apply.
  assert.match(ev(st, 'note', 'a1', { text: 'x', applied: { suggestion: 'S1', prev: [], reserved: [] } }, 9).why, /Only the board/);
});

test('a reservation records who made it: the agent, or the person giving it the block (B28)', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1' } }, 0);
  run(st, 'block.reserve', 'a1', { block: 'engine', take: [] }, 1);
  assert.deepEqual([st.blocks.engine.holder, st.blocks.engine.by], ['a1', 'a1']);
  run(st, 'block.reserve', HUMAN, { block: 'tables', agent: 'a1', take: [] }, 2);
  assert.deepEqual([st.blocks.tables.holder, st.blocks.tables.by], ['a1', HUMAN]);
});

test('the board wakes an agent for a block the person gave it, never for one it reserved itself (B28)', async () => {
  const { planWakes } = await import('../core/launch.js');
  const st = createState(BOARD);
  const id = 'cc-b2800000';
  const sessions = [{ id: 'b2800000', sessionId: 'b2800000-0000-4000-8000-000000000000', kind: 'background', status: 'idle', cwd: '/r' }];
  run(st, 'agent.join', id, { agent: { id } }, 0);
  run(st, 'agent.status', id, { status: 'review' }, 1);
  // It reserves a block itself and its turn goes on to end: nothing to wake it for.
  run(st, 'block.reserve', id, { block: 'engine', take: [] }, 2);
  const memory = { woken: new Map(), nudged: new Set([id]) };
  assert.deepEqual(planWakes(st, sessions, at(3), memory), []);
  // The person gives it another: that wakes it.
  run(st, 'block.reserve', HUMAN, { block: 'tables', agent: id, take: [] }, 4);
  run(st, 'agent.status', id, { status: 'review' }, 3.5);
  const plans = planWakes(st, sessions, at(5), memory);
  assert.match(plans[0].reasons.find((r) => r.kind === 'blocks').text, /reserved tables for you/);
  assert.doesNotMatch(plans[0].reasons.find((r) => r.kind === 'blocks').text, /engine/);
});

test('Changes: each block gets its agents, lines, stages and overlapping files from every checkout (T61)', async () => {
  const { changesByBlock } = await import('../core/merges.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'cc-aa000000', { agent: { id: 'cc-aa000000', name: 'Ann' } }, 1);
  run(st, 'agent.join', 'cc-bb000000', { agent: { id: 'cc-bb000000', name: 'Bob' } }, 1);
  run(st, 'merge.ready', 'cc-bb000000', { worktree: 'two', branch: 'two', commit: 'abc', ahead: 1 }, 2);
  const snap = {
    list: [
      { name: 'main', main: true, changes: [
        { file: 'src/engine/pass.ts', add: 10, del: 2, stage: 'uncommitted', agent: 'cc-aa000000' },
        { file: 'src/engine/core.ts', add: 5, del: 0, stage: 'committed', agent: 'cc-aa000000' },
      ] },
      { name: 'two', changes: [
        { file: 'src/engine/core.ts', add: 3, del: 1, stage: 'committed', agent: 'cc-bb000000' },
        { file: 'README.md', add: 1, del: 0, stage: 'uncommitted', agent: '' },
      ] },
    ],
  };
  const out = changesByBlock(st, snap);
  const engine = out.get('engine');
  assert.equal(engine.add, 8);
  // Biggest first; Bob's committed work is queued to merge with its worktree.
  assert.deepEqual(engine.agents.map((a) => [a.agent, a.add, a.del, a.stage]), [['cc-aa000000', 5, 0, 'committed'], ['cc-bb000000', 3, 1, 'queued']]);
  assert.deepEqual(engine.overlap, ['src/engine/core.ts']);
  // The most specific pattern wins: pass.ts is The pass's, uncommitted, Ann's.
  assert.deepEqual(out.get('pass').agents.map((a) => [a.agent, a.stage, a.add]), [['cc-aa000000', 'uncommitted', 10]]);
  // A file nobody is known to have edited still counts, under no one.
  assert.deepEqual(out.get('tables').agents.map((a) => a.agent), ['']);
});

test('who the board nudged survives a restart: the memory is rebuilt from the log (B29)', async () => {
  const { memoryFromLog } = await import('../core/launch.js');
  // The log a freshly started server reads: a1 nudged; a2 nudged, then given a block (a new idle stretch); a3 only
  // woken for a message.
  const events = [];
  const s2 = createState(BOARD);
  for (const id of ['a1', 'a2', 'a3']) events.push(makeEvent(s2, 'agent.join', id, { agent: { id } }, at(0)));
  events.push({ type: 'note', by: HUMAN, ts: at(1), wake: { agent: 'a1', why: ['nudge'] } });
  events.push({ type: 'note', by: HUMAN, ts: at(1), wake: { agent: 'a2', why: ['nudge'] } });
  events.push({ type: 'block.reserve', by: HUMAN, agent: 'a2', block: 'engine', ts: at(2) });
  events.push({ type: 'note', by: HUMAN, ts: at(3), wake: { agent: 'a3', why: ['inbox'] } });
  const m = memoryFromLog(events);
  assert.deepEqual([...m.nudged], ['a1']);
  assert.deepEqual([...m.woken.keys()].sort(), ['a1', 'a2', 'a3']);
  assert.equal(m.woken.get('a3'), at(3));
});

test('a Bash command\'s edits are the files git sees change between before and after it (B30)', async () => {
  const { dirtySnapshot, editedBetween } = await import('../hooks/bashedits.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bash-')));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'kept.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'dirty.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  fs.writeFileSync(path.join(root, 'dirty.txt'), 'b\n');
  const before = dirtySnapshot(root);
  assert.deepEqual(Object.keys(before.files), ['dirty.txt']);
  // The command: edits a committed file, creates one, and leaves the already-dirty one alone.
  fs.writeFileSync(path.join(root, 'kept.txt'), 'changed\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'new.txt'), 'n\n');
  assert.deepEqual(editedBetween(before, dirtySnapshot(root)).sort(), ['kept.txt', 'sub/new.txt']);
  // Saving the dirty one again counts once its time moves.
  const again = dirtySnapshot(root);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'dirty.txt'), t, t);
  assert.deepEqual(editedBetween(again, dirtySnapshot(root)), ['dirty.txt']);
  assert.equal(dirtySnapshot(os.tmpdir()), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an item typed into Up next has no block: it is queued as filed, anyone takes it, and it comes back as the team\'s (B31)', async () => {
  const { queueEntries, nextFor, queuePlan } = await import('../core/model.js');
  const st = createState(BOARD);
  run(st, 'agent.join', 'a1', { agent: { id: 'a1', name: 'Heron' } }, 0);
  run(st, 'agent.join', 'a2', { agent: { id: 'a2', name: 'Basalt' } }, 1);
  // Only a task or bug with no block goes straight into the queue.
  assert.match(ev(st, 'item.add', HUMAN, { queue: true, item: { kind: 'task', title: 'x', block: 'engine' } }, 1).why, /no block/);
  assert.match(ev(st, 'item.add', HUMAN, { queue: true, item: { kind: 'question', title: 'x?' } }, 1).why, /no block/);
  run(st, 'item.add', HUMAN, { queue: true, item: { kind: 'task', title: 'Make the footer quieter' } }, 2);
  assert.deepEqual(queueEntries(st).map((q) => [q.item, q.block]), [['T1', null]]);
  // Anyone can take it; with no context anywhere, the agent idle longest.
  assert.equal(nextFor(st, 'a2').item, 'T1');
  assert.deepEqual(queuePlan(st, ['a1', 'a2'], at(3)).map((p) => [p.entry.item, p.agent]), [['T1', 'a1']]);
  // Taken: given and doing, off the queue. Returned: the team's again, open, back on the queue.
  run(st, 'item.update', HUMAN, { item: 'T1', assignee: 'a1', status: 'doing', note: 'taken from the queue' }, 4);
  assert.deepEqual(queueEntries(st), []);
  run(st, 'block.queue', 'a1', { item: 'T1' }, 5);
  assert.equal(st.items.T1.assignee, null);
  assert.equal(st.items.T1.status, 'open');
  assert.deepEqual(queueEntries(st).map((q) => q.item), ['T1']);
  // An item with a block still queues with its block.
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Pass', block: 'pass' } }, 6);
  assert.match(ev(st, 'block.queue', HUMAN, { item: 'T2' }, 6).why, /belongs to pass; queue it with its block/);
  run(st, 'block.unqueue', HUMAN, { item: 'T1' }, 7);
  assert.deepEqual(queueEntries(st), []);
});

test('an edit made before its file joined a block is not a trespass in that block (B32)', () => {
  const st = createState(BOARD);
  run(st, 'agent.join', 'cc-aa000000', { agent: { id: 'cc-aa000000', name: 'Ann' } }, 1);
  run(st, 'agent.join', 'cc-bb000000', { agent: { id: 'cc-bb000000', name: 'Bob' } }, 1);
  run(st, 'block.reserve', 'cc-bb000000', { agent: 'cc-bb000000', block: 'tables' }, 2);
  // makeEvent stamps the block each file is in as the edit happens.
  const now = makeEvent(st, 'touch', 'cc-aa000000', { files: ['README.md', 'nowhere/x.txt'], op: 'edit' }, at(3));
  assert.deepEqual(now.blocks, ['tables', '_unmapped']);
  // Ann edited it while no block claimed it; the board has since put it in Tables, which Bob holds.
  apply(st, { ...makeEvent(st, 'touch', 'cc-aa000000', { files: ['README.md'], op: 'edit' }, at(4)), blocks: ['_unmapped'] });
  assert.equal(alerts(st, at(5)).filter((a) => a.kind === 'trespass').length, 0);
  // Its activity still counts in the block it is in now.
  assert.equal(st.blocks.tables.touches.at(-1).agent, 'cc-aa000000');
  // An edit stamped in Tables while Bob held it is one.
  apply(st, makeEvent(st, 'touch', 'cc-aa000000', { files: ['README.md'], op: 'edit' }, at(6)));
  assert.equal(alerts(st, at(7)).filter((a) => a.kind === 'trespass').length, 1);
});

test('qb names a queued item with no block as such, not "in null" (B33)', async () => {
  const { summary } = await import('../cli.js');
  const st = createState(BOARD);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Loose end' }, queue: true }, 0);
  run(st, 'item.add', HUMAN, { item: { kind: 'task', title: 'Fix the pass', block: 'engine' } }, 0);
  run(st, 'block.queue', HUMAN, { block: 'engine', item: 'T2' }, 1);
  const line = summary(st, at(2)).split('\n').find((l) => l.startsWith('Up next'));
  assert.match(line, /T1, no block yet/);
  assert.match(line, /T2 in engine/);
  assert.doesNotMatch(line, /null/);
});

test('an idle agent with work lined up from before its turn ended is woken to take it, at most every 10 minutes for the same work', async () => {
  const { planWakes } = await import('../core/launch.js');
  let st = createState({ name: 't', districts: [{ id: 'd', name: 'D' }], blocks: [{ id: 'b', name: 'B', district: 'd', paths: ['b/'] }] });
  const t0 = Date.now() - 600_000;
  st = apply(st, makeEvent(st, 'agent.join', 'cc-a', { agent: { id: 'cc-a' } }, t0));
  st = apply(st, makeEvent(st, 'item.add', HUMAN, { item: { kind: 'bug', title: 'Lined-up bug', block: 'b', id: 'B1' } }, t0 + 1));
  st = apply(st, makeEvent(st, 'item.update', HUMAN, { item: 'B1', assignee: 'cc-a', status: 'open' }, t0 + 2));
  // Its turn ends after the item was given: no 'given' reason, but it still has the work.
  st = apply(st, makeEvent(st, 'agent.status', 'cc-a', { status: 'review' }, t0 + 3));
  const memory = { woken: new Map(), nudged: new Set() };
  const s = [{ kind: 'pty', status: 'idle', agent: 'cc-a', sock: 'x', id: 'pty:cc-a' }];
  const now = Date.now();
  const first = planWakes(st, s, now, memory, { settleMs: 0 });
  assert.deepEqual(first.map((p) => p.reasons.map((r) => r.kind)), [['lined']]);
  assert.match(first[0].reasons[0].text, /B1 \(Lined-up bug\)/);
  assert.deepEqual(planWakes(st, s, now + 60_000, memory, { settleMs: 0 }), [], 'the same lined-up work does not wake it again within 10 minutes');
  assert.equal(planWakes(st, s, now + 11 * 60_000, memory, { settleMs: 0 }).length, 1);
});

test('the page reloads onto a commit, not a save: the code stamp is the install\'s git HEAD (T83)', async () => {
  const { codeStampOf } = await import('../server.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-stamp-')));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  assert.equal(codeStampOf(root), 'v9.9.9');
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'a.js'), '1');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
  const one = git('rev-parse', 'HEAD');
  assert.equal(codeStampOf(root), one);
  // A save is not a version.
  fs.writeFileSync(path.join(root, 'a.js'), '2');
  assert.equal(codeStampOf(root), one);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two');
  const two = git('rev-parse', 'HEAD');
  assert.notEqual(two, one);
  assert.equal(codeStampOf(root), two);
  // Packed refs, and a detached HEAD.
  git('pack-refs', '--all');
  assert.equal(codeStampOf(root), two);
  git('checkout', '-q', one);
  assert.equal(codeStampOf(root), one);
  fs.rmSync(root, { recursive: true, force: true });
});
