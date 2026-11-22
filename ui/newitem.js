// New Item: file a bug or a task from anywhere on the page, not only from a block's drawer. A small panel under the
// button that opened it: kind, title, an optional detail, and the block it belongs to (the one whose drawer is
// open, else the one its words name, else the person picks). Enter in the title files it; Ctrl/Cmd+Enter does from
// the detail; Escape or Cancel closes it and keeps what was typed for the next time it opens.

import { h, setHtml, selectWrap, escapeLayer, ESC } from './dom.js';
import { UNMAPPED } from '../core/model.js';

let open = null;
const draft = { kind: 'bug', title: '', detail: '', block: '' };

// The block the title's words point at: a block's id or name, else its keywords. Only a single clear hit counts.
function guessBlock(board, text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) || [];
  if (!words.length) return '';
  let best = '';
  let bestScore = 0;
  let tie = false;
  for (const b of board.blocks) {
    const names = [b.id, ...String(b.name || '').toLowerCase().split(/\s+/), ...(b.keywords || []).map((k) => k.toLowerCase())];
    const score = words.filter((w) => names.includes(w)).length;
    if (score > bestScore) {
      best = b.id;
      bestScore = score;
      tie = false;
    } else if (score && score === bestScore) tie = true;
  }
  return tie ? '' : best;
}

export function closeNewItem({ focus = true } = {}) {
  if (!open) return;
  const { el, anchor } = open;
  open = null;
  el.remove();
  anchor?.setAttribute('aria-expanded', 'false');
  if (focus) anchor?.focus();
}

export function openNewItem(ctx, anchor) {
  if (open) return closeNewItem();
  const board = ctx.board;
  if (!board) return;
  if (ctx.selected && ctx.selected !== UNMAPPED && board.blocks.some((b) => b.id === ctx.selected)) draft.block = ctx.selected;

  const kind = h('select', { class: 'solenoid-settings__select', 'aria-label': 'Kind' }, h('option', { value: 'bug' }, 'Bug'), h('option', { value: 'task' }, 'Task'));
  kind.value = draft.kind;
  const title = h('input', { class: 'field', id: 'new-item-title', autocomplete: 'off', placeholder: 'What is wrong, or what to do' });
  title.value = draft.title;
  const detail = h('textarea', { class: 'field pop-field', id: 'new-item-detail', rows: '3', placeholder: 'Steps, file paths, what you expected' });
  detail.value = draft.detail;
  const block = h('select', { class: 'solenoid-settings__select', id: 'new-item-block', 'aria-label': 'Block' }, h('option', { value: '' }, 'Choose a block'));
  const districts = new Map(board.districts.map((d) => [d.id, h('optgroup', { label: d.name })]));
  for (const b of board.blocks) {
    const opt = h('option', { value: b.id }, b.name);
    (districts.get(b.district) || block).append(opt);
  }
  for (const g of districts.values()) if (g.children.length) block.append(g);
  block.value = draft.block;
  let picked = !!draft.block;
  block.addEventListener('change', () => {
    picked = !!block.value;
  });

  const keep = () => {
    draft.kind = kind.value;
    draft.title = title.value;
    draft.detail = detail.value;
    draft.block = block.value;
  };
  for (const f of [kind, title, detail, block]) f.addEventListener('input', keep);
  // Until the person picks a block, the title's words suggest one.
  title.addEventListener('input', () => {
    if (picked) return;
    const guess = guessBlock(board, title.value);
    if (guess) block.value = guess;
    keep();
  });

  const file = h('button', { class: 'btn sm confirm', type: 'submit' }, 'File It');
  const cancel = h('button', { class: 'btn sm', type: 'button' }, 'Cancel');
  const form = h(
    'form',
    { class: 'popover new-item', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'New item' },
    h('div', { class: 'pop-head' }, h('h3', {}, 'New Item')),
    h('div', { class: 'new-item-row' }, selectWrap(kind), selectWrap(block)),
    h('label', { class: 'pop-label', for: 'new-item-title' }, 'Title'),
    title,
    h('label', { class: 'pop-label', for: 'new-item-detail' }, 'Detail'),
    detail,
    h('div', { class: 'pop-foot' }, file, cancel),
  );
  const submit = async () => {
    const t = title.value.trim();
    if (!t) return title.focus();
    if (!block.value) return block.focus();
    const item = { kind: kind.value, title: t, block: block.value };
    const d = detail.value.trim();
    if (d) item.detail = d;
    const ok = await ctx.act.addItem(item);
    if (ok === false) return;
    draft.title = '';
    draft.detail = '';
    closeNewItem();
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  detail.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });
  cancel.addEventListener('click', () => closeNewItem());

  form.style.position = 'fixed';
  form.style.zIndex = '60';
  document.body.append(form);
  const r = anchor?.getBoundingClientRect() || { left: 16, bottom: 56 };
  const w = form.getBoundingClientRect().width;
  form.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  form.style.top = `${r.bottom + 6}px`;
  anchor?.setAttribute('aria-expanded', 'true');
  open = { el: form, anchor };
  title.focus();
}

escapeLayer(ESC.popover, () => !!open, () => closeNewItem());
// A press outside closes it; what was typed stays for the next time.
document.addEventListener('pointerdown', (e) => open && !open.el.contains(e.target) && !open.anchor?.contains(e.target) && closeNewItem({ focus: false }), true);
