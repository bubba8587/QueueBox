<!-- dte:A1,A2,A3 -->
# Working in QueueBox

Read `README.md` first: it says what QueueBox is and how it is built. This repository has its own QueueBox board (`qb`); the hooks brief you at session start.

## Everything goes on the board

The author watches the board, not your chat window, and wants to open your chat as rarely as possible. Keep nothing to yourself: anything the author or another agent would want to know or act on goes on the board, where it can be seen and acted on.
- **Work you find** (a bug, a follow-up, a loose end, something you're deferring): file it at once with `qb bug` or `qb task`, in the block it belongs to. Don't save it for a summary at the end.
- **Questions and decisions for the author:** `qb ask`, never a question in chat. Then end your turn or keep working on something else.
- **What you're doing:** keep `qb doing` current with what you're doing this minute, never a summary of your queue (your window lists Now and Lined up from the board, and a line like "Nothing lined up" goes stale beside it); record test runs with `qb test pass|fail`, and mark items `doing` and then `done` (`qb item <id> …`) as you go.
- **When a piece lands:** a `qb note` in the block saying what changed and what's left, then `qb release --landed`. Your end-of-turn chat message can then be one line.
- **Peers:** message them with `qb msg`, so the exchange shows on the board.
- **Your queue is on the board, not in your head.** Work you've been handed or plan to do next is an item assigned to you (file it, or take an existing one), and stays `open` until you start it; only what you're actually working on is `doing`. Reserve the block you're working in now, not the ones you'll need later. The author reassigns lined-up work to idle agents from the board, so nothing you intend to do may live only in your chat. When the author moves an item away from you, drop it.

## Working on the code

- **Use it before you change it:** try a page change on the live board, or on a throwaway board seeded from a recorded session: `node scripts/smoke.js --keep` prints its address.
- **Tests:** `node --test test/*.test.js` after every change, recorded with `qb test pass|fail`. A change to the page also runs `npm run smoke` (`scripts/smoke.js`, which needs Playwright and says when it skipped), and you look at it in the browser before reporting it: the live board or the seeded one. Leave the live board's tab open when you're done.
- **Commits:** a one-line summary saying what is now true ("A double-click on the map does nothing"), a blank line, a short body. The checkout is shared: stage only the files you changed (`git add <paths>`), never `git add -A`.
- **Pre-alpha, break freely:** `board.json`, the event log and the CLI have one user. Change their formats outright, with no shims, aliases or migrations.
- **An audit fixes by default:** behaviour that is defensible but worse gets fixed. A change to behaviour the author relies on, or anything that needs the author's call, goes to `qb ask` first.

## Decision tree

QueueBox keeps its decisions as a Decision Tree Engineering tree in `decisions/`. Follow `vendor/dte/PROTOCOL.md` (rules in `vendor/dte/SPEC.md`, DTE's own leaves in `vendor/dte/DECISIONS.md`). The tool is `python3 tools/dte.py`. Never edit `vendor/dte/` or `tools/dte.py`: refresh both with `python3 tools/dte.py vendor --from ~/projects/DTE`, and send a change the tool needs to the DTE repository.

**Use the tree sparingly.** A leaf is a decision with stakes: a call that changes what QueueBox is or is for, which must survive the tweaking around it. Everything that describes how something works or is built goes in a spec under `specs/`, and most work creates no leaf at all. When in doubt, write the spec and mention that it could be a leaf if the author wants it kept.

- **Rings:** `A` QueueBox's goals (the author's). `B` product calls across QueueBox. `C` and deeper only for a call the author wants preserved. Until the author gives you a ring, work at C.
- **Ratifying is the author's act alone**, on a direct instruction naming the leaf. Every leaf here so far was drafted by an agent and is unratified.
- **Specs:** `specs/coordination.md` (reservations, worktrees, who directs the work), `specs/page.md` (rules the page keeps), `specs/glossary.md` (the words for every part). A change to a behaviour a spec describes updates the spec in the same commit. A spec states the rule, not who ruled: who decided and when go in a leaf's Why and in git. A rule the code doesn't keep yet says so ("not yet: T4"). One paragraph or list item is one line, never hard-wrapped, and specs don't say "you".
- **Session start:** `python3 tools/dte.py outbox` and `python3 tools/dte.py inbox`.
- **Before finishing:** `python3 tools/dte.py validate --as <your ring>` prints `OK`.
