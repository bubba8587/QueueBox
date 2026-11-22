# QueueBox

A live map of a repository's **blocks of work**, for running several coding agents in one codebase without reading their chats. A block is a piece of the repository one agent can own at a time: a subsystem, a feature, the docs. An agent **reserves** a block before it edits there, and its tile moves from the map into that agent's window until the work lands. Every tile carries its open bugs and tasks, its last test run, and who has been editing in it.

Zero dependencies; your repository carries only its board, `.queuebox/board.json`. QueueBox is an alpha: it works, and its formats still change.

## Install

Node 20 or newer and git.

```
curl -fsSL https://raw.githubusercontent.com/bubba8587/QueueBox/main/install.sh | sh
```

It clones QueueBox into `~/.local/share/queuebox` and puts `qb` on your PATH; run it again to update.

## Quick start

```
cd your-repo
qb up               # draws a first board, hooks up Claude Code, starts the board and opens it
qb run -- claude    # start each agent this way (any agent CLI), so the board can wake it
```

`qb up` is safe to run again; `qb down` stops the board. `qb` prints who has reserved what, `qb help` lists the rest, and `qb doctor` checks the setup.

The first board is drafted from your folders. Reshape it on the page (drag a block to another district; right-click for Split or Dissolve), with `qb board split|join|move|rename`, or by editing `board.json` and committing it.

## Agents on the board

**Claude Code** sessions started in the repository join on their own. They're briefed at start, an edit in a free block reserves it, an edit in a block someone else holds is refused with the reason, and their questions, tests and finished turns show on the board.

**Any other agent** (Codex, Gemini CLI, Aider, a script) takes part through the CLI. Put this in its instructions file:

```
This repository has a QueueBox board (the `qb` command). Before editing in an area, reserve its block:
`qb which <file>` names it, `qb reserve <block> --for "<what>"` takes it, and a refusal says who has it.
Say what you're doing with `qb doing "<what>"`, record tests with `qb test pass|fail "<what ran>"`,
file what you find with `qb bug|task "<title>"`, ask the person with `qb ask "<question>"` (answers arrive
in `qb inbox`), and release with `qb release --landed` when the work is committed.
```

An agent working in its own git worktree shows up even if it never runs a command: the board reads its changes from git.

## What you see

- **The map.** Districts of tiles, one tile per block. Pan, zoom and Fit; fold a district to one card; **Active** hides blocks with nothing going on.
- **Lenses.** Work; Heat (who edited where, lately); Changes (what hasn't landed, whose, how big, and where two agents changed the same files).
- **Needs you.** An inbox of what waits on you: questions to answer, permission prompts, finished turns, a merge queue head to merge.
- **Up next.** The team's queue: work you queue goes to the free agent who already knows that part of the code, and the board wakes it.
- **Agent windows.** One per agent: its state, task, what it's doing now, its subagents, and the blocks it's working in or has lined up.
- **The timeline** replays the whole board, so you can see what happened while you were away.

Drag a tile into an agent's window to give it the block, or into Up next to queue it. **New Item** (or N) files a bug or task from anywhere. The page's Help (the ? in the top bar) explains each part.

## Why use it next to orchestrators

Tools like Conductor, Claude Squad or Vibe Kanban give each agent its own branch and show you a list of sessions; overlap surfaces later as a merge conflict. QueueBox works before the edit, not at the merge: one agent per block, refused edits with a reason, and one map of where everyone is and what waits on you. It runs next to any of them.

You stay the orchestrator. QueueBox hands work over and wakes agents when you queue, assign or answer, and starts one on your click. It never runs a model on its own initiative, merges, or shows transcripts.

## How it works

The truth is an append-only log of events (`.queuebox/live/events.jsonl`, ignored by git); state is the fold of that log over the board, the same code in Node and the browser, so any moment can be replayed. Every write goes through one lock, so two agents racing for a block can't both win. Worktrees, branches and the merge forecast (a dry-run `git merge-tree`) are read from git, live.

[docs/reference.md](docs/reference.md) has the details: the hooks, the guard settings, the board file, the event log, worktrees and the merge queue, remote agents, and the source layout. The rules the code keeps are in [specs/](specs/). Questions and bugs: [GitHub issues](https://github.com/bubba8587/QueueBox/issues).

## Licence

MIT (`LICENSE`). The font, Allo by Josh Puckett, is under the SIL Open Font License 1.1 (`ui/fonts/Allo-OFL.txt`).
