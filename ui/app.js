// The board page: folds the log into state, renders the map, the windows, the timeline and the
// inspector from it, and turns what the person does (drag a tile, answer a question) into events.

import { HUMAN, apply, reduce, alerts, presence, needsHuman, isIdleFree, blockMeta, agentName, clock, queuedIntent, readsSoon, suggestionPlan, undoApplyEvents } from '../core/model.js';
import { blockForPath } from '../core/glob.js';
import { connect } from './source.js';
import { createMap } from './map.js';
import { createSide } from './windows.js';
import { createTimeline } from './timeline.js';
import { createInspector } from './inspector.js';
import { createTethers } from './tethers.js';
import { enableDnd } from './dnd.js';
import { createWorktrees, worktreeIndex } from './worktrees.js';
import { startFavicon } from './favicon.js';
import { agentsInWorktree, worktreeLabel, mergeChecks, mergeCommand } from '../core/merges.js';
import { h, icon, setHtml, setText, toast, storageGet, storageSet, esc, timer, startTimers, copyText, escapeLayer, ESC } from './dom.js';
import { initTheme, appTools, toolButton, openSettings, switchRow, appThemeStore, ICONS } from './theme/index.js';
import { openNewItem } from './newitem.js';
import { openHelp } from './help.js';

// Solenoid's palette system, from the theme kit (vendored in ui/theme/). Its slots mean these things here; the
// names label the Custom palette's wells. Teal and lime color nothing on the board, so they aren't listed.
initTheme({
  slotRoles: [
    { slot: 'gold', label: 'Needs you' },
    { slot: 'vermilion', label: 'Conflicts, failures' },
    { slot: 'green', label: 'Working, passing' },
    { slot: 'amber', label: 'Heat' },
    { slot: 'sky', label: 'First agent' },
    { slot: 'violet', label: 'Second agent' },
    { slot: 'pink', label: 'Third agent' },
    { slot: 'blue', label: 'Fourth agent' },
    { slot: 'purple', label: 'Fifth agent' },
    { slot: 'gray', label: 'You' },
  ],
  isMobile: () => matchMedia('(max-width: 860px)').matches,
});

const $ = (id) => document.getElementById(id);

const ctx = {
  board: null,
  events: [],
  live: null,
  view: null,
  viewNow: Date.now(),
  replayTs: null,
  // The Issues lens folded into Work (T27): every lens shows each block's open items.
  // Lenses that were renamed or folded: Issues into Work (T27), Branches into Changes (T61).
  lens: (({ issues: 'work', branches: 'changes' })[storageGet('queuebox.lens', 'work')] || storageGet('queuebox.lens', 'work')),
  search: null,
  selected: null,
  mode: 'connecting',
  source: null,
  byAgent: new Map(),
  alertsOpen: false,
  toast,
  liveNow: () => Date.now(),
  eventsOf(id) {
    return this.byAgent.get(id) || [];
  },
};

ctx.map = createMap(ctx, $('map'));
const side = createSide(ctx, $('side'));
const timeline = createTimeline(ctx, $('timeline'));

// The timeline's height is the viewer's (T60): a grip on its top edge drags it between the time axis with one lane
// and half the window, the arrow keys step it, and a double-click puts the default back. The grip is its own
// handle; the strip itself never resizes on a press (B6).
(function timelineGrip() {
  const root = $('timeline');
  const grip = h('div', { class: 'tl-grip', role: 'separator', tabindex: '0', 'aria-orientation': 'horizontal', 'aria-label': 'Timeline height', title: 'Timeline height' });
  root.prepend(grip);
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const bounds = () => [3.5 * rem(), Math.round(innerHeight / 2)];
  const set = (px, save = true) => {
    const [lo, hi] = bounds();
    if (px == null) root.style.removeProperty('--tl-h');
    else root.style.setProperty('--tl-h', `${Math.round(Math.min(hi, Math.max(lo, px)))}px`);
    if (save) storageSet('queuebox.timelineH', px == null ? null : parseFloat(root.style.getPropertyValue('--tl-h')));
    grip.setAttribute('aria-valuenow', String(Math.round(root.querySelector('.tl-body')?.offsetHeight || 0)));
    ctx.map?.refit?.();
    ctx.render?.();
  };
  const saved = storageGet('queuebox.timelineH', null);
  if (Number.isFinite(saved)) set(saved, false);
  const current = () => root.querySelector('.tl-body')?.offsetHeight || 0;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // The pointer already went away.
    }
    const y0 = e.clientY;
    const h0 = current();
    root.classList.add('resizing');
    const move = (ev) => set(h0 + (y0 - ev.clientY), false);
    const up = () => {
      root.classList.remove('resizing');
      set(current());
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => set(null));
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    set(current() + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 64 : 16));
  });
})();
const inspector = createInspector(ctx, $('inspector'), $('scrim'));
const tethers = createTethers(ctx, $('tethers'), $('map-wrap'), $('side'));
const trees = createWorktrees(ctx, $('wt-bar'), side.mergeHost);
ctx.worktrees = null;
ctx.focusWt = null;
ctx.mergeRows = [];
ctx.activeOnly = storageGet('queuebox.activeOnly', matchMedia('(max-width: 860px)').matches);

// Focus one worktree: the map lights the blocks it changed and its agent's window comes into view.
ctx.focus = (name) => {
  ctx.focusWt = name && name !== ctx.focusWt ? name : null;
  render();
  const wt = ctx.worktrees?.list.find((w) => w.name === ctx.focusWt);
  if (wt?.agents?.length) document.querySelector(`.win[data-win="${CSS.escape(wt.agents[0])}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

// Go to an agent: its worktree in focus (path, cd, editor link) and its window flashed into view.
ctx.focusAgent = (id) => {
  const wt = ctx.worktrees?.list.find((w) => w.agents?.includes(id) && !w.main);
  if (wt && ctx.focusWt !== wt.name) ctx.focus(wt.name);
  const win = side.windowOf(id);
  if (!win) return;
  win.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  win.classList.add('flash');
  setTimeout(() => win.classList.remove('flash'), 900);
};

ctx.dnd = enableDnd(ctx);

// ------------------------------------------------------------------------------------------- state

function index(e) {
  const keys = new Set([e.by, typeof e.agent === 'string' ? e.agent : null, e.to && e.to !== '*' ? e.to : null]);
  for (const k of keys) {
    if (!k) continue;
    if (!ctx.byAgent.has(k)) ctx.byAgent.set(k, []);
    ctx.byAgent.get(k).push(e);
  }
}

function setBoard(board, events) {
  ctx.board = board;
  ctx.events = events.slice();
  ctx.byAgent = new Map();
  for (const e of ctx.events) index(e);
  ctx.live = reduce(board, ctx.events);
  ctx.map.build(board);
  setText($('board-name'), board.name);
  ctx.paintMenuBar?.();
  document.title = `${board.name} QueueBox`;
  computeView();
  render();
}

// A replay moving forward applies only the events since its last frame; going back folds again from the start.
let replayFold = null;
function replayState(ts) {
  const evs = ctx.events;
  let f = replayFold;
  if (!f || f.board !== ctx.board || f.n !== evs.length || ts < f.ts) f = { board: ctx.board, n: evs.length, i: 0, ts: -Infinity, state: reduce(ctx.board, []) };
  while (f.i < evs.length && evs[f.i].ts <= ts) apply(f.state, evs[f.i++]);
  f.ts = ts;
  replayFold = f;
  return f.state;
}

function computeView() {
  if (ctx.replayTs) {
    ctx.view = replayState(ctx.replayTs);
    ctx.viewNow = ctx.replayTs;
  } else {
    replayFold = null;
    ctx.view = ctx.live;
    ctx.viewNow = Date.now();
  }
}

ctx.replay = (ts) => {
  ctx.replayTs = ts;
  computeView();
  render();
};

ctx.select = (id) => {
  ctx.selected = id;
  if (id) inspector.open(id);
  else inspector.close();
  render();
};
ctx.selectQuiet = (id) => {
  ctx.selected = id;
  render();
};

// ----------------------------------------------------------------------------------------- actions

async function commit(list, ok) {
  if (ctx.replayTs) {
    toast('Back to live to change the board.');
    return false;
  }
  try {
    await ctx.source.commit(list);
    if (ok) toast(ok);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

// A change to board.json, through the server; the new board replaces the old at once.
ctx.boardOp = async (op, ok) => {
  try {
    const board = await ctx.source.boardOp(op);
    if (board) setBoard(board, ctx.events);
    if (ok) toast(ok);
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
};

const nameOf = (id) => blockMeta(ctx.live, id)?.name || id;
const humanName = () => ctx.live.agents[HUMAN].name;

ctx.act = {
  assign(block, agent) {
    const b = ctx.live.blocks[block];
    const list = [];
    if (b.holder && b.holder !== agent) {
      list.push({ type: 'block.release', agent: b.holder, block, outcome: 'handoff', note: `given to ${agentName(ctx.live, agent)}` });
      if (b.holder !== HUMAN) list.push({ type: 'msg', auto: true, to: b.holder, text: `Moved ${nameOf(block)} (${block}) to ${agentName(ctx.live, agent)}. Stop editing there.` });
    }
    list.push({ type: 'block.reserve', agent, block, intent: b.intent || queuedIntent(ctx.live, b.queued) });
    if (agent !== HUMAN) list.push({ type: 'msg', auto: true, to: agent, text: `Assigned to you: ${nameOf(block)} (${block}). \`qb show ${block}\` lists its docs and open items.` });
    return commit(list, agent === HUMAN ? `You reserved ${nameOf(block)}. Agents stay out.` : `Gave ${nameOf(block)} to ${agentName(ctx.live, agent)}.`);
  },
  release(block) {
    const b = ctx.live.blocks[block];
    if (!b.holder) return Promise.resolve(false);
    const list = [{ type: 'block.release', agent: b.holder, block, outcome: 'parked', note: `released by ${humanName()}` }];
    if (b.holder !== HUMAN) list.push({ type: 'msg', auto: true, to: b.holder, text: `Took ${nameOf(block)} (${block}) back. Stop editing there.` });
    return commit(list, `${nameOf(block)} is free.`);
  },
  queue(block) {
    const b = ctx.live.blocks[block];
    const list = [];
    if (b.holder) {
      list.push({ type: 'block.release', agent: b.holder, block, outcome: 'parked', note: 'moved to the queue' });
      if (b.holder !== HUMAN) list.push({ type: 'msg', auto: true, to: b.holder, text: `Moved ${nameOf(block)} (${block}) back to the queue. Stop editing there.` });
    }
    list.push({ type: 'block.queue', block, note: b.intent || '' });
    return commit(list, `${nameOf(block)} is up next.`);
  },
  unqueue: (block) => commit([{ type: 'block.unqueue', block }], `${nameOf(block)} is off the queue.`),
  queueItem: (it) => commit([{ type: 'block.queue', block: it.block, item: it.id }], `${it.id} is up next, with ${nameOf(it.block)}.`),
  unqueueItem: (it) => commit([{ type: 'block.unqueue', block: it.block, item: it.id }], `${it.id} is off the queue.`),
  freeze: (block, on) => commit([{ type: 'block.freeze', block, on }], on ? `Froze ${nameOf(block)}.` : `Unfroze ${nameOf(block)}.`),
  addItem: (item) => commit([{ type: 'item.add', item }], `Filed it in ${nameOf(item.block)}.`),
  // Up next's box (B31): a task with no block, queued as it's filed; whoever takes it files it properly.
  queueText: (title) => commit([{ type: 'item.add', queue: true, item: { kind: 'task', title } }], 'In Up next. Whoever takes it files it in its block.'),
  updateItem: (id, patch, said) => commit([{ type: 'item.update', item: id, ...patch }], said),
  deleteItem: (id) => commit([{ type: 'item.delete', item: id }], `Deleted ${id}.`),
  answer: (id, text) => commit([{ type: 'item.update', item: id, answer: text, status: 'done' }], 'Answered. It lands in the agent’s inbox.'),
  // An agent's suggested distribution, applied by the person: each item goes to its agent, who gets its block when
  // the block is free, or the item queued with the block when someone else has it; each agent hears what it got.
  applySuggestion(id) {
    const { events } = suggestionPlan(ctx.live, id);
    if (!events.length) return Promise.resolve(false);
    return commit(events, `Applied ${id}.`);
  },
  // Undo an Auto-Apply (T59), from its note: items back to whom they were with, its reservations released, the
  // suggestion open again for the person.
  undoApply(noteId) {
    const note = ctx.live.notes.find((n) => n.id === noteId);
    const events = undoApplyEvents(ctx.live, note);
    if (!events.length) return Promise.resolve(false);
    return commit(events, `Undid ${note.applied.suggestion}. It waits for you as a suggestion.`);
  },
  // A message only reaches an agent on its next tool call, or while its Stop hook waits on its question; one that
  // has ended its turn reads it when it next runs, and the toast says so rather than looking delivered.
  message: (agent, text) => {
    const name = agentName(ctx.live, agent);
    const soon = readsSoon(ctx.live, agent, Date.now(), ctx.sessions);
    return commit([{ type: 'msg', to: agent, text }], soon ? `Sent to ${name}.` : `On the board for ${name}: delivered when ${name} next runs.`);
  },
  mergeReady(wt) {
    if (!wt.ahead) {
      toast(wt.dirty ? 'Nothing committed yet. Commit, then queue it.' : `Nothing to merge: no commits ahead of ${ctx.worktrees?.base || 'the base'}.`);
      return Promise.resolve(false);
    }
    return commit([{ type: 'merge.ready', worktree: wt.name, branch: wt.branch, commit: wt.head, ahead: wt.ahead, ...(wt.agents?.length === 1 ? { agent: wt.agents[0] } : {}) }], `${labelOfTree(wt.name)} is in the merge queue.`);
  },
  mergeUnready: (name) => commit([{ type: 'merge.unready', worktree: name }], `${labelOfTree(name)} is out of the merge queue.`),
  // Move a queued branch to a place in the queue (0 is the head): its position goes halfway between its new neighbors.
  mergeMove(name, to) {
    const ready = Object.values(ctx.live.merges).filter((m) => m.status === 'ready' && m.worktree !== name).sort((a, b) => a.pos - b.pos);
    if (!ctx.live.merges[name] || to < 0 || to > ready.length) return Promise.resolve(false);
    const before = ready[to - 1]?.pos;
    const after = ready[to]?.pos;
    const pos = before === undefined ? (after ?? 0) - 1 : after === undefined ? before + 1 : (before + after) / 2;
    return commit([{ type: 'merge.order', worktree: name, pos }]);
  },
  copyMerge(name) {
    const entry = ctx.live.merges[name];
    if (entry) copyText(mergeCommand(entry, ctx.worktrees?.base), 'Copied the merge command.');
  },
  askFix(name) {
    const row = ctx.mergeRows.find((r) => r.entry.worktree === name);
    const bad = row?.checks.filter((c) => c.level === 'danger') || [];
    const text = `Your branch can't merge yet: ${bad.map((c) => `${c.text}${c.files ? ` (${c.files.slice(0, 6).join(', ')})` : ''}${c.detail ? ` (${c.detail})` : ''}`).join('; ') || 'it has problems'}. Fix it, commit, and \`qb ready\` again.`;
    return askTree(name, text, 'Asked for a fix.');
  },
  askRebase(name) {
    const base = ctx.worktrees?.base || 'the base';
    return askTree(name, `Your branch is behind ${base}. Rebase onto ${base} (\`git rebase ${base}\`), run the tests, then \`qb ready\` again.`, 'Asked for a rebase.');
  },
};

function labelOfTree(name) {
  const wt = ctx.worktrees?.list.find((w) => w.name === name);
  return wt ? worktreeLabel(ctx.live, wt) : name;
}

// A note for the agent in a worktree; when nobody there talks to the board, the command to run yourself.
function askTree(name, text, done) {
  const wt = ctx.worktrees?.list.find((w) => w.name === name);
  const agents = (wt?.agents || []).filter((a) => !a.startsWith('wt-'));
  if (agents.length) return commit(agents.map((to) => ({ type: 'msg', to, text })), `${done} ${agents.map((a) => agentName(ctx.live, a)).join(' and ')} ${agents.length === 1 ? 'gets' : 'get'} it on the next step.`);
  copyText(wt ? `cd "${wt.path}"` : name, `No agent on the board works in ${name}. Copied its cd command.`);
  return Promise.resolve(false);
}

// ------------------------------------------------------------------------------------------ render

let raf = 0;
ctx.render = () => render();
// The canvas says so when nobody is working (T87): every agent on the board idle with nothing in hand, or no agents
// at all, with the two ways to get going. Its x hides it until an agent works again.
const idleCard = h('div', { class: 'idle-card', hidden: true, role: 'status' });
$('map-wrap').append(idleCard);
let idleHidden = false;
idleCard.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-idle]');
  if (!b) return;
  if (b.dataset.idle === 'new') openNewItem(ctx, $('new-item'));
  else if (b.dataset.idle === 'start') ctx.startAgent?.('');
  else if (b.dataset.idle === 'help') openHelp(document.querySelector('button[aria-label="Help"]') || b);
  else if (b.dataset.idle === 'close') {
    idleHidden = true;
    idleCard.hidden = true;
  }
});
function paintIdleCard() {
  const st = ctx.view;
  const now = ctx.viewNow;
  const agents = Object.values(st.agents).filter((a) => a.id !== HUMAN && !a.leftAt && presence(st, a.id, now) !== 'stale');
  const idle = agents.every((a) => isIdleFree(st, a.id, now));
  if (!idle) idleHidden = false;
  const show = ctx.mode === 'live' && !ctx.replayTs && idle && !idleHidden;
  idleCard.hidden = !show;
  if (!show) return;
  // A board that has never had an agent gets a welcome and the three ways in (T88).
  const fresh = !agents.length && !ctx.events.some((e) => e.type === 'agent.join');
  const words = fresh ? 'Welcome to QueueBox. Start an agent, file a first item, or open Help to see how the board works.' : agents.length ? 'All agents are idle! Want to get something done?' : 'No agents on the board yet. Want to start one?';
  if (idleCard.dataset.words === words) return;
  idleCard.dataset.words = words;
  setHtml(idleCard, `<p>${esc(words)}</p><div class="idle-acts">${fresh ? '<button class="btn sm" type="button" data-idle="help">Help</button>' : ''}${agents.length || fresh ? '<button class="btn sm" type="button" data-idle="new">New Item</button>' : ''}<button class="btn sm confirm" type="button" data-idle="start" title="Start a Claude Code session in the main checkout that takes the next queued work">Start an Agent</button><button class="icon-btn" type="button" data-idle="close" aria-label="Hide this" title="Hide">${icon('close')}</button></div>`);
}

function render() {
  if (!raf) raf = requestAnimationFrame(doRender);
}

function doRender() {
  raf = 0;
  document.documentElement.style.setProperty('--top-h', `${Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom)}px`);
  if (!ctx.view) return;
  if (!ctx.replayTs) {
    ctx.view = ctx.live;
    ctx.viewNow = Date.now();
  }
  const before = new Map();
  for (const [id, tile] of ctx.map.tiles) before.set(id, tile.getBoundingClientRect());
  ctx.alertList = alerts(ctx.view, ctx.viewNow);
  if (ctx.worktrees) for (const wt of ctx.worktrees.list) wt.agents = agentsInWorktree(ctx.view, wt, ctx.viewNow);
  ctx.wtIndex = worktreeIndex(ctx.view, ctx.worktrees);
  ctx.mergeRows = ctx.worktrees ? mergeChecks(ctx.view, ctx.worktrees, ctx.viewNow) : [];
  document.body.dataset.lens = ctx.lens;
  document.body.classList.toggle('inspecting', !!inspector.id);
  document.body.classList.toggle('replaying', !!ctx.replayTs);
  side.update();
  trees.update();
  paintIdleCard();
  const moved = placeTiles();
  ctx.map.paint();
  paintTop();
  paintAlerts();
  paintAttention();
  timeline.update();
  inspector.update();
  // Last of the layout: after the paint (which slots the Active view hides) and after the alert strip and the
  // timeline have taken their height.
  ctx.map.fit();
  fly(moved, before);
  tethers.draw();
}

// Put every tile where its block is: its map slot, its holder's tray, or the queue.
function placeTiles() {
  const st = ctx.view;
  const trays = new Map();
  const moves = [];
  for (const [id, tile] of ctx.map.tiles) {
    const b = st.blocks[id];
    const slot = ctx.map.slots.get(id);
    let into = slot;
    if (b?.holder) into = side.trayFor(b.holder, id) || slot;
    else if (b?.queued?.whole) into = side.trayFor('queue') || slot;
    if (into === slot) {
      if (tile.parentElement !== slot) moves.push([tile, slot]);
    } else {
      if (!trays.has(into)) trays.set(into, []);
      trays.get(into).push(id);
    }
  }
  for (const [tray, ids] of trays) {
    ids.sort((a, b) => {
      const x = st.blocks[a];
      const y = st.blocks[b];
      return x.holder ? x.since - y.since : x.queued.pos - y.queued.pos;
    });
    const current = [...tray.children].filter((c) => c.classList.contains('tile'));
    const same = current.length === ids.length && current.every((c, i) => c.dataset.block === ids[i]);
    if (same) continue;
    for (const id of ids) moves.push([ctx.map.tiles.get(id), tray]);
  }
  for (const [tile, into] of moves) {
    into.append(tile);
    // Only Up next orders its tiles (by queue position, set when the side column paints).
    if (into !== side.trayFor('queue')) tile.style.order = '';
  }
  for (const [tray] of trays) for (const c of [...tray.children]) if (c.classList.contains('tile') && !trays.get(tray).includes(c.dataset.block)) ctx.map.slots.get(c.dataset.block)?.append(c);
  return moves.map(([tile]) => tile);
}

// FLIP: each moved tile starts where it was and glides to where it is now.
function fly(tiles, before) {
  // A replay moves many tiles a frame; they jump, so the motion means a live change.
  if (!tiles.length || ctx.replayTs || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const tile of tiles) {
    const a = before.get(tile.dataset.block);
    const b = tile.getBoundingClientRect();
    if (!a || !a.width || !b.width) continue;
    // Inside the zoomed map a translation is scaled by the zoom, so undo it.
    const z = tile.closest('.map') ? ctx.map.zoom : 1;
    const dx = (a.left - b.left) / z;
    const dy = (a.top - b.top) / z;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    tile.style.zIndex = '20';
    const anim = tile.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: '0 0' },
        { transform: 'none', transformOrigin: '0 0' },
      ],
      { duration: 560, easing: 'cubic-bezier(.2,.75,.15,1)' },
    );
    anim.onfinish = anim.oncancel = () => {
      tile.style.zIndex = '';
    };
  }
  tethers.follow(620);
}

// The top bar keeps only the connection's state: the counts it had repeated the inbox and the agent windows, and
// were the first thing a narrow window ate. The tab title still carries the inbox count.
function paintTop() {
  const conn = $('conn');
  const mode = ctx.replayTs ? 'replay' : ctx.connState || ctx.mode;
  conn.className = `conn ${mode}`;
  conn.hidden = mode === 'live';
  setText(conn.lastElementChild, mode === 'replay' ? `Replay ${clock(ctx.replayTs)}` : { snapshot: 'Snapshot', offline: 'Reconnecting', connecting: 'Connecting' }[mode] || mode);
}

// One strip: each alert a chip that opens what it's about. Questions live in the inbox, so they aren't repeated here.
// An alert dismissed with its x stays dismissed in this browser (T82); alerts still go after three hours on their own.
const alertKey = (a) => `${a.kind}|${a.block || ''}|${a.agent || ''}|${a.ts}`;
const dismissed = new Set(storageGet('queuebox.dismissed', []));
function paintAlerts() {
  const al = ctx.alertList.filter((a) => a.kind !== 'question' && !dismissed.has(alertKey(a)));
  const now = ctx.viewNow;
  const strip = $('alerts');
  const room = matchMedia('(max-width: 860px)').matches ? 2 : 3;
  const shown = ctx.alertsOpen ? al : al.slice(0, room);
  const away = ctx.away && !ctx.replayTs ? awayLine(ctx.away.since) : '';
  const rows = shown.map((a) => {
    const kind = a.severity === 'high' ? 'high' : 'warn';
    return `<div class="alert ${kind}" role="button" tabindex="0" data-alert-block="${esc(a.block || '')}" data-alert-agent="${esc(a.agent || '')}" data-alert-kind="${esc(a.kind)}"><i class="${kind === 'high' ? 'dot-danger' : 'dot-warn'}"></i><span class="txt" title="${esc(a.text)}">${esc(a.text)}</span>${timer(a.ts, {}, now)}<button class="icon-btn" type="button" data-alert-dismiss="${esc(alertKey(a))}" aria-label="Dismiss: ${esc(a.text)}" title="Dismiss">${icon('close')}</button></div>`;
  });
  if (al.length > room) rows.push(`<button class="more" type="button" data-alert-more>${ctx.alertsOpen ? 'Fewer' : `+${al.length - room}`}</button>`);
  if (away) rows.unshift(`<div class="alert away"><i class="dot-muted"></i><span class="txt" title="${esc(away)}">${esc(away)}</span><button class="btn sm" type="button" data-away-replay>Replay</button><button class="icon-btn" type="button" data-away-close aria-label="Dismiss">${icon('close')}</button></div>`);
  strip.classList.toggle('open', !!ctx.alertsOpen);
  setHtml(strip, rows.join(''));
}

// What happened while the page was in the background, in one sentence.
function awayLine(since) {
  const evs = ctx.events.filter((e) => e.ts >= since);
  const n = (f) => evs.filter(f).length;
  const landed = n((e) => e.type === 'block.release' && e.outcome === 'landed');
  const bugs = n((e) => e.type === 'item.add' && e.item?.kind === 'bug');
  const asked = n((e) => e.type === 'item.add' && e.item?.kind === 'question');
  const failed = n((e) => e.type === 'test' && !e.ok);
  let add = 0;
  let del = 0;
  for (const e of evs) if (e.type === 'touch') {
    add += e.add || 0;
    del += e.del || 0;
  }
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const parts = [
    landed && plural(landed, 'block landed', 'blocks landed'),
    (add || del) && `+${add} −${del} lines`,
    bugs && plural(bugs, 'bug filed', 'bugs filed'),
    asked && plural(asked, 'question', 'questions'),
    failed && plural(failed, 'failing test run', 'failing test runs'),
  ].filter(Boolean);
  return `Since ${clock(since)}: ${parts.length ? parts.join(', ') : 'nothing new'}.`;
}

ctx.showAway = (since) => {
  ctx.away = { since };
  render();
};

$('alerts').addEventListener('click', (e) => {
  if (e.target.closest('[data-away-replay]')) {
    const since = ctx.away.since;
    ctx.away = null;
    timeline.playFrom(since);
    return render();
  }
  if (e.target.closest('[data-away-close]')) {
    ctx.away = null;
    return render();
  }
  const gone = e.target.closest('[data-alert-dismiss]');
  if (gone) {
    dismissed.add(gone.dataset.alertDismiss);
    // Only the last day's are kept: older alerts have long gone by themselves.
    const day = Date.now() - 24 * 3600_000;
    storageSet('queuebox.dismissed', [...dismissed].filter((k) => Number(k.split('|').pop()) > day));
    return render();
  }
  if (e.target.closest('[data-alert-more]')) {
    ctx.alertsOpen = !ctx.alertsOpen;
    return render();
  }
  const row = e.target.closest('.alert');
  if (!row) return undefined;
  if (row.dataset.alertKind === 'stale' && row.dataset.alertAgent) ctx.focusAgent(row.dataset.alertAgent);
  if (row.dataset.alertBlock) ctx.select(row.dataset.alertBlock);
  return undefined;
});
$('alerts').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.alert[role="button"]')) {
    e.preventDefault();
    e.target.click();
  }
});

// ---------------------------------------------------------------------------------------- attention

// The tab title carries how many agents wait on the human, so a background tab still says so. With the bell
// on, an agent starting to wait, or an edit inside someone else's block, becomes a desktop notification.
const seen = { needs: new Set(), alerts: new Set(), primed: false };
function paintAttention() {
  if (!ctx.live || !ctx.board) return;
  const now = Date.now();
  const waiting = Object.values(ctx.live.agents).filter((a) => a.id !== HUMAN && !a.leftAt && needsHuman(ctx.live, a.id, now));
  const count = ctx.replayTs ? waiting.length : ctx.inboxCount || 0;
  document.title = `${count ? `(${count}) ` : ''}${ctx.board.name} QueueBox`;
  const conflicts = alerts(ctx.live, now).filter((a) => a.kind === 'trespass' || a.kind === 'frozen');
  if (seen.primed && notifyOn() && document.hidden) {
    for (const a of waiting) if (!seen.needs.has(a.id)) notify(`${a.name} needs you`, a.doing || openTitle(a));
    for (const c of conflicts) if (!seen.alerts.has(`${c.agent}|${c.block}`)) notify('Conflict', c.text);
  }
  seen.needs = new Set(waiting.map((a) => a.id));
  seen.alerts = new Set(conflicts.map((c) => `${c.agent}|${c.block}`));
  seen.primed = true;
}
function openTitle(a) {
  const q = Object.values(ctx.live.items).find((it) => it.kind === 'question' && it.by === a.id && it.status === 'open');
  return q ? q.title : '';
}
const canNotify = typeof Notification !== 'undefined';
const notifyOn = () => canNotify && Notification.permission === 'granted' && storageGet('queuebox.notify', false);
function notify(title, body) {
  try {
    new Notification(title, { body, tag: `${title}|${body}` });
  } catch {
    // Some browsers only notify from a service worker; the title count still shows it.
  }
}
async function setNotify(on) {
  if (!on) return storageSet('queuebox.notify', false);
  let perm = Notification.permission;
  if (perm === 'default') {
    try {
      perm = await Notification.requestPermission();
    } catch {
      perm = 'denied';
    }
  }
  if (perm === 'granted') storageSet('queuebox.notify', true);
  else toast('The browser blocked notifications for this page.');
  return undefined;
}

// The accent pill and Settings, as Solenoid's top bar has them. Settings holds the palette (Appearance) and the
// board's own switches.
const settingsRows = () => [
  ...(canNotify ? [switchRow({ label: 'Desktop notifications', help: 'Get a desktop notification when an agent asks you something or needs your permission, or edits a block another agent has reserved. Only while this tab isn’t in front.', get: notifyOn, set: setNotify })] : []),
  switchRow({
    label: 'Wake idle agents',
    help: 'When an agent is sitting idle and something is waiting for it (your reply, work you gave it, or the next queued task), QueueBox gets it going. Once per idle spell it also asks the agent to look over the board and suggest who should take what. Works for agents started with qb run. When off, idle agents wait until you prompt them. Applies to everyone using this board.',
    get: () => ctx.board?.nudgeIdle !== false,
    set: (on) => ctx.boardOp({ op: 'settings', nudgeIdle: on }, on ? 'The board will wake idle agents when work waits for them.' : 'Idle agents stay stopped until their next prompt.'),
  }),
  switchRow({
    label: 'Auto-apply suggestions',
    help: "When an agent suggests who should take what, the board applies it right away, as your Apply would, except for work someone is already doing and items another suggestion moved first; those stay a suggestion for you. Each one shows in Needs you with Undo for 10 minutes. Applies to everyone using this board.",
    get: () => ctx.board?.autoApply === true,
    set: (on) => ctx.boardOp({ op: 'settings', autoApply: on }, on ? "The board applies agents' suggestions as they land." : 'Suggestions wait for you again.'),
  }),
  switchRow({
    label: 'Wait for context',
    help: 'Normally the next queued task goes straight to whichever agent is free. When this is on, a task can wait up to 10 minutes for a busy agent who has done far more work in that part of the code than anyone free. Applies to everyone using this board.',
    get: () => (ctx.board?.waitForContext || 0) > 0,
    set: (on) => ctx.boardOp({ op: 'settings', waitForContext: on ? 10 : 0 }, on ? 'Queued work waits up to 10 minutes for the agent who knows it.' : 'Queued work goes to a free agent at once.'),
  }),
  switchRow({
    label: 'Active blocks only',
    help: 'Hide the quiet blocks. The map keeps only blocks that are reserved, queued, recently edited, failing a test, or changed on a branch.',
    get: () => !!ctx.activeOnly,
    set: (on) => setActiveOnly(on),
  }),
];
const tools = appTools({
  buttons: [
    // Help and About (T72): what the page's parts are and do, the keys, where to read more.
    toolButton({ title: 'Help', icon: icon('question'), onClick: (e) => openHelp(e?.currentTarget || document.querySelector('[data-help]')) }),
    toolButton({ title: 'Settings (Ctrl+,)', icon: ICONS.settings, onClick: () => showSettings() }),
  ],
});
$('app-tools').replaceWith(tools.el);
// The menu bar, after Solenoid's (T77): a thin accent strip over the top bar. Its first menu is the board's own, named
// after the repository; the rest gather the page's commands, each run the way its own button or key runs it.
(function menuBar() {
  const bar = $('menubar');
  if (!bar) return;
  const press = (sel) => document.querySelector(sel)?.click();
  const key = (k, mods = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift }));
  const lensItem = (lens, label) => ({ label, checked: () => ctx.lens === lens, run: () => press(`#lens button[data-lens="${lens}"]`) });
  const folded = () => $('timeline').classList.contains('folded');
  const menus = () => [
    {
      label: ctx.board?.name || 'Board',
      items: [
        { label: 'Start an Agent', run: () => press('.win.upnext .win-head .btn') },
        { label: 'New Item…', shortcut: 'N', run: () => press('#new-item') },
        { label: 'Items', checked: () => document.body.classList.contains('docked') && !inspector.id, run: () => inspector.toggleList() },
        { sep: true },
        { label: 'Settings…', shortcut: 'Ctrl+,', run: () => showSettings() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo Layout', shortcut: 'Ctrl+Z', run: () => key('z', { ctrl: true }) },
        { label: 'Redo Layout', shortcut: 'Ctrl+Shift+Z', run: () => key('z', { ctrl: true, shift: true }) },
        { sep: true },
        { label: 'Find a Block or File', shortcut: '/', run: () => $('search').focus() },
      ],
    },
    {
      label: 'View',
      items: [
        lensItem('work', 'Work'),
        lensItem('heat', 'Heat'),
        lensItem('changes', 'Changes'),
        { sep: true },
        { label: 'Active Blocks Only', checked: () => !!ctx.activeOnly, run: () => setActiveOnly(!ctx.activeOnly) },
        { label: 'Timeline', checked: () => !folded(), run: () => press('.tl-fold') },
        { sep: true },
        { label: 'Fit the Map', run: () => press('.map-fit') },
        { label: 'Zoom In', run: () => press('.map-zoom[aria-label="Zoom in"]') },
        { label: 'Zoom Out', run: () => press('.map-zoom[aria-label="Zoom out"]') },
        { label: 'Tidy', shortcut: 'T', run: () => press('.map-tidy') },
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'QueueBox Help', run: () => openHelp(bar.querySelector('.menubar-top[data-i="3"]')) }],
    },
  ];
  let open = null;
  const close = () => {
    open = null;
    paint();
  };
  function paint() {
    const list = menus();
    setHtml(bar, list.map((m, i) => `<div class="menubar-item"><button type="button" class="menubar-top${open === i ? ' open' : ''}" data-i="${i}" aria-haspopup="menu" aria-expanded="${open === i}">${esc(m.label)}</button>${open === i ? `<div class="menubar-drop" role="menu">${m.items.map((it, j) => (it.sep ? '<div class="menubar-sep"></div>' : `<button type="button" role="menuitem" class="menubar-opt" data-j="${j}"><span class="menubar-check">${it.checked?.() ? '✓' : ''}</span><span class="menubar-label">${esc(it.label)}</span>${it.shortcut ? `<span class="menubar-key">${esc(it.shortcut)}</span>` : ''}</button>`)).join('')}</div>` : ''}</div>`).join(''));
    if (open !== null) bar.querySelector('.menubar-opt')?.focus();
  }
  bar.addEventListener('click', (e) => {
    const top = e.target.closest('.menubar-top');
    if (top) {
      const i = Number(top.dataset.i);
      open = open === i ? null : i;
      return paint();
    }
    const opt = e.target.closest('.menubar-opt');
    if (!opt || open === null) return;
    const it = menus()[open].items[Number(opt.dataset.j)];
    close();
    it?.run();
  });
  // With a menu open, pointing at another title opens that one instead.
  bar.addEventListener('pointerover', (e) => {
    const top = e.target.closest('.menubar-top');
    if (top && open !== null && Number(top.dataset.i) !== open) {
      open = Number(top.dataset.i);
      paint();
    }
  });
  bar.addEventListener('keydown', (e) => {
    if (open === null || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const opts = [...bar.querySelectorAll('.menubar-opt')];
    const i = opts.indexOf(document.activeElement);
    opts[(i + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length]?.focus();
  });
  document.addEventListener('pointerdown', (e) => open !== null && !bar.contains(e.target) && close(), true);
  escapeLayer(ESC.menu, () => open !== null, () => {
    const i = open;
    close();
    bar.querySelector(`.menubar-top[data-i="${i}"]`)?.focus();
  });
  ctx.paintMenuBar = () => open === null && paint();
  paint();
})();
appThemeStore.subscribe(() => render());

// Active only: the map keeps the blocks with something going on (held, queued, edited lately, failing, in a branch).
// New Item: file a bug or task from anywhere (ui/newitem.js); N opens it too.
$('new-item').addEventListener('click', (e) => openNewItem(ctx, e.currentTarget));
$('items-btn').addEventListener('click', () => inspector.toggleList());
const activeBtn = $('active-only');
const paintActive = () => activeBtn.setAttribute('aria-pressed', String(!!ctx.activeOnly));
function setActiveOnly(on) {
  ctx.activeOnly = !!on;
  storageSet('queuebox.activeOnly', ctx.activeOnly);
  paintActive();
  ctx.map.refit();
  render();
}
activeBtn.addEventListener('click', () => setActiveOnly(!ctx.activeOnly));
paintActive();

// Coming back after a while: a one-line digest of what changed, with a replay from when you left.
const AWAY_MS = 3 * 60_000;
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt >= AWAY_MS) ctx.showAway(hiddenAt);
});

// ------------------------------------------------------------------------------- lens, search, theme

const lensSeg = $('lens');
for (const b of lensSeg.querySelectorAll('button')) {
  b.setAttribute('aria-pressed', String(b.dataset.lens === ctx.lens));
  b.addEventListener('click', () => {
    ctx.lens = b.dataset.lens;
    storageSet('queuebox.lens', ctx.lens);
    for (const x of lensSeg.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    render();
  });
}

$('search-ic').innerHTML = icon('search');
const search = $('search');
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  if (!q || !ctx.board) ctx.search = null;
  else if (/[/.]/.test(q) && !/\s/.test(q)) {
    const id = blockForPath(ctx.live.index, q);
    ctx.search = { matches: new Set(id ? [id] : []), exact: true, path: q };
  } else {
    const hits = ctx.board.blocks.filter((b) => `${b.name} ${b.id} ${(b.keywords || []).join(' ')} ${b.about || ''}`.toLowerCase().includes(q)).map((b) => b.id);
    ctx.search = { matches: new Set(hits), exact: hits.length === 1 };
  }
  render();
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && ctx.search) {
    const [only] = ctx.search.matches;
    if (ctx.search.path) {
      if (only) {
        const b = ctx.live.blocks[only];
        toast(`${search.value.trim()} is in ${nameOf(only)}${b.holder ? `, reserved by ${agentName(ctx.live, b.holder)}` : ', free'}.`);
        ctx.select(only);
      } else toast('No block claims that path.');
    } else if (ctx.search.matches.size === 1) ctx.select(only);
  }
});
// An Enter that confirms an IME composition reaches no handler of ours (the browser doesn't submit a form on it
// either). Escape, drafts included, is one stack (escapeLayer in dom.js).
document.addEventListener(
  'keydown',
  (e) => {
    if ((e.isComposing || e.keyCode === 229) && e.key === 'Enter') e.stopImmediatePropagation();
  },
  true,
);
escapeLayer(ESC.search, () => document.activeElement === search, () => search.blur());
// Settings (the theme kit's dialog) sits over everything, so Escape closes it before anything under it.
escapeLayer(ESC.menu + 10, () => !!document.querySelector('.solenoid-settings'), () => document.querySelector('.solenoid-settings__close')?.click());
function showSettings() {
  openSettings({ sections: [{ title: 'Board', rows: settingsRows() }] });
}
// Ctrl+, (Cmd+, on a Mac) opens Settings, as in Solenoid; it works from a text field too, like the browser's own.
document.addEventListener('keydown', (e) => {
  if (e.key === ',' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !document.querySelector('.solenoid-settings')) {
    e.preventDefault();
    showSettings();
  }
});
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input,textarea,select');
  // ? opens Help (T89).
  if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    openHelp(document.querySelector('button[aria-label="Help"]'));
    return;
  }
  if (e.key === '/' && !typing) {
    e.preventDefault();
    search.focus();
  } else if ((e.key === 't' || e.key === 'T') && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) ctx.map.tidy();
  else if ((e.key === 'n' || e.key === 'N') && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && ctx.mode === 'live') {
    e.preventDefault();
    openNewItem(ctx, $('new-item'));
  }
});

// -------------------------------------------------------------------------------------------- boot

// The page's own code changed on disk (a commit landed): reload, so nobody looks at fixed bugs in an old tab. The
// first stamp is the one this page loaded with. Lens, pan, folds and the timeline are kept in the browser anyway;
// the open block, the focused worktree and the search ride across the reload. With a draft typed, a popover open or a
// tile in hand it waits, offers Reload, and goes once the draft is gone.
let codeStamp = null;
let reloadDue = false;
let reloadOffered = false;
function onVersion(v) {
  if (!v) return;
  if (codeStamp === null || codeStamp === v) {
    codeStamp = v;
    return;
  }
  codeStamp = v;
  reloadDue = true;
  reloadWhenFree();
}
function busy() {
  const typed = [...document.querySelectorAll('input, textarea')].some((f) => f.type !== 'checkbox' && f.value.trim() && f !== search);
  return typed || !!document.querySelector('.popover, .solenoid-settings, .map-menu') || !!ctx.dnd?.active;
}
function reloadWhenFree() {
  if (!reloadDue) return;
  if (!busy()) {
    try {
      sessionStorage.setItem('queuebox.resume', JSON.stringify({ selected: ctx.selected || null, focusWt: ctx.focusWt || null, search: search.value || '' }));
    } catch {
      // Without session storage the reload just starts fresh.
    }
    location.reload();
    return;
  }
  if (!reloadOffered) {
    reloadOffered = true;
    toast('The board has new code. It reloads once your draft is sent.', 'info', { action: { label: 'Reload Now', run: () => location.reload() } });
  }
}
setInterval(reloadWhenFree, 3000);
function resumeView() {
  let r = null;
  try {
    r = JSON.parse(sessionStorage.getItem('queuebox.resume') || 'null');
    sessionStorage.removeItem('queuebox.resume');
  } catch {
    return;
  }
  if (!r) return;
  if (r.search) {
    search.value = r.search;
    search.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (r.focusWt) ctx.focusWt = r.focusWt;
  if (r.selected && ctx.live?.blocks[r.selected]) ctx.select(r.selected);
  render();
}

async function boot() {
  try {
    const src = await connect({
      onBoard: (board) => setBoard(board, ctx.events),
      onReset: (events) => setBoard(ctx.board, events),
      onEvents: (list) => {
        for (const e of list) {
          // A block landing is worth a word (T90): who, which block. Only as it happens, never on a reload or replay.
          const landed = e.type === 'block.release' && e.outcome === 'landed' && !ctx.replayTs && ctx.live.blocks[e.block]?.holder;
          const who = landed ? ctx.live.blocks[e.block].holder : null;
          ctx.events.push(e);
          index(e);
          apply(ctx.live, e);
          if (who) toast(`${agentName(ctx.live, who)} landed ${nameOf(e.block)}.`);
        }
        render();
      },
      onWorktrees: (snap) => {
        ctx.worktrees = snap;
        render();
      },
      onVersion,
      onSessions: (sessions) => {
        ctx.sessions = sessions || {};
        render();
      },
      onStatus: (s, message) => {
        if (s === 'problem') return toast(message, 'error');
        ctx.connState = s;
        render();
      },
    });
    ctx.source = src;
    ctx.mode = src.mode;
    ctx.connState = src.mode;
    setBoard(src.board, src.events);
    resumeView();
  } catch (err) {
    $('map').textContent = '';
    $('map').append(h('p', { class: 'boot' }, `The board didn't load: ${err.message}`));
    setText($('board-name'), 'not connected');
  }
}

setInterval(render, 5000);
startFavicon();
startTimers(() => ctx.viewNow && ctx.replayTs ? ctx.replayTs : Date.now());
window.addEventListener('resize', render);
boot();

// For scripts that drive the page (screenshots, tests).
window.queuebox = ctx;
