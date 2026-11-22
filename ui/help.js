// Help and About (T72): what each part of the page is and does, the keys, where to read more, and which QueueBox
// this is. Opened from the ? in the top bar, in the same popover the side column uses.

import { openPopover } from './popover.js';
import { esc } from './dom.js';

export const VERSION = '2.0.0';
const REPO = 'https://github.com/bubba8587/QueueBox';

const PARTS = [
  ['The map', 'Every block of the repository, grouped in districts. A reserved block shows whose it is; its badges count open bugs and tasks, failing tests and conflicts. Right-click a tile or a district for Details, Split or Dissolve; drag a district by its name to place it.'],
  ['Needs you', 'What waits on you: a question to answer, a permission an agent asked for in its terminal, a suggestion to apply, a branch ready to merge. Each row has its own button.'],
  ['Up next', 'The queue. The next free agent takes the top; under each item, who the board would hand it to and why. Start an agent here launches one to take it.'],
  ['Agent windows', 'One per agent: its state, what it is doing this second, Now (what it is on) and Lined up (what it was given). Read opens what it said last, Wake hands an idle agent its work, Message writes to it.'],
  ['Items', 'Every open bug, task and question, across blocks. A block’s details list its own, with a filter and Done.'],
  ['The timeline', 'Who held which block when. Scrub it to replay the board at any moment; Live comes back.'],
];

const ACTS = [
  'Drag a tile into an agent’s window to give it the block, or into Up next to queue it.',
  'Send an item on from its row: pick where it goes (the General Queue, or one agent) and press Queue.',
  'Escape backs out one step: the menu, the popover, the drawer, the search.',
];

const KEYS = [
  ['/', 'Find a block or a file path'],
  ['N', 'File a new item'],
  ['T', 'Tidy the map'],
  ['Ctrl+,', 'Settings'],
  ['Shift+F10', 'A tile’s menu, from the keyboard'],
  ['Esc', 'Back out one step'],
];

export function openHelp(anchor) {
  const html = [
    '<p class="pop-text">QueueBox is a live map of who is working where in this repository: agents reserve blocks, you see the whole team at once and direct the work.</p>',
    ...PARTS.map(([name, text]) => `<p class="pop-text"><b>${esc(name)}.</b> ${esc(text)}</p>`),
    `<p class="pop-meta">What you can do</p>${ACTS.map((t) => `<p class="pop-text">${esc(t)}</p>`).join('')}`,
    `<p class="pop-meta">Keys</p><p class="pop-text">${KEYS.map(([k, t]) => `<kbd>${esc(k)}</kbd> ${esc(t)}`).join('<br>')}</p>`,
    `<p class="pop-meta">More</p><p class="pop-text">In the terminal, <code>qb help</code> lists every command and <code>qb doctor</code> checks the setup. The <a href="${REPO}#readme" target="_blank" rel="noopener">README</a> says how it works; questions and bugs go to <a href="${REPO}/issues" target="_blank" rel="noopener">its issues</a>.</p>`,
    `<p class="pop-meta">About</p><p class="pop-text">QueueBox ${esc(VERSION)}, an alpha, under the MIT licence. <a href="${REPO}" target="_blank" rel="noopener">${esc(REPO.replace('https://', ''))}</a>. The font is Allo by Josh Puckett (SIL OFL 1.1).</p>`,
  ].join('');
  openPopover({ key: 'help', anchor, title: 'QueueBox help', html, actions: [], closeLabel: 'Close' });
}
