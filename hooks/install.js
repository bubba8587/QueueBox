// Wires the QueueBox hooks into a project's .claude/settings.local.json (per machine, ignored by
// git), or takes them out. Entries are recognized by the script path, so install is idempotent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-code.js');
const EVENTS = {
  SessionStart: null,
  UserPromptSubmit: null,
  // Edits for the guard; the rest only move the agent's activity tag (reading, testing, researching...).
  PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob|Bash|WebFetch|WebSearch|Agent|Task',
  PostToolUse: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task',
  // A background subagent's end, for the compact row in its parent's window (its start is PreToolUse on Agent).
  SubagentStop: null,
  Notification: null,
  Stop: null,
  SessionEnd: null,
};

// QueueBox lives outside the host repository, so the hook names its script by absolute path: a path relative to
// the project would break in a worktree, which sits at a different depth.
export function hookConfig() {
  const command = `node "${SCRIPT.split(path.sep).join('/')}"`;
  const hooks = {};
  for (const [event, matcher] of Object.entries(EVENTS)) {
    hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  return { hooks };
}

// Ours is this very script, by its absolute path, or one by either name of the tool: the folder isn't renamed with
// it, so matching a name alone installed a fresh copy on every run (B18).
const SCRIPT_POSIX = SCRIPT.split(path.sep).join('/');
const ours = (entry) => (entry.hooks || []).some((x) => {
  const cmd = String(x.command || '');
  return cmd.includes(SCRIPT_POSIX) || /(blockmap|queuebox)\/hooks\/claude-code\.js/.test(cmd);
});

export function hooksInstalled(root) {
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8')).hooks || {};
    return Object.keys(EVENTS).every((e) => (hooks[e] || []).some(ours));
  } catch {
    return false;
  }
}

export function installHooks(root, action = 'print') {
  const file = path.join(root, '.claude', 'settings.local.json');
  const config = hookConfig();
  if (action === 'print') {
    return { message: `Add this to .claude/settings.local.json (or run \`qb hooks install\`):\n${JSON.stringify(config, null, 2)}`, config };
  }
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No local settings yet.
  }
  settings.hooks ||= {};
  // Every event, not only the ones listed now: an event QueueBox stopped using must not keep calling it.
  for (const event of new Set([...Object.keys(settings.hooks), ...Object.keys(EVENTS)])) {
    const kept = (settings.hooks[event] || []).filter((e) => !ours(e));
    if (action === 'install' && config.hooks[event]) kept.push(...config.hooks[event]);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return {
    message:
      action === 'install'
        ? `Installed the QueueBox hooks in ${path.relative(root, file)}. New Claude Code sessions here join the board; \`QUEUEBOX=off\` turns them off for one session, \`qb hooks uninstall\` for good.`
        : `Removed the QueueBox hooks from ${path.relative(root, file)}.`,
    file,
  };
}
