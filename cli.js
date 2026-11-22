#!/usr/bin/env node
// qb: the QueueBox command line. Agents reserve blocks, say what they're doing, file bugs and read
// the human's messages with it; `qb serve` opens the board. `qb help` lists everything.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUMAN, UNMAPPED, OUTCOMES, ITEM_STATUS, reduce, makeEvent, findBlock, blockMeta, agentName, presence, alerts, queue,
  itemCounts, describeEvent, clock, ago, queuedIntent, activityOf, queueEntries, nextFor, queuePlan, isIdleFree, EVENT_TYPES,
} from './core/model.js';
import { blockForPath, matchDetail, normalizePath } from './core/glob.js';
import { openStore, remoteStore, findBoardDir } from './core/store.js';
import { changedFiles } from './core/files.js';
import { worktreeSnapshot } from './core/worktrees.js';
import { mergeChecks, agentsInWorktree, blocksOf, mergeCommand } from './core/merges.js';
import { whoAmI, whereAmI, agentKind, worktreeHere } from './core/identity.js';

// The board.json shape this qb reads and writes. A newer board is read for what this one knows (qb doctor says so).
const BOARD_SCHEMA = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Arguments

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') && !BOOLEAN.has(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (/^-[a-z]$/.test(a)) {
      const k = { n: 'n', f: 'follow', j: 'json' }[a[1]] || a[1];
      if (k === 'n') flags.n = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { cmd: pos.shift() || 'board', pos, flags };
}

const BOOLEAN = new Set(['json', 'watch', 'force', 'all', 'landed', 'parked', 'handoff', 'dropped', 'keep', 'staged', 'open', 'follow', 'auto', 'quiet', 'peek', 'no-open', 'no-hooks', 'wait', 'take', 'any']);

class Refusal extends Error {}

// ---------------------------------------------------------------------------------------------
// Plumbing

async function context(flags) {
  const url = flags.url || process.env.QUEUEBOX_URL;
  const store = url ? remoteStore(url) : openStore(findBoardDir());
  const now = Date.now();
  const me = whoAmI(flags.as);
  if (store.kind !== 'local') {
    const { board, events } = await store.load();
    return { store, board, events, state: reduce(board, events), me, now, flags };
  }
  // The local store keeps its fold; the raw log is read only by the commands that print it.
  let events = null;
  const ctx = { store, board: store.board(), state: store.state(), me, now, flags };
  Object.defineProperty(ctx, 'events', { enumerable: true, get: () => (events ??= store.readEvents()) });
  return ctx;
}

async function commit(ctx, events) {
  try {
    const res = await ctx.store.commit(events);
    ctx.state = res.state;
    return res.events;
  } catch (err) {
    if (err.refused) throw new Refusal(err.message);
    throw err;
  }
}

// Agents that haven't joined join on the first command that says they work here: doing, status, reserve,
// next, touch, test, note, ready, ask. Filing (task, bug), moving an item, messaging and reading don't.
function joinIfNeeded(ctx, extra = {}) {
  const a = ctx.state.agents[ctx.me];
  if (ctx.me === HUMAN) return [];
  if (a && !a.leftAt && a.joinedAt) return [];
  return [
    makeEvent(ctx.state, 'agent.join', ctx.me, {
      agent: { id: ctx.me, name: extra.name || a?.name || (ctx.me.startsWith('wt-') ? ctx.me.slice(3) : undefined), kind: extra.kind || agentKind(ctx.me), model: extra.model || process.env.QUEUEBOX_MODEL || '', where: whereAmI(), worktree: worktreeHere()?.path || '' },
      task: extra.task || '',
    }, ctx.now),
  ];
}

function ev(ctx, type, payload) {
  return makeEvent(ctx.state, type, ctx.me, payload, ctx.now);
}

function needBlock(ctx, query) {
  const r = findBlock(ctx.state, query);
  if (r.error) throw new Refusal(r.error);
  return r.block;
}

function relPath(ctx, p) {
  const root = ctx.store.root;
  const abs = path.resolve(p);
  return normalizePath(abs.startsWith(root + path.sep) ? path.relative(root, abs) : p);
}

function defaultBlock(ctx) {
  const a = ctx.state.agents[ctx.me];
  if (!a) return null;
  for (let i = a.touches.length - 1; i >= 0; i--) if (a.touches[i].block && a.touches[i].block !== UNMAPPED) return a.touches[i].block;
  return a.held[0] || null;
}

const out = (ctx, text, json) => {
  if (ctx.flags.json) console.log(JSON.stringify(json ?? { ok: true }, null, 2));
  else if (!ctx.flags.quiet && text) console.log(text);
};

function words(pos) {
  return pos.join(' ').trim();
}

function docsLine(meta) {
  return meta?.docs?.length ? `Read first: ${meta.docs.join(', ')}.` : '';
}

function countsLine(ctx, id) {
  const c = itemCounts(ctx.state, id);
  const parts = [];
  if (c.bug) parts.push(`${c.bug} bug${c.bug > 1 ? 's' : ''}`);
  if (c.task) parts.push(`${c.task} task${c.task > 1 ? 's' : ''}`);
  if (c.decision) parts.push(`${c.decision} waiting on the human`);
  if (c.question) parts.push(`${c.question} open question${c.question > 1 ? 's' : ''}`);
  return parts.length ? `Open there: ${parts.join(', ')} (\`qb show ${id}\`).` : '';
}

// ---------------------------------------------------------------------------------------------
// Commands

const commands = {
  // `qb board` alone is the summary; with a word after it, it reshapes the board (core/board-ops.js).
  async board(ctx) {
    const sub = ctx.pos[0];
    if (!sub) return console.log(summary(ctx.state, ctx.now, ctx.me));
    if (!BOARD_SUBCOMMANDS[sub]) throw new Refusal(`\`qb board\` reshapes with ${Object.keys(BOARD_SUBCOMMANDS).join(', ')}. \`qb help\` has the forms.`);
    if (ctx.store.kind !== 'local') throw new Refusal('Reshape the board on the machine that has it (qb board talks to board.json directly), or from the page.');
    const op = BOARD_SUBCOMMANDS[sub](ctx, ctx.pos.slice(1));
    let res;
    try {
      res = ctx.store.writeBoard(op, ctx.me, ctx.now);
    } catch (err) {
      if (err.refused) throw new Refusal(err.message);
      throw err;
    }
    ctx.state = res.state;
    const moved = Object.entries(res.event.remap || {}).flatMap(([from, to]) => Object.values(res.state.items).filter((it) => it.block === to && it.history.at(-1)?.note === `moved from ${from} with the board`).map((it) => `${it.id} (${from} to ${to})`));
    out(ctx, [`Board: ${res.summary}.`, moved.length ? `Open items moved: ${moved.join(', ')}. \`qb item <id> --block <block>\` moves one elsewhere.` : ''].filter(Boolean).join('\n'), { op, summary: res.summary, remap: res.event.remap });
  },

  // Run an agent's command in a terminal QueueBox owns (core/ptyrun.py), so the board can type into it to wake it:
  // any agent CLI on any model. A Claude Code session reports the terminal through its hooks; any other agent is
  // joined here as --agent <id> (its own `qb` calls then act as that id) and leaves when the command ends.
  async run(ctx) {
    const cmd = ctx.pos;
    if (!cmd.length) throw new Refusal('Name the agent to run: `qb run -- claude`, or `qb run --agent codex-1 -- codex` for an agent without QueueBox hooks.');
    if (ctx.store.kind !== 'local') throw new Refusal('`qb run` runs on the machine that has the board.');
    const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import pty'], { stdio: 'ignore' }).status === 0);
    if (!python) throw new Refusal('`qb run` needs Python 3 (its standard library pty module) on PATH.');
    const sock = path.join(ctx.store.live, 'ptys', `${crypto.randomBytes(5).toString('hex')}.sock`);
    const agent = typeof ctx.flags.agent === 'string' ? ctx.flags.agent : '';
    if (agent) {
      const e = makeEvent(ctx.state, 'agent.join', agent, { agent: { id: agent, name: typeof ctx.flags.name === 'string' ? ctx.flags.name : undefined, kind: path.basename(cmd[0]), where: whereAmI(), worktree: worktreeHere()?.path || '', pty: sock }, task: '' }, Date.now());
      await commit(ctx, [e]);
    }
    const child = spawn(python, [path.join(HERE, 'core', 'ptyrun.py'), sock, ...cmd], { stdio: 'inherit', env: { ...process.env, ...(agent ? { QUEUEBOX_AGENT: agent } : {}) } });
    const code = await new Promise((resolve) => child.on('exit', (c, sig) => resolve(c ?? (sig ? 1 : 0))));
    if (agent) {
      const st = ctx.store.state();
      await ctx.store.commit([makeEvent(st, 'agent.leave', agent, { note: `${path.basename(cmd[0])} exited` }, Date.now())]).catch(() => {});
    }
    process.exitCode = code;
  },

  async join(ctx) {
    const { name, task, model, kind } = ctx.flags;
    const events = [];
    const a = ctx.state.agents[ctx.me];
    if (!a || a.leftAt || !a.joinedAt) events.push(...joinIfNeeded(ctx, { name, task, model, kind }));
    else events.push(ev(ctx, 'agent.join', { agent: { id: ctx.me, name, kind, model, where: whereAmI(), worktree: worktreeHere()?.path || '' }, task: task || a.task }));
    await commit(ctx, events);
    const me = ctx.state.agents[ctx.me];
    out(ctx, `You are ${me.name} (${me.id}) on the ${ctx.board.name} board.${me.task ? ` Task: ${me.task}.` : ''}\n${protocolHint()}`, me);
  },

  async leave(ctx) {
    const held = [...(ctx.state.agents[ctx.me]?.held || [])];
    await commit(ctx, [ev(ctx, 'agent.leave', { note: ctx.flags.note || '' })]);
    out(ctx, held.length ? `Left. Released ${held.join(', ')}.` : 'Left.', { released: held });
  },

  async doing(ctx) {
    const text = words(ctx.pos);
    await commit(ctx, [...joinIfNeeded(ctx), ev(ctx, 'agent.status', { doing: text, status: 'working', ...(ctx.flags.task ? { task: ctx.flags.task } : {}) })]);
    out(ctx, `Doing: ${text}`);
  },

  async status(ctx) {
    const status = ctx.pos[0];
    const doing = ctx.flags.note ?? words(ctx.pos.slice(1));
    await commit(ctx, [...joinIfNeeded(ctx), ev(ctx, 'agent.status', { status, ...(doing ? { doing } : {}) })]);
    out(ctx, `Status: ${status}${doing ? ` (${doing})` : ''}`);
  },

  async reserve(ctx) {
    if (!ctx.pos.length) throw new Refusal('Name the block(s) to reserve: `qb reserve <block> [--for "what you will do"]`.');
    const blocks = ctx.pos.map((q) => needBlock(ctx, q));
    const mode = ctx.flags.watch ? 'watch' : 'own';
    const intent = typeof ctx.flags.for === 'string' ? ctx.flags.for : '';
    const events = [...joinIfNeeded(ctx)];
    // take: []: reserving a block doesn't take the items queued in it; they stay in line, each its own (B13).
    for (const b of blocks) events.push(ev(ctx, 'block.reserve', { block: b.id, mode, intent, take: [], ...(ctx.flags.force ? { force: true } : {}) }));
    await commit(ctx, events);
    const lines = blocks.map((b) => {
      const parts = [`${mode === 'watch' ? 'Watching' : 'Reserved'} ${b.name} (${b.id}).`, docsLine(b), countsLine(ctx, b.id)];
      return parts.filter(Boolean).join(' ');
    });
    out(ctx, lines.join('\n'), { reserved: blocks.map((b) => b.id), mode });
  },

  async release(ctx) {
    const a = ctx.state.agents[ctx.me];
    let ids;
    if (ctx.flags.all || !ctx.pos.length) ids = [...(a?.held || []), ...(a?.watching || [])];
    else ids = ctx.pos.map((q) => needBlock(ctx, q).id);
    if (!ids.length) return out(ctx, 'You have nothing reserved.', { released: [] });
    const outcome = OUTCOMES.find((o) => ctx.flags[o]) || ctx.flags.outcome || (ctx.flags.note ? 'parked' : 'landed');
    const note = typeof ctx.flags.note === 'string' ? ctx.flags.note : '';
    await commit(ctx, ids.map((id) => ev(ctx, 'block.release', { block: id, outcome, note })));
    out(ctx, `Released ${ids.join(', ')} (${outcome}).`, { released: ids, outcome });
  },

  // The first queue entry it can take (B13): a whole block, or one item, whose block is free or already its own.
  async next(ctx) {
    // Asked to finish and stop (T38): what it has now, nothing new from the queue until the person resumes it.
    if (ctx.state.agents[ctx.me]?.finishing) return out(ctx, 'The person asked you to finish what you have and take nothing new: no queued work until they resume you.', { block: null, finishing: true });
    // The entry the board would give it (T54): the same plan as the board's wakes, over this agent and the other idle
    // ones. One planned for an agent with more context there is left to them, unless --any.
    const others = Object.values(ctx.state.agents).filter((a) => a.id !== HUMAN && a.id !== ctx.me && !a.leftAt && !a.finishing && isIdleFree(ctx.state, a.id, ctx.now)).map((a) => a.id);
    const plan = queuePlan(ctx.state, [ctx.me, ...others], ctx.now, { waitMin: ctx.state.board?.waitForContext || 0 });
    const planned = plan.find((p) => p.agent === ctx.me);
    // A caller not on the board yet (it joins as it takes) isn't in the plan: it takes the first it can, as --any does.
    const onBoard = ctx.state.agents[ctx.me] && !ctx.state.agents[ctx.me].leftAt;
    const q = planned ? planned.entry : ctx.flags.any || !onBoard ? nextFor(ctx.state, ctx.me) : null;
    if (!q) {
      // Entries held for a busy agent who knows them better (Wait for context) are named too.
      const theirs = [...plan.filter((p) => p.agent !== ctx.me), ...(plan.waiting || []).map((p) => ({ ...p, why: `waiting for them, busy now: ${p.why}` }))];
      if (theirs.length) return out(ctx, `Nothing in the queue is yours: ${theirs.map((p) => `${p.entry.kind === 'item' ? p.entry.item : p.entry.block} goes to ${agentName(ctx.state, p.agent)} (${p.why})`).join('; ')}. \`qb next --any\` takes the first you can anyway.`, { block: null, theirs: theirs.map((p) => ({ entry: p.entry.key, agent: p.agent })) });
      return out(ctx, 'Nothing in the queue you can take. `qb` shows the board; pick a free block and `qb reserve` it.', { block: null });
    }
    const it = q.kind === 'item' ? ctx.state.items[q.item] : null;
    // An item typed into Up next has no block yet (B31): it is given, and the taker files it properly or returns it.
    if (it && !q.block) {
      await commit(ctx, [...joinIfNeeded(ctx), ev(ctx, 'item.update', { item: it.id, status: 'doing', assignee: ctx.me, note: 'taken from the queue' }), ev(ctx, 'agent.status', { task: `${it.id}: ${it.title}`, status: 'working' })]);
      return out(ctx, `Took ${it.id} from the queue: ${it.title}\nIt has no block yet. File it properly (\`qb item ${it.id} --block <block>\`, and \`qb task\` or \`qb bug\` for more), then do it; or return it with \`qb queue ${it.id}\` and a \`qb note\` saying why.`, { block: null, items: [it.id] });
    }
    const b = ctx.state.blocks[q.block];
    const meta = blockMeta(ctx.state, q.block);
    const note = q.kind === 'block' ? q.note : '';
    const wanted = it ? `${it.id}: ${it.title}` : note;
    const intent = typeof ctx.flags.for === 'string' ? ctx.flags.for : wanted;
    const take = it ? [it.id] : [];
    // Read before committing: the local store folds in place, so b.holder is this agent's afterwards either way.
    const mine = b.holder === ctx.me;
    const events = [...joinIfNeeded(ctx)];
    if (mine && it) events.push(ev(ctx, 'item.update', { item: it.id, status: 'doing', assignee: ctx.me, note: 'taken from the queue' }));
    else events.push(ev(ctx, 'block.reserve', { block: q.block, intent, take }));
    if (wanted) events.push(ev(ctx, 'agent.status', { task: wanted, status: 'working' }));
    await commit(ctx, events);
    out(ctx, [
      it ? `Took ${it.id} from the queue${mine ? ` (in ${meta.name}, yours already)` : `; ${meta.name} (${q.block}) is reserved for you`}. It's yours, marked doing (\`qb item ${it.id} done\` when it lands):\n  ${it.id}  ${it.kind}  ${it.title}${it.detail ? `\n      ${it.detail}` : ''}` : `Reserved ${meta.name} (${q.block}) from the queue.`,
      note ? `The human's note: ${note}` : '',
      docsLine(meta),
      countsLine(ctx, q.block),
    ].filter(Boolean).join('\n'), { block: q.block, note, items: take });
  },

  async which(ctx) {
    const rows = ctx.pos.map((p) => {
      const rel = relPath(ctx, p);
      const hit = matchDetail(ctx.state.index, rel);
      const b = hit ? ctx.state.blocks[hit.block] : null;
      return { path: rel, block: hit?.block || null, pattern: hit?.pattern || null, holder: b?.holder || null, frozen: !!b?.frozen };
    });
    out(
      ctx,
      rows
        .map((r) => {
          if (!r.block) return `${r.path}: no block claims it (add it to .queuebox/board.json)`;
          const meta = blockMeta(ctx.state, r.block);
          const held = r.holder ? `reserved by ${agentName(ctx.state, r.holder)}${r.holder === ctx.me ? ' (you)' : ''}` : 'free';
          return `${r.path}: ${meta.name} (${r.block}), ${held}${r.frozen ? ', frozen' : ''}`;
        })
        .join('\n'),
      rows,
    );
  },

  async show(ctx) {
    const meta = needBlock(ctx, words(ctx.pos));
    const b = ctx.state.blocks[meta.id];
    const items = Object.values(ctx.state.items).filter((it) => it.block === meta.id && it.status !== 'done' && it.status !== 'wontfix');
    const d = ctx.board.districts.find((x) => x.id === meta.district);
    const lines = [
      `${meta.name} (${meta.id}), in ${d?.name || meta.district}`,
      meta.about,
      b.holder ? `Reserved by ${agentName(ctx.state, b.holder)} since ${clock(b.since)}${b.intent ? `: ${b.intent}` : ''}` : 'Free.',
      b.frozen ? `Frozen by ${agentName(ctx.state, b.frozen.by)}${b.frozen.note ? `: ${b.frozen.note}` : ''}` : '',
      b.queued ? `Queued #${b.queued.pos}${queuedIntent(ctx.state, b.queued) ? `: ${queuedIntent(ctx.state, b.queued)}` : ''}` : '',
      b.test ? `Last test: ${b.test.ok ? 'pass' : 'FAIL'} ${ago(ctx.now - b.test.ts)} ago${b.test.summary ? ` (${b.test.summary})` : ''}` : '',
      meta.docs?.length ? `Docs: ${meta.docs.join(', ')}` : '',
      `Paths: ${meta.paths.join(', ')}`,
      items.length ? `\nOpen items (${items.length}):` : '\nNo open items.',
      ...items.slice(0, 40).map((it) => `  ${it.id.padEnd(9)} ${it.kind.padEnd(8)} ${it.status === 'open' ? '' : `[${it.status}] `}${it.title}`),
      b.touches.length ? '\nRecent activity:' : '',
      ...b.touches.slice(-8).reverse().map((t) => `  ${ago(ctx.now - t.ts).padStart(7)} ago  ${agentName(ctx.state, t.agent)} ${t.op} ${t.file}`),
    ];
    out(ctx, lines.filter((l) => l !== '').join('\n'), { block: meta, state: b, items });
  },

  async mine(ctx) {
    const a = ctx.state.agents[ctx.me];
    if (!a) return out(ctx, `You (${ctx.me}) haven't joined. \`qb join --name <name> --task "<task>"\`.`, null);
    const lines = [
      `${a.name} (${a.id}) is ${presence(ctx.state, a.id, ctx.now)}.${a.task ? ` Task: ${a.task}` : ''}`,
      a.held.length ? `Holding: ${a.held.map((id) => `${blockMeta(ctx.state, id).name} (${id})`).join(', ')}` : 'Holding nothing.',
      a.watching.length ? `Watching: ${a.watching.join(', ')}` : '',
      a.inbox.length ? `${a.inbox.length} unread message${a.inbox.length > 1 ? 's' : ''}: \`qb inbox\`` : '',
    ];
    out(ctx, lines.filter(Boolean).join('\n'), a);
  },

  async touch(ctx) {
    const files = ctx.pos.map((p) => relPath(ctx, p));
    await commit(ctx, [...joinIfNeeded(ctx), ev(ctx, 'touch', { files, op: ctx.flags.op || 'edit' })]);
    out(ctx, '', { files });
  },

  async test(ctx) {
    const verdict = ctx.pos[0];
    if (!['pass', 'fail'].includes(verdict)) throw new Refusal('`qb test pass|fail "<what ran>"`.');
    const blocks = ctx.flags.block ? [needBlock(ctx, ctx.flags.block).id] : undefined;
    await commit(ctx, [...joinIfNeeded(ctx), ev(ctx, 'test', { ok: verdict === 'pass', summary: words(ctx.pos.slice(1)), ...(blocks ? { blocks } : {}) })]);
    out(ctx, `Recorded: tests ${verdict}.`);
  },

  async bug(ctx) {
    return fileItem(ctx, 'bug');
  },
  async task(ctx) {
    return fileItem(ctx, 'task');
  },
  async ask(ctx) {
    return fileItem(ctx, 'question');
  },
  // A proposed distribution of work, for the human to apply with one click: `qb suggest Basalt:T4 Saffron:B5,B6`.
  // It reassigns nothing; only the human does.
  async suggest(ctx) {
    if (!ctx.pos.length) throw new Refusal('`qb suggest <agent>:<item>[,<item>]... [--note "why"]`, for example `qb suggest Basalt:T4 Saffron:B5,B6`.');
    const plan = [];
    for (const word of ctx.pos) {
      const m = /^([^:]+):(.+)$/.exec(word);
      if (!m) throw new Refusal(`"${word}" isn't <agent>:<item>[,<item>].`);
      const agent = resolveAgent(ctx, m[1]);
      if (agent === HUMAN) throw new Refusal('Suggest work for agents; the human takes what they like.');
      for (const id of m[2].split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!ctx.state.items[id]) throw new Refusal(`No item ${id}. \`qb show <block>\` lists a block's items.`);
        plan.push({ agent, item: id });
      }
    }
    const title = suggestionTitle(ctx.state, plan);
    const note = typeof ctx.flags.note === 'string' ? ctx.flags.note : '';
    const [e] = await commit(ctx, [ev(ctx, 'item.add', { item: { kind: 'suggestion', title, detail: note, plan } })]).then((evs) => evs.filter((x) => x.type === 'item.add'));
    out(ctx, `Suggested ${e.item.id}: ${title}. The human applies or dismisses it on the board.`, e.item);
  },

  async item(ctx) {
    const [id, status] = ctx.pos;
    const it = ctx.state.items[id];
    if (!it) throw new Refusal(`No item ${id}. \`qb show <block>\` lists a block's items.`);
    // delete: an item filed by mistake goes away (the person, or whoever filed it). Done and wontfix close real work.
    if (status === 'delete') {
      await commit(ctx, [ev(ctx, 'item.delete', { item: id })]);
      return out(ctx, `${id} deleted.`);
    }
    if (status && !ITEM_STATUS.includes(status)) throw new Refusal(`Statuses are ${ITEM_STATUS.join(', ')}, or delete.`);
    const payload = { item: id };
    if (status) payload.status = status;
    if (typeof ctx.flags.note === 'string') payload.note = ctx.flags.note;
    if (typeof ctx.flags.answer === 'string') payload.answer = ctx.flags.answer;
    // --take: the item is yours (an agent may assign itself; only the person gives work to someone else).
    if (ctx.flags.take) payload.assignee = ctx.me;
    if (ctx.flags.block) payload.block = needBlock(ctx, ctx.flags.block).id;
    await commit(ctx, [ev(ctx, 'item.update', payload)]);
    out(ctx, `${id}: ${status || 'updated'}.`);
  },

  async inbox(ctx) {
    const a = ctx.state.agents[ctx.me];
    const msgs = a?.inbox || [];
    if (!msgs.length) return out(ctx, 'No messages.', []);
    if (!ctx.flags.keep && !ctx.flags.peek) await commit(ctx, [ev(ctx, 'msg.read', { ids: msgs.map((m) => m.id) })]);
    out(ctx, msgs.map((m) => `${clock(m.ts)} ${agentName(ctx.state, m.from)}: ${m.text}`).join('\n'), msgs);
  },

  async note(ctx) {
    const text = words(ctx.pos);
    if (ctx.flags.to) {
      ctx.pos = [ctx.flags.to, ...ctx.pos];
      return commands.msg(ctx);
    }
    const block = ctx.flags.block ? needBlock(ctx, ctx.flags.block).id : undefined;
    await commit(ctx, [...joinIfNeeded(ctx), ev(ctx, 'note', { text, ...(block ? { block } : {}) })]);
    out(ctx, 'Noted on the board.');
  },

  async msg(ctx) {
    const [toQuery, ...rest] = ctx.pos;
    const to = toQuery === '*' || toQuery === 'all' ? '*' : resolveAgent(ctx, toQuery);
    await commit(ctx, [ev(ctx, 'msg', { to, text: words(rest) })]);
    out(ctx, `Sent to ${to === '*' ? 'everyone' : agentName(ctx.state, to)}.`);
  },

  async queue(ctx) {
    if (!ctx.pos.length) {
      const q = queueEntries(ctx.state);
      return out(ctx, q.length ? q.map((e, i) => `#${i + 1} ${e.kind === 'item' ? `${e.item} ${ctx.state.items[e.item].title}${e.block ? `, in ${blockMeta(ctx.state, e.block).name}` : ', no block yet'}` : `${blockMeta(ctx.state, e.block).name} (${e.block}), the whole block${e.note ? `: ${e.note}` : ''}`}`).join('\n') : 'The queue is empty.', q);
    }
    const it = ctx.state.items[ctx.pos[0]];
    if (it) {
      // An item with no block goes back to the queue as it is, and stops being anyone's (B31).
      if (!it.block) {
        await commit(ctx, [ev(ctx, 'block.queue', { item: it.id })]);
        return out(ctx, `Queued ${it.id} (${it.title}), with no block yet.`);
      }
      await commit(ctx, [ev(ctx, 'block.queue', { block: it.block, item: it.id })]);
      return out(ctx, `Queued ${it.id} (${it.title}) with ${blockMeta(ctx.state, it.block).name}.`);
    }
    const b = needBlock(ctx, ctx.pos[0]);
    await commit(ctx, [ev(ctx, 'block.queue', { block: b.id, note: words(ctx.pos.slice(1)) || ctx.flags.note || '' })]);
    out(ctx, `Queued ${b.name}.`);
  },
  async unqueue(ctx) {
    const it = ctx.state.items[ctx.pos[0]];
    if (it && !it.block) {
      if (!it.queued) throw new Refusal(`${it.id} isn't on the queue.`);
      await commit(ctx, [ev(ctx, 'block.unqueue', { item: it.id })]);
      return out(ctx, `${it.id} is off the queue.`);
    }
    if (it?.block) {
      if (!ctx.state.blocks[it.block]?.queued?.items?.includes(it.id)) throw new Refusal(`${it.id} isn't on the queue.`);
      await commit(ctx, [ev(ctx, 'block.unqueue', { block: it.block, item: it.id })]);
      return out(ctx, `${it.id} is off the queue.`);
    }
    const b = needBlock(ctx, ctx.pos[0]);
    await commit(ctx, [ev(ctx, 'block.unqueue', { block: b.id })]);
    out(ctx, `${b.name} is off the queue.`);
  },
  async freeze(ctx) {
    const b = needBlock(ctx, ctx.pos[0]);
    await commit(ctx, [ev(ctx, 'block.freeze', { block: b.id, on: true, note: words(ctx.pos.slice(1)) || ctx.flags.note || '' })]);
    out(ctx, `Froze ${b.name}. Agents can't reserve it or edit inside it until it's unfrozen.`);
  },
  async unfreeze(ctx) {
    const b = needBlock(ctx, ctx.pos[0]);
    await commit(ctx, [ev(ctx, 'block.freeze', { block: b.id, on: false })]);
    out(ctx, `Unfroze ${b.name}.`);
  },

  async blocks(ctx) {
    const rows = ctx.board.blocks.filter((b) => !ctx.flags.district || b.district === ctx.flags.district);
    const byDistrict = {};
    for (const b of rows) (byDistrict[b.district] ||= []).push(b);
    const lines = [];
    for (const d of ctx.board.districts) {
      if (!byDistrict[d.id]) continue;
      lines.push(d.name);
      for (const b of byDistrict[d.id]) {
        const s = ctx.state.blocks[b.id];
        const tag = s.holder ? `reserved by ${agentName(ctx.state, s.holder)}` : s.frozen ? 'frozen' : 'free';
        lines.push(`  ${b.id.padEnd(18)} ${b.name.padEnd(32)} ${tag}`);
      }
    }
    out(ctx, lines.join('\n'), rows.map((b) => ({ ...b, state: ctx.state.blocks[b.id] })));
  },

  async agents(ctx) {
    const rows = Object.values(ctx.state.agents).filter((a) => a.id !== HUMAN && !a.leftAt);
    out(
      ctx,
      rows.length ? rows.map((a) => `${a.name.padEnd(10)} ${a.id.padEnd(12)} ${presence(ctx.state, a.id, ctx.now).padEnd(8)} ${activityOf(ctx.state, a.id, ctx.now).padEnd(11)} ${a.held.join(', ') || '-'}  ${a.doing || a.task}`).join('\n') : 'No agents on the board.',
      rows,
    );
  },

  async log(ctx) {
    const n = Number(ctx.flags.n || 30);
    const print = (events, state) => {
      for (const e of events) console.log(`${clock(e.ts)}  ${describeEvent(state, e)}`);
    };
    print(ctx.events.slice(-n), ctx.state);
    if (!ctx.flags.follow || ctx.store.kind !== 'local') return;
    let seen = ctx.events.length;
    setInterval(() => {
      const events = ctx.store.readEvents();
      if (events.length > seen) {
        const state = reduce(ctx.board, events);
        print(events.slice(seen), state);
        seen = events.length;
      }
    }, 700);
    await new Promise(() => {});
  },

  async check(ctx) {
    const files = changedFiles(ctx.store.root, { staged: !!ctx.flags.staged, since: typeof ctx.flags.since === 'string' ? ctx.flags.since : null });
    const mine = new Set(ctx.state.agents[ctx.me]?.held || []);
    const outside = [];
    for (const f of files) {
      const id = blockForPath(ctx.state.index, f) || UNMAPPED;
      const b = ctx.state.blocks[id];
      if (mine.has(id)) continue;
      outside.push({ file: f, block: id, holder: b.holder });
    }
    if (!outside.length) return out(ctx, `All ${files.length} changed file${files.length === 1 ? '' : 's'} sit in blocks you've reserved.`, { ok: true, files });
    const lines = outside.map((o) => `  ${o.file}  →  ${o.block === UNMAPPED ? 'no block' : blockMeta(ctx.state, o.block).name}${o.holder ? ` (reserved by ${agentName(ctx.state, o.holder)})` : ' (free)'}`);
    out(ctx, `${outside.length} changed file${outside.length === 1 ? '' : 's'} outside your blocks:\n${lines.join('\n')}\nReserve the free ones with \`qb reserve <block>\`; coordinate on the reserved ones.`, { ok: false, outside });
    process.exitCode = 1;
  },

  // Worktrees: each one's branch, agent, distance from the base, uncommitted work, blocks and merge state.
  async wt(ctx) {
    const snap = await worktreeSnapshot(ctx.store.root, { base: ctx.board.base });
    if (ctx.pos[0] === 'path') {
      const name = ctx.pos[1];
      const hit = snap.list.find((w) => w.name === name || w.branch === name) || snap.list.find((w) => w.name.includes(name || ''));
      if (!hit) throw new Refusal(`No worktree "${name}". \`qb wt\` lists them.`);
      return console.log(hit.path);
    }
    const checks = new Map(mergeChecks(ctx.state, snap, ctx.now).map((c) => [c.entry.worktree, c]));
    const rows = snap.list.map((w) => {
      const agents = agentsInWorktree(ctx.state, w, ctx.now);
      const blocks = [...blocksOf(ctx.state, w).keys()];
      const m = checks.get(w.name);
      return { ...w, agents, blocks, merge: m ? { pos: m.entry.status === 'ready' ? m.entry.pos : null, status: m.entry.status, verdict: m.verdict } : null };
    });
    if (ctx.flags.json) return out(ctx, '', { base: snap.base, worktrees: rows });
    const width = Math.max(4, ...rows.map((r) => r.name.length));
    const who = (r) => (r.agents.length ? r.agents.map((id) => agentName(ctx.state, id)).join(', ') : '-');
    const whoWidth = Math.max(10, ...rows.map((r) => who(r).length));
    const lines = [`Base: ${snap.base}`];
    for (const r of rows) {
      const state = [r.ahead ? `${r.ahead} ahead` : '', r.behind ? `${r.behind} behind` : '', r.dirty ? `${r.dirty} uncommitted` : '', r.conflicts.length ? `conflicts in ${r.conflicts.length}` : ''].filter(Boolean).join(', ') || 'even';
      lines.push(`  ${r.name.padEnd(width)}  ${(r.branch || '-').padEnd(14)} ${who(r).padEnd(whoWidth)} ${state}${r.add || r.del ? `, +${r.add} -${r.del}` : ''}`);
      if (r.blocks.length) lines.push(`  ${' '.repeat(width)}  blocks: ${r.blocks.slice(0, 6).join(', ')}${r.blocks.length > 6 ? ` and ${r.blocks.length - 6} more` : ''}`);
      if (r.merge) lines.push(`  ${' '.repeat(width)}  merge: ${r.merge.status === 'landed' ? 'merged' : r.merge.verdict}`);
    }
    lines.push('`qb wt path <name>` prints a worktree\'s path: cd "$(qb wt path agent-2)"');
    console.log(lines.join('\n'));
  },

  // Mark this worktree's branch ready to merge at its current commit.
  async ready(ctx) {
    const snap = await worktreeSnapshot(ctx.store.root, { base: ctx.board.base });
    const here = worktreeHere()?.path;
    const name = typeof ctx.flags.worktree === 'string' ? ctx.flags.worktree : snap.list.find((w) => w.path === here)?.name;
    const wt = snap.list.find((w) => w.name === name);
    if (!wt) throw new Refusal('Run `qb ready` inside the worktree, or name it with --worktree.');
    if (wt.main) throw new Refusal('The main checkout is where branches merge into, not one that queues.');
    if (!wt.ahead) throw new Refusal(`Nothing to merge: ${wt.name} has no commits ahead of ${snap.base}.${wt.dirty ? ` Commit its ${wt.dirty} uncommitted change(s), then run \`qb ready\` again.` : ''}`);
    const note = typeof ctx.flags.note === 'string' ? ctx.flags.note : words(ctx.pos);
    await commit(ctx, [...joinIfNeeded(ctx), ev(ctx, 'merge.ready', { worktree: wt.name, branch: wt.branch, commit: wt.head, ahead: wt.ahead, note })]);
    const warn = [wt.dirty ? `${wt.dirty} uncommitted change(s) won't be in the merge; commit them and run \`qb ready\` again.` : '', wt.conflicts.length ? `It conflicts with ${snap.base} in ${wt.conflicts.join(', ')}.` : ''].filter(Boolean);
    out(ctx, [`${wt.name} (${wt.branch}) is in the merge queue at ${wt.head.slice(0, 8)}.`, ...warn].join('\n'), { worktree: wt.name });
  },

  async unready(ctx) {
    const here = worktreeHere()?.path;
    const snap = await worktreeSnapshot(ctx.store.root, { base: ctx.board.base });
    const name = typeof ctx.flags.worktree === 'string' ? ctx.flags.worktree : ctx.pos[0] || snap.list.find((w) => w.path === here)?.name;
    await commit(ctx, [ev(ctx, 'merge.unready', { worktree: name })]);
    out(ctx, `${name} is out of the merge queue.`);
  },

  // The merge queue, in order, with what each branch would run into.
  async merge(ctx) {
    const snap = await worktreeSnapshot(ctx.store.root, { base: ctx.board.base });
    const rows = mergeChecks(ctx.state, snap, ctx.now);
    if (ctx.flags.json) return out(ctx, '', rows);
    if (!rows.length) return console.log('The merge queue is empty. In a worktree, `qb ready` puts its branch in it.');
    const lines = [`Into ${snap.base}:`];
    rows.forEach((r, i) => {
      const mark = r.entry.status === 'landed' ? 'merged' : `#${i + 1}`;
      lines.push(`  ${mark.padEnd(6)} ${r.entry.worktree} (${r.entry.branch || '-'}): ${r.verdict}`);
      for (const c of r.checks.slice(1)) lines.push(`         ${c.text}`);
    });
    const next = rows.find((r) => r.entry.status === 'ready');
    if (next && next.level === 'danger') lines.push(`Next is ${next.entry.worktree}, which has to fix "${next.verdict}" first.`);
    else if (next) lines.push(`Next, from the main checkout: ${mergeCommand(next.entry, snap.base)}`);
    console.log(lines.join('\n'));
  },

  // Whether the board still fits the code: patterns that match nothing, empty blocks, files nobody claims,
  // the log's size, the hooks, and whether git can do the dry-run merge the merge queue relies on.
  async doctor(ctx) {
    const { gitFiles } = await import('./core/files.js');
    const { compileIndex, expandBraces, globToRegExp } = await import('./core/glob.js');
    const files = gitFiles(ctx.store.root);
    const index = compileIndex(ctx.board.blocks);
    const lines = [];
    const stale = [];
    const empty = [];
    for (const b of ctx.board.blocks) {
      let owned = 0;
      for (const raw of b.paths || []) {
        for (const pat of expandBraces(raw)) {
          const re = globToRegExp(pat);
          if (!files.some((f) => re.test(f))) stale.push(`${b.id}: ${pat}`);
        }
      }
      for (const f of files) if (blockForPath(index, f) === b.id) owned++;
      if (!owned) empty.push(b.id);
    }
    const unclaimed = files.filter((f) => !blockForPath(index, f));
    const byDir = {};
    for (const f of unclaimed) {
      const d = f.includes('/') ? f.split('/').slice(0, 2).join('/') : '(top level)';
      byDir[d] = (byDir[d] || 0) + 1;
    }
    if ((ctx.board.schema ?? 1) > BOARD_SCHEMA) lines.push(`The board is schema ${ctx.board.schema}, newer than this qb (${BOARD_SCHEMA}): it reads what it knows and ignores the rest. Update qb.`);
    lines.push(`${files.length} files, ${ctx.board.blocks.length} blocks, ${unclaimed.length} unclaimed.`);
    if (unclaimed.length) lines.push(`  Unclaimed: ${Object.entries(byDir).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, n]) => `${d} (${n})`).join(', ')}`);
    if (empty.length) lines.push(`  Blocks that own no file: ${empty.join(', ')}`);
    if (stale.length) lines.push(`  Patterns that match nothing (${stale.length}): ${stale.slice(0, 10).join('; ')}${stale.length > 10 ? '; …' : ''}`);
    if (ctx.store.kind === 'local') {
      let size = 0;
      try {
        size = fs.statSync(ctx.store.eventsPath).size;
      } catch {
        // No log yet.
      }
      lines.push(`Log: ${ctx.events.length} events, ${(size / 1024 / 1024).toFixed(1)} MB at ${ctx.store.eventsPath}`);
      // A newer QueueBox wrote here: this one folds what it knows and skips the rest, so say what it can't show.
      const unknown = new Map();
      for (const e of ctx.events) if (!EVENT_TYPES.includes(e.type)) unknown.set(e.type, (unknown.get(e.type) || 0) + 1);
      if (unknown.size) lines.push(`  Written by a newer QueueBox, skipped here: ${[...unknown].map(([t, n]) => `${String(t).slice(0, 40)} (${n})`).join(', ')}. Update qb to see them.`);
      // The installer's own test, which knows the hook by its real path (B18), not by a folder name.
      const { hooksInstalled } = await import('./hooks/install.js');
      const hooked = hooksInstalled(ctx.store.root);
      lines.push(`Claude Code hooks: ${hooked ? 'installed' : 'not installed (`qb hooks install`)'}`);
    }
    const { execFileSync } = await import('node:child_process');
    let mergeTree = false;
    try {
      execFileSync('git', ['merge-tree', '--write-tree', 'HEAD', 'HEAD'], { cwd: ctx.store.root, stdio: 'ignore' });
      mergeTree = true;
    } catch {
      mergeTree = false;
    }
    lines.push(`git merge-tree --write-tree: ${mergeTree ? 'available' : 'missing (git 2.38 or newer finds conflicts before a merge)'}`);
    out(ctx, lines.join('\n'), { files: files.length, unclaimed: unclaimed.length, empty, stale, mergeTree });
    if (unclaimed.length || empty.length || stale.length) process.exitCode = 1;
  },

  async version() {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(`queuebox ${pkg.version}`);
  },

  async serve(ctx) {
    const { serve } = await import('./server.js');
    await serve({ port: Number(ctx.flags.port || process.env.QUEUEBOX_PORT || 4477), host: ctx.flags.host || '127.0.0.1', open: !!ctx.flags.open });
  },

  // A standalone page of this session: the page and its modules, the board, and the log, in one folder any static
  // server can serve. Opened that way the page replays the log, read-only. (It replaces the simulated demo, T41.)
  async snapshot(ctx) {
    const dir = path.resolve(typeof ctx.flags.out === 'string' ? ctx.flags.out : 'queuebox-snapshot');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const board = ctx.store.board({ items: true, files: true, samples: 14 });
    const events = ctx.flags.empty ? [] : ctx.events;
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(here, 'ui'), path.join(dir, 'ui'), { recursive: true });
    for (const f of ['model.js', 'glob.js', 'merges.js']) {
      fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
      fs.copyFileSync(path.join(here, 'core', f), path.join(dir, 'core', f));
    }
    const page = fs.readFileSync(path.join(here, 'ui', 'index.html'), 'utf8').replace(/<title>[^<]*<\/title>/, `<title>${board.name.replace(/[<&]/g, '')} QueueBox</title>`);
    fs.writeFileSync(path.join(dir, 'index.html'), page);
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify(board));
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events));
    out(ctx, `Wrote a standalone page of ${board.name} to ${dir}: ${events.length} events. Serve the folder with any static server and open index.html.`, { dir, events: events.length });
  },

  async hooks(ctx) {
    const { installHooks } = await import('./hooks/install.js');
    const action = ctx.pos[0] || 'print';
    const res = installHooks(ctx.store.root, action);
    out(ctx, res.message, res);
  },

  // One command for the human: a board if there isn't one, the Claude Code hooks, the server in the background,
  // the page in a browser. Safe to run again; it only does what's missing.
  async up(ctx) {
    const { execFileSync } = await import('node:child_process');
    const { ensureServer } = await import('./core/daemon.js');
    const { installHooks, hooksInstalled } = await import('./hooks/install.js');
    const { openBrowser } = await import('./server.js');
    const cwd = process.cwd();
    let checkout = cwd;
    try {
      checkout = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Not a git checkout: this folder.
    }
    const lines = [];
    let boardDir = findBoardDir(cwd);
    if (!boardDir) {
      const { initBoard } = await import('./scripts/init.js');
      initBoard(cwd, { name: ctx.flags.name });
      boardDir = findBoardDir(cwd);
      const n = JSON.parse(fs.readFileSync(path.join(boardDir, 'board.json'), 'utf8')).blocks.length;
      lines.push(`  ✓ Board        drew a first one from your folders (${n} blocks) in .queuebox/board.json; rename them any time`);
    } else {
      const b = JSON.parse(fs.readFileSync(path.join(boardDir, 'board.json'), 'utf8'));
      lines.push(`  ✓ Board        ${b.blocks.length} blocks in ${path.relative(cwd, path.join(boardDir, 'board.json')) || 'board.json'}`);
    }
    const name = JSON.parse(fs.readFileSync(path.join(boardDir, 'board.json'), 'utf8')).name;
    if (ctx.flags['no-hooks']) lines.push('  - Claude Code  left alone (--no-hooks)');
    else {
      const had = hooksInstalled(checkout);
      installHooks(checkout, 'install');
      lines.push(`  ✓ Claude Code  ${had ? 'hooked up' : 'hooked up just now'}: every session started here joins the board`);
    }
    const srv = await ensureServer(boardDir, { port: ctx.flags.port ? Number(ctx.flags.port) : undefined });
    lines.push(`  ✓ Server       ${srv.started ? 'started' : 'already running'} in the background (pid ${srv.pid})`);
    if (ctx.flags['no-open']) lines.push(`  - Page         not opened (--no-open): ${srv.url}`);
    else {
      openBrowser(srv.url);
      lines.push(`  ✓ Page         opened ${srv.url} in your browser${srv.started ? '' : ' (the server was already running)'}`);
    }
    console.log([
      '',
      `QueueBox is up for ${name}:  ${srv.url}`,
      '',
      ...lines,
      '',
      'Start Claude Code in this repository (`claude`) and the session appears on the map.',
      'Close the terminal if you like; the board keeps running. `qb down` stops it.',
      '',
    ].join('\n'));
  },

  async down() {
    const { stopServer } = await import('./core/daemon.js');
    const boardDir = findBoardDir();
    if (!boardDir) return console.log('No QueueBox board here.');
    console.log((await stopServer(boardDir)) ? 'QueueBox stopped. `qb up` starts it again.' : 'QueueBox wasn\'t running.');
  },

  async init(ctx) {
    const { initBoard } = await import('./scripts/init.js');
    const res = initBoard(process.cwd(), { auto: ctx.flags.auto !== false, name: ctx.flags.name });
    console.log(res.message);
  },

  async help() {
    console.log(HELP);
  },
};

// "Basalt takes T4 in Map; Saffron takes B5, B6": who takes what, grouped by agent, in the order given.
function suggestionTitle(state, plan) {
  const by = new Map();
  for (const p of plan) {
    if (!by.has(p.agent)) by.set(p.agent, []);
    by.get(p.agent).push(p.item);
  }
  return [...by].map(([agent, ids]) => {
    const blocks = [...new Set(ids.map((id) => state.items[id]?.block).filter(Boolean))];
    return `${agentName(state, agent)} takes ${ids.join(', ')}${blocks.length === 1 ? ` in ${blockMeta(state, blocks[0]).name}` : ''}`;
  }).join('; ');
}

// The words after `qb board`, as the change core/board-ops.js takes.
const BOARD_SUBCOMMANDS = {
  split: (ctx, [block]) => {
    if (!block) throw new Refusal('`qb board split <block>`: drafts its sub-blocks from its folders and makes it a district holding them.');
    return { op: 'split', block: needBlock(ctx, block).id };
  },
  dissolve: (ctx, [district]) => {
    if (!district) throw new Refusal('`qb board dissolve <district> [--into <id>] [--name "…"]`: one block for everything in it.');
    return { op: 'dissolve', district, ...(typeof ctx.flags.into === 'string' ? { into: ctx.flags.into } : {}), ...(typeof ctx.flags.name === 'string' ? { name: ctx.flags.name } : {}) };
  },
  join: (ctx, members) => {
    if (members.length < 2 || typeof ctx.flags.into !== 'string') throw new Refusal('`qb board join <block|district> <block|district>... --into <id> [--name "…"] [--district <id>]`: one block whose paths are theirs together.');
    const ids = members.map((m) => (ctx.board.districts.some((d) => d.id === m) ? m : needBlock(ctx, m).id));
    return { op: 'join', members: ids, into: ctx.flags.into, ...(typeof ctx.flags.name === 'string' ? { name: ctx.flags.name } : {}), ...(typeof ctx.flags.district === 'string' ? { district: ctx.flags.district } : {}) };
  },
  move: (ctx, [block, district]) => {
    if (!block || !district) throw new Refusal('`qb board move <block> <district> [--before <block>]`');
    return { op: 'move', block: needBlock(ctx, block).id, district, ...(typeof ctx.flags.before === 'string' ? { before: needBlock(ctx, ctx.flags.before).id } : {}) };
  },
  rename: (ctx, [id, ...name]) => {
    if (!id || !name.length) throw new Refusal('`qb board rename <block|district> "<new name>"`');
    const known = ctx.board.districts.some((d) => d.id === id) ? id : needBlock(ctx, id).id;
    return { op: 'rename', id: known, name: words(name) };
  },
};

function resolveAgent(ctx, q) {
  const s = String(q || '').toLowerCase();
  const all = Object.values(ctx.state.agents);
  const hit = all.find((a) => a.id.toLowerCase() === s) || all.find((a) => a.name.toLowerCase() === s) || all.find((a) => a.name.toLowerCase().startsWith(s));
  if (!hit) throw new Refusal(`No agent "${q}". \`qb agents\` lists them.`);
  return hit.id;
}

async function fileItem(ctx, kind) {
  const title = words(ctx.pos);
  if (!title) throw new Refusal(`\`qb ${kind === 'question' ? 'ask' : kind} "<title>" [--block <block>]\``);
  const block = ctx.flags.block ? needBlock(ctx, ctx.flags.block).id : defaultBlock(ctx);
  const item = { kind, title, block, detail: typeof ctx.flags.detail === 'string' ? ctx.flags.detail : '' };
  // Filing doesn't put the filer on the board (one can file from another repository's session); asking does,
  // since the asker waits on the answer.
  const [e] = await commit(ctx, [...(kind === 'question' ? joinIfNeeded(ctx) : []), ev(ctx, 'item.add', { item })]).then((evs) => evs.filter((x) => x.type === 'item.add'));
  const where = block ? ` in ${blockMeta(ctx.state, block).name}` : '';
  if (kind === 'question' && ctx.flags.wait) return waitForAnswer(ctx, e.item, where);
  const after = kind === 'question' ? ' The human sees it on the board; `qb inbox` shows the answer.' : '';
  out(ctx, `Filed ${e.item.id}${where}.${after}`, e.item);
}

// `qb ask --wait [--timeout <minutes>]`: for agents without hooks, block until the person answers (or closes) the
// question, then print the answer and mark it read. Past the timeout (30 min by default) it gives up and says so.
async function waitForAnswer(ctx, q, where) {
  const minutes = Number(ctx.flags.timeout) > 0 ? Number(ctx.flags.timeout) : 30;
  const until = Date.now() + minutes * 60_000;
  const pollMs = Number(process.env.QUEUEBOX_POLL_MS) || 2000;
  if (!ctx.flags.json) console.log(`Filed ${q.id}${where}. Waiting up to ${minutes} min for the answer...`);
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const st = ctx.store.kind === 'local' ? ctx.store.state() : await remoteStore(process.env.QUEUEBOX_URL).state();
    const it = st.items[q.id];
    if (it && it.status !== 'open') {
      const msg = st.agents[ctx.me]?.inbox.find((m) => m.text.startsWith(`Answer to ${q.id} `));
      ctx.state = st;
      if (msg) await commit(ctx, [ev(ctx, 'msg.read', { ids: [msg.id] })]);
      return out(ctx, it.answer ? `${q.id} answered: ${it.answer}` : `${q.id} was closed as ${it.status}, with no answer.`, it);
    }
    if (Date.now() >= until) throw new Refusal(`No answer to ${q.id} after ${minutes} min. It stays open on the board; \`qb inbox\` shows the answer when it comes.`);
  }
}

function protocolHint() {
  return 'Reserve a block before you edit in it (`qb reserve <block> --for "<what>"`), say what you are doing (`qb doing "<what>"`), release it when the work lands (`qb release --landed`).';
}

export function summary(state, now, me = null) {
  const agents = Object.values(state.agents).filter((a) => a.id !== HUMAN && !a.leftAt);
  const held = Object.values(state.blocks).filter((b) => b.holder);
  const al = alerts(state, now);
  const lines = [`${state.board.name}: ${agents.length || 'no'} agent${agents.length === 1 ? '' : 's'}, ${held.length} of ${state.board.blocks.length} blocks reserved.`];
  const human = state.agents[HUMAN];
  if (human.held.length) lines.push(`${human.name} (the human) has reserved ${human.held.join(', ')}. Agents stay out.`);
  const width = Math.max(4, ...agents.map((a) => a.name.length + (a.id === me ? 6 : 0)));
  // The activity column is there only while some agent has a tag.
  const tagWidth = Math.max(0, ...agents.map((a) => activityOf(state, a.id, now).length));
  for (const a of agents) {
    const who = `${a.name}${a.id === me ? ' (you)' : ''}`.padEnd(width);
    const p = presence(state, a.id, now).padEnd(8);
    const doingNow = activityOf(state, a.id, now).padEnd(tagWidth);
    const holds = a.held.length ? a.held.join(', ') : '-';
    lines.push(`  ${who}  ${p}  ${doingNow}${tagWidth ? '  ' : ''}${holds}${a.doing || a.task ? `\n  ${' '.repeat(width)}  ${a.doing || a.task}` : ''}`);
  }
  const entries = queueEntries(state);
  if (entries.length) lines.push(`Up next: ${entries.slice(0, 8).map((e) => (e.kind === 'item' ? `${e.item}${e.block ? ` in ${e.block}` : ', no block yet'}` : `${e.block}${e.note ? ` ("${e.note}")` : ''}`)).join(', ')}${entries.length > 8 ? ` and ${entries.length - 8} more` : ''}. \`qb next\` takes the first you can.`);
  const frozen = Object.values(state.blocks).filter((b) => b.frozen);
  if (frozen.length) lines.push(`Frozen: ${frozen.map((b) => `${b.id}${b.frozen.note ? ` (${b.frozen.note})` : ''}`).join(', ')}.`);
  for (const a of al.slice(0, 6)) lines.push(`  ! ${a.text}`);
  if (me && me !== HUMAN && state.agents[me]?.inbox.length) lines.push(`You have ${state.agents[me].inbox.length} unread message(s): \`qb inbox\`.`);
  return lines.join('\n');
}

const HELP = `qb, the QueueBox command line

Start here
  qb up                      set up this repository and open the board (safe to run again)
  qb down                    stop the board's background server

Board
  qb                         who has reserved what, the queue, alerts
  qb blocks [--district d]   every block and whether it's free
  qb show <block>            a block's docs, open items and recent activity
  qb which <path...>         which block owns a file, and who has reserved it
  qb agents | qb log [-n 30] [--follow]
  qb serve [--port 4477] [--open]          the visual board in a browser

Working (agents)
  qb run [--agent ID] -- <agent command>     run an agent in a terminal the board can type into, so it wakes it
  qb join [--name N] [--task T]              join the board (any command joins you)
  qb reserve <block...> [--for "intent"] [--watch]
  qb next [--any]                            take the queued work the board would give you (--any: the first you can)
  qb doing "<what you're doing now>"
  qb status working|idle|blocked|done
  qb touch <path...> [--op edit|read]        record activity (the hooks do this for you)
  qb test pass|fail "<what ran>" [--block b]
  qb bug|task "<title>" [--block b] [--detail d]
  qb ask "<question>" [--wait [--timeout m]] shows on the board; the answer lands in your inbox (--wait: wait for it here)
  qb suggest <agent>:<item>[,<item>]...      propose who takes what; the human applies it
  qb item <id> open|doing|done|wontfix|delete [--note n] [--take]   --take: assign it to yourself
  qb inbox                                   messages and answers from the human
  qb note "<text>" [--block b]  |  qb msg <agent|all> "<text>"
  qb release [<block...>] [--landed|--parked|--handoff|--dropped] [--note n]
  qb check [--staged | --since <ref>]        changed files outside your blocks (exit 1)
  qb ready ["note"]  |  qb unready           put this worktree's branch in the merge queue, or take it out

Worktrees
  qb wt                                      every worktree: branch, agent, ahead/behind, conflicts, blocks
  qb wt path <name>                          its path: cd "$(qb wt path agent-2)"
  qb merge                                   the merge queue in order, with what each branch would hit
  qb leave

The human
  qb queue <block|item> ["note"]  |  qb unqueue <block|item>
  qb freeze <block> ["why"]  |  qb unfreeze <block>
  qb board split <block>                     its folders become sub-blocks in a district of its name
  qb board dissolve <district> [--into <id>] everything in it becomes one block
  qb board join <a> <b>... --into <id>       blocks (or districts) become one block
  qb board move <block> <district> [--before <block>]  |  qb board rename <id> "name"
  qb hooks install|uninstall|print           Claude Code hooks, in .claude/settings.local.json
  qb snapshot --out <dir>                    a standalone page of this session (page, board, log)
  qb doctor                                  patterns that match nothing, unclaimed files, the log, the hooks
  qb init [--name N]                         only draw a board (qb up does this for you)

Identity: --as <id>, else QUEUEBOX_AGENT, else a Claude Code session, else the worktree you're in, else the human.
Any agent on any model can use qb; QUEUEBOX_KIND names its harness on the board.
Remote board: QUEUEBOX_URL=http://host:4477 (and QUEUEBOX_TOKEN if the server has one).
Add --json to any command for machine-readable output.`;

// ---------------------------------------------------------------------------------------------

async function main() {
  const { cmd, pos, flags } = parse(process.argv.slice(2));
  const fn = commands[cmd];
  if (!fn) {
    console.error(`qb: no command "${cmd}". \`qb help\` lists them.`);
    process.exit(2);
  }
  if (cmd === 'help' || cmd === 'init' || cmd === 'version' || cmd === 'up' || cmd === 'down') return fn({ pos, flags });
  const ctx = await context(flags);
  ctx.pos = pos;
  await fn(ctx);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    if (err instanceof Refusal) {
      console.error(`qb: ${err.message}`);
      process.exit(3);
    }
    console.error(`qb: ${err.message}`);
    process.exit(1);
  });
}

