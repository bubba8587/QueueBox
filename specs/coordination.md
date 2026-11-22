<!-- dte:A1,A2,A3,B1,B2,B3,B4,B5,B8 -->
# Coordination

How agents and the person share one repository on the board. The README describes the commands and the page; this spec holds the behaviour they must keep.

## Reservations and the guard

- An agent reserves a block before editing in it. With the default guard (`board.json` `guard`), an edit inside a block someone else reserves, or a frozen one, is refused with who has it and what to do instead; an edit in a free block reserves it. `ask`, `warn` and `allow` relax this per board.
- A refusal is the point: a warning after the edit leaves the person to untangle the overlap.
- The hooks fail open: an error in QueueBox never blocks a tool call.
- The person can always take a block back; a reserver unseen for `staleAfterMin` can be taken over.

Tests (`test/core.test.js`): a reservation refuses a second agent; the store refuses the second of two racing reservations; the hook refuses an edit inside another agent's block; the lock is broken only when its holder is gone.

## Worktrees

- Several agents in one checkout and one agent per worktree both work fully. A worktree lists every agent in it; each agent's reservations, edits, line counts and messages are its own. Edits git sees but no agent reported go to the agent there who last edited that file.
- The base branch is the board's `base`, else `develop` where it exists, else the remote's default. The checkout that has the base branch out is measured against its upstream.
- Merging stays a command the person runs: the merge queue copies it and marks an entry merged when its commit reaches the base.

Tests (`test/core.test.js`): worktrees are read from git; a worktree holds several agents; develop is the base where there is one; the merge queue checks conflicts.

## The person directs (A2)

- Agents report (`qb doing`, tests), ask (`qb ask`) and suggest; they never assign or take back each other's work.
- The queue holds entries, each with its own place: a whole block, or one item (B13). An item may have no block: one typed into Up next is filed with no block and queued as it lands (`item.add` with `queue: true`). Anyone can take it (with no block, context doesn't score it); the taker is given it, not a block, files it properly (`qb item <id> --block`, more items with `qb task` or `qb bug`) and does it, or returns it with `qb queue <id>`, which makes it the team's again: unassigned and open. `qb next` and the board's wakes hand out one entry at a time, the first the agent can take: its block free (the taker reserves it) or already its own, never frozen. An item whose block someone else has reserved waits for it, and in one pass two agents never get the same block. Reserving a block takes its whole-block entry and none of its queued items (`take: []`); a reservation from before B13 (no `take`) took every item queued with its block, and still replays that way. The page sums a block's entries as one tile in Up next.
- An idle agent (turn finished, nothing reserved, nothing assigned, no open question) is the board's to manage, never kept going by the Stop hook. The Stop hook only marks the turn ended. The server watches for what is waiting for an idle agent: a message or an answer (they land in its inbox), an item or block the person gave it since its turn ended, queued work, or the planning nudge (review the board and suggest a distribution, once per idle stretch, before queued work). It then wakes that agent's session (below). Queued work is reserved for the agent first, under the store lock, so one queued block goes to one agent. The Nudge switch (`nudgeIdle`, on by default) turns the managing off, as do `QUEUEBOX=off` and `QUEUEBOX_WAKE=off` on the server. An agent whose work is done, which has reviewed the board and whose queue is empty, stays stopped.
  - `qb suggest <agent>:<item>...` files a suggestion item (id `S…`) carrying the plan. Applying it gives each item to its agent, with the item's block when it is free, else the item queued with the block; each agent is messaged what it got. Dismissing closes it.
  - The model refuses an agent assigning an item to anyone but itself, or taking one that is someone else's.
  - Auto-Apply (`autoApply` on the board, Settings' Auto-apply suggestions, off by default) is the person's standing yes: the server applies each open suggestion as it lands, as the person's Apply would (`suggestionPlan` in core/model.js), but leaves out an item another agent is doing, an item whose block another agent reserves and has touched in the last 20 minutes, and an item another suggestion placed with an agent that still has it; those stay a suggestion for the person. Each apply logs a note saying what it did, which carries what changed so the person can undo it from Needs you for 10 minutes, or until the person acts on that suggestion (applies the rest, dismisses it, undoes it) or it goes away. A suggestion it has been through is never applied by it again.
- Reshaping the board (split, dissolve, join, move, rename) is refused while a block it touches is reserved by someone else, queued or frozen; a split never moves a file between blocks other than the split block's own going to its parts.
- Needs you is a permission prompt or an open question, nothing else (B11): Claude Code's notice that a session has sat waiting for input only means its turn is over, and an idle agent is the board's to manage.
- Questions reach the person whole: each open question has its own inbox row and opens in full.
- An answer reaches an asker whose turn has ended the same way: it lands in the inbox and the board wakes the session. `qb ask --wait` blocks until the answer for agents without hooks. A message to an agent that has ended its turn says on the page that it is delivered when the agent next runs.

Tests (`test/core.test.js`): the Stop hook only marks the turn ended; an agent is idle with nothing to do only when its turn is over; the board plans whom to wake; qb ask --wait blocks until the answer; only the human forces a reservation or acts for another agent.

## Who takes queued work

- Queued work goes to the free agent who already knows it, the same way every time: the same board and log give the same assignment (`queuePlan` in core/model.js).
- Up next is walked in the person's order, which stays the priority. For each entry every agent still free in the pass is scored by its context with the entry's block, in whole points so ties are exact: its edits there (10 each) and its reservations of it (20 each), both halving every two hours, and the items there it filed or finished (5 each), plus 15 when its worktree's branch already changes the block's files.
- The highest score takes the entry; a tie goes to the agent idle longest, then to the agent id. With nobody above zero, the agent idle longest takes it, so work never waits for context. An agent takes one entry per pass, and a block reserved by someone waits for them.
- Free means idle with nothing reserved or assigned, not asked to finish and stop, and (for the board's wakes) in a session the board can wake. The person's own acts win: work given to an agent, or a block kept by the person, isn't the queue's to hand out.
- The wake prompt and the board's note say why an agent got its entry ("you edited table.ts, reserved tables before").
- Up next shows under each queued item who the board would hand it to now and why, or whom it waits for (the agent who has its block, or under Wait for context the busy agent who knows it), from the same plan over the idle agents not in a terminal the board can't wake. `qb next` names the same waits. Not yet: the page's prediction leaves out the branch signal the board's wakes count.
- Wait for context, a board setting off by default (`waitForContext`, minutes; the page's switch sets 10): an entry queued less than that long ago waits for a busy agent whose score is at least 20 and twice the best free agent's, instead of going to a free agent at once. After that it goes to a free agent after all.
- `qb next` takes the entry the same plan gives its caller (over it and the other idle agents); one planned for an agent with more context is left to them and named, unless `--any`, which takes the first it can. A caller not on the board yet takes the first it can.
- Not yet: a whole-block entry in Up next doesn't show its predicted taker.

## Waking and starting agents (B1)

QueueBox acts on the person's explicit word, short of being a harness: it never runs or manages a model.
- **Terminals QueueBox owns:** `qb run -- <agent CLI>` runs any agent (Claude Code, Codex, Gemini, Aider…) under `core/ptyrun.py`, a relay built on Python's standard `pty`: the person's terminal shows and types as before, and a socket in `.queuebox/live/ptys/` types into the agent too. A Claude Code session reports the socket through its hooks (`QUEUEBOX_PTY`); any other agent is joined as `qb run --agent <id>` and leaves when its command ends. Waking such an agent types the wake prompt as one line, then Enter a moment later, only while the board sees it idle. This is the one way to wake a session in someone's terminal: GNOME Terminal has no remote control and the kernel forbids typing into another process's terminal, so an agent started outside `qb run` waits for its next prompt. Only sockets in the board's own `ptys` folder are typed into.
- **Wake** uses Claude Code's documented background sessions. `claude agents --json` says which are idle; waking one is `claude stop <id>` then `claude --bg --resume <session-id> "<prompt>"`, which Claude Code reports as "woke session <id> with its saved options" (resuming one still running would start a copy, so it is stopped first). The prompt is fixed framing around the board's own facts (what is waiting). Each wake is logged on the board as a note with the agent, the session and why. The person can also wake one agent by hand (`POST /api/wake { agent }`, the page's Wake): it gets what waits for it, else is asked to look at the board. The Stop hook posts what an agent said last, so the page can show it instead of sending the person to a terminal (B12). Only background sessions are woken: a session open in someone's terminal is never touched, and gets its work on its next prompt. Claude Code also documents each session's inbox socket, but not the framing of a message on it, so QueueBox doesn't write to it.
- **Finish and stop:** the person can ask one agent, or all, to finish what it has now and take nothing new (`agent.finish { agent, on }`, the person's alone). The agent is messaged to complete its current work, note it and release; the board then hands it no queued work, gives it no planning nudge (`nextFor`, `queuePlan`, wakes and `qb next` all skip it) and only wakes it for its messages, until the person resumes it. Its window reads Finishing while it works and Stopped once its turn ends.
- **Start:** `POST /api/launch { op: "start", worktree }`, the person's click on the page. The server runs one fixed command, `claude --bg --name <board>-<worktree> "<fixed prompt>"`, in a checkout it listed itself (never a path or text from the page), and the prompt tells the session to take the next queued work with `qb next`. Its hooks join it to the board like any session; `claude attach <id>` opens it. Human only (the request's `by` must be the person, with the `x-queuebox` header, on localhost or with the token), and each start is logged on the board as a note with its worktree and id.

Tests (`test/core.test.js`): the server wakes an idle background session for queued work; the person starts an agent in a worktree from the board; the board types into an agent's own terminal and plans its wake.

## Standing alone (A3)

- No dependencies and nothing imported from the host project; the host carries only `.queuebox/board.json`. Any agent that can run a command can take part; hooks only save attention.
