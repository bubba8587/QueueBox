// Which files a Bash command edited (B30). The hooks see Edit and Write by their inputs, but a command (sed, a script,
// a heredoc) edits files without saying so. PreToolUse snapshots the files git sees as changed or new, with their
// modification times; PostToolUse snapshots again, and a file that is new to the list or whose time moved was edited by
// that command. Read without git's index lock (--no-optional-locks), so the agent's own git commands never collide.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseStatus } from '../core/worktrees.js';

const GIT = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024, timeout: 4000 };

// { root, files: { path: mtimeMs, or -1 when gone } }, or null outside a git checkout.
export function dirtySnapshot(cwd) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { ...GIT, cwd }).trim();
    const out = execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', 'status', '--porcelain', '-z', '--untracked-files=all'], { ...GIT, cwd: root });
    const files = {};
    for (const e of parseStatus(out)) {
      // The board's own live folder is the board writing, not the agent.
      if (e.path.startsWith('.queuebox/live/')) continue;
      let m = -1;
      try {
        m = fs.statSync(path.join(root, e.path)).mtimeMs;
      } catch {
        // Deleted: it stays -1.
      }
      files[e.path] = m;
    }
    return { root, files };
  } catch {
    return null;
  }
}

// The files edited between two snapshots of the same checkout.
export function editedBetween(before, after) {
  if (!before || !after || before.root !== after.root) return [];
  return Object.entries(after.files)
    .filter(([f, m]) => before.files[f] === undefined || before.files[f] !== m)
    .map(([f]) => f);
}

// Snapshots wait between the two hooks in the live folder, one per tool call; any left behind an hour are dropped.
export function saveSnapshot(liveDir, id, snap) {
  const dir = path.join(liveDir, 'bash');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { force: true });
    }
    fs.writeFileSync(path.join(dir, `${safe(id)}.json`), JSON.stringify(snap));
  } catch {
    // Without a snapshot this command's edits just aren't seen.
  }
}

export function takeSnapshot(liveDir, id) {
  const p = path.join(liveDir, 'bash', `${safe(id)}.json`);
  try {
    const snap = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.rmSync(p, { force: true });
    return snap;
  } catch {
    return null;
  }
}

const safe = (id) => String(id).replace(/[^\w.-]/g, '_').slice(0, 120);
