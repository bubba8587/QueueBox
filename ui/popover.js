// One popover for the side column: a panel beside the sidebar, level with the row it came from, that shows
// something whole (a question, a suggestion) and takes an answer. It isn't modal: the board stays live behind it.
// It is opened only by a particular button; Escape or Cancel closes it and gives focus back to that button, and a
// press anywhere else closes it. What
// was typed into it survives closing and the side column re-rendering, keyed by what it is about.

import { h, esc, setHtml, escapeLayer, ESC } from './dom.js';

const drafts = new Map();
let open = null;

// spec: { key, anchor (the button), title, html (the body, already escaped), field?: { label, placeholder },
//   actions: [{ label, kind?: 'confirm', run(value) => Promise<boolean>|boolean }] } ; Cancel is always there.
export function openPopover(spec) {
  if (open?.key === spec.key) return closePopover();
  closePopover({ focus: false });
  const el = h('div', { class: 'popover', role: 'dialog', 'aria-modal': 'false', 'aria-label': spec.title, tabindex: '-1' });
  const head = h('div', { class: 'pop-head' });
  setHtml(head, `<h3>${esc(spec.title)}</h3>`);
  const body = h('div', { class: 'pop-body' });
  setHtml(body, spec.html || '');
  el.append(head, body);
  let field = null;
  if (spec.field) {
    const id = `pop-field-${spec.key.replace(/[^\w-]/g, '_')}`;
    field = h('textarea', { class: 'field pop-field', id, rows: '4', placeholder: spec.field.placeholder || '' });
    field.value = drafts.get(spec.key) || '';
    field.addEventListener('input', () => {
      if (field.value) drafts.set(spec.key, field.value);
      else drafts.delete(spec.key);
    });
    // Ctrl/Cmd+Enter sends with the first action.
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        run(spec.actions[0]);
      }
    });
    el.append(h('label', { class: 'pop-label', for: id }, spec.field.label || 'Answer'), field);
  }
  const foot = h('div', { class: 'pop-foot' });
  const run = async (action) => {
    if (!action) return;
    const value = field ? field.value.trim() : '';
    if (field && action.needsValue !== false && !value) return field.focus();
    const ok = await action.run(value);
    if (ok !== false) {
      drafts.delete(spec.key);
      closePopover();
    }
  };
  for (const action of spec.actions || []) {
    const b = h('button', { class: `btn sm${action.kind === 'confirm' ? ' confirm' : ''}`, type: 'button' }, action.label);
    b.addEventListener('click', () => run(action));
    foot.append(b);
  }
  const cancel = h('button', { class: 'btn sm', type: 'button' }, spec.closeLabel || 'Cancel');
  cancel.addEventListener('click', () => closePopover());
  foot.append(cancel);
  el.append(foot);
  // Placed against the viewport, whatever the stylesheet says about the rest.
  el.style.position = 'fixed';
  el.style.zIndex = '60';
  document.body.append(el);
  spec.anchor.setAttribute('aria-expanded', 'true');
  open = { key: spec.key, el, anchor: spec.anchor, field };
  place();
  (field || el).focus();
  return open;
}

escapeLayer(ESC.popover, () => !!open, () => closePopover());
// A press outside the popover and the button that opened it closes it; what was typed stays in its draft.
document.addEventListener('pointerdown', (e) => {
  if (open && !open.el.contains(e.target) && !open.anchor.contains(e.target)) closePopover({ focus: false });
}, true);

export function closePopover({ focus = true } = {}) {
  if (!open) return;
  const { el, anchor, key } = open;
  open = null;
  el.remove();
  // The side column may have re-rendered since: give focus to whatever button now opens this.
  const now = anchor.isConnected ? anchor : document.querySelector(`[data-pop="${CSS.escape(key)}"]`);
  now?.setAttribute('aria-expanded', 'false');
  if (focus) now?.focus();
}

// After the side column repaints: follow the new button that opens the same thing, or close when it's gone
// (the question was answered elsewhere).
export function refreshPopover() {
  if (!open) return;
  const next = document.querySelector(`[data-pop="${CSS.escape(open.key)}"]`);
  if (!next) return closePopover({ focus: false });
  if (next !== open.anchor) {
    open.anchor = next;
    next.setAttribute('aria-expanded', 'true');
  }
  place();
}

export function popoverKey() {
  return open?.key || null;
}

// Beside the sidebar, on the map's side of it, its top level with the row, kept inside the window.
function place() {
  const { el, anchor } = open;
  const side = anchor.closest('.side') || document.getElementById('side');
  const row = anchor.closest('.ib-item, .ib-row') || anchor;
  const s = side.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const gap = 8;
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const onRight = s.left + s.width / 2 > window.innerWidth / 2;
  let left = onRight ? s.left - gap - w : s.right + gap;
  // A narrow screen has no room beside the column: lay it over the column instead.
  if (left < gap || left + w > window.innerWidth - gap) left = Math.max(gap, Math.min(window.innerWidth - w - gap, s.left));
  const top = Math.max(gap, Math.min(window.innerHeight - hgt - gap, r.top));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

window.addEventListener('resize', () => open && place());
