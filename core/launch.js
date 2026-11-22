// Starting and waking Claude Code sessions, on the person's click only (B1: QueueBox acts on the person's word,
// short of being a harness). Node only. Every command here is fixed: the page names a worktree or an agent the
// server already knows, never a path, a flag or text to run.
//
// It uses Claude Code's documented background sessions: `claude --bg "<prompt>"` starts one and prints its id
// (`claude attach <id>` opens it in a terminal, `claude agents` lists it), and `claude agents --json` lists every
// running session with its pid, folder, session id and idle or busy.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isIdleFree, presence, blockMeta, queuePlan } from './model.js';
import { sessionAgentId as sessionAgentIdOf } from './identity.js';

// The `claude` on PATH, or null.
export function findClaude(env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // Not here.
    }
  }
  return null;
}

// What a session started from the board is told. Fixed text; only the board's own `qb` path goes in.
export function startPrompt(cli) {
  return [
    'You were started from the QueueBox board, on the person\'s click, to take the next piece of queued work.',
    `Run \`${cli} next\`: it reserves the first queued block for you and hands you its items. Then do the work the way this repository's CLAUDE.md says (keep \`${cli} doing\` current, test, commit by pathspec, \`${cli} release --landed\`).`,
    `If the queue is empty, run \`${cli}\` to see the board, say so in one line, and stop: QueueBox hands you work when the person queues or assigns it.`,
  ].join(' ');
}

// Starts a background Claude Code session in `cwd` (a checkout the server listed), named for the board.
// Resolves { id, name, output } or rejects with a readable message.
export function startSession({ cwd, name, cli, claude = findClaude(), timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    if (!claude) return reject(new Error('Claude Code (`claude`) isn\'t on the server\'s PATH, so the board can\'t start a session.'));
    execFile(claude, ['--bg', '--name', name, startPrompt(cli)], { cwd, timeout: timeoutMs, env: { ...process.env, QUEUEBOX: '' } }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (err) return reject(new Error(`\`claude --bg\` failed: ${output.split('\n').pop() || err.message}`));
      // It prints the short id `claude attach` takes; keep the last word that looks like one.
      const id = (output.match(/\b[0-9a-f]{6,}\b/gi) || []).pop() || '';
      resolve({ id, name, output });
    });
  });
}

// Every running Claude Code session ({ pid, cwd, kind, sessionId, name, status }), or [] when it can't say.
export function listSessions({ claude = findClaude(), timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    if (!claude) return resolve([]);
    execFile(claude, ['agents', '--json'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const list = JSON.parse(stdout);
        resolve(Array.isArray(list) ? list : []);
      } catch {
        resolve([]);
      }
    });
  });
}

// The board's agent id for a Claude Code session id: the hooks' own rule.
export { sessionAgentId as agentIdOfSession } from './identity.js';


// Waking an idle background session: it is stopped (its conversation is kept) and resumed in the background under
// the same id with a prompt, which Claude Code reports as "woke session <id> with its saved options". Resuming a
// session that is still running would start a copy instead, so the stop comes first. Only background sessions
// (`claude --bg`): a session open in someone's terminal is never touched.
export function wakeSession(session, prompt, { claude = findClaude(), timeoutMs = 30_000 } = {}) {
  const run = (args) => new Promise((resolve, reject) => {
    execFile(claude, args, { cwd: session.cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (err) reject(new Error(`\`claude ${args[0]}\` failed: ${output.split('\n').pop() || err.message}`));
      else resolve(output);
    });
  });
  if (!claude) return Promise.reject(new Error('Claude Code (`claude`) isn\'t on the server\'s PATH.'));
  return run(['stop', session.id]).then(() => run(['--bg', '--resume', session.sessionId, prompt]));
}

// Waking an agent `qb run` put in a terminal QueueBox owns (any agent CLI): the prompt is typed into it as one line,
// then Enter on its own a moment later, so the agent's input reads it as typing and the Enter as submitting.
export function typeInto(sock, text, { enterAfterMs = 400, timeoutMs = 5000 } = {}) {
  const line = String(text).replace(/\s*\n\s*/g, ' ').trim();
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error('the terminal did not answer'));
    }, timeoutMs);
    c.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'its terminal has closed' : err.message));
    });
    c.on('connect', () => {
      c.write(line);
      setTimeout(() => c.end('\r', () => {
        clearTimeout(timer);
        resolve();
      }), enterAfterMs);
    });
  });
}

// Which idle agents to wake and why: pure, so it can be tested without sessions. `sessions` is `claude agents
// --json`; `memory` carries, between calls, when each agent was last woken (`woken`) and which were nudged this
// idle stretch (`nudged`), and is updated here. Returns [{ agent, session, reasons, claim }] where reasons are
// { kind: 'inbox'|'given'|'blocks'|'queue'|'nudge', text } and claim is the queued block to reserve for it first.
export function planWakes(state, sessions, now, memory, { cli = 'qb', settleMs = 60_000, force = false, branches = null } = {}) {
  const plans = [];
  const nudgeOn = state.board?.nudgeIdle !== false;
  // Who takes queued work (T53): the board plans the whole queue at once among the agents it can hand work to now
  // (idle, a session it can wake, settled, not asked to finish), each entry to the one with the most context there.
  const wakeable = (s) => {
    const id = s.agent || sessionAgentIdOf(s.sessionId);
    const a = state.agents[id];
    if (!a || a.leftAt || a.finishing || (s.kind !== 'background' && s.kind !== 'pty') || s.status !== 'idle') return null;
    if (!isIdleFree(state, id, now) || now - (memory.woken.get(id) || 0) < settleMs) return null;
    return id;
  };
  const planned = new Map(nudgeOn ? queuePlan(state, sessions.map(wakeable).filter(Boolean), now, { branches, waitMin: state.board?.waitForContext || 0 }).map((p) => [p.agent, p]) : []);
  for (const s of sessions) {
    const id = s.agent || sessionAgentIdOf(s.sessionId);
    const a = state.agents[id];
    if (!a || a.leftAt) continue;
    const idle = isIdleFree(state, id, now);
    // The idle stretch ends when it gets work (a block reserved, an item given), not when it is merely busy: the
    // planning turn a nudge starts is busy too, and must not earn it a second nudge (B25).
    const hasWork = a.held.length > 0 || Object.values(state.items).some((it) => it.assignee === id && ['open', 'doing', 'blocked'].includes(it.status));
    if (hasWork) memory.nudged.delete(id);
    if ((s.kind !== 'background' && s.kind !== 'pty') || s.status !== 'idle') continue;
    const p = presence(state, id, now);
    if (p !== 'review' && p !== 'idle' && p !== 'waiting' && p !== 'stale' && p !== 'blocked') continue;
    if (now - (memory.woken.get(id) || 0) < settleMs) continue;
    const since = a.statusSince || 0;
    const reasons = [];
    if (a.inbox.length) reasons.push({ kind: 'inbox', text: `${a.inbox.length} message${a.inbox.length === 1 ? '' : 's'} for you on the board (an answer, or a note from the person or a teammate): read them with \`${cli} inbox\`.` });
    const given = Object.values(state.items).filter((it) => it.assignee === id && it.kind !== 'suggestion' && ['open', 'doing', 'blocked'].includes(it.status) && (it.history.at(-1)?.ts || it.createdAt) > since);
    if (given.length) reasons.push({ kind: 'given', text: `The person gave you ${given.map((it) => `${it.id} (${it.title})`).join(', ')}.` });
    // Work it already has lined up (given before its turn ended) and hasn't finished: it finished a turn, not the
    // work, so it is woken to take the next one. The same lined-up set wakes it at most every 10 minutes, in case it
    // ends turns without taking any (Finish and stop, or the switch, keeps it asleep).
    if (!given.length && nudgeOn && !a.finishing) {
      const lined = Object.values(state.items).filter((it) => it.assignee === id && it.kind !== 'suggestion' && (it.status === 'open' || it.status === 'doing'));
      const key = lined.map((it) => it.id).sort().join(',');
      memory.lined ||= new Map();
      const last = memory.lined.get(id);
      if (lined.length && !(last && last.key === key && now - last.ts < 10 * 60_000)) {
        memory.lined.set(id, { key, ts: now });
        reasons.push({ kind: 'lined', text: `You have work lined up: ${lined.map((it) => `${it.id} (${it.title})`).join(', ')}. Take the next one (\`${cli} item <id> doing\`), and mark each done when it lands.` });
      }
    }
    // Only blocks someone else reserved for it (the person giving it one), never its own reservations (B28).
    const blocks = a.held.filter((b) => (state.blocks[b]?.since || 0) > since && state.blocks[b]?.by !== id);
    if (blocks.length) reasons.push({ kind: 'blocks', text: `The person reserved ${blocks.join(', ')} for you.` });
    let claim = null;
    // Asked to finish and stop (T38): only its messages wake it; no planning nudge, no queued work.
    if (idle && nudgeOn && !a.finishing) {
      if (!memory.nudged.has(id)) reasons.push({ kind: 'nudge', text: `You're idle. First review the board (\`${cli}\`, \`${cli} queue\`, \`${cli} show <block>\`) and propose who takes which open items, yourself included, with \`${cli} suggest <agent>:<item>... --note "why"\`; reserve and reassign nothing yourself.` });
      // Its entry in the board's plan: one per agent, never the same block for two (B13, T53).
      const mine = planned.get(id);
      const next = mine?.entry;
      if (next) {
        const it = next.kind === 'item' ? state.items[next.item] : null;
        const name = blockMeta(state, next.block)?.name || next.block;
        claim = { block: next.block, intent: it ? `${it.id}: ${it.title}` : next.note || '', take: it ? [it.id] : [] };
        // An item typed into Up next has no block yet (B31): the agent files it properly, or returns it to the queue.
        if (it && !next.block) reasons.push({ kind: 'queue', why: mine.why, text: `Then take the person's queued work: ${it.id} (${it.title}) is yours. It has no block yet: file it properly (\`${cli} item ${it.id} --block <block>\`, and \`${cli} task\` or \`${cli} bug\` for more), then do it, or return it to the queue with \`${cli} queue ${it.id}\` and say why with \`${cli} note\`. It came to you because you ${mine.why}.` });
        else reasons.push({ kind: 'queue', why: mine.why, text: `${it ? `Then take the person's queued work: ${it.id} (${it.title}) is yours, with ${name} (${next.block}) reserved for you. \`${cli} show ${next.block}\` has its docs.` : `Then take the person's queued work: ${name} (${next.block}) is reserved for you${next.note ? `, for "${next.note}"` : ''}. \`${cli} show ${next.block}\` lists its items.`} It came to you because you ${mine.why}.` });
      }
    }
    // The person's own Wake with nothing waiting: look at the board and take or suggest work.
    if (!reasons.length && force) reasons.push({ kind: 'person', text: `The person woke you. Look at the board (\`${cli}\`, \`${cli} queue\`) and take what's yours or waiting, or suggest who takes what with \`${cli} suggest\`.` });
    if (!reasons.length) continue;
    plans.push({ agent: id, session: s, reasons, claim });
  }
  return plans;
}

// What a woken session is told: fixed framing around the board's own facts.
export function wakePrompt(plan) {
  return [`QueueBox woke you: something on the board is waiting for you.`, ...plan.reasons.map((r) => `- ${r.text}`), 'Do it the way this repository\'s CLAUDE.md says, then end your turn; the board wakes you again when more comes.'].join('\n');
}

// The wake memory (who was woken when, who was nudged this idle stretch) rebuilt from the log, so a server restart
// doesn't nudge every idle agent again (B29). An agent counts as nudged when its last planning wake came after the
// last time it got work: a block reserved by or for it, or an item given to it or taken up by it.
export function memoryFromLog(events) {
  const woken = new Map();
  const nudgedAt = new Map();
  const workAt = new Map();
  for (const e of events) {
    if (e.type === 'note' && e.wake?.agent) {
      woken.set(e.wake.agent, e.ts);
      if ((e.wake.why || []).includes('nudge')) nudgedAt.set(e.wake.agent, e.ts);
    } else if (e.type === 'block.reserve' && e.mode !== 'watch') {
      workAt.set(typeof e.agent === 'string' ? e.agent : e.by, e.ts);
    } else if (e.type === 'item.update') {
      if (e.assignee) workAt.set(e.assignee, e.ts);
      if (e.status === 'doing' && e.by) workAt.set(e.by, e.ts);
    }
  }
  const nudged = new Set([...nudgedAt].filter(([id, ts]) => ts > (workAt.get(id) || 0)).map(([id]) => id));
  return { woken, nudged };
}
