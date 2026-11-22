# QueueBox reference

The details behind the README: how agents take part, the board file, the model, worktrees and the merge queue. The rules the code keeps are in `specs/` (`coordination.md`, `page.md`, `glossary.md`).

## Commands

`qb up` draws a first board from your folders if the repository has none, hooks up Claude Code so every session started there joins the board on its own, starts the board's server in the background and opens it in your browser. Run it again any time; it only does what's missing. Once it's set up you don't even need `qb up`: the first Claude Code session in the repository starts the board if it isn't running. `qb down` stops it.

Each repository gets its own board and port (4477, then 4478, …). Other commands:

```
qb                       # who has reserved what, in the terminal
qb snapshot --out <dir>  # a standalone page of this session, to share or look back at
qb help                  # everything else
```

A snapshot needs no server: serve its folder with any static server and the page replays the session, read-only. To try the board without a session of your own, `node scripts/smoke.js --keep` serves a throwaway board seeded from a recorded session (`test/fixtures/`).

## The first board

`qb up` drafts a board from your folders the first time (`qb init` does only that): each top-level folder becomes a district, and a folder becomes a block once it holds few enough files. It's a starting point. A good block is a piece of work one agent can own at a time: a subsystem, a feature, the docs. Reshape it from the page (right-click a tile or a district's name: Split, Dissolve, drag a block to another district) or from the terminal:

```
qb board split <block>                       # its folders become sub-blocks
qb board join <a> <b> --into <id>            # several blocks become one
qb board move <block> <district>
qb board rename <block|district> "New name"
```

or edit `.queuebox/board.json` by hand: districts, and blocks with `paths` (globs; the most specific pattern wins a file). Commit it: the board is part of the repository. Every file the board doesn't claim shows as Unmapped.

## The page

- **The map.** Districts of tiles on a dot-grid canvas, every tile one size. The districts are packed into shelves (which districts share a row, and how many tiles tall each row is, chosen together for the least height), so the whole repository fits a laptop screen at full size. Drag the empty canvas to pan; the wheel zooms at the cursor (a trackpad's scroll and pinch too), in 10% steps; the + and − buttons zoom by 40%, and Fit frames the whole map. Where you're looking is yours, kept in the browser. Drag a district by its name to place it, and Tidy (T) packs the shelves again; Undo on the toast, or Ctrl+Z, puts a moved district or a Tidy back. A district's chevron folds it to one card, on your screen only, and right-click on a tile or a district's label for Details, Split or Dissolve. A tile shows what is live, a conflict (an edit inside a block someone else has reserved, or a merge git says will conflict), a failing test, branches that changed it, a lock when frozen, and its open items: bugs in red, your calls in gold, tasks plain. A reserved block leaves a hatched socket with the name of whoever reserved it and for how long. **Active** hides every block with nothing going on.
- **Needs you.** The top of the side column is an inbox, one row per thing that waits on you, each with its act: an agent's question (answer it there), a permission prompt or a finished turn (Go focuses its worktree and window), the merge queue's head when it's clean (Merge copies the command) or broken (Ask To Fix messages its agent). The top bar's count is this list's.
- **Up next** is the team's queue, no one's: a block queued there goes to the next free agent (`qb next`). Your own window shows only while you keep blocks for yourself, which is always an explicit act (**Keep Agents Out**), never a drop or a default.
- **Agent windows.** One per agent: a disc in its color (the disc its sockets carry), the lines its worktree changed against the base, its state as a word with a colored dot and a live timer (a stopwatch while it works), its task, what it's doing this second, and the tray of blocks it has reserved. The chevron opens its recent actions and a message box. Five agents or more turn the column into a roster of one-line windows. A session silent for six hours holding nothing drops off.
- **A tether** runs from a socket to its holder's window when you point at the agent (its window, a socket or a tile).
- **The timeline** has a lane per agent: the blocks it reserved (hatched while still reserved), a cross for a failing test and a diamond for a question. Drag across it, or press play (quiet stretches are skipped), to replay the board; the map is framed and the top bar says the time while you do. It folds away.
- **Attention:** the tab title carries the inbox count, Settings turns on desktop notifications, and coming back to the tab after a few minutes shows one line of what changed, with a replay from when you left.
- **Lenses:** every lens shows each block's open items (bugs, tasks, your calls). Work; Heat (each tile tinted in the color of whoever edited there last, at three strengths by how much and how lately, discs for who passed through); Changes (what hasn't landed: unchanged blocks fade, and a changed tile carries its lines, +84 −12, and a bar with one segment per agent, as wide as its lines, hollow while uncommitted, solid once committed, checked once queued to merge, with red seams where two agents changed the same files; the main checkout counts too).
- **Search** finds blocks by name; a file path finds the block that owns it.
- **Alerts** sit in one strip: edits inside someone else's (or a frozen) block, a holder gone quiet, failing tests.

**Color says who; neutral says where.** The look is Solenoid's palette system, from the theme kit (`ui/theme/`, see `ui/theme/README.md`): the nine palettes and Custom, the neutral ramp per theme and the chrome derived from it, the accent you pick with the paintbrush, the accent-mix rungs, the rule that a strong colored edge always has a tinted inside. The gear opens Settings: the palette, Edit custom…, the accent, and the board's switches (desktop notifications, active blocks only). Agents are colored by palette slot (sky, violet, pink, blue, purple first, so no agent looks like a status), and a palette change recolors them. The only other hues are the status slots: vermilion for bugs, failing tests and conflicts, gold for what needs you, green for working and passing. Status text stays neutral beside a colored dot, so nothing depends on reading a colored word. Timers read in compact units (`47s`, `12m`, `1h 05m`) and grow a gold, then vermilion, dot at named thresholds.

Drag a tile into an agent's window to give it the block (the agent is messaged), into **Up next** to queue it for the next free agent, or back onto the map to release it. To keep agents out of a block yourself, choose **Keep Agents Out** in its menu (right-click the tile) or last in **Give To**. On a phone, long-press to drag, or tap a block and use **Give To** in its details. The **Items** button in the top bar opens a column left of the map with every open item on the board, newest first, each with Queue and a button for its block. The same column (a sheet on a phone) opens when you pick a block and shows that block: its state, its items, who changed it and where; it also files bugs and tasks, changes an item's status, freezes a block, and lists the specs to read before touching it. **New Item** in the top bar (or N) files a bug or task from anywhere, in the block its title names or the one you pick. Answer an agent's question in the inbox; the answer lands in its inbox on the board.

## The agent side

Agents use the `qb` command line (`qb <command>`), or, in Claude Code, nothing at all once the hooks are installed:

| Hook | What it does |
|---|---|
| SessionStart | joins the board and briefs the agent: who has reserved what, the queue, frozen blocks, the commands |
| UserPromptSubmit | marks the agent working, delivers your messages |
| PreToolUse (edits) | **refuses** an edit inside a block another agent or you have reserved, or a frozen one, and says why and what to do instead; an edit in a free block **reserves** it |
| PostToolUse | records the edit or the command, and the files a command edited (what git sees change across it, except in a block someone else has reserved); reads a test runner's output for pass or fail; tells the agent which specs govern a block it just reserved; delivers messages |
| Notification | a permission prompt or a long wait: the agent needs you |
| Stop | the turn ended, so it's your turn. The hook holds nothing: an idle agent is the board's to wake (see Waking and starting agents in specs/coordination.md) |
| SessionEnd | leave the board, releasing every block |

The guard is per board (`"guard"` in `board.json`): `held` (a block someone else has reserved) and `frozen` take `deny`, `ask` (prompt the person), `warn` (allow, alert on the board) or `allow`; `free` takes `reserve`, `allow` or `deny` (reserve first). The hooks fail open: an error in QueueBox never blocks a tool call. `QUEUEBOX=off` turns them off for one session.

The commands an agent uses most:

```
qb reserve frame-verbs --for "pivot date grouping"   # refused, with the reason, if someone else has reserved it
qb doing "porting the quarter grouping to Rust"
qb test fail "tests/graph/pivotDates.test.ts"
qb bug "Quarter grouping drops the year on Q1"
qb ask "Q1 2026 or 2026 Q1?"                          # the answer arrives in `qb inbox` (and through the hooks)
qb release --landed
qb check                                              # changed files outside your blocks, exit 1
```

Identity: `--as <id>`, else `QUEUEBOX_AGENT`, else the Claude Code session (`cc-` + the session id's first 8 characters), else the person at the shell, who is the human. Any command joins an agent that hasn't joined.

## Any agent, any model

Nothing in QueueBox depends on which agent or model does the work. There are three levels of taking part:

1. **Nothing at all.** An agent that only edits files in its own worktree still shows up: the server sees the edits in git and records them for a stand-in agent named after the worktree.
2. **The CLI.** Any agent that can run a command can reserve, report, ask and queue. Inside a worktree it is known by that worktree without configuration; `QUEUEBOX_KIND` names its harness on the board. Paste this into the instructions file your agents read (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, and so on):

   ```
   This repository has a QueueBox board (the `qb` command). Before editing in an area, reserve its block:
   `qb which <file>` names the block, `qb reserve <block> --for "<what>"` takes it, and a
   refusal says who has reserved it. Say what you're doing with `qb doing "<what>"`, record test runs with
   `qb test pass|fail "<what ran>"`, ask the human with `qb ask "<question>"` and read answers with `qb inbox`. When
   your branch is ready, commit and run `qb ready`; release your blocks with `qb release --landed`.
   ```
3. **Hooks.** A harness with lifecycle hooks can do all of that without the agent's attention. `hooks/claude-code.js` is the one written so far; another harness needs the same mapping: session start to `agent.join`, a prompt to `agent.status working`, an edit about to happen to a reservation check, an edit done to `touch`, a permission prompt to `agent.status waiting`, a turn's end to `agent.status review`, and the session's end to `agent.leave`.

## Worktrees and the merge queue

QueueBox reads every worktree of the repository from git every few seconds (`core/worktrees.js`): its branch, how far it is ahead of and behind the base branch (`"base"` in `board.json`, else the remote's default, else main), the files and lines it changed since it branched with uncommitted work included, and the files that would conflict if it merged now, from a dry-run `git merge-tree` that touches nothing.

- **Quick swap.** The strip over the map lists every worktree by its agent's name, with commits ahead and behind, uncommitted work, a red mark when it conflicts with the base or with another branch, and its queue position. A tab focuses the map on the blocks that worktree changed and gives its path, a copied `cd`, and an Open link for VS Code, Cursor or Zed. In a terminal, `cd "$(qb wt path agent-2)"`; `qb wt` lists them all.
- **The merge forecast.** For every pair of branches that changed a file in common, a dry-run merge of the two heads says whether they will really conflict once one lands (cached per pair of commits). Only those, and conflicts with the base, are red; branches that merely share a file are noted and stay neutral.
- **The merge queue.** `qb ready` in a worktree (or Queue Merge on its tab) puts its branch in line at its current commit, once it has a commit to merge. Each entry shows the worst of: conflicts with the base or with a branch ahead of it, failing tests, commits behind the base, new commits since it was readied; then what is only worth knowing (shared files, uncommitted work, no test run). Each row has the one act that moves it along: **Merge** at a clean head (copies the command), **Rebase** or **Ask To Fix** (a message to its agent). Drag the grip, or use the arrow keys on it, to reorder. QueueBox never merges: the lead does, and the board marks the entry merged when the commit shows up in the base. `qb merge` prints the same queue.
- **What is being changed where.** A tile changed in two or more worktrees carries a branch count, red only when the forecast or the base says it will conflict there. The Changes lens shows what each agent hasn't landed in each block, and the block's details list each agent's files with their lines.

## The model

The truth is an append-only log, `.queuebox/live/events.jsonl` (ignored by git), one JSON event per line: `agent.join`, `agent.status`, `agent.leave`, `block.reserve`, `block.release`, `block.queue`, `block.freeze`, `item.add`, `item.update`, `item.delete`, `touch`, `test`, `note`, `msg`, `msg.read`, `merge.ready`, `merge.unready`, `merge.order`, `merge.landed`, `board.change`. Worktree state is not in the log: it is read from git, live. State is never stored: it is the fold of the log over the board (`core/model.js`, the same code in Node and the browser), which is what lets the timeline replay any moment, and lets a renamed block or moved path re-map old activity.

Every write goes through one lock (`core/store.js`): bring the fold up to date with what was appended since, check each event against that state (`checkEvent`), append. Two agents racing for a block can't both win, and the hook refuses the loser's edit. The lock is a file naming its owner (pid, host, a nonce): it is broken only when that process is gone or it is a minute old, and a writer removes only its own. Worktrees of one repository share the main checkout's board and log. `--force` (taking a reserved or frozen block) and acting for another agent are the person's alone. The log is append-only: a running server reads only what was appended, so an earlier line edited by hand (to the same length) shows only once the server restarts. A holder unseen for `staleAfterMin` (30) can be taken over; the human can always take a block back.

**The board** (`.queuebox/board.json`, committed) names the districts and blocks. A block has an `id`, a `name`, a `district`, `about`, `paths` (globs: `**`, `*`, `{a,b}`, a trailing `/` for a folder, a bare name matches anywhere; the most specific pattern wins a contested file), `docs` to read before touching it, and `keywords` for routing. `sources` import items from a markdown checklist (`- [ ] **Title** detail` under `## Heading`s): each heading routes to a block or to `auto` (the block whose keywords the item names most), and `kinds` set an item's kind from its heading. QueueBox's own board imports nothing: its items are filed on the board with `qb bug` and `qb task`. `qb init` drafts a board for any repository from its folders.

**Reshaping the board.** A district may sit inside another (`"parent": "<district>"`; the list stays flat), and `layout.districts` keeps where the page put each one (`{ x, y, cols }`; Tidy drops it). Changes go through one function (`core/board-ops.js`, pure, so the page checks a change before sending it) and one write (`store.writeBoard`: under the lock, validate, write board.json whole, log a `board.change` event):

```
qb board split <block>                       # its folders become sub-blocks, in a district of its name
qb board dissolve <district> [--into <id>]   # everything in it becomes one block (a split undone)
qb board join <a> <b>... --into <id>         # blocks or districts become one block with all their paths
qb board move <block> <district> [--before <block>]
qb board rename <block|district> "New name"
```

The page sends the same changes to `POST /api/board` (`{ "op": "split", "block": "ui" }`, answered `{ ok, board }` or `{ ok: false, code, message }`), as the person. A change is refused while a block it touches is reserved by someone else, queued or frozen; a split is refused if any file would change block other than the split one's going to its parts. Open items of a block that goes away move to the block that took its files (a split's biggest part).

**Remote agents:** `qb serve --host 0.0.0.0` with `QUEUEBOX_TOKEN` set, and agents elsewhere set `QUEUEBOX_URL` (and the token). The CLI then talks HTTP; the hooks still need the board on disk.

## What it doesn't do yet

- **Hooks for other harnesses.** Any agent shows up through git and can use the CLI, but only Claude Code reports questions, permission prompts and turn ends without being told to.
- **Hooks against a remote board.** A cloud session can use the CLI over `QUEUEBOX_URL`, but the hooks still need the board on disk.
- **A board that keeps itself current.** `qb init` drafts one from the folders, and unclaimed files show up on the map, but the blocks are kept by hand.
- **Cost.** No token or spend tracking.

## Files

| | |
|---|---|
| `core/` | the model and fold, glob matching (both run in the browser too), the store and its lock, identity, file listing |
| `adapters/markdown-checklist.js` | the backlog importer |
| `cli.js`, `qb` | the command line |
| `server.js` | the HTTP server: the page, the board, the log, a server-sent event stream tailing the log |
| `hooks/` | the Claude Code hook script and its installer |
| `ui/` | the page: map, windows, timeline, inspector, drag and drop, tethers |
| `ui/theme/` | Solenoid's theme kit, vendored; regenerated from Solenoid's `tools/solenoid-theme/sync.mjs`, not edited here |
| `scripts/` | `qb init`'s drafter, the browser smoke test (`smoke.js`, on a board seeded from `test/fixtures/`, and the stress board), the stress board (`stress.js --keep` serves it: 20 agents, 5,000 items, 48,000 events) |
| `test/` | `node --test test/*.test.js`; `fixtures/` holds a recorded session the smoke test and a try-out board start from |

The page's one font is Allo (Josh Puckett, SIL OFL 1.1), vendored in `ui/fonts/`, so it loads nothing from outside: tabular figures everywhere, and its disambiguation set where characters are compared (paths, ids, timers). The tab's [Q] mark is drawn in Allo Black in the accent.
