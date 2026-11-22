<!-- dte:A1 -->
# Glossary

The proper names for QueueBox's parts. The page, the CLI, the hooks, the specs, the README and the reference use these words and no others for the same thing.

## The board

- **Board:** one repository's `.queuebox/board.json` and its log, and the page that shows them.
- **Block:** a piece of the repository one agent can own, named by path globs. Every file belongs to at most one block.
- **District:** a named group of blocks. A district may sit inside another.
- **Reserved / free:** a block is reserved by an agent or by the person, or it is free. Never "held" or "claimed".
- **Frozen:** a block nobody may edit until the person unfreezes it.
- **Item:** a task, bug, decision, question, note or suggestion filed against a block, with an id by kind (`T4`, `B2`, `D1`, `Q5`, `N3`, `S1`).
- **Up next:** the team's queue of blocks and items. The next free agent takes the top one (`qb next`).
- **The person:** the human directing the work. The page calls them "you"; the specs say "the person".

## The page

Each surface, what it shows, and how it opens and closes.

- **Map:** the canvas of districts and tiles. Always there; drag to pan, the wheel to zoom, Fit to frame it.
- **Tile:** a block on the map. When its block is reserved, the tile moves into the agent's tray and leaves a socket behind.
- **Socket:** the hatched place a reserved block's tile left, carrying the reserver's name and disc.
- **Compact tile:** a collapsed district, drawn as one tile with its members' badges. The district label's chevron collapses and expands it.
- **Lens:** what the tiles show: Work, Heat or Changes. Picked in the top bar.
- **Worktree strip:** the row of worktree tabs over the map. A tab focuses the map on that worktree's blocks.
- **Side column:** the column of windows beside the map, the inbox on top.
- **Inbox:** the window of rows that wait on the person, each with its act.
- **Agent window:** one per agent: disc, state, timer, task line, what it's doing and its tray. Its chevron opens recent actions and a message box.
- **Tray:** the blocks an agent has reserved, inside its window.
- **Task line:** the line in an agent window saying what the agent is working on.
- **Tether:** the line from a socket to its reserver's window, drawn while the person points at that agent.
- **Drawer:** the block column (`ui/inspector.js`), left of the map, taking no space while nothing is open in it; on a phone, a sheet over the page. Pressing a tile or its socket, or Details in a tile's menu, shows that block in it; the Items button shows every open item on the board. Escape or its close button folds it away.
- **Popover:** a small panel anchored to a button in the side column, such as an answer box. Its button toggles it; Escape, Cancel or a press anywhere else closes it, keeping what was typed.
- **Menu:** the right-click menu on a tile or a district label. Escape, a pick or a press outside closes it.
- **Timeline:** the lane-per-agent history under the map, for replaying the board. Its fold button folds it away.
- **Toast:** a short notice at the foot of the page that goes away on its own.
- **Settings:** the gear's panel: palette, accent and the board's switches.

## Work in git

- **Worktree:** a git checkout of the repository; several agents may share one.
- **Base:** the branch work merges into: the board's `base`, else `develop`, else the remote's default.
- **Merge queue:** the branches readied with `qb ready`, in the order the lead merges them.
- **Forecast:** the dry-run merge of two branch heads that says whether they will really conflict.
