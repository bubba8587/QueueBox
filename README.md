# QueueBox

A live map of which coding agent is working where in your repository. An agent reserves a block of the code before it edits there, so two agents never edit the same part at once, and one page shows who holds what, what waits on you, and what's queued next. Zero dependencies. Alpha.

## Install

Node 20+ and git.

```
curl -fsSL https://raw.githubusercontent.com/bubba8587/QueueBox/main/install.sh | sh
```

## Start

```
cd your-repo
qb up               # draws a board from your folders, hooks up Claude Code, opens the page
qb run -- claude    # start each agent this way, so the board can wake it
```

Claude Code sessions join on their own. Other agents (Codex, Gemini CLI, Aider) use the `qb` command; [docs/reference.md](docs/reference.md#any-agent-any-model) has the lines to paste into their instructions.

## More

- The page's Help (the ? in the top bar) explains each part.
- [docs/reference.md](docs/reference.md): commands, hooks, the board file, worktrees and merges.
- [specs/](specs/): the rules the code keeps.
- [Issues](https://github.com/bubba8587/QueueBox/issues).

MIT licensed. The Allo font is by Josh Puckett, under the SIL Open Font License 1.1.
