// The board server: serves the UI, the board and the log, and streams every new event to open
// pages over server-sent events. It tails the log file, so events written by the CLI or the hooks
// (with no server involved) still reach the page within a second. Zero dependencies.
//
// Each streamed batch carries the log's byte offset after it as its event id, so a page that reconnects
// (the browser sends the last id it saw) gets exactly what it missed, in the log's order.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordServer, forgetServer } from './core/daemon.js';
import { openStore, findBoardDir, parseLines } from './core/store.js';
import { makeEvent, HUMAN, SYSTEM, worktreeAgentId, presence, autoApplyEvents } from './core/model.js';
import { worktreeSnapshot, landed, changedBetween } from './core/worktrees.js';
import { agentsInWorktree, branchBlocks } from './core/merges.js';
import { startSession, listSessions, planWakes, wakePrompt, wakeSession, typeInto, memoryFromLog } from './core/launch.js';
import { sessionAgentId } from './core/identity.js';
import { blockForPath } from './core/glob.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const STATIC_ROOTS = ['ui', 'core', 'adapters'];

export function pageHtml(fragment) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="queuebox" content="server"></head><body>\n${fragment}\n</body></html>`;
}

// Without a token the board answers only to this machine: it binds a loopback address, and a request whose Host
// names anything else (another site's page reaching it through DNS rebinding) is turned away.
export function isLoopbackBind(host) {
  return ['localhost', '::1', '[::1]'].includes(String(host).toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host);
}
export function isLoopbackHostHeader(header) {
  const m = /^(\[[^\]]*\]|[^:\[\]]+)(?::\d+)?$/.exec(String(header || ''));
  return !!m && (['localhost', '[::1]'].includes(m[1].toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(m[1]));
}

export async function serve({ port = 4477, host = '127.0.0.1', open = false, quiet = false } = {}) {
  const token = process.env.QUEUEBOX_TOKEN || '';
  if (!isLoopbackBind(host) && !token) {
    throw new Error(`Serving on ${host} would let anyone who can reach it change the board. Set QUEUEBOX_TOKEN, or serve on 127.0.0.1.`);
  }
  const store = openStore(findBoardDir());
  let board = store.board({ items: true, files: true, samples: 14 });
  // The log as the page sees it: the events, and the byte offset just past each one's line.
  let events = [];
  let ends = [];
  let lineEnd = 0;
  const clients = new Set();
  const timers = [];
  const closers = [];
  const every = (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    timers.push(t);
  };

  const send = (res, type, data, id) => res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (type, data, id) => {
    for (const res of clients) send(res, type, data, id);
  };

  // Reads the log from byte `from` to its last whole line: the events, each one's end offset, and where it stopped.
  function readFrom(from) {
    let fd;
    try {
      fd = fs.openSync(store.eventsPath, 'r');
    } catch {
      return { list: [], at: [], end: from };
    }
    try {
      const total = fs.fstatSync(fd).size;
      if (total <= from) return { list: [], at: [], end: from };
      const buf = Buffer.alloc(total - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const stop = buf.lastIndexOf(10) + 1;
      const list = [];
      const at = [];
      for (let pos = 0; pos < stop; ) {
        const nl = buf.indexOf(10, pos);
        const [e] = parseLines(buf, pos, nl);
        if (e) {
          list.push(e);
          at.push(from + nl + 1);
        }
        pos = nl + 1;
      }
      return { list, at, end: from + stop };
    } finally {
      fs.closeSync(fd);
    }
  }

  function reload() {
    const r = readFrom(0);
    events = r.list;
    ends = r.at;
    lineEnd = r.end;
  }
  reload();

  function poll() {
    const now = size(store.eventsPath);
    if (now < lineEnd) {
      reload();
      broadcast('reset', { events }, lineEnd);
      return;
    }
    if (now === lineEnd) return;
    const r = readFrom(lineEnd);
    if (r.end === lineEnd) return;
    lineEnd = r.end;
    if (r.list.length) {
      events.push(...r.list);
      ends.push(...r.at);
      broadcast('events', r.list, lineEnd);
    }
  }

  // The events after a byte offset a page last saw, or null when the offset is past this log's end (it was
  // cut short or replaced since).
  function since(offset) {
    if (offset > lineEnd) return null;
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return events.slice(lo);
  }

  fs.mkdirSync(store.live, { recursive: true });
  let pending = null;
  const kick = () => {
    clearTimeout(pending);
    pending = setTimeout(poll, 40);
    pending.unref();
  };
  try {
    const w = fs.watch(store.live, kick);
    w.unref();
    closers.push(() => w.close());
  } catch {
    // Polling below covers file systems without watch.
  }
  every(poll, 1000);

  const watched = [store.boardPath, ...board.sources.filter((s) => s.file).map((s) => path.join(store.home, s.file))];
  const reloadBoard = () => {
    try {
      board = store.board({ items: true, files: true, samples: 14 });
      broadcast('board', board);
    } catch (err) {
      broadcast('problem', { message: `The board config didn't load: ${err.message}` });
    }
  };
  for (const f of watched) {
    try {
      fs.watchFile(f, { interval: 1500 }, reloadBoard).unref();
      closers.push(() => fs.unwatchFile(f, reloadBoard));
    } catch {
      // A missing source just never reloads.
    }
  }
  every(() => broadcast('ping', { ts: Date.now() }), 20_000);

  // The board manages idle agents (B1, on the person's word): every few seconds it asks Claude Code which
  // background sessions are idle, and wakes one that something on the board is waiting for: a message or answer,
  // an item or block the person gave it, queued work (reserved for it first, under the store lock, so one agent
  // per block), or the once-per-idle-stretch planning nudge. Each wake is logged. The Nudge switch
  // (board.nudgeIdle) turns it off; so does QUEUEBOX=off or QUEUEBOX_WAKE=off for the server.
  // Rebuilt from the log, so a restart doesn't nudge every idle agent again (B29).
  const wakeMemory = memoryFromLog(store.readEvents());
  // One wake: reserve its queued block first (under the lock; someone faster means it wakes only for the rest),
  // wake the session, log it. Returns the note's text, or null when nothing was left to wake it for.
  async function runWake(plan) {
    if (plan.claim) {
      try {
        // An item with no block (B31) is given, not reserved with a block.
        if (!plan.claim.block) {
          const gone = plan.claim.take.find((item) => !store.state().items[item]?.queued);
          if (gone) throw Object.assign(new Error(`${gone} was taken meanwhile`), { refused: true });
          store.commit(plan.claim.take.map((item) => makeEvent(store.state(), 'item.update', HUMAN, { item, assignee: plan.agent, status: 'doing', note: 'taken from the queue' })));
        }
        else store.commit([makeEvent(store.state(), 'block.reserve', HUMAN, { block: plan.claim.block, agent: plan.agent, intent: plan.claim.intent, take: plan.claim.take || [] })]);
      } catch (err) {
        if (!err.refused) throw err;
        plan.reasons = plan.reasons.filter((r) => r.kind !== 'queue');
        if (!plan.reasons.length) return null;
      }
    }
    wakeMemory.woken.set(plan.agent, Date.now());
    if (plan.reasons.some((r) => r.kind === 'nudge')) wakeMemory.nudged.add(plan.agent);
    let failed = '';
    try {
      if (plan.session.kind === 'pty') await typeInto(plan.session.sock, wakePrompt(plan));
      else await wakeSession(plan.session, wakePrompt(plan));
    } catch (err) {
      failed = err.message;
    }
    const name = store.state().agents[plan.agent]?.name || plan.agent;
    const why = plan.reasons.map((r) => ({ inbox: 'messages', given: 'items given', lined: 'its lined-up work', blocks: 'blocks given', queue: `queued ${plan.claim?.take?.[0] || plan.claim?.block}`, nudge: 'planning', person: 'the person asked' })[r.kind]).join(', ');
    const text = failed ? `Couldn't wake ${name} (${why}): ${failed}` : `Woke ${name}: ${why}.`;
    store.commit([makeEvent(store.state(), 'note', HUMAN, { text, wake: { agent: plan.agent, session: plan.session.id, why: plan.reasons.map((r) => r.kind), ok: !failed } })]);
    poll();
    return { text, ok: !failed };
  }
  // Agents `qb run` put in a terminal QueueBox owns: the board types into them (any agent CLI). Only sockets in this
  // board's own ptys folder that still exist count; whether one is idle is the board's own presence check.
  const ptyDir = path.join(store.live, 'ptys');
  function ptySessions() {
    return Object.values(store.state().agents)
      .filter((a) => a.pty && !a.leftAt && path.dirname(a.pty) === ptyDir && fs.existsSync(a.pty))
      .map((a) => ({ kind: 'pty', status: 'idle', agent: a.id, sock: a.pty, id: `pty:${a.id}`, cwd: a.worktree || store.root }));
  }
  let waking = false;
  // Which agents run as background sessions, and idle or busy, for the page (a message to an idle background agent
  // wakes it; to one in a terminal it waits for its next prompt): sent on change and to each new page (T28).
  let sessionsSeen = '{}';
  async function manageIdle() {
    if (waking || process.env.QUEUEBOX === 'off' || process.env.QUEUEBOX_WAKE === 'off') return;
    waking = true;
    try {
      const ptys = ptySessions();
      const all = [...(await listSessions()), ...ptys];
      const byAgent = Object.fromEntries(all.map((x) => [x.agent || sessionAgentId(x.sessionId), { kind: x.kind, status: x.status || '' }]));
      const seen = JSON.stringify(byAgent);
      if (seen !== sessionsSeen) {
        sessionsSeen = seen;
        broadcast('sessions', byAgent);
      }
      if (board.nudgeIdle === false) return;
      const sessions = all.filter((s) => s.kind === 'background' || s.kind === 'pty');
      if (!sessions.length) return;
      const cli = path.join(HERE, 'qb');
      const st = store.state();
      const branches = worktrees ? branchBlocks(st, worktrees) : null;
      for (const plan of planWakes(st, sessions, Date.now(), wakeMemory, { cli, branches })) await runWake(plan);
    } catch (err) {
      broadcast('problem', { message: `Waking idle agents failed: ${err.message}` });
    } finally {
      waking = false;
    }
  }
  every(manageIdle, Number(process.env.QUEUEBOX_WAKE_MS) || 5000);

  // Auto-Apply (T59): with the person's standing yes (board.autoApply), each open suggestion is applied as it lands,
  // within the model's guards, as the person, one suggestion per commit so a later one sees what an earlier one
  // moved. The agents given work are woken like any assignment.
  const applyRefused = new Set();
  function autoApply() {
    if (board.autoApply !== true) return;
    for (;;) {
      const st = store.state();
      const sug = Object.values(st.items).find((it) => it.kind === 'suggestion' && it.status === 'open' && !applyRefused.has(it.id) && autoApplyEvents(st, it.id));
      if (!sug) return;
      try {
        const evs = autoApplyEvents(st, sug.id, Date.now());
        store.commit(evs.map(({ type, ...payload }) => makeEvent(st, type, HUMAN, payload)));
        poll();
      } catch (err) {
        // Refused (a block taken meanwhile, say): it stays a suggestion for the person, and the board says why once.
        applyRefused.add(sug.id);
        broadcast('problem', { message: `Couldn't apply ${sug.id}: ${err.message}. It stays a suggestion for you.` });
      }
    }
  }
  every(autoApply, 2000);

  // The page's own code: a stamp of the newest file under ui/ and core/, sent to each page as 'version' when it
  // connects and again when that code changes (half a second after the last change, since a commit touches several
  // files), so an open page can reload itself onto new code (T33).
  const codeStamp = () => {
    let newest = 0;
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, d.name);
        if (d.isDirectory()) walk(f);
        else if (/\.(js|css|html|svg)$/.test(d.name)) newest = Math.max(newest, fs.statSync(f).mtimeMs);
      }
    };
    try {
      for (const dir of ['ui', 'core']) walk(path.join(HERE, dir));
    } catch {
      // A file moved while walking: the next look settles it.
    }
    return String(Math.round(newest));
  };
  let version = codeStamp();
  let versionSeen = version;
  let versionTimer = null;
  every(() => {
    const now = codeStamp();
    if (now === versionSeen) return;
    versionSeen = now;
    clearTimeout(versionTimer);
    versionTimer = setTimeout(() => {
      version = versionSeen;
      broadcast('version', { v: version });
    }, Number(process.env.QUEUEBOX_VERSION_SETTLE_MS) || 500);
    versionTimer.unref?.();
  }, Number(process.env.QUEUEBOX_VERSION_MS) || 1000);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!token && !isLoopbackHostHeader(req.headers.host)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('This board answers only on localhost. Set QUEUEBOX_TOKEN to serve it to other machines.');
      }
      if (url.pathname.startsWith('/api/')) {
        if (token && req.headers.authorization !== `Bearer ${token}` && url.searchParams.get('token') !== token) return json(res, 401, { error: 'This board needs its token.' });
        return await api(req, res, url);
      }
      return serveStatic(res, url.pathname);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  async function api(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/board') return json(res, 200, board);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      poll();
      const after = Number(url.searchParams.get('since') || 0);
      return json(res, 200, after ? events.filter((e) => e.ts > after) : events, { 'x-queuebox-offset': String(lineEnd) });
    }
    if (req.method === 'GET' && url.pathname === '/api/worktrees') return json(res, 200, worktrees || { base: '', at: 0, list: [] });
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      poll();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      send(res, 'hello', { count: events.length });
      // The stamp as it is on disk now, not the settled one: a page loaded while a change is settling already runs
      // the new code, and the settled stamp would arrive a moment later and reload it for nothing (B27).
      send(res, 'version', { v: codeStamp() });
      send(res, 'sessions', JSON.parse(sessionsSeen));
      // Resume where the page left off: the last id the browser saw, else the offset its first read ended at.
      const from = req.headers['last-event-id'] ?? url.searchParams.get('from');
      if (from !== undefined && from !== null && from !== '') {
        const missed = /^\d+$/.test(from) ? since(Number(from)) : null;
        if (missed === null) send(res, 'reset', { events }, lineEnd);
        else if (missed.length) send(res, 'events', missed, lineEnd);
      }
      if (worktrees) send(res, 'worktrees', worktrees);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    if (req.method === 'POST' && url.pathname === '/api/commit') {
      // A custom header keeps other sites' pages from posting here: a cross-origin request
      // carrying it needs a preflight this server never answers.
      if (req.headers['x-queuebox'] !== '1') return json(res, 403, { error: 'Send the x-queuebox: 1 header.' });
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'The body is not JSON.' });
      }
      if (!Array.isArray(body?.events)) return json(res, 400, { error: 'Send { "events": [...] }.' });
      const state = store.state();
      const now = Date.now();
      // The server stamps every event's id and time itself; `by` is kept, and checked as an id like the rest.
      const prepared = body.events.map((raw) => {
        const { id, ts, type, by, ...rest } = raw && typeof raw === 'object' ? raw : {};
        const e = makeEvent(state, type, by || HUMAN, rest, now);
        if (e.type === 'merge.ready' && e.ahead === undefined) {
          const wt = worktrees?.list.find((w) => w.name === e.worktree);
          if (wt) e.ahead = wt.ahead;
        }
        return e;
      });
      try {
        const { events: accepted } = store.commit(prepared, now);
        poll();
        return json(res, 200, { accepted });
      } catch (err) {
        return json(res, err.refused ? 409 : 500, { error: err.message });
      }
    }
    // Reshaping the board is the human's act (agents use `qb board`, which checks the same rules): { op, ...args }
    // as core/board-ops.js takes it. The new board goes out on the stream at once rather than on the file poll.
    if (req.method === 'POST' && url.pathname === '/api/board') {
      if (req.headers['x-queuebox'] !== '1') return json(res, 403, { error: 'Send the x-queuebox: 1 header.' });
      let op;
      try {
        op = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, code: 'invalid', message: 'The body is not JSON.' });
      }
      if (!op || typeof op !== 'object' || Array.isArray(op)) return json(res, 400, { ok: false, code: 'invalid', message: 'Send { "op": "...", ... }.' });
      const { by, ...change } = op;
      if (by !== undefined && by !== HUMAN) return json(res, 403, { ok: false, code: 'human', message: 'Only the human reshapes the board from the page; agents use `qb board`.' });
      try {
        store.writeBoard(change, HUMAN);
      } catch (err) {
        if (!err.refused) throw err;
        return json(res, err.code === 'invalid' || err.code === 'unknown' ? 400 : 409, { ok: false, code: err.code, message: err.message });
      }
      reloadBoard();
      poll();
      return json(res, 200, { ok: true, board });
    }
    // The person's Wake on an agent (B12): a background session that has ended its turn is woken with what waits for
    // it (its messages, its next queued work), else asked to look at the board. A session in a terminal can't be.
    if (req.method === 'POST' && url.pathname === '/api/wake') {
      if (req.headers['x-queuebox'] !== '1') return json(res, 403, { error: 'Send the x-queuebox: 1 header.' });
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, message: 'The body is not JSON.' });
      }
      if (body?.by !== undefined && body.by !== HUMAN) return json(res, 403, { ok: false, message: 'Only the person wakes agents.' });
      const st = store.state();
      const agent = st.agents[body?.agent];
      if (!agent || body.agent === HUMAN) return json(res, 400, { ok: false, message: `No agent "${String(body?.agent).slice(0, 60)}".` });
      const session = ptySessions().find((x) => x.agent === agent.id) || (await listSessions()).find((x) => sessionAgentId(x.sessionId) === agent.id);
      if (!session) return json(res, 409, { ok: false, message: `${agent.name} has no session the board can reach. Start it with \`qb run -- claude\` (any agent CLI works), or Start an agent here.` });
      if (session.kind !== 'background' && session.kind !== 'pty') return json(res, 409, { ok: false, message: `${agent.name} is in a plain terminal, which the board can't type into. Restart it under \`qb run -- claude\` and the board can wake it.` });
      const p = presence(st, agent.id, Date.now());
      if (session.kind === 'pty' ? p === 'working' : session.status !== 'idle') return json(res, 409, { ok: false, message: `${agent.name} is working already.` });
      const [plan] = planWakes(st, [session], Date.now(), { woken: new Map(), nudged: new Set(wakeMemory.nudged) }, { cli: path.join(HERE, 'qb'), settleMs: 0, force: true });
      const done = await runWake(plan);
      if (!done) return json(res, 409, { ok: false, message: `Someone took ${agent.name}'s queued work first; nothing to wake it for.` });
      return json(res, done.ok ? 200 : 502, { ok: done.ok, message: done.text });
    }
    // The person's click to start an agent (B1): a Claude Code session in a checkout the server listed, with a fixed
    // prompt to take the next queued work. Nothing from the body reaches the command but the worktree's name, which
    // must be one of this repository's. Each start is logged on the board.
    if (req.method === 'POST' && url.pathname === '/api/launch') {
      if (req.headers['x-queuebox'] !== '1') return json(res, 403, { error: 'Send the x-queuebox: 1 header.' });
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, message: 'The body is not JSON.' });
      }
      if (body?.by !== undefined && body.by !== HUMAN) return json(res, 403, { ok: false, message: 'Only the person starts agents.' });
      if (body?.op !== 'start') return json(res, 400, { ok: false, message: 'Launches are { op: "start", worktree }.' });
      const snap = worktrees || (await worktreeSnapshot(store.root, { base: board.base }));
      const wt = snap.list.find((w) => w.name === body.worktree) || (body.worktree ? null : snap.list.find((w) => w.main));
      if (!wt) return json(res, 400, { ok: false, message: `No worktree "${String(body.worktree).slice(0, 60)}" in this repository.` });
      const name = `${board.name}-${wt.name}`.replace(/[^\w.-]+/g, '-').slice(0, 60);
      let started;
      try {
        started = await startSession({ cwd: wt.path, name, cli: path.join(HERE, 'qb') });
      } catch (err) {
        return json(res, 502, { ok: false, message: err.message });
      }
      const text = `Started an agent in ${wt.name} to take the next queued work${started.id ? ` (\`claude attach ${started.id}\` opens it)` : ''}.`;
      store.commit([makeEvent(store.state(), 'note', HUMAN, { text, launch: { how: 'start', worktree: wt.name, id: started.id, name } })]);
      poll();
      return json(res, 200, { ok: true, id: started.id, name, worktree: wt.name, message: text });
    }
    return json(res, 404, { error: 'No such route.' });
  }

  function serveStatic(res, pathname) {
    if (pathname === '/' || pathname === '/index.html') {
      const html = fs.readFileSync(path.join(HERE, 'ui', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(pageHtml(html));
    }
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const top = rel.split('/')[0];
    const file = path.resolve(HERE, rel);
    if (!STATIC_ROOTS.includes(top) || !file.startsWith(HERE + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return undefined;
  }

  // Worktrees, read from git every few seconds. Edits in a worktree whose agent never talks to the board
  // are recorded for it all the same (a stand-in agent named after the worktree), so any agent on any
  // model shows up; a queued branch is marked landed once its commit is in the base.
  let worktrees = null;
  let seen = new Map();
  let polling = false;
  async function pollWorktrees() {
    if (polling) return;
    polling = true;
    try {
      const state = store.state();
      const snap = await worktreeSnapshot(store.root, { base: board.base });
      const now = Date.now();
      const fresh = [];
      for (const wt of snap.list) wt.agents = agentsInWorktree(state, wt, now);
      const { next, changes } = await gitEdits(seen, snap.list, { mtime: mtimeOf, headDiff: changedBetween });
      for (const { wt, files: changed } of changes) {
        if (!wt.agents.length) {
          const standIn = worktreeAgentId(wt.name);
          fresh.push(makeEvent(state, 'agent.join', standIn, { agent: { id: standIn, name: wt.name, kind: 'worktree', worktree: wt.path } }, now));
          wt.agents = [standIn];
        }
        // Edits any agent here already reported in the last half minute aren't counted twice. The rest go to
        // the agent here who last edited that file, else the one seen most recently.
        const recent = new Set(wt.agents.flatMap((id) => state.agents[id]?.touches || []).filter((t) => now - t.ts < 30_000).map((t) => t.file));
        const byAgent = new Map();
        for (const f of changed) {
          if (recent.has(f)) continue;
          const owner = wt.agents.length === 1 ? wt.agents[0] : lastEditor(state, wt.agents, f) || wt.agents[0];
          if (!byAgent.has(owner)) byAgent.set(owner, []);
          byAgent.get(owner).push(f);
        }
        for (const [agent, files] of byAgent) fresh.push(makeEvent(state, 'touch', agent, { files, op: 'edit', src: 'git' }, now));
      }
      for (const m of Object.values(state.merges)) {
        // A branch marked ready with nothing ahead of the base is already "in" it; only real work lands.
        // Readied with nothing ahead, it was in the base already; an entry from before `ahead` was recorded can still land.
        if (m.status !== 'ready' || !m.commit || m.ahead === 0) continue;
        if (await landed(store.root, m.commit, board.base)) fresh.push(makeEvent(state, 'merge.landed', SYSTEM, { worktree: m.worktree, commit: m.commit }, now));
      }
      // The file times move forward only once what they showed is in the log; a write that fails is seen again.
      if (commitEach(fresh, now)) seen = next;
      else seen = new Map([...next].map(([k, v]) => [k, changes.some((c) => c.wt.path === k) ? seen.get(k) : v]).filter(([, v]) => v));
      // Each changed file's agent (T61): alone in its worktree it is that agent's. In a shared checkout, the one here
      // who last edited it (its own recent edits, then the block's), else the one here who has its block reserved,
      // else nobody known.
      const after = store.state();
      for (const wt of snap.list) {
        for (const c of wt.changes || []) c.agent = wt.agents.length === 1 ? wt.agents[0] : changeOwner(after, wt.agents, c.file);
      }
      worktrees = snap;
      broadcast('worktrees', snap);
    } catch (err) {
      broadcast('problem', { message: `Reading the worktrees failed: ${err.message}` });
    } finally {
      polling = false;
    }
  }
  // Commits the batch, or, if the rules refuse part of it, each event the rules accept. False when the log
  // couldn't be written at all.
  function commitEach(list, now) {
    if (!list.length) return true;
    try {
      store.commit(list, now);
    } catch (err) {
      if (!err.refused) return false;
      for (const e of list) {
        try {
          store.commit([e], now);
        } catch (one) {
          if (!one.refused) return false;
        }
      }
    }
    poll();
    return true;
  }
  pollWorktrees();
  every(pollWorktrees, Number(process.env.QUEUEBOX_WORKTREE_MS || 4000));

  // Closing stops the polls and watchers and ends the open streams, so the process can exit.
  const close = server.close.bind(server);
  server.wakeMemory = wakeMemory;
  server.version = () => version;
  server.close = (cb) => {
    for (const t of timers) clearInterval(t);
    clearTimeout(pending);
    for (const c of closers) c();
    for (const res of clients) res.end();
    clients.clear();
    try {
      forgetServer(store.boardDir, process.pid);
    } catch {
      // Nothing recorded.
    }
    return close(cb);
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  // Where it serves is recorded, so a restart (`qb down`, `qb up`) keeps the board on this port (B15).
  if (isLoopbackBind(host)) {
    try {
      recordServer(store.boardDir, { pid: process.pid, port: server.address().port });
    } catch {
      // The record is a convenience; serving goes on without it.
    }
  }
  const where = `http://${isLoopbackBind(host) ? host.replace(/^::1$/, '[::1]') : 'localhost'}:${server.address().port}`;
  if (!quiet) {
    console.log(`QueueBox: ${board.name} board at ${where}`);
    console.log(`Log: ${store.eventsPath}`);
  }
  if (open) openBrowser(where);
  return server;
}

function mtimeOf(dir, file) {
  try {
    return fs.statSync(path.join(dir, file)).mtimeMs;
  } catch {
    return -1;
  }
}

// The files git shows changed in each linked worktree since the last recorded poll. `seen` maps a worktree's
// path to the HEAD and file times that poll saw; the result's `next` is what to remember once the edits are in
// the log. A worktree seen for the first time is only remembered (its existing changes aren't edits happening
// now), and when HEAD moved (a commit, checkout, rebase or reset) a file that differs between the two HEADs
// changed because git rewrote it, so it isn't reported either.
export async function gitEdits(seen, list, { mtime = mtimeOf, headDiff = changedBetween } = {}) {
  const next = new Map();
  const changes = [];
  for (const wt of list) {
    if (wt.main) continue;
    const files = new Map(wt.files.map((f) => [f, mtime(wt.path, f)]));
    next.set(wt.path, { head: wt.head, files });
    const prev = seen.get(wt.path);
    if (!prev) continue;
    const moved = prev.head === wt.head ? new Set() : await headDiff(wt.path, prev.head, wt.head);
    const changed = [];
    for (const [f, m] of files) {
      if (prev.files.get(f) === m) continue;
      if (!moved || moved.has(f)) continue;
      changed.push(f);
    }
    if (changed.length) changes.push({ wt, files: changed });
  }
  return { next, changes };
}

function size(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Body too large.'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // No browser to open; the URL is printed above.
  }
}

// Of several agents sharing a worktree, the one whose own edits touched a file last.
export function changeOwner(state, ids, file) {
  const last = lastEditor(state, ids, file);
  if (last) return last;
  const b = state.blocks[blockForPath(state.index, file)];
  const t = (b?.touches || []).findLast((x) => x.file === file && x.op !== 'read' && ids.includes(x.agent));
  if (t) return t.agent;
  return b?.holder && ids.includes(b.holder) ? b.holder : null;
}

export function lastEditor(state, ids, file) {
  let best = null;
  for (const id of ids) {
    const t = (state.agents[id]?.touches || []).findLast((x) => x.file === file && x.op !== 'read');
    if (t && (!best || t.ts > best.ts)) best = { id, ts: t.ts };
  }
  return best?.id || null;
}
