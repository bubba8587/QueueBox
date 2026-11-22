#!/usr/bin/env node
// Claude Code hooks for QueueBox. One script for every hook event; it reads the hook's JSON on
// stdin. It fails open: if anything here breaks, the tool call goes ahead as if QueueBox weren't
// installed. `qb hooks install` wires it into .claude/settings.local.json.
//
//   SessionStart       join the board, hand the agent a short briefing
//   UserPromptSubmit   mark the agent working, deliver the human's messages
//   PreToolUse         an edit inside another agent's (or the human's, or a frozen) block is refused
//                      with the reason; an edit in a free block reserves it, per the board's guard
//   PostToolUse        record the edit or the command, guess test results, deliver messages
//   Notification       a permission prompt or a long wait: the agent needs the human
//   Stop               the turn ended: the agent waits for the human's next prompt
//   SessionEnd         leave the board, releasing what the agent held

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, findBoardDir } from '../core/store.js';
import { makeEvent, blockMeta, agentName, isStale, clock, itemCounts, queueEntries, HUMAN } from '../core/model.js';
import { blockForPath, normalizePath } from '../core/glob.js';
import { sessionAgentId, whereAmI, worktreeHere } from '../core/identity.js';
import { lineCounts, testVerdict } from './lines.js';
import { dirtySnapshot, editedBetween, saveSnapshot, takeSnapshot } from './bashedits.js';
import { ensureServer } from '../core/daemon.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// What a tool says the agent is doing this second. Tools not named here leave the tag as it was.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
function activityFor(tool, toolInput) {
  if (READ_TOOLS.has(tool)) return 'reading';
  if (EDIT_TOOLS.has(tool)) return 'editing';
  if (tool === 'Bash') return TEST_CMD.test(String(toolInput?.command || '')) ? 'testing' : 'running';
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'researching';
  if (tool === 'Agent' || tool === 'Task') return 'delegating';
  return null;
}
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const TEST_CMD = /\b(vitest|jest|mocha|pytest|cargo (nextest|test)|npm (run )?test|go test|node --test|test-bucket|cargo-test)\b/;
// QueueBox lives in its own folder, outside the host repository: name its `qb` by absolute path.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'qb');

async function main() {
  if (process.env.QUEUEBOX === 'off') return;
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  const cwd = input.cwd || process.cwd();
  const dir = findBoardDir(cwd);
  if (!dir) return;
  // An opt-in trace of what Claude Code hands the hook: only while .queuebox/live/hook-trace.jsonl exists (create it
  // to start, delete it to stop). For checking undocumented fields; the folder is ignored by git.
  try {
    const trace = path.join(dir, 'live', 'hook-trace.jsonl');
    if (fs.existsSync(trace)) fs.appendFileSync(trace, JSON.stringify(input) + '\n');
  } catch {
    // A trace is never worth failing a hook over.
  }
  const store = openStore(dir, { cwd });
  const me = process.env.QUEUEBOX_AGENT || sessionAgentId(input.session_id || process.env.CLAUDE_CODE_SESSION_ID || 'session');
  const board = store.board();
  const guard = { held: 'deny', frozen: 'deny', free: 'reserve', ...(board.guard || {}) };
  const now = Date.now();
  // One fold per call: the store keeps it current, and each commit only reads what was appended since.
  let state = store.state();
  const cli = CLI;

  // Commits the events and returns null, or the reason they were refused. Any other failure is logged and
  // the hook carries on, failing open.
  const commit = (events) => {
    if (!events.length) return null;
    try {
      state = store.commit(events, now).state;
      return null;
    } catch (err) {
      if (err.refused) return err.message;
      logError(store.live, err);
      return null;
    }
  };
  const ev = (type, payload) => makeEvent(state, type, me, payload, now);
  const joined = () => {
    const a = state.agents[me];
    return a && !a.leftAt && a.joinedAt;
  };
  // Under `qb run` the session sits in a terminal QueueBox can type into; the board learns its socket here.
  const pty = process.env.QUEUEBOX_PTY || '';
  const ensureJoined = () => {
    if (joined()) return state.agents[me].pty === pty ? [] : [ev('agent.join', { agent: { id: me, pty } })];
    return [ev('agent.join', { agent: { id: me, kind: 'Claude Code', where: whereAmI(cwd), worktree: worktreeHere(cwd)?.path || '', model: process.env.QUEUEBOX_MODEL || '', pty }, task: '' })];
  };

  // An agent that has just gone idle (nothing reserved, nothing assigned, no question of its own) is kept going
  // once, to review the board and suggest who takes what, unless the person turned it off, the person's own
  // prompt started this turn, or this turn was already a nudge.
  switch (input.hook_event_name) {
    case 'SessionStart': {
      commit(ensureJoined());
      // The board comes up with the first session, so the human never has to start it (QUEUEBOX_SERVE=off doesn't).
      let url = null;
      if (process.env.QUEUEBOX_SERVE !== 'off') {
        try {
          url = (await ensureServer(dir, { wait: false })).url;
        } catch (err) {
          logError(store.live, err);
        }
      }
      return context('SessionStart', briefing(state, me, now, cli) + (url ? `\nThe human watches the board at ${url}; mention it if they ask where to see what agents are doing.` : ''));
    }

    case 'UserPromptSubmit': {
      const a = state.agents[me];
      const events = [...ensureJoined()];
      // The newest prompt is the task line now (B8), unless it says nothing a person would read as a task.
      const task = promptTask(input.prompt);
      events.push(ev('agent.status', { auto: true, status: 'working', activity: 'thinking', doing: 'Reading the prompt', ...(task ? { task } : {}) }));
      commit(events);
      return context('UserPromptSubmit', inboxText(state, me, commit, ev));
    }

    case 'PreToolUse': {
      // The activity tag moves only when it changes, so a run of reads is one event. An edit's tag rides on
      // PostToolUse's status, so nothing here touches the board before the guard has read it.
      // A subagent's own calls carry its agent_id and the parent's session: they are the parent's work (its
      // reservations guard them), but they don't move the parent's tag, which stays on delegating.
      const tag = EDIT_TOOLS.has(input.tool_name) || input.agent_id ? null : activityFor(input.tool_name, input.tool_input);
      const self = state.agents[me];
      if (tag && joined() && (self.activity?.tag !== tag || self.status !== 'working')) commit([ev('agent.status', { auto: true, status: 'working', activity: tag })]);
      // A subagent starting: its row in this agent's window, keyed by the spawning call.
      if (SUBAGENT_TOOLS.has(input.tool_name) && input.tool_use_id && joined()) {
        const desc = String(input.tool_input?.description || input.tool_input?.subagent_type || 'Subagent').replace(/\s+/g, ' ').trim().slice(0, 120);
        commit([ev('agent.sub', { sub: input.tool_use_id, desc, kind: String(input.tool_input?.subagent_type || '').slice(0, 60), state: 'running' })]);
      }
      // A command can edit files without saying which (B30): note what git sees changed now, to compare afterwards.
      if (input.tool_name === 'Bash' && input.tool_use_id && joined()) {
        const snap = dirtySnapshot(cwd);
        if (snap) saveSnapshot(path.dirname(store.eventsPath), input.tool_use_id, snap);
      }
      if (!EDIT_TOOLS.has(input.tool_name)) return undefined;
      const file = relFile(store.root, input.tool_input?.file_path || input.tool_input?.notebook_path);
      if (!file) return undefined;
      const id = blockForPath(state.index, file);
      if (!id) return undefined;
      const b = state.blocks[id];
      const meta = blockMeta(state, id);
      // Frozen comes first: a freeze stops the holder too.
      if (b.frozen && guard.frozen !== 'allow') {
        return decide(guard.frozen, `${file} is in ${meta.name}, which ${agentName(state, b.frozen.by)} froze${b.frozen.note ? ` (${b.frozen.note})` : ''}. Don't edit there until it's unfrozen; pick other work or ask with \`${cli} ask "…"\`.`);
      }
      if (b.holder === me) return undefined;
      if (b.holder && (b.holder === HUMAN || !isStale(state, b.holder, now)) && guard.held !== 'allow') {
        const who = b.holder === HUMAN ? `${agentName(state, HUMAN)} (the human)` : agentName(state, b.holder);
        return decide(
          guard.held,
          `${file} is in ${meta.name}, reserved by ${who} since ${clock(b.since)}${b.intent ? ` for "${b.intent}"` : ''}. Leave it to them: work elsewhere, message them (\`${cli} msg ${b.holder === HUMAN ? 'human' : agentName(state, b.holder)} "…"\`), or ask the human to move the block to you.`,
        );
      }
      if (guard.free === 'deny') return decide('deny', `${file} is in ${meta.name}, which you haven't reserved. Reserve it first: \`${cli} reserve ${id} --for "<what you'll do>"\`.`);
      if (guard.free === 'reserve') {
        const a = state.agents[me];
        const takeover = b.holder ? ` (taking over from ${agentName(state, b.holder)}, quiet since ${clock(state.agents[b.holder]?.lastSeen || b.since)})` : '';
        const refused = commit([...ensureJoined(), ev('block.reserve', { auto: true, block: id, take: [], intent: a?.task || `editing ${path.basename(file)}` })]);
        if (refused) {
          // Another agent reserved it (or the human froze it) since this hook read the board: the edit waits.
          // Any other refusal (a bad agent id, say) is the board's problem, and the hooks fail open.
          const now = store.state().blocks[id];
          if (now?.frozen) return decide(guard.frozen, `${file} is in ${meta.name}, which was frozen before QueueBox could reserve it for you. ${refused}`);
          if (now?.holder && now.holder !== me) return decide(guard.held, `${file} is in ${meta.name}, which was taken before QueueBox could reserve it for you. ${refused}`);
          return undefined;
        }
        if (state.blocks[id].holder === me) {
          const c = itemCounts(state, id);
          const open = [c.bug && `${c.bug} open bug${c.bug > 1 ? 's' : ''}`, c.task && `${c.task} open task${c.task > 1 ? 's' : ''}`, c.decision && `${c.decision} waiting on the human`].filter(Boolean).join(', ');
          note(store, me, `QueueBox reserved ${meta.name} (${id}) for you${takeover}, since you're editing ${file}.${meta.docs?.length ? ` Read before changing it: ${meta.docs.join(', ')}.` : ''}${open ? ` Open there: ${open} (\`${cli} show ${id}\`).` : ''} Release it when the work lands: \`${cli} release ${id} --landed\`.`);
        }
      }
      return undefined;
    }

    case 'PostToolUse': {
      const events = [];
      if (EDIT_TOOLS.has(input.tool_name)) {
        const file = relFile(store.root, input.tool_input?.file_path || input.tool_input?.notebook_path);
        if (file) {
          events.push(ev('touch', { files: [file], op: 'edit', ...lineCounts(input.tool_name, input.tool_input, input.tool_response) }));
          events.push(ev('agent.status', { auto: true, status: 'working', activity: 'editing', doing: `Editing ${file}` }));
        }
      } else if (SUBAGENT_TOOLS.has(input.tool_name) && input.tool_use_id) {
        // The spawning call returned: a foreground subagent is done (or failed: the response is then the error
        // text); one sent to the background has only launched, and its row ends at SubagentStop.
        const r = input.tool_response;
        const aid = r && typeof r === 'object' && typeof r.agentId === 'string' ? r.agentId : undefined;
        const outcome = !r || typeof r === 'string' ? 'failed' : r.status === 'async_launched' ? 'running' : r.status === 'completed' || r.status === undefined ? 'done' : 'failed';
        events.push(ev('agent.sub', { sub: input.tool_use_id, ...(aid ? { aid } : {}), state: outcome }));
      } else if (input.tool_name === 'Bash') {
        const cmd = String(input.tool_input?.command || '').replace(/\s+/g, ' ').trim();
        if (cmd) {
          events.push(ev('touch', { op: 'run', cmd: cmd.slice(0, 140) }));
          // The files it edited, from git before and after (B30): they are this agent's edits like any other.
          const before = input.tool_use_id ? takeSnapshot(path.dirname(store.eventsPath), input.tool_use_id) : null;
          // In a shared checkout another agent may have saved a file meanwhile, so a file in a block someone else
          // reserves is left to them: the edit tools' own guard still catches a real trespass.
          const theirs = (f) => {
            const holder = state.blocks[blockForPath(state.index, f)]?.holder;
            return holder && holder !== me;
          };
          const edited = before ? editedBetween(before, dirtySnapshot(cwd)).map((f) => normalizePath(f)).filter((f) => !theirs(f)) : [];
          if (edited.length) events.push(ev('touch', { files: edited.slice(0, 200), op: 'edit', src: 'bash' }));
          const verdict = TEST_CMD.test(cmd) ? testVerdict(input.tool_response) : null;
          if (verdict) events.push(ev('test', verdict));
        }
      }
      if (events.length) commit([...ensureJoined(), ...events]);
      const parts = [takeNotes(store, me), inboxText(state, me, commit, ev)].filter(Boolean);
      return parts.length ? context('PostToolUse', parts.join('\n\n')) : undefined;
    }

    case 'SubagentStop': {
      // A background subagent ending. Claude Code doesn't say whether it went well, so it is done; one that ran in
      // the foreground already ended when its call returned.
      const s = input.agent_id ? state.agents[me]?.subs?.find((x) => x.aid === input.agent_id) : null;
      if (s && s.state === 'running') commit([ev('agent.sub', { aid: input.agent_id, state: 'done' })]);
      return undefined;
    }

    case 'Notification': {
      // A permission prompt (it names a tool) needs the person. Claude Code's other notice, that it has sat waiting
      // for input, only says the turn is over: the agent is idle, which the board manages, not Needs you (B11).
      const message = String(input.message || '').trim();
      if (!joined()) return undefined;
      if (/permission/i.test(message)) commit([ev('agent.status', { auto: true, urgent: true, status: 'waiting', activity: 'permission', doing: message })]);
      else if (state.agents[me].status !== 'review' || state.agents[me].activity) commit([ev('agent.status', { auto: true, status: 'review', activity: '' })]);
      return undefined;
    }

    case 'Stop': {
      // The turn ended: it's the person's turn. Waking an idle agent is the board's job (server.js), not a hold here.
      const a = state.agents[me];
      if (!a || a.leftAt) return undefined;
      // Its last message goes on the board, so the person can read it there instead of finding the terminal (B12).
      const last = lastAssistantText(input.transcript_path);
      if (a.status !== 'review' || a.activity || last) commit([ev('agent.status', { auto: true, status: 'review', activity: '', doing: 'Finished the turn', ...(last ? { last } : {}) })]);
      return undefined;
    }

    case 'SessionEnd': {
      if (joined()) commit([ev('agent.leave', { note: input.reason ? `session ended (${input.reason})` : 'session ended' })]);
      return undefined;
    }

    default:
      return undefined;
  }
}

function briefing(state, me, now, cli) {
  const a = state.agents[me];
  const others = Object.values(state.agents).filter((x) => x.id !== me && x.id !== HUMAN && !x.leftAt && !isStale(state, x.id, now));
  const lines = [
    `QueueBox: you are ${a.name} (${me}) on the ${state.board.name} board, where the human watches which agent works in which block of the repository.`,
    `Editing a file in a free block reserves that block for you; editing inside a block another agent or the human has reserved is refused. Release blocks when the work lands: \`${cli} release --landed\`. Say what you're doing with \`${cli} doing "…"\`, file bugs with \`${cli} bug "…"\`, ask the human with \`${cli} ask "…"\`. \`${cli} help\` lists the rest.`,
  ];
  if (others.length) lines.push(`Working now: ${others.map((x) => `${x.name} has ${x.held.length ? `reserved ${x.held.join(', ')}` : 'nothing reserved'}${x.task ? ` (${x.task})` : ''}`).join('; ')}.`);
  const human = state.agents[HUMAN];
  if (human.held.length) lines.push(`The human has reserved ${human.held.join(', ')}: stay out.`);
  const frozen = Object.values(state.blocks).filter((b) => b.frozen);
  if (frozen.length) lines.push(`Frozen: ${frozen.map((b) => b.id).join(', ')}.`);
  const q = queueEntries(state);
  if (q.length) lines.push(`The human's queue: ${q.slice(0, 8).map((e) => (e.kind === 'item' ? `${e.item}${e.block ? ` in ${e.block}` : ', no block yet'}` : `${e.block}${e.note ? ` ("${e.note}")` : ''}`)).join(', ')}${q.length > 8 ? ` and ${q.length - 8} more` : ''}. \`${cli} next\` takes the first you can.`);
  if (a.held.length) lines.push(`You still have ${a.held.join(', ')} reserved from earlier.`);
  return lines.join('\n');
}

function inboxText(state, me, commit, ev) {
  const a = state.agents[me];
  if (!a?.inbox.length) return '';
  const msgs = a.inbox.map((m) => `- ${clock(m.ts)} ${agentName(state, m.from)}: ${m.text}`);
  commit([ev('msg.read', { ids: a.inbox.map((m) => m.id) })]);
  return `Messages on the QueueBox board for you:\n${msgs.join('\n')}`;
}

// Notes the PreToolUse hook leaves for the PostToolUse hook to say, so they reach the agent as context.
// A prompt's task line: its first line with words in it. A teammate's message is unwrapped to its text; a system
// reminder, a background task's notice, or a poke with no words ("." to nudge the agent) gives none.
function promptTask(prompt) {
  let text = String(prompt || '');
  if (/^\s*<(system-reminder|task-notification|scheduled-task|wakeup)\b/i.test(text)) return '';
  // The board's own wake prompt (core/launch.js wakePrompt) says what is waiting, not what the agent is on (B34).
  if (/^\s*QueueBox woke you\b/.test(text)) return '';
  const wrapped = /^\s*<cross-session-message\b[^>]*>([\s\S]*?)(<\/cross-session-message>|$)/i.exec(text);
  if (wrapped) text = wrapped[1];
  const line = text.split('\n').map((l) => l.trim()).find((l) => /[\p{L}\p{N}]{2,}/u.test(l)) || '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

// The text of the last assistant message in a Claude Code transcript (JSONL), from its tail, or ''. Up to 8000
// characters, keeping the end.
function lastAssistantText(file) {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 512 * 1024);
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry?.type !== 'assistant' || entry.isSidechain) continue;
      const content = entry.message?.content;
      const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '').trim();
      if (text) return text.length > 8000 ? `…${text.slice(-7999)}` : text;
    }
  } catch {
    // No transcript to read: nothing to post.
  }
  return '';
}

function notesPath(store, me) {
  return path.join(store.live, 'hooks', `${me}.json`);
}
function note(store, me, text) {
  const p = notesPath(store, me);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // First note.
  }
  list.push(text);
  fs.writeFileSync(p, JSON.stringify(list));
}
function takeNotes(store, me) {
  const p = notesPath(store, me);
  try {
    const list = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.rmSync(p, { force: true });
    return list.join('\n');
  } catch {
    return '';
  }
}

function relFile(root, file) {
  if (!file) return null;
  const abs = path.resolve(file);
  if (!abs.startsWith(root + path.sep)) return null;
  return normalizePath(path.relative(root, abs));
}

function context(hookEventName, text) {
  if (!text) return undefined;
  return { hookSpecificOutput: { hookEventName, additionalContext: text } };
}

function decide(mode, reason) {
  if (mode === 'warn' || mode === 'allow') return undefined;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: mode === 'ask' ? 'ask' : 'deny', permissionDecisionReason: `QueueBox: ${reason}` } };
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function logError(live, err) {
  try {
    fs.mkdirSync(live, { recursive: true });
    fs.appendFileSync(path.join(live, 'hook-errors.log'), `${new Date().toISOString()} ${err.stack || err}\n`);
  } catch {
    // Nowhere to log; fail open regardless.
  }
}

main()
  .then((out) => {
    if (out) process.stdout.write(JSON.stringify(out));
  })
  .catch((err) => {
    try {
      const dir = findBoardDir(process.cwd());
      if (dir) logError(openStore(dir).live, err);
    } catch {
      // Nowhere to log; fail open regardless.
    }
  })
  .finally(() => process.exit(0));
