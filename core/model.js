// The QueueBox model: an append-only log of events folded into the board's state.
// Runs unchanged in Node (CLI, hooks, server) and in the browser (the board UI, the replay).
//
// The log is the truth. State is never saved; it is the fold of the log over the board config,
// so the timeline can replay any moment, and a board change (a block renamed, a path moved)
// re-maps old activity the next time anything folds it.

import { indexFor, blockForPath, normalizePath } from './glob.js';

export const SCHEMA = 1;
export const HUMAN = 'human';
// The board itself, for what it observes rather than what anyone does (a merge it saw land in git).
export const SYSTEM = 'system';
export const UNMAPPED = '_unmapped';
// Agents are colored by palette slot, not by hex, so a palette change recolors them. Every slot near a status
// color stays out (vermilion and amber for danger, gold and lime for needs-you, green and teal for ok), and
// gray is the human; past five agents the colors repeat and the initials tell them apart.
export const PALETTE = ['sky', 'violet', 'pink', 'blue', 'purple'];
// waiting: the agent needs the human (a question, a permission prompt). review: its turn ended and it waits for the
// next prompt. Both count as needing the human, and neither goes stale until four times the usual quiet.
export const AGENT_STATUS = ['working', 'idle', 'blocked', 'waiting', 'review', 'done'];
export const NEEDS_HUMAN = ['waiting', 'review'];
// A suggestion is an agent's proposed distribution of work ({ plan: [{ agent, item }] }), for the human to apply.
export const ITEM_KINDS = ['task', 'bug', 'question', 'decision', 'note', 'suggestion'];
export const ITEM_STATUS = ['open', 'doing', 'blocked', 'done', 'wontfix'];
export const OUTCOMES = ['landed', 'parked', 'handoff', 'dropped', 'taken'];
export const EVENT_TYPES = [
  'agent.join', 'agent.status', 'agent.beat', 'agent.leave', 'block.reserve', 'block.release', 'block.queue', 'block.unqueue',
  'block.freeze', 'item.add', 'item.update', 'touch', 'test', 'note', 'msg', 'msg.read', 'merge.ready', 'merge.unready',
  'merge.order', 'merge.landed', 'board.change', 'agent.sub', 'item.delete', 'agent.finish',
];
// A subagent's row: running until its spawning call returns (or, run in the background, until it stops).
export const SUB_STATES = ['running', 'done', 'failed'];
const SUB_KEEP = 12;
const TOUCH_OPS = ['edit', 'read', 'run'];
// What an agent is doing this second, as its hooks see it; '' clears it. `question` is never sent: it is an
// open question the agent asked, read from the items.
export const ACTIVITIES = ['thinking', 'reading', 'editing', 'testing', 'running', 'researching', 'delegating', 'waiting', 'permission'];
// Ids are keys in the state, so they are short plain words; the three names that reach an object's prototype never are.
const ID = /^[\w.-]{1,80}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export function validId(id) {
  return typeof id === 'string' && ID.test(id) && !RESERVED.has(id);
}
// The nearest valid id to a name from outside (a worktree's folder).
// The stand-in agent for a worktree whose agent never talks to the board; capped with its prefix, so it stays valid.
export function worktreeAgentId(name) {
  return safeId(`wt-${name}`);
}

export function safeId(name) {
  const id = String(name).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'x';
  return RESERVED.has(id) ? `${id}-` : id;
}
// An empty optional field is absent; anything else must be one of its kind.
const given = (v) => v !== undefined && v !== null && v !== '';
// Only the human and the board itself may force a reservation or act for another agent.
const privileged = (actor) => actor === HUMAN || actor === SYSTEM;
// An agent quiet this long no longer keeps its palette slot for itself (a session that crashed never leaves).
const COLOR_HOLD_MS = 6 * 3600_000;
// How far ahead of the clock an event may be dated: no further than a write in flight.
const FUTURE_MS = 5 * 60_000;
const KIND_PREFIX = { task: 'T', bug: 'B', question: 'Q', decision: 'D', note: 'N', suggestion: 'S' };
const KEEP = 48;

const CODENAMES = [
  'Heron', 'Basalt', 'Juniper', 'Quill', 'Marten', 'Cobalt', 'Fennel', 'Sable', 'Wren', 'Ochre',
  'Tamarack', 'Lumen', 'Pike', 'Saffron', 'Birch', 'Flint', 'Moss', 'Vesper', 'Otter', 'Cinder',
  'Talus', 'Kestrel', 'Larch', 'Alder', 'Bramble', 'Corvid', 'Dune', 'Ember', 'Gannet', 'Hazel',
];

export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function codename(id) {
  return CODENAMES[hash(String(id)) % CODENAMES.length];
}

export function eventId(now, rand = Math.random) {
  return `${Math.floor(now).toString(36)}-${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// State

export function createState(board) {
  const blocks = Object.create(null);
  for (const b of board.blocks) blocks[b.id] = freshBlock(b.id);
  blocks[UNMAPPED] = freshBlock(UNMAPPED);
  const items = Object.create(null);
  for (const it of board.items || []) items[it.id] = { status: 'open', source: 'import', history: [], ...it };
  const state = {
    board,
    index: indexFor(board.blocks),
    blocks,
    agents: Object.create(null),
    items,
    // Ids of deleted items, so a new item never takes one back.
    deleted: [],
    trespass: [],
    notes: [],
    merges: Object.create(null),
    mergeSeq: 0,
    queueSeq: 0,
    count: 0,
    firstTs: 0,
    lastTs: 0,
    staleMs: (board.staleAfterMin ?? 30) * 60_000,
  };
  ensureAgent(state, HUMAN, 0, { name: board.human?.name || 'You', kind: 'human' });
  return state;
}

function freshBlock(id) {
  return { id, holder: null, since: 0, by: null, intent: '', watchers: Object.create(null), queued: null, whole: null, frozen: null, touches: [], test: null, history: [], added: 0, removed: 0 };
}

function ensureAgent(state, id, ts, info = {}) {
  let a = state.agents[id];
  if (!a) {
    a = state.agents[id] = {
      id,
      name: info.name || (id === HUMAN ? 'You' : codename(id)),
      kind: info.kind || (id === HUMAN ? 'human' : id.startsWith('cc-') ? 'Claude Code' : id.startsWith('wt-') ? 'worktree' : 'agent'),
      worktree: info.worktree || '',
      pty: info.pty || '',
      color: info.color || pickColor(state, id, ts),
      model: info.model || '',
      where: info.where || '',
      task: '',
      status: 'idle',
      statusSince: ts,
      doing: '',
      joinedAt: ts,
      lastSeen: ts,
      leftAt: 0,
      held: [],
      watching: [],
      touches: [],
      inbox: [],
      asked: [],
      edits: 0,
      added: 0,
      removed: 0,
      tests: 0,
      lastRun: null,
      lastTest: null,
      activity: null,
      subs: [],
      finishing: 0,
    };
  }
  return a;
}

function pickColor(state, id, ts) {
  if (id === HUMAN) return '';
  // The first slot no present agent wears, in PALETTE's order, so the first agents get the cool hues. An agent
  // that left, or has been quiet for hours, doesn't keep its slot.
  const used = new Set(Object.values(state.agents).filter((a) => a.id !== HUMAN && !a.leftAt && ts - a.lastSeen <= COLOR_HOLD_MS).map((a) => a.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[hash(id) % PALETTE.length];
}

function setStatus(a, status, ts) {
  if (a.status !== status) a.statusSince = ts;
  a.status = status;
}

function push(list, entry) {
  list.push(entry);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
}

function addUnique(list, v) {
  if (!list.includes(v)) list.push(v);
}

function remove(list, v) {
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
}

function releaseInternal(state, b, ts, outcome, note, by) {
  const holder = b.holder;
  if (!holder) return;
  b.history.push({ agent: holder, from: b.since, to: ts, outcome: outcome || 'parked', intent: b.intent, note: note || '', by });
  const a = state.agents[holder];
  if (a) remove(a.held, b.id);
  b.holder = null;
  b.since = 0;
  b.intent = '';
}

// ---------------------------------------------------------------------------------------------
// The fold

export function reduce(board, events, untilTs = Infinity) {
  const state = createState(board);
  for (const e of events) {
    if (e.ts > untilTs) continue;
    apply(state, e);
  }
  return state;
}

// Whether a logged event can be folded at all: a log can be edited by hand, so the fold skips an event whose
// time isn't a number or whose ids aren't ids, rather than letting one reach the page or an object's prototype.
function foldable(e) {
  if (!e || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return false;
  if (!validId(e.by || HUMAN)) return false;
  if (typeof e.agent === 'string' && !validId(e.agent)) return false;
  if (given(e.block) && !validId(e.block)) return false;
  if (given(e.worktree) && !validId(e.worktree)) return false;
  if (given(e.to) && e.to !== '*' && !validId(e.to)) return false;
  if ((e.type === 'item.update' || e.type === 'item.delete') && !validId(e.item)) return false;
  if (e.type === 'item.add' && given(e.item?.id) && !validId(e.item.id)) return false;
  return true;
}

// A block's queue summary for the page, from its whole-block entry and its queued items: null when it has none.
function syncQueued(state, b) {
  const items = Object.values(state.items).filter((it) => it.block === b.id && it.queued && it.status !== 'done' && it.status !== 'wontfix').sort((x, y) => x.queued.pos - y.queued.pos);
  if (!b.whole && !items.length) {
    b.queued = null;
    return;
  }
  const first = b.whole || items[0].queued;
  b.queued = { ts: first.ts, note: b.whole?.note || '', items: items.map((it) => it.id), pos: Math.min(b.whole?.pos ?? Infinity, items[0]?.queued.pos ?? Infinity), by: first.by, whole: !!b.whole };
}

// What a reservation takes from the queue: the block's whole entry, and the items it names (`take`). A reservation
// written before items were queued one by one (no `take`) takes every item queued with the block, as it did then.
function takeQueued(state, b, target, e, actor) {
  const ids = Array.isArray(e.take) ? e.take : b.queued?.items || [];
  for (const iid of ids) {
    const it = state.items[iid];
    if (!it || it.block !== b.id || it.status === 'done' || it.status === 'wontfix') continue;
    it.status = 'doing';
    it.assignee = target.id;
    it.queued = null;
    it.history.push({ ts: e.ts, by: actor, status: 'doing', note: `taken with ${b.id}` });
    if (target.id !== HUMAN) target.task = `${it.id}: ${it.title}`;
  }
  b.whole = null;
  syncQueued(state, b);
}

// Events that don't say their author is working here (filing, messaging, reshaping the board). A question is the exception: its asker waits on it.
function passive(e) {
  if (e.type === 'item.add') return e.item?.kind !== 'question';
  // Queuing, unqueuing and freezing are the person's acts on the board, whoever types them (B17).
  return ['item.update', 'item.delete', 'msg', 'msg.read', 'board.change', 'block.queue', 'block.unqueue', 'block.freeze'].includes(e.type);
}

export function apply(state, e) {
  if (!foldable(e)) return state;
  state.count++;
  if (!state.firstTs) state.firstTs = e.ts;
  state.lastTs = Math.max(state.lastTs, e.ts);
  const actor = e.by || HUMAN;
  if (actor === SYSTEM) {
    applySystem(state, e);
    return state;
  }
  // Filing, updating an item, messaging or reading the inbox don't put an author on the board: one who
  // isn't on it (never joined, or left) stays off, with a record so its name and inbox still resolve.
  const offBoard = actor !== HUMAN && passive(e) && (!state.agents[actor] || state.agents[actor].leftAt);
  const me = ensureAgent(state, actor, e.ts, e.type === 'agent.join' ? e.agent : undefined);
  if (offBoard) {
    if (!me.leftAt) {
      me.leftAt = e.ts;
      me.joinedAt = 0;
      me.status = 'done';
    }
  } else {
    me.lastSeen = Math.max(me.lastSeen, e.ts);
    if (e.activity !== undefined && actor !== HUMAN) me.activity = e.activity ? { tag: e.activity, ts: e.ts } : null;
    if (me.leftAt && e.type !== 'agent.leave' && actor !== HUMAN) {
      me.leftAt = 0;
      if (!me.joinedAt) me.joinedAt = e.ts;
    }
  }
  // Acting for another agent is the human's alone; anyone else naming one acts for themselves.
  const target = typeof e.agent === 'string' && (e.agent === actor || actor === HUMAN) ? ensureAgent(state, e.agent, e.ts) : me;

  switch (e.type) {
    case 'agent.join': {
      const info = e.agent || {};
      for (const k of ['name', 'kind', 'model', 'where', 'color', 'worktree']) if (info[k]) me[k] = info[k];
      // The socket of the terminal `qb run` gave it, which the board types into to wake it; '' clears it.
      if (info.pty !== undefined) me.pty = info.pty;
      if (me.leftAt || !me.joinedAt) me.joinedAt = e.ts;
      me.leftAt = 0;
      if (e.task) me.task = e.task;
      setStatus(me, e.task ? 'working' : 'idle', e.ts);
      break;
    }
    case 'agent.status': {
      if (e.status) setStatus(target, e.status, e.ts);
      // What the agent said it is doing (`qb doing`) stands until it says something else: a hook's automatic line
      // (auto) never replaces it, except one the person must see (urgent: a permission prompt), and the next
      // automatic line puts the agent's own back.
      if (e.doing !== undefined) {
        if (!e.auto) target.said = e.doing;
        target.doing = !e.auto || e.urgent || !target.said ? e.doing : target.said;
      }
      if (e.task !== undefined) target.task = e.task;
      if (e.name) target.name = e.name;
      // What it said last, at the end of its turn (the Stop hook reads it from the transcript), for the page to open.
      if (typeof e.last === 'string') target.last = { text: e.last, ts: e.ts };
      break;
    }
    // A subagent the agent spawned, one compact row in its window. Keyed by the spawning call's id; its run id (aid)
    // links the end that arrives later when it ran in the background. Only a start (with a description) makes a
    // row; an end for a row never seen is dropped. Its tool calls are the agent's own: they count as its work.
    // Finish and stop (T38), by the person: the agent completes what it has and takes nothing new (no queued work,
    // no planning nudge) until resumed. finishing is when it was asked, 0 once resumed.
    case 'agent.finish': {
      target.finishing = e.on === false ? 0 : e.ts;
      break;
    }
    case 'agent.sub': {
      const subs = me.subs || (me.subs = []);
      let s = subs.find((x) => (e.sub && x.id === e.sub) || (e.aid && x.aid === e.aid));
      if (!s) {
        if (!e.desc) break;
        s = { id: e.sub || e.aid, aid: '', desc: '', kind: '', state: 'running', since: e.ts, end: 0 };
        subs.push(s);
        if (subs.length > SUB_KEEP) subs.splice(0, subs.length - SUB_KEEP);
      }
      if (e.aid) s.aid = e.aid;
      if (e.desc) s.desc = e.desc;
      if (e.kind) s.kind = e.kind;
      if (e.state && e.state !== 'running' && s.state === 'running') {
        s.state = e.state;
        s.end = e.ts;
      }
      break;
    }
    case 'agent.beat':
      break;
    case 'agent.leave': {
      for (const id of [...target.held]) releaseInternal(state, state.blocks[id], e.ts, e.outcome || 'parked', e.note, actor);
      for (const id of target.watching) if (state.blocks[id]) delete state.blocks[id].watchers[target.id];
      target.watching = [];
      target.leftAt = e.ts;
      setStatus(target, 'done', e.ts);
      target.doing = e.note || '';
      break;
    }
    case 'block.reserve': {
      const b = state.blocks[e.block];
      if (!b) break;
      if (e.mode === 'watch') {
        b.watchers[target.id] = e.ts;
        addUnique(target.watching, b.id);
        break;
      }
      // Files no block claims aren't a block anyone can hold: taking them hands over the items queued there (filed on
      // unclaimed files), and nobody becomes the holder.
      if (e.block === UNMAPPED) {
        takeQueued(state, b, target, e, actor);
        if (target.id !== HUMAN && target.status !== 'blocked') setStatus(target, 'working', e.ts);
        break;
      }
      if (b.holder === target.id) {
        if (e.intent) b.intent = e.intent;
        if (e.take) takeQueued(state, b, target, e, actor);
        if (e.intent && !e.auto && target.id !== HUMAN) target.task = e.intent;
        break;
      }
      if (b.holder) releaseInternal(state, b, e.ts, 'taken', `taken by ${target.name}`, actor);
      b.holder = target.id;
      b.since = e.ts;
      // Who made the reservation: the agent itself, or the person giving it the block (B28).
      b.by = actor;
      b.intent = e.intent || queuedIntent(state, b.queued);
      takeQueued(state, b, target, e, actor);
      delete b.watchers[target.id];
      remove(target.watching, b.id);
      addUnique(target.held, b.id);
      if (target.id !== HUMAN && target.status !== 'blocked') setStatus(target, 'working', e.ts);
      // What it reserves the block for is its task now: the session's first prompt, which the hook takes as a
      // task until there is one, never outlives real work. A hook's own reservation on an edit (auto) says nothing new.
      if (b.intent && !e.auto && target.id !== HUMAN) target.task = b.intent;
      break;
    }
    case 'block.release': {
      const b = state.blocks[e.block];
      if (!b) break;
      if (b.watchers[target.id] && b.holder !== target.id) {
        delete b.watchers[target.id];
        remove(target.watching, b.id);
        break;
      }
      if (b.holder && (b.holder === target.id || actor === HUMAN)) {
        releaseInternal(state, b, e.ts, e.outcome, e.note, actor);
      }
      break;
    }
    // The queue holds entries, each with its own place: a whole block, or one item (B13). An item is taken on its
    // own; `b.queued` sums up a block's entries for the page (its note, its queued items, its first place).
    case 'block.queue': {
      // An item with no block (one typed into Up next, B31) is queued on its own: no block to sum it into.
      if (!e.block && e.item) {
        const it = state.items[e.item];
        if (it && !it.block && !it.queued) {
          it.queued = { pos: ++state.queueSeq, ts: e.ts, by: actor };
          // Back on the queue it is the team's: nobody's, and open.
          it.assignee = null;
          if (it.status === 'doing' || it.status === 'blocked') it.status = 'open';
          it.history.push({ ts: e.ts, by: actor, status: it.status, note: 'queued' });
        }
        break;
      }
      const b = state.blocks[e.block];
      if (!b) break;
      if (e.item) {
        const it = state.items[e.item];
        if (it && !it.queued) it.queued = { pos: ++state.queueSeq, ts: e.ts, by: actor };
      } else if (!b.whole) b.whole = { ts: e.ts, note: e.note || '', pos: ++state.queueSeq, by: actor };
      else if (e.note) b.whole.note = e.note;
      syncQueued(state, b);
      break;
    }
    case 'block.unqueue': {
      if (!e.block && e.item) {
        if (state.items[e.item] && !state.items[e.item].block) state.items[e.item].queued = null;
        break;
      }
      const b = state.blocks[e.block];
      if (!b) break;
      if (e.item) {
        if (state.items[e.item]) state.items[e.item].queued = null;
      } else b.whole = null;
      syncQueued(state, b);
      break;
    }
    case 'block.freeze': {
      const b = state.blocks[e.block];
      if (b) b.frozen = e.on === false ? null : { ts: e.ts, note: e.note || '', by: actor };
      break;
    }
    case 'item.add': {
      const it = e.item;
      if (!it?.id) break;
      state.items[it.id] = {
        kind: 'task',
        block: null,
        detail: '',
        ...it,
        status: it.status || 'open',
        source: 'board',
        createdAt: e.ts,
        by: actor,
        history: [],
      };
      // Typed into Up next (B31): filed with no block and queued at once, for whoever takes it to file properly.
      if (e.queue === true && !state.items[it.id].block) state.items[it.id].queued = { pos: ++state.queueSeq, ts: e.ts, by: actor };
      if (it.kind === 'question') {
        addUnique(me.asked, it.id);
        if (actor !== HUMAN) setStatus(me, 'waiting', e.ts);
      }
      break;
    }
    case 'item.update': {
      const it = state.items[e.item];
      if (!it) break;
      const before = it.status;
      const wasBlock = it.block;
      for (const k of ['status', 'title', 'block', 'assignee', 'answer', 'detail']) if (e[k] !== undefined) it[k] = e[k];
      // Given to someone, taken up, finished or moved: it leaves the queue.
      if (it.queued && (e.assignee || ['doing', 'done', 'wontfix'].includes(e.status) || (e.block && e.block !== wasBlock))) {
        it.queued = null;
        if (state.blocks[wasBlock]) syncQueued(state, state.blocks[wasBlock]);
      }
      // Work an agent takes up (it marks the item doing, or the person gives it the item) is its task line now (B8).
      const worker = e.assignee || (e.status === 'doing' && actor !== HUMAN ? actor : null);
      if (worker && worker !== HUMAN && state.agents[worker] && it.kind !== 'question' && it.kind !== 'suggestion' && it.status !== 'done' && it.status !== 'wontfix') state.agents[worker].task = `${it.id}: ${it.title}`;
      it.history.push({ ts: e.ts, by: actor, status: it.status, note: e.note || '' });
      if (it.kind === 'question' && e.answer && it.by && state.agents[it.by]) {
        const asker = state.agents[it.by];
        asker.inbox.push({ id: e.id, ts: e.ts, from: actor, text: `Answer to ${it.id} (${it.title}): ${e.answer}` });
        if (it.status === 'open') it.status = 'done';
      }
      if (it.kind === 'question' && it.status !== 'open' && before === 'open' && it.by && state.agents[it.by]) {
        const asker = state.agents[it.by];
        remove(asker.asked, it.id);
        if (asker.status === 'waiting' && !asker.asked.length) setStatus(asker, 'working', e.ts);
      }
      break;
    }
    // An item filed by mistake goes away: off the queue, out of its asker's open questions, out of the state. The
    // log keeps the event, so a replay before it still shows the item.
    case 'item.delete': {
      const it = state.items[e.item];
      if (!it) break;
      delete state.items[e.item];
      state.deleted.push(e.item);
      if (it.queued && state.blocks[it.block]) syncQueued(state, state.blocks[it.block]);
      if (it.kind === 'question' && it.by && state.agents[it.by]) {
        const asker = state.agents[it.by];
        remove(asker.asked, it.id);
        if (asker.status === 'waiting' && !asker.asked.length) setStatus(asker, 'working', e.ts);
      }
      break;
    }
    case 'touch': {
      const op = e.op || 'edit';
      if (op === 'run') {
        target.lastRun = { ts: e.ts, cmd: e.cmd || '' };
        push(target.touches, { ts: e.ts, op, cmd: e.cmd || '', block: null, file: '' });
        break;
      }
      for (const [i, raw] of (e.files || []).entries()) {
        const file = normalizePath(raw);
        const id = blockForPath(state.index, file) || UNMAPPED;
        // The block it was in then, when the event says (B32); only an edit in that same block can be a trespass now.
        const sameBlock = !Array.isArray(e.blocks) || e.blocks[i] === undefined || e.blocks[i] === id;
        const b = state.blocks[id];
        push(b.touches, { ts: e.ts, agent: target.id, file, op });
        push(target.touches, { ts: e.ts, file, block: id, op });
        if (op === 'edit') {
          target.edits++;
          // Line counts ride on a single-file edit (the hooks measure them); a multi-file touch carries none.
          if ((e.files || []).length === 1) {
            target.added += e.add || 0;
            target.removed += e.del || 0;
            b.added += e.add || 0;
            b.removed += e.del || 0;
          }
          if (!sameBlock) {
            // Moved into this block since: its activity, not a trespass.
          } else if (b.holder && b.holder !== target.id) {
            push(state.trespass, { ts: e.ts, agent: target.id, block: id, holder: b.holder, file, kind: 'held' });
          } else if (b.frozen) {
            push(state.trespass, { ts: e.ts, agent: target.id, block: id, holder: null, file, kind: 'frozen' });
          }
        }
      }
      break;
    }
    case 'test': {
      let ids = e.blocks && e.blocks.length ? e.blocks : [...target.held];
      if (!ids.length) ids = recentBlocks(target, e.ts, 15 * 60_000);
      for (const id of ids) {
        const b = state.blocks[id];
        if (b) b.test = { ok: !!e.ok, ts: e.ts, summary: e.summary || '', agent: target.id };
      }
      target.tests++;
      target.lastTest = { ok: !!e.ok, ts: e.ts, summary: e.summary || '' };
      break;
    }
    // The board was reshaped (core/board-ops.js). The fold already runs over the new board; this moves open items
    // of blocks that went away to the block that took their files.
    case 'board.change': {
      for (const [from, to] of Object.entries(e.remap || {})) {
        if (!state.blocks[to]) continue;
        for (const it of Object.values(state.items)) {
          if (it.block !== from || it.status === 'done' || it.status === 'wontfix') continue;
          it.block = to;
          it.history.push({ ts: e.ts, by: actor, status: it.status, note: `moved from ${from} with the board` });
        }
      }
      break;
    }
    case 'note': {
      // An Auto-Apply's note carries what it changed, so the person can undo it (T59).
      push(state.notes, { id: e.id, ts: e.ts, agent: target.id, text: e.text || '', block: e.block || null, ...(e.applied ? { applied: e.applied } : {}) });
      break;
    }
    case 'msg': {
      const to = e.to === '*' ? Object.values(state.agents).filter((a) => !a.leftAt && a.id !== HUMAN) : [state.agents[e.to]].filter(Boolean);
      for (const a of to) a.inbox.push({ id: e.id, ts: e.ts, from: actor, text: e.text || '' });
      break;
    }
    case 'msg.read': {
      const ids = new Set(e.ids || []);
      target.inbox = target.inbox.filter((m) => !ids.has(m.id) && !(e.upTo && m.ts <= e.upTo));
      break;
    }
    // The merge queue: a worktree's branch, marked ready at a commit, waits its turn to merge into the base.
    case 'merge.ready': {
      const prev = state.merges[e.worktree];
      state.merges[e.worktree] = {
        worktree: e.worktree,
        branch: e.branch || '',
        commit: e.commit || '',
        // Commits ahead of the base when it was marked ready; a branch with none is never seen to land.
        ahead: Number.isFinite(e.ahead) ? e.ahead : null,
        note: e.note || '',
        agent: target.id,
        readyAt: e.ts,
        pos: prev && prev.status === 'ready' ? prev.pos : ++state.mergeSeq,
        status: 'ready',
        landedAt: 0,
      };
      break;
    }
    case 'merge.unready': {
      delete state.merges[e.worktree];
      break;
    }
    case 'merge.order': {
      const m = state.merges[e.worktree];
      if (m) m.pos = Number(e.pos);
      break;
    }
    case 'merge.landed': {
      const m = state.merges[e.worktree];
      if (m) {
        m.status = 'landed';
        m.landedAt = e.ts;
        if (e.commit) m.commit = e.commit;
      }
      break;
    }
    default:
      break;
  }
  return state;
}

function applySystem(state, e) {
  if (e.type === 'merge.landed') {
    const m = state.merges[e.worktree];
    if (m) {
      m.status = 'landed';
      m.landedAt = e.ts;
      if (e.commit) m.commit = e.commit;
    }
  }
}

function recentBlocks(agent, now, windowMs) {
  const out = [];
  for (let i = agent.touches.length - 1; i >= 0; i--) {
    const t = agent.touches[i];
    if (now - t.ts > windowMs) break;
    if (t.block && t.block !== UNMAPPED && !out.includes(t.block)) out.push(t.block);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading the state

export function blockMeta(state, id) {
  if (id === UNMAPPED) return { id, name: 'Unmapped files', district: null, about: 'Files no block claims. Add them to a block in the board config.' };
  return state.board.blocks.find((b) => b.id === id) || null;
}

export function agentName(state, id) {
  if (id === SYSTEM) return 'QueueBox';
  return state.agents[id]?.name || (id === HUMAN ? 'You' : codename(id));
}

export function isStale(state, agentId, now) {
  const a = state.agents[agentId];
  if (!a || agentId === HUMAN) return false;
  if (a.leftAt) return true;
  return now - a.lastSeen > quietLimit(state, a);
}

function quietLimit(state, a) {
  return NEEDS_HUMAN.includes(a.status) ? state.staleMs * 4 : state.staleMs;
}

// Whether the agent is waiting on the human right now: a question, a permission prompt, or a finished turn.
export function needsHuman(state, agentId, now) {
  // A permission prompt, an open question, or blocked (T85); a finished turn is the board's to manage, not the
  // person's (B11).
  const p = presence(state, agentId, now);
  return p === 'waiting' || p === 'blocked';
}

// The items assigned to an agent that are marked blocked, oldest first (T85).
export function blockedItems(state, agentId) {
  return Object.values(state.items).filter((it) => it.assignee === agentId && it.status === 'blocked' && it.kind !== 'suggestion').sort((x, y) => blockedAt(x) - blockedAt(y));
}
const blockedAt = (it) => (it.history || []).findLast((h) => h.status === 'blocked')?.ts || it.createdAt || 0;

// What an agent's window shows as its state.
export function presence(state, agentId, now) {
  const a = state.agents[agentId];
  if (!a) return 'gone';
  if (agentId === HUMAN) return 'here';
  if (a.leftAt) return 'gone';
  if (now - a.lastSeen > quietLimit(state, a)) return 'stale';
  if (openQuestions(state, agentId).length) return 'waiting';
  // Blocked (T85): it said so, or, between turns with nothing in progress, its work is marked blocked.
  if (a.status !== 'working' && a.status !== 'waiting' && blockedItems(state, agentId).length && !Object.values(state.items).some((it) => it.assignee === agentId && it.status === 'doing')) return 'blocked';
  return a.status;
}

// Idle with nothing to do: its turn is over (or it never had one), it reserves nothing, no item assigned to it is
// still open, and it has no question of its own waiting. Distinct from a turn finished mid-task (review with work).
export function isIdleFree(state, agentId, now) {
  const a = state.agents[agentId];
  if (!a || agentId === HUMAN) return false;
  const p = presence(state, agentId, now);
  if (p !== 'review' && p !== 'idle') return false;
  if (a.held.length) return false;
  return !Object.values(state.items).some((it) => it.assignee === agentId && (it.status === 'open' || it.status === 'doing' || it.status === 'blocked'));
}

// Whether a message reaches the agent soon: it is mid-turn (it reads its inbox on its next tool call) or about to
// be, past a permission prompt. Otherwise the board wakes it (a background session) or it reads it on its next run. Otherwise it waits for its next run.
export function readsSoon(state, agentId, now, sessions = null) {
  const p = presence(state, agentId, now);
  const tag = state.agents[agentId]?.activity?.tag;
  if (p === 'working' || (p === 'waiting' && tag === 'permission')) return true;
  // An idle background session is the board's to wake, and a message wakes it within seconds (T28); `sessions` is
  // the server's 'sessions' event: { agentId: { kind, status } }.
  return sessions?.[agentId]?.kind === 'background' && state.board?.nudgeIdle !== false;
}

// The activity tag to show beside an agent's state: what it is doing this second, never the state word again,
// and nothing for an agent that is gone, quiet or between turns.
export function activityOf(state, agentId, now) {
  const a = state.agents[agentId];
  const p = presence(state, agentId, now);
  if (!a || !['working', 'waiting', 'blocked'].includes(p)) return '';
  if (openQuestions(state, agentId).length) return 'question';
  const tag = a.activity?.tag || '';
  return tag === p ? '' : tag;
}

// When the state presence() reports began: the timer an agent's window runs.
export function presenceSince(state, agentId, now) {
  const a = state.agents[agentId];
  if (!a) return now;
  const p = presence(state, agentId, now);
  if (p === 'gone') return a.leftAt;
  if (p === 'stale') return a.lastSeen;
  const asked = openQuestions(state, agentId).map((q) => q.createdAt);
  if (p === 'waiting' && asked.length) return Math.min(...asked);
  if (p === 'blocked' && a.status !== 'blocked') return blockedAt(blockedItems(state, agentId)[0]);
  return a.statusSince || a.joinedAt;
}

export function openQuestions(state, agentId) {
  return Object.values(state.items).filter((it) => it.kind === 'question' && it.by === agentId && it.status === 'open');
}

export function heat(block, now, halfLifeMs = 20 * 60_000) {
  let h = 0;
  for (const t of block.touches) {
    const age = Math.max(0, now - t.ts);
    const w = t.op === 'edit' ? 1 : t.op === 'read' ? 0.3 : 0.2;
    h += w * 0.5 ** (age / halfLifeMs);
  }
  return h;
}

export function itemCounts(state, blockId) {
  const c = { bug: 0, task: 0, decision: 0, question: 0, note: 0, open: 0, doing: 0, done: 0 };
  for (const it of Object.values(state.items)) {
    if (it.block !== blockId) continue;
    if (it.status === 'done' || it.status === 'wontfix') {
      c.done++;
      continue;
    }
    c[it.kind] = (c[it.kind] || 0) + 1;
    c.open++;
    if (it.status === 'doing') c.doing++;
  }
  return c;
}

export function recentToucher(block, now, windowMs = 30 * 60_000) {
  for (let i = block.touches.length - 1; i >= 0; i--) {
    const t = block.touches[i];
    if (now - t.ts > windowMs) return null;
    if (t.agent) return t.agent;
  }
  return null;
}

// Agents (other than the holder) who touched the block lately: footprints on the tile.
export function footprints(block, now, windowMs = 60 * 60_000) {
  const seen = new Set();
  for (let i = block.touches.length - 1; i >= 0; i--) {
    const t = block.touches[i];
    if (now - t.ts > windowMs) break;
    if (t.agent && t.agent !== block.holder) seen.add(t.agent);
  }
  return [...seen];
}

export function alerts(state, now) {
  const out = [];
  const seen = new Set();
  for (let i = state.trespass.length - 1; i >= 0; i--) {
    const t = state.trespass[i];
    if (now - t.ts > 3 * 3600_000) break;
    const key = `${t.agent}|${t.block}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const b = state.blocks[t.block];
    if (t.kind === 'held' && b.holder !== t.holder) continue;
    if (t.kind === 'frozen' && !b.frozen) continue;
    const name = blockMeta(state, t.block)?.name || t.block;
    out.push({
      kind: t.kind === 'frozen' ? 'frozen' : 'trespass',
      severity: 'high',
      ts: t.ts,
      block: t.block,
      agent: t.agent,
      text:
        t.kind === 'frozen'
          ? `${agentName(state, t.agent)} edited ${t.file.split('/').pop()} in frozen ${name}`
          : `${agentName(state, t.agent)} edited ${t.file.split('/').pop()} in ${agentName(state, t.holder)}'s ${name}`,
    });
  }
  for (const b of Object.values(state.blocks)) {
    if (b.holder && b.holder !== HUMAN && isStale(state, b.holder, now)) {
      const a = state.agents[b.holder];
      out.push({
        kind: 'stale',
        severity: 'medium',
        ts: a.lastSeen,
        block: b.id,
        agent: b.holder,
        text: `${a.name} went quiet with ${blockMeta(state, b.id)?.name || b.id} reserved`,
      });
    }
    if (b.test && !b.test.ok && now - b.test.ts < 6 * 3600_000) {
      out.push({
        kind: 'failing',
        severity: 'high',
        ts: b.test.ts,
        block: b.id,
        agent: b.test.agent,
        text: `${blockMeta(state, b.id)?.name || b.id}: ${b.test.summary || 'tests fail'}`,
      });
    }
  }
  for (const it of Object.values(state.items)) {
    if (it.kind === 'question' && it.status === 'open' && it.by && it.by !== HUMAN) {
      out.push({ kind: 'question', severity: 'medium', ts: it.createdAt, block: it.block, agent: it.by, item: it.id, text: `${agentName(state, it.by)} asks: ${it.title}` });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.ts - a.ts);
}

// The merge queue in order: ready branches by position, then the two that landed last, for ten minutes.
export function mergeQueue(state, now) {
  const all = Object.values(state.merges);
  const ready = all.filter((m) => m.status === 'ready').sort((a, b) => a.pos - b.pos);
  const done = all.filter((m) => m.status === 'landed' && now - m.landedAt < 10 * 60_000).sort((a, b) => b.landedAt - a.landedAt).slice(0, 2);
  return [...ready, ...done];
}

// What a queued block is for: the person's note, else the titles of the items queued with it.
export function queuedIntent(state, queued) {
  if (!queued) return '';
  if (queued.note) return queued.note;
  return (queued.items || []).map((iid) => state.items[iid]?.title).filter(Boolean).join('; ');
}

// Every entry in the queue, in order: { kind: 'block', block, pos, note } for a whole block, { kind: 'item', item,
// block, pos } for one item (B13).
export function queueEntries(state) {
  const out = [];
  for (const b of Object.values(state.blocks)) if (b.whole) out.push({ kind: 'block', block: b.id, pos: b.whole.pos, note: b.whole.note });
  for (const it of Object.values(state.items)) {
    if (it.queued && it.status !== 'done' && it.status !== 'wontfix') out.push({ kind: 'item', item: it.id, block: it.block || null, pos: it.queued.pos });
  }
  return out.sort((x, y) => x.pos - y.pos);
}

// The first entry an agent can take now: one whose block is free, or already its own, and not frozen. An item
// whose block someone else has reserved waits for it. `skip` holds entries already promised to someone else.
export function nextFor(state, agentId, skip = new Set()) {
  if (state.agents[agentId]?.finishing) return null;
  // A block promised to someone else in the same pass counts as theirs already.
  const promised = new Set([...skip].map((k) => (k.startsWith('block:') ? k.slice(6) : state.items[k]?.block)).filter(Boolean));
  for (const q of queueEntries(state)) {
    const key = q.kind === 'item' ? q.item : `block:${q.block}`;
    if (skip.has(key)) continue;
    // An item with no block anyone can take; one with a block needs it free, or already its taker's.
    const b = q.block ? state.blocks[q.block] : null;
    if (q.block && (promised.has(q.block) || !b || b.frozen || (b.holder && b.holder !== agentId))) continue;
    return { ...q, key };
  }
  return null;
}

// Who takes queued work (T53): each entry, in the person's queue order, goes to the free agent with the most context
// for it, deterministically: the same state gives the same answer. Context is points, whole numbers so ties are
// exact: each edit the agent made in the entry's block (10, halving every two hours), each past reservation of the
// block (20, halving likewise), each item there it filed or finished (5), and its worktree's branch already changing
// the block (15; `branches` maps an agent to the blocks its branch changes). Ties, and entries nobody knows, go to
// the agent idle longest, then by id. An agent takes one entry per pass; a block someone reserves waits for them.
const CONTEXT_HALF_LIFE = 2 * 60 * 60_000;
const fade = (pts, age) => Math.round(pts * 0.5 ** (Math.max(0, age) / CONTEXT_HALF_LIFE));
export function contextFor(state, agentId, blockId, now, branches) {
  const b = state.blocks[blockId];
  const out = { points: 0, edits: 0, reserved: 0, items: 0, branch: false };
  if (!b) return out;
  for (const t of b.touches) {
    if (t.agent !== agentId || t.op !== 'edit') continue;
    out.edits++;
    out.points += fade(10, now - t.ts);
  }
  for (const r of b.history) {
    if (r.agent !== agentId) continue;
    out.reserved++;
    out.points += fade(20, now - r.to);
  }
  if (b.holder === agentId) {
    out.reserved++;
    out.points += 20;
  }
  for (const it of Object.values(state.items)) {
    if (it.block !== blockId) continue;
    const finished = it.history.some((x) => x.by === agentId && x.status === 'done');
    if (it.by === agentId || finished) {
      out.items++;
      out.points += 5;
    }
  }
  if (branches?.get(agentId)?.has(blockId)) {
    out.branch = true;
    out.points += 15;
  }
  return out;
}
const times = (n, word) => (n === 1 ? `${word} once` : `${word} ${n}x`);
export function contextWhy(state, ctx, blockId) {
  const name = blockMeta(state, blockId)?.name || blockId;
  const parts = [];
  if (ctx.edits) parts.push(`${times(ctx.edits, `edited ${name}`)}`);
  if (ctx.reserved) parts.push(times(ctx.reserved, 'reserved it'));
  if (ctx.items) parts.push(`filed or finished ${ctx.items} item${ctx.items === 1 ? '' : 's'} there`);
  if (ctx.branch) parts.push('its branch changes it');
  return parts.join(', ');
}
// The plan for a pass: [{ entry, agent, points, why }] for the entries that find a taker, in queue order. `free` is
// the agents that may take work now (idle, not stopped); the rest of the queue waits. With `waitMin` (the board's
// Wait for context, off by default) an entry queued less than that many minutes ago waits for a busy agent that
// outscores every free one by a margin (at least 20 points, and twice the best free score); those are listed in
// `plan.waiting` as { entry, agent, points, why } and take no one in this pass.
export const WAIT_MARGIN = 20;
export function queuePlan(state, free, now, { branches = null, waitMin = 0 } = {}) {
  // An agent asked to finish and stop (T38) takes nothing new.
  const left = new Set(free.filter((id) => state.agents[id] && !state.agents[id].leftAt && !state.agents[id].finishing));
  const idleSince = (id) => state.agents[id].statusSince || state.agents[id].joinedAt || 0;
  const plan = [];
  // Not enumerable, so a plan still compares and spreads as the plain list of takers.
  Object.defineProperty(plan, 'waiting', { value: [], enumerable: false });
  const promised = new Set();
  const freeSet = new Set(free);
  const busy = waitMin > 0 ? Object.values(state.agents).filter((a) => a.id !== HUMAN && !a.leftAt && !a.finishing && !freeSet.has(a.id)).map((a) => a.id) : [];
  for (const q of queueEntries(state)) {
    if (!left.size) break;
    const b = q.block ? state.blocks[q.block] : null;
    if (q.block && (!b || b.frozen || promised.has(q.block))) continue;
    // A block someone reserves waits for them; only they can take it. An item with no block is anyone's, by idleness.
    const pool = b?.holder ? [...left].filter((id) => id === b.holder) : [...left];
    if (!pool.length) continue;
    const scored = pool.map((id) => ({ id, ctx: contextFor(state, id, q.block, now, branches) }));
    scored.sort((x, y) => y.ctx.points - x.ctx.points || idleSince(x.id) - idleSince(y.id) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const best = scored[0];
    const key0 = q.kind === 'item' ? q.item : `block:${q.block}`;
    if (busy.length && b && !b.holder) {
      const queuedAt = q.kind === 'item' ? state.items[q.item]?.queued?.ts : b.whole?.ts;
      const rival = busy.map((id) => ({ id, ctx: contextFor(state, id, q.block, now, branches) })).sort((x, y) => y.ctx.points - x.ctx.points || (x.id < y.id ? -1 : 1))[0];
      if (rival && now - (queuedAt || 0) < waitMin * 60_000 && rival.ctx.points >= Math.max(WAIT_MARGIN, 2 * best.ctx.points)) {
        promised.add(q.block);
        plan.waiting.push({ entry: { ...q, key: key0 }, agent: rival.id, points: rival.ctx.points, why: contextWhy(state, rival.ctx, q.block) });
        continue;
      }
    }
    left.delete(best.id);
    if (q.block) promised.add(q.block);
    const key = q.kind === 'item' ? q.item : `block:${q.block}`;
    plan.push({ entry: { ...q, key }, agent: best.id, points: best.ctx.points, why: best.ctx.points > 0 ? contextWhy(state, best.ctx, q.block) : 'idle longest, nobody has context there' });
  }
  return plan;
}

// Applying a suggestion (B5): each item goes to its agent, who gets its block when it is free, or the item queued with
// the block when someone else has it; each agent hears what it got. One plan for the person's Apply and the board's
// Auto-Apply (T59). With `guard`, Auto-Apply leaves out what someone is working on: an item another agent has marked
// doing, an item whose block another agent reserves and has touched in the last 20 minutes, and an item another
// suggestion placed with an agent that still has it (the first applied wins). Returns { events, given: [{ item, agent }],
// left: [{ item, agent, why }], prev: [{ item, assignee }] } for the caller to commit as the person.
export function suggestionPlan(state, id, { guard = false, now = Date.now() } = {}) {
  const sug = state.items[id];
  const out = { events: [], given: [], left: [], prev: [] };
  if (!sug || sug.kind !== 'suggestion' || sug.status !== 'open') return out;
  const taken = {};
  const got = new Map();
  for (const p of sug.plan || []) {
    const it = state.items[p.item];
    if (!it || it.status === 'done' || it.status === 'wontfix' || !state.agents[p.agent]) continue;
    const b = it.block ? state.blocks[it.block] : null;
    if (guard) {
      const other = (x) => x && x !== p.agent && x !== HUMAN;
      let why = '';
      if (it.status === 'doing' && other(it.assignee)) why = `${agentName(state, it.assignee)} is doing it`;
      else if (b && other(b.holder) && b.touches.some((t) => t.agent === b.holder && now - t.ts < 20 * 60_000)) why = `${agentName(state, b.holder)} is working in ${blockMeta(state, b.id)?.name || b.id}`;
      else if (it.assignee && it.assignee !== p.agent && /^from S\d+$/.test(it.history.at(-1)?.note || '') && it.history.at(-1).note !== `from ${id}`) why = 'another suggestion moved it first';
      if (why) {
        out.left.push({ item: it.id, agent: p.agent, why });
        continue;
      }
    }
    out.prev.push({ item: it.id, assignee: it.assignee || null, block: it.block || null });
    out.events.push({ type: 'item.update', item: it.id, assignee: p.agent, note: `from ${id}` });
    const holder = b ? (taken[it.block] ?? b.holder) : null;
    // Applying never makes the person a holder: an entry for them (the model refuses one anyway) only assigns.
    if (p.agent !== HUMAN && b && !b.frozen && !holder) {
      out.events.push({ type: 'block.reserve', agent: p.agent, block: it.block, intent: it.title });
      taken[it.block] = p.agent;
    } else if (p.agent !== HUMAN && b && !b.frozen && holder !== p.agent) out.events.push({ type: 'block.queue', block: it.block, item: it.id });
    out.given.push({ item: it.id, agent: p.agent });
    if (!got.has(p.agent)) got.set(p.agent, []);
    got.get(p.agent).push(`${it.id} (${it.title})`);
  }
  const who = agentName(state, HUMAN);
  for (const [agent, what] of got) out.events.push({ type: 'msg', auto: true, to: agent, text: `${who} gave you ${what.join(', ')}, from ${agentName(state, sug.by)}'s suggestion ${id}. \`qb show <block>\` has the details.` });
  // The person's Apply closes it. Auto-Apply closes it when nothing was left out; otherwise it stays open for the
  // person, marked so the board doesn't apply it again.
  if (!guard) out.events.push({ type: 'item.update', item: id, status: 'done', note: 'applied' });
  else if (!out.left.length) out.events.push({ type: 'item.update', item: id, status: 'done', note: 'auto-applied' });
  else out.events.push({ type: 'item.update', item: id, note: `auto-applied ${out.given.map((g) => g.item).join(', ') || 'nothing'}; left ${out.left.map((l) => `${l.item} (${l.why})`).join(', ')}` });
  return out;
}
// Auto-Apply's commit for one suggestion (T59): the guarded plan, then a note saying what it did ("Applied Saffron's
// S4: T53 to Saffron, T47 to Basalt") that carries what changed, for Undo. Null when there is nothing to do.
export function autoApplyEvents(state, id, now = Date.now()) {
  const sug = state.items[id];
  if (!sug || sug.kind !== 'suggestion' || sug.status !== 'open' || autoApplied(sug)) return null;
  const plan = suggestionPlan(state, id, { guard: true, now });
  if (!plan.given.length && !plan.left.length) return null;
  const said = plan.given.map((g) => `${g.item} to ${agentName(state, g.agent)}`).join(', ');
  const left = plan.left.map((l) => `${l.item} (${l.why})`).join(', ');
  const text = `Applied ${agentName(state, sug.by)}'s ${id}: ${said || 'nothing'}${left ? `. Left for you: ${left}` : ''}.`;
  const reserved = plan.events.filter((e) => e.type === 'block.reserve').map((e) => ({ block: e.block, agent: e.agent }));
  return [...plan.events, { type: 'note', text, applied: { suggestion: id, prev: plan.prev.map(({ item, assignee }) => ({ item, assignee })), reserved } }];
}
// Undoing an Auto-Apply: items go back to whom they were with, the blocks it reserved are released, the agents are told,
// and the suggestion is open again for the person (still marked, so the board doesn't apply it again).
export function undoApplyEvents(state, note) {
  const a = note?.applied;
  if (!a) return [];
  const out = [];
  const told = new Map();
  for (const p of a.prev) {
    const it = state.items[p.item];
    if (!it) continue;
    if (it.assignee && it.assignee !== p.assignee) {
      if (!told.has(it.assignee)) told.set(it.assignee, []);
      told.get(it.assignee).push(it.id);
    }
    out.push({ type: 'item.update', item: it.id, assignee: p.assignee, note: `undid ${a.suggestion}` });
  }
  for (const r of a.reserved) if (state.blocks[r.block]?.holder === r.agent) out.push({ type: 'block.release', agent: r.agent, block: r.block, outcome: 'dropped', note: `undid ${a.suggestion}` });
  for (const [agent, ids] of told) out.push({ type: 'msg', auto: true, to: agent, text: `${agentName(state, HUMAN)} undid ${a.suggestion}: drop ${ids.join(', ')}.` });
  if (state.items[a.suggestion]) out.push({ type: 'item.update', item: a.suggestion, status: 'open', note: 'auto-applied, then undone' });
  return out;
}
// Whether Auto-Apply has been through a suggestion already.
export function autoApplied(sug) {
  return !!sug?.history?.some((x) => /^auto-applied/.test(x.note || ''));
}

export function queue(state) {
  return Object.values(state.blocks)
    .filter((b) => b.queued)
    .sort((a, b) => a.queued.pos - b.queued.pos);
}

// ---------------------------------------------------------------------------------------------
// Finding blocks by what people type

export function findBlock(state, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { error: 'Name a block.' };
  const blocks = state.board.blocks;
  const exact = blocks.find((b) => b.id.toLowerCase() === q || b.name.toLowerCase() === q);
  if (exact) return { block: exact };
  const hits = blocks.filter((b) => b.id.toLowerCase().includes(q) || b.name.toLowerCase().includes(q) || (b.keywords || []).some((k) => k.toLowerCase() === q));
  if (hits.length === 1) return { block: hits[0] };
  if (hits.length > 1) return { error: `"${query}" matches ${hits.length} blocks: ${hits.map((b) => b.id).join(', ')}.`, suggestions: hits.map((b) => b.id) };
  const close = blocks
    .map((b) => ({ b, d: Math.min(distance(q, b.id.toLowerCase()), distance(q, b.name.toLowerCase())) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map((x) => x.b.id);
  return { error: `No block named "${query}". Closest: ${close.join(', ')}. \`qb blocks\` lists them all.`, suggestions: close };
}

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

// ---------------------------------------------------------------------------------------------
// Making and checking events (the CLI and the server call these under the store's lock)

export function makeEvent(state, type, by, payload = {}, now = Date.now(), rand = Math.random) {
  const e = { id: eventId(now, rand), ts: Math.floor(now), by: by || HUMAN, type, ...payload };
  if (type === 'item.add' && e.item && !e.item.id) {
    const prefix = KIND_PREFIX[e.item.kind] || 'T';
    let n = 0;
    for (const id of [...Object.keys(state.items), ...(state.deleted || [])]) {
      const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
      if (m) n = Math.max(n, Number(m[1]));
    }
    e.item = { ...e.item, id: `${prefix}${n + 1}` };
  }
  // A touch names the block each file was in when it happened (B32): a file the board later moves into a block
  // brings its old edits along, but not as trespasses in a block it wasn't in.
  if (type === 'touch' && Array.isArray(e.files) && e.files.length && !e.blocks && state.index) {
    e.blocks = e.files.map((f) => blockForPath(state.index, normalizePath(String(f))) || UNMAPPED);
  }
  return e;
}

// Returns null when the event may be appended, or a sentence saying why not and what to do.
export function checkEvent(state, e, now = Date.now()) {
  const bad = checkShape(e, now);
  if (bad) return bad;
  const actor = e.by || HUMAN;
  const who = typeof e.agent === 'string' ? e.agent : actor;
  const priv = privileged(actor);
  if (who !== actor && !priv) return `Only the human acts for another agent; ${agentName(state, actor)} can act only for itself.`;
  if (e.force && !priv) return `Only the human can force a reservation. Ask them to move the block to you, or wait: a reservation unseen for ${Math.round(state.staleMs / 60_000)} min can be taken over.`;
  switch (e.type) {
    case 'note':
      if (e.applied === undefined) return null;
      if (!priv) return 'Only the board records an Auto-Apply.';
      if (!e.applied || typeof e.applied !== 'object' || !validId(e.applied.suggestion) || !Array.isArray(e.applied.prev) || e.applied.prev.length > 40 || !Array.isArray(e.applied.reserved) || e.applied.reserved.length > 40) return 'An Auto-Apply note names its suggestion and what it changed.';
      if (e.applied.prev.some((x) => !x || !validId(x.item) || (x.assignee !== null && !validId(x.assignee)))) return 'An Auto-Apply note names items and their earlier assignees.';
      if (e.applied.reserved.some((x) => !x || !validId(x.block) || !validId(x.agent))) return 'An Auto-Apply note names the blocks it reserved.';
      return null;
    case 'agent.finish':
      if (!priv) return 'Only the person asks an agent to finish and stop, or resumes it.';
      if (typeof e.agent !== 'string' || !state.agents[e.agent] || e.agent === HUMAN) return 'Name the agent to finish.';
      return null;
    case 'block.reserve': {
      const b = state.blocks[e.block];
      if (!b) return `No block named "${e.block}".`;
      if (e.block === UNMAPPED) {
        const ids = Array.isArray(e.take) ? e.take : b.queued?.items || [];
        return !e.mode && ids.length ? null : 'Unmapped files are no block anyone can reserve; give one of its queued items instead.';
      }
      if (e.mode === 'watch') return null;
      const name = blockMeta(state, e.block).name;
      if (b.frozen && !priv) {
        return `${name} is frozen${b.frozen.note ? ` (${b.frozen.note})` : ''}. Ask the human to unfreeze it, or pick other work.`;
      }
      if (b.holder && b.holder !== who && !priv) {
        const h = state.agents[b.holder];
        if (b.holder === HUMAN) {
          return `${name} is reserved by ${h.name} (the human)${b.intent ? `: ${b.intent}` : ''}. Pick other work or ask them.`;
        }
        if (!isStale(state, b.holder, now)) {
          return `${name} is reserved by ${h.name} since ${clock(b.since)}${b.intent ? ` for "${b.intent}"` : ''}. Message them with \`qb note\`, pick other work, or wait: a reservation unseen for ${Math.round(state.staleMs / 60_000)} min can be taken over.`;
        }
      }
      return null;
    }
    case 'block.release': {
      const b = state.blocks[e.block];
      if (!b) return `No block named "${e.block}".`;
      if (b.watchers[who]) return null;
      if (!b.holder) return `${blockMeta(state, e.block).name} isn't reserved by anyone.`;
      if (b.holder !== who && !priv) return `${blockMeta(state, e.block).name} is reserved by ${agentName(state, b.holder)}, not you.`;
      return null;
    }
    case 'block.queue':
    case 'block.unqueue': {
      if (!e.block) {
        if (!e.item) return 'Name a block, or an item with no block.';
        const it = state.items[e.item];
        if (!it) return `No item ${e.item}.`;
        if (it.block) return `${e.item} belongs to ${it.block}; queue it with its block.`;
        if (e.type === 'block.queue' && (it.status === 'done' || it.status === 'wontfix')) return `${e.item} is ${it.status}.`;
        return null;
      }
      if (!state.blocks[e.block]) return `No block named "${e.block}".`;
      if (!e.item) return null;
      const it = state.items[e.item];
      if (!it) return `No item ${e.item}.`;
      if (it.block !== e.block) return `${e.item} belongs to ${it.block || 'no block'}, not ${e.block}.`;
      if (e.type === 'block.queue' && (it.status === 'done' || it.status === 'wontfix')) return `${e.item} is ${it.status}.`;
      return null;
    }
    case 'block.freeze':
      return state.blocks[e.block] ? null : `No block named "${e.block}".`;
    case 'item.delete': {
      const it = state.items[e.item];
      if (!it) return `No item ${e.item}.`;
      if (!priv && it.by !== actor) return `${e.item} was filed by ${agentName(state, it.by)}; only they or the person delete it.`;
      return null;
    }
    case 'item.add':
      if (!e.item?.title) return 'An item needs a title.';
      if (e.queue !== undefined && (e.queue !== true || e.item.block || e.item.kind === 'suggestion' || e.item.kind === 'question')) return 'Only a task or bug with no block is filed straight into the queue.';
      if (e.item.block && !state.blocks[e.item.block]) return `No block named "${e.item.block}".`;
      if (given(e.item.assignee) && !priv && e.item.assignee !== actor) return 'Only the human files work for someone else; suggest it with `qb suggest`.';
      if (e.item.kind === 'suggestion') {
        const plan = e.item.plan;
        if (!Array.isArray(plan) || !plan.length || plan.length > 40) return 'A suggestion names who takes what: plan: [{ agent, item }].';
        for (const p of plan) {
          if (!p || !validId(p.agent) || p.agent === HUMAN || !state.agents[p.agent]) return `No agent "${String(p?.agent).slice(0, 40)}" to suggest work for.`;
          const it = validId(p.item) ? state.items[p.item] : null;
          if (!it) return `No item ${String(p.item).slice(0, 40)}.`;
          if (it.status === 'done' || it.status === 'wontfix' || it.kind === 'question' || it.kind === 'suggestion') return `${it.id} isn't work to hand out.`;
        }
      } else if (e.item.plan !== undefined) return 'Only a suggestion carries a plan.';
      return null;
    case 'item.update':
      if (!state.items[e.item]) return `No item ${e.item}.`;
      // Agents never reassign each other's work: only the human gives an item to someone else.
      if (e.assignee !== undefined && !priv && e.assignee !== actor) return `Only the human assigns ${e.item} to someone else; suggest it with \`qb suggest\`.`;
      if (e.assignee !== undefined && !priv && state.items[e.item].assignee && state.items[e.item].assignee !== actor) return `${e.item} is ${agentName(state, state.items[e.item].assignee)}'s; only the human moves it.`;
      if (e.block && !state.blocks[e.block]) return `No block named "${e.block}".`;
      return null;
    case 'merge.ready':
      if (!e.worktree) return 'Name the worktree that is ready.';
      if (e.ahead === 0) return `Nothing to merge: ${e.worktree} has no commits ahead of the base. Commit first, then mark it ready.`;
      return null;
    case 'merge.unready':
    case 'merge.order':
    case 'merge.landed':
      return state.merges[e.worktree] ? null : `${e.worktree} isn't in the merge queue.`;
    case 'board.change': {
      if (!e.change || typeof e.change !== 'object' || typeof e.change.op !== 'string') return 'A board change says what changed.';
      if (e.remap !== undefined && (typeof e.remap !== 'object' || e.remap === null)) return 'A remap is { oldBlock: newBlock }.';
      for (const [from, to] of Object.entries(e.remap || {})) if (!validId(from) || !validId(to) || !state.blocks[to]) return `Can't move items from ${from} to ${to}.`;
      return null;
    }
    case 'msg':
      if (!e.text) return 'A message needs text.';
      if (e.to !== '*' && !state.agents[e.to]) return `No agent "${e.to}".`;
      return null;
    default:
      return null;
  }
}

// Types, ids and enums, before any rule: a value from outside reaches state keys, timers and markup.
function checkShape(e, now) {
  if (!e || typeof e !== 'object') return 'An event is an object.';
  if (!EVENT_TYPES.includes(e.type)) return `No event type "${String(e.type).slice(0, 40)}".`;
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return 'An event needs a time (ts, in milliseconds).';
  if (e.ts > now + FUTURE_MS) return 'That event is dated in the future.';
  if (e.id !== undefined && !validId(e.id)) return 'An event id is a short plain word.';
  const id = (v, what) => (validId(v) ? null : `"${String(v).slice(0, 40)}" isn't a valid ${what} id: up to 80 letters, digits, _, . and -.`);
  const oneOf = (v, list, what) => (!given(v) || list.includes(v) ? null : `${what} are ${list.join(', ')}.`);
  const checks = [
    id(e.by || HUMAN, 'agent'),
    typeof e.agent === 'string' ? id(e.agent, 'agent') : null,
    given(e.block) ? id(e.block, 'block') : null,
    given(e.worktree) ? id(e.worktree, 'worktree') : null,
    given(e.to) && e.to !== '*' ? id(e.to, 'agent') : null,
    oneOf(e.mode, ['own', 'watch'], 'Modes'),
    oneOf(e.outcome, OUTCOMES, 'Outcomes'),
    e.type === 'touch' ? oneOf(e.op, TOUCH_OPS, 'Touch ops') : null,
    e.type === 'agent.status' ? oneOf(e.status, AGENT_STATUS, 'Statuses') : null,
    e.type === 'agent.status' && given(e.last) && (typeof e.last !== 'string' || e.last.length > 8000) ? 'An agent\'s last message is text, up to 8000 characters.' : null,
    e.type === 'agent.sub' ? oneOf(e.state, SUB_STATES, 'Subagent states') : null,
    e.type === 'agent.sub' && given(e.sub) ? id(e.sub, 'subagent') : null,
    e.type === 'agent.sub' && given(e.aid) ? id(e.aid, 'subagent') : null,
    e.type === 'agent.sub' && given(e.desc) && (typeof e.desc !== 'string' || e.desc.length > 200) ? 'A subagent description is a short text.' : null,
    e.type === 'agent.sub' && given(e.kind) && (typeof e.kind !== 'string' || e.kind.length > 80) ? 'A subagent kind is a short name.' : null,
    oneOf(e.activity, ACTIVITIES, 'Activities'),
    e.type === 'item.update' ? oneOf(e.status, ITEM_STATUS, 'Statuses') : null,
  ];
  if (e.type === 'agent.join' && e.agent && typeof e.agent === 'object') {
    if (given(e.agent.id)) checks.push(id(e.agent.id, 'agent'));
    if (given(e.agent.color) && !PALETTE.includes(e.agent.color)) checks.push(`Colors are ${PALETTE.join(', ')}.`);
    if (e.agent.pty !== undefined && !(typeof e.agent.pty === 'string' && e.agent.pty.length < 300 && (e.agent.pty === '' || /\/ptys\/[\w.-]+\.sock$/.test(e.agent.pty)))) checks.push('pty is the path of a qb run socket.');
  }
  if (e.type === 'item.update' || ((e.type === 'block.queue' || e.type === 'block.unqueue') && given(e.item))) checks.push(id(e.item, 'item'));
  if (e.type === 'item.add') {
    if (!e.item || typeof e.item !== 'object') return 'An item needs a title.';
    if (given(e.item.id)) checks.push(id(e.item.id, 'item'));
    if (given(e.item.block)) checks.push(id(e.item.block, 'block'));
    checks.push(oneOf(e.item.kind, ITEM_KINDS, 'Kinds'), oneOf(e.item.status, ITEM_STATUS, 'Statuses'));
  }
  if (e.blocks !== undefined) checks.push(Array.isArray(e.blocks) ? e.blocks.map((b) => id(b, 'block')).find(Boolean) || null : 'blocks is a list of block ids.');
  if (e.files !== undefined && !(Array.isArray(e.files) && e.files.every((f) => typeof f === 'string'))) checks.push('files is a list of paths.');
  if (e.ids !== undefined && !(Array.isArray(e.ids) && e.ids.every((x) => typeof x === 'string'))) checks.push('ids is a list of event ids.');
  if (e.type === 'merge.order' && !Number.isFinite(e.pos)) checks.push('A position is a number.');
  if (given(e.ahead) && !(Number.isInteger(e.ahead) && e.ahead >= 0)) checks.push('ahead is a count of commits.');
  return checks.find(Boolean) || null;
}

// ---------------------------------------------------------------------------------------------
// Words

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
  return `${Math.round(h / 24)} days`;
}

export function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function describeEvent(state, e) {
  const who = agentName(state, typeof e.agent === 'string' ? e.agent : e.by || HUMAN);
  const by = agentName(state, e.by || HUMAN);
  const block = (id) => blockMeta(state, id)?.name || id;
  const onBehalf = typeof e.agent === 'string' && e.agent !== e.by ? ` (by ${by})` : '';
  switch (e.type) {
    case 'agent.join':
      return `${who} joined${e.task ? `: ${e.task}` : ''}`;
    case 'agent.leave':
      return `${who} left${e.note ? `: ${e.note}` : ''}`;
    case 'agent.status':
      return e.doing ? `${who}: ${e.doing}` : `${who} is ${e.status || 'updated'}`;
    case 'agent.beat':
      return `${who} checked in`;
    case 'agent.finish':
      return `${agentName(state, e.by || HUMAN)} ${e.on === false ? 'resumed' : 'asked'} ${agentName(state, e.agent)}${e.on === false ? '' : ' to finish and stop'}`;
    case 'agent.sub':
      return e.state === 'failed' ? `${who}'s subagent failed${e.desc ? `: ${e.desc}` : ''}` : e.state === 'done' ? `${who}'s subagent finished${e.desc ? `: ${e.desc}` : ''}` : `${who} started a subagent: ${e.desc || e.kind || 'unnamed'}`;
    case 'block.reserve':
      return e.mode === 'watch' ? `${who} is watching ${block(e.block)}` : `${who} reserved ${block(e.block)}${e.intent ? `: ${e.intent}` : ''}${onBehalf}`;
    case 'block.release':
      return `${who} released ${block(e.block)}${e.outcome ? ` (${e.outcome})` : ''}${e.note ? `: ${e.note}` : ''}${onBehalf}`;
    case 'block.queue':
      if (e.item) return `${by} queued ${e.item} in ${block(e.block)}${state.items[e.item] ? `: ${state.items[e.item].title}` : ''}`;
      return `${by} queued ${block(e.block)}${e.note ? `: ${e.note}` : ''}`;
    case 'block.unqueue':
      return e.item ? `${by} took ${e.item} off the queue` : `${by} took ${block(e.block)} off the queue`;
    case 'block.freeze':
      return e.on === false ? `${by} unfroze ${block(e.block)}` : `${by} froze ${block(e.block)}${e.note ? `: ${e.note}` : ''}`;
    case 'item.add':
      return `${by} filed ${e.item.kind || 'task'} ${e.item.id}${e.item.block ? ` in ${block(e.item.block)}` : ''}: ${e.item.title}`;
    case 'item.update':
      return `${by} set ${e.item} to ${e.status || 'updated'}${e.answer ? `: ${e.answer}` : ''}`;
    case 'touch':
      if (e.op === 'run') return `${who} ran ${e.cmd || 'a command'}`;
      return `${who} ${e.op === 'read' ? 'read' : 'edited'} ${(e.files || []).join(', ')}`;
    case 'test':
      return `${who}: tests ${e.ok ? 'pass' : 'fail'}${e.summary ? ` (${e.summary})` : ''}`;
    case 'note':
      return `${who}: ${e.text}`;
    case 'msg':
      return `${by} to ${e.to === '*' ? 'everyone' : agentName(state, e.to)}: ${e.text}`;
    case 'msg.read':
      return `${who} read their messages`;
    case 'board.change':
      return `${who} ${e.summary || `reshaped the board (${e.change?.op})`}`;
    case 'merge.ready':
      return `${who} marked ${e.worktree}${e.branch ? ` (${e.branch})` : ''} ready to merge${e.note ? `: ${e.note}` : ''}`;
    case 'merge.unready':
      return `${by} took ${e.worktree} out of the merge queue`;
    case 'merge.order':
      return `${by} moved ${e.worktree} in the merge queue`;
    case 'merge.landed':
      return `${e.worktree} merged`;
    default:
      return `${who}: ${e.type}`;
  }
}
