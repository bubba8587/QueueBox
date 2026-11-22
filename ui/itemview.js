// An item whole, for the popover a row's open button shows: its full title, detail and answer, where it is, who
// filed it, who has it, its status and what happened to it lately. Rows stay one or two lines; this is the rest.

import { blockMeta, agentName, clock } from '../core/model.js';
import { esc } from './dom.js';

const KIND = { bug: 'Bug', task: 'Task', decision: 'Your call', question: 'Question', note: 'Note', suggestion: 'Suggestion' };

export function itemHtml(st, it) {
  const block = it.block ? blockMeta(st, it.block)?.name || it.block : '';
  const facts = [
    `${KIND[it.kind] || it.kind}, ${it.status}`,
    block ? `in ${block}` : 'in no block',
    it.assignee ? `${agentName(st, it.assignee)} has it` : it.queued ? 'in the General Queue' : '',
    it.source === 'import' ? `from the backlog${it.group ? `: ${it.group}` : ''}` : it.by ? `filed by ${agentName(st, it.by)}` : '',
  ].filter(Boolean);
  const history = (it.history || []).slice(-5).reverse()
    .map((x) => `<li><span class="pop-meta">${esc(clock(x.ts))}</span> ${esc(agentName(st, x.by))}: ${esc(x.status)}${x.note ? `, ${esc(x.note)}` : ''}</li>`);
  return [
    `<p class="pop-text pop-title">${esc(it.title)}</p>`,
    `<p class="pop-meta">${facts.map(esc).join(' · ')}</p>`,
    it.detail ? `<p class="pop-text">${esc(it.detail)}</p>` : '',
    it.answer ? `<p class="pop-label">Answer</p><p class="pop-text">${esc(it.answer)}</p>` : '',
    it.ref ? `<p class="pop-meta">${esc(it.ref)}</p>` : '',
    history.length ? `<p class="pop-label">Lately</p><ul class="pop-list">${history.join('')}</ul>` : '',
  ].join('');
}
