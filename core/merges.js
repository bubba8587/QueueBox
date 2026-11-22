// Worktrees on the board: which agent works in each, which blocks each changed, and whether each queued
// branch is fit to merge. Pure, so the CLI and the page share it. Runs in Node and the browser.

import { blockForPath } from './glob.js';
import { HUMAN, UNMAPPED, mergeQueue, agentName, worktreeAgentId, isStale } from './model.js';

// The agents working in a worktree, most recently seen first: every present agent that joined from it (one
// checkout can hold several), else the watcher's stand-in (`wt-<name>`), which exists for agents that never
// talk to the board.
// Given a time, one gone quiet past the board's stale limit counts only while it still reserves a block: a crashed
// session never says goodbye, and must not keep the label, take git-seen edits or fail the branch with its last test.
export function agentsInWorktree(state, wt, now) {
  const live = (a) => now === undefined || !isStale(state, a.id, now) || a.held.length > 0;
  const here = Object.values(state.agents)
    .filter((a) => a.id !== HUMAN && !a.leftAt && a.kind !== 'worktree' && (a.worktree === wt.path || a.worktree === wt.name) && live(a))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((a) => a.id);
  if (here.length) return here;
  const standIn = state.agents[worktreeAgentId(wt.name)];
  return standIn && !standIn.leftAt ? [standIn.id] : [];
}

// The worktree's agents by name, for a label: "Bramble", "Bramble, Birch", else the worktree's own name.
export function worktreeLabel(state, wt) {
  const ids = wt.agents || agentsInWorktree(state, wt);
  return ids.length ? ids.map((id) => agentName(state, id)).join(', ') : wt.name;
}

// Which of a worktree's agents changed a block: those whose own edits landed in it, else all of them (git
// saw the change, nobody reported it). One agent alone in a worktree is always the one.
export function agentsInBlock(state, wt, blockId) {
  const ids = wt.agents || agentsInWorktree(state, wt);
  if (ids.length < 2) return ids;
  const b = state.blocks[blockId];
  const touched = new Set((b?.touches || []).filter((t) => t.op !== 'read').map((t) => t.agent));
  const mine = ids.filter((id) => touched.has(id));
  return mine.length ? mine : ids;
}

export function blocksOf(state, wt) {
  const out = new Map();
  for (const f of wt.files || []) {
    const id = blockForPath(state.index, f) || UNMAPPED;
    out.set(id, (out.get(id) || 0) + 1);
  }
  return out;
}

// What hasn't landed, per block (T61): each agent's lines there and files, its stage (the least landed of its files:
// uncommitted, then committed, then queued to merge when its worktree is in the merge queue), the block's total, and
// the files two or more agents changed (an overlap; a real conflict is the forecast's). Every checkout counts, the
// main one included; a file in a shared checkout is its last editor's, '' when nobody is known.
const STAGE_RANK = { uncommitted: 0, committed: 1, queued: 2 };
export function changesByBlock(state, snap) {
  const out = new Map();
  for (const wt of snap?.list || []) {
    const queued = state.merges?.[wt.name]?.status === 'ready';
    for (const c of wt.changes || []) {
      const id = blockForPath(state.index, c.file) || UNMAPPED;
      if (!out.has(id)) out.set(id, { add: 0, del: 0, agents: new Map(), byFile: new Map() });
      const blk = out.get(id);
      const who = c.agent || '';
      const stage = c.stage === 'committed' && queued ? 'queued' : c.stage;
      if (!blk.agents.has(who)) blk.agents.set(who, { agent: who, add: 0, del: 0, stage, files: [] });
      const a = blk.agents.get(who);
      a.add += c.add;
      a.del += c.del;
      if (STAGE_RANK[stage] < STAGE_RANK[a.stage]) a.stage = stage;
      a.files.push({ file: c.file, add: c.add, del: c.del, stage, worktree: wt.name });
      blk.add += c.add;
      blk.del += c.del;
      if (!blk.byFile.has(c.file)) blk.byFile.set(c.file, new Set());
      blk.byFile.get(c.file).add(who);
    }
  }
  for (const blk of out.values()) {
    blk.overlap = [...blk.byFile].filter(([, who]) => who.size > 1).map(([f]) => f);
    blk.agents = [...blk.agents.values()].sort((x, y) => y.add + y.del - (x.add + x.del));
    delete blk.byFile;
  }
  return out;
}

// Agent id to the blocks its worktree's branch changes (not the main checkout), for queuePlan's branch signal.
export function branchBlocks(state, snap) {
  const out = new Map();
  for (const wt of snap?.list || []) {
    if (wt.main) continue;
    const blocks = [...blocksOf(state, wt).keys()];
    for (const id of wt.agents || agentsInWorktree(state, wt)) {
      if (!out.has(id)) out.set(id, new Set());
      for (const b of blocks) out.get(id).add(b);
    }
  }
  return out;
}

// Block id to the worktrees (other than the main checkout) that changed something in it.
export function worktreesByBlock(state, snap) {
  const out = new Map();
  for (const wt of snap?.list || []) {
    if (wt.main) continue;
    for (const id of blocksOf(state, wt).keys()) {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(wt.name);
    }
  }
  return out;
}

// danger: the merge would fail or break things. warn: it needs a step first. info: worth knowing.
const RANK = { ok: 0, info: 1, warn: 2, danger: 3 };

// Each queued branch with the checks a merge would care about, worst first, and a one-word-ish verdict.
// Overlaps count against branches ahead in the queue: those land first and will move the files under it.
export function mergeChecks(state, snap, now) {
  const byName = new Map((snap?.list || []).map((wt) => [wt.name, wt]));
  const base = snap?.base || 'base';
  const clashes = snap?.clashes || [];
  const label = (name) => {
    const wt = byName.get(name);
    return wt ? worktreeLabel(state, wt) : name;
  };
  const ahead = [];
  return mergeQueue(state, now).map((m) => {
    if (m.status === 'landed') return { entry: m, wt: byName.get(m.worktree) || null, checks: [], level: 'ok', verdict: 'Merged', label: m.agent && state.agents[m.agent] ? agentName(state, m.agent) : label(m.worktree) };
    const wt = byName.get(m.worktree) || null;
    const checks = [];
    if (!wt) checks.push({ level: 'danger', text: 'Worktree gone' });
    else {
      if (wt.conflicts.length) checks.push({ level: 'danger', text: `Conflicts with ${base}`, files: wt.conflicts });
      for (const prev of ahead) {
        const clash = clashes.find((c) => (c.a === prev.name && c.b === wt.name) || (c.b === prev.name && c.a === wt.name));
        if (clash) checks.push({ level: 'danger', text: `Conflicts with ${label(prev.name)}`, files: clash.files, with: prev.name });
        else {
          const shared = prev.files.filter((f) => wt.files.includes(f));
          if (shared.length) checks.push({ level: 'info', text: `Shares files with ${label(prev.name)}`, files: shared });
        }
      }
      // Several agents in one worktree: any of them failing its last run fails the branch.
      const tests = (wt.agents || agentsInWorktree(state, wt, now)).map((id) => state.agents[id]?.lastTest).filter(Boolean);
      const failing = tests.find((t) => !t.ok);
      const test = failing || tests[0] || null;
      if (failing) checks.push({ level: 'danger', text: 'Tests fail', detail: failing.summary });
      if (!wt.conflicts.length && wt.behind) checks.push({ level: 'warn', text: `${wt.behind} behind ${base}`, action: 'rebase' });
      if (m.commit && wt.head && !wt.head.startsWith(m.commit) && !m.commit.startsWith(wt.head)) checks.push({ level: 'warn', text: 'Moved since ready' });
      if (wt.ahead === 0) checks.push({ level: 'info', text: 'Nothing to merge' });
      if (wt.dirty) checks.push({ level: 'info', text: `${wt.dirty} uncommitted` });
      if (!test) checks.push({ level: 'info', text: 'No test run' });
      ahead.push({ name: wt.name, files: wt.files });
    }
    checks.sort((a, b) => RANK[b.level] - RANK[a.level]);
    const top = checks[0];
    const level = !top || top.level === 'info' ? 'ok' : top.level;
    return { entry: m, wt, checks, level, verdict: level === 'ok' ? (top ? `Ready, ${top.text.toLowerCase()}` : 'Ready') : top.text, label: label(m.worktree) };
  });
}

export function mergeCommand(entry, base) {
  return `git merge --no-ff ${entry.branch || entry.worktree}${base ? `  # into ${base}` : ''}`;
}

