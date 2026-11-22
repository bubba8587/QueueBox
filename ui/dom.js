// Small DOM helpers and the icon set. Browser only.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, String(val));
        else el.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function setText(el, text) {
  const t = String(text ?? '');
  if (el.textContent !== t) el.textContent = t;
}

export function setHtml(el, html) {
  if (el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
}

export function toggle(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

// An agent's picture (T93): its kind's icon; the person keeps their initials.
export function agentFace(a) {
  if (!a || a.id === 'human' || a.kind === 'human') return esc(initials(a?.name));
  const k = String(a.kind || '').toLowerCase();
  const name = /claude/.test(k) ? 'kindClaude' : /codex/.test(k) ? 'kindCodex' : /gemini/.test(k) ? 'kindGemini' : /aider/.test(k) ? 'kindAider' : k === 'worktree' ? 'branch' : 'run';
  return icon(name, 'face');
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 1)).toUpperCase();
}

const P = {
  bug: '<path d="M8 4.2c1.6 0 2.8 1.2 2.8 2.9v3.1c0 1.7-1.3 3.1-2.8 3.1s-2.8-1.4-2.8-3.1V7.1C5.2 5.4 6.4 4.2 8 4.2Z"/><path d="M6.3 4.6 5.2 3M9.7 4.6 10.8 3M5.2 8H3M5.2 11H3.4M10.8 8H13M10.8 11h1.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  task: '<rect x="3.2" y="3.2" width="9.6" height="9.6" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  done: '<rect x="3.2" y="3.2" width="9.6" height="9.6" rx="2"/><path d="m5.6 8.2 1.7 1.7 3.2-3.6" fill="none" stroke="var(--raised)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  decision: '<path d="M8 2.6 13.4 8 8 13.4 2.6 8Z"/>',
  question: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.4 6.4c.1-.9.8-1.5 1.7-1.5.9 0 1.6.6 1.6 1.4 0 1.3-1.6 1.3-1.6 2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8.1" cy="11" r=".85"/>',
  check: '<path d="m3.5 8.4 2.9 2.9 6-6.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  cross: '<path d="m4.3 4.3 7.4 7.4m0-7.4-7.4 7.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  lock: '<rect x="3.6" y="7.2" width="8.8" height="6.2" rx="1.6"/><path d="M5.6 7.2V5.6a2.4 2.4 0 0 1 4.8 0v1.6" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  eye: '<path d="M1.8 8s2.3-4 6.2-4 6.2 4 6.2 4-2.3 4-6.2 4-6.2-4-6.2-4Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.9"/>',
  flame: '<path d="M8 1.8c.4 2.2 3.8 3.6 3.8 7.2a3.8 3.8 0 0 1-7.6 0c0-1.6.8-2.6 1.6-3.3.1 1.2.7 1.9 1.4 2.1C7 5.9 7.4 3.6 8 1.8Z"/>',
  send: '<path d="M2.6 8 13.4 3 10.6 13 8 9.2Z"/>',
  play: '<path d="M4.6 3.2v9.6L12.8 8Z"/>',
  pause: '<rect x="4" y="3.4" width="2.8" height="9.2" rx=".8"/><rect x="9.2" y="3.4" width="2.8" height="9.2" rx=".8"/>',
  search: '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.2 10.2 3.4 3.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  moon: '<path d="M12.8 10.2A5.6 5.6 0 0 1 5.8 3.2a5.6 5.6 0 1 0 7 7Z"/>',
  close: '<path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  hand: '<path d="M5.4 8.6V4.2a.9.9 0 0 1 1.8 0v3.4-4.6a.9.9 0 0 1 1.8 0v4.6-3.8a.9.9 0 0 1 1.8 0v4.2-2.6a.9.9 0 0 1 1.8 0v3.8c0 2.6-1.8 4.4-4.3 4.4-1.6 0-2.6-.7-3.5-1.9L3.3 9.2a.9.9 0 0 1 1.4-1.1Z"/>',
  queue: '<path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  live: '<circle cx="8" cy="8" r="3.4"/>',
  run: '<path d="M3 4.6 6.4 8 3 11.4M7.8 11.6h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  edit: '<path d="M3 13l.8-3.2 6.6-6.6 2.4 2.4-6.6 6.6Z"/>',
  file: '<path d="M4.2 2.4h5l2.6 2.6v8.6H4.2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  note: '<path d="M3 3.4h10v7H8.4L5.4 13v-2.6H3Z"/>',
  reserve: '<path d="M8 2.4 13 5v6L8 13.6 3 11V5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 13.6V8m0 0 5-3M8 8 3 5" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  release: '<path d="M8 13V5.4m0 0L5 8.4m3-3 3 3M3.6 3h8.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  join: '<circle cx="8" cy="5.6" r="2.6"/><path d="M3 13.4c.6-2.6 2.6-4 5-4s4.4 1.4 5 4Z"/>',
  conflict: '<path d="M8 2.2 14.2 13H1.8Z"/><path d="M8 6.4v3.2" stroke="var(--surface)" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".85" fill="var(--surface)"/>',
  chev: '<path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  bell: '<path d="M8 2.4a3.6 3.6 0 0 0-3.6 3.6v2.5L3.2 10.8h9.6L11.6 8.5V6A3.6 3.6 0 0 0 8 2.4Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6.6 12.6a1.4 1.4 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  branch: '<circle cx="4.6" cy="3.6" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.6" cy="12.4" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.4" cy="5.6" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.6 5.2v5.6M11.4 7.2c0 2.6-2.4 3-4.6 3.6" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  copy: '<rect x="5.2" y="5.2" width="8" height="8.6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 10.6V3.8C3 3.2 3.4 2.8 4 2.8h6" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  up: '<path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  inbox: '<path d="M2.6 9.4 4.4 3.4h7.2l1.8 6v3.4H2.6Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M2.7 9.4h3.1l.9 1.5h2.6l.9-1.5h3.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  grip: '<circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/>',
  tidy: '<rect x="2.6" y="2.6" width="4.6" height="4.6" rx="1"/><rect x="8.8" y="2.6" width="4.6" height="4.6" rx="1"/><rect x="2.6" y="8.8" width="4.6" height="4.6" rx="1"/><rect x="8.8" y="8.8" width="4.6" height="4.6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  fit: '<path d="M2.8 6V3.6c0-.4.4-.8.8-.8H6M10 2.8h2.4c.4 0 .8.4.8.8V6M13.2 10v2.4c0 .4-.4.8-.8.8H10M6 13.2H3.6c-.4 0-.8-.4-.8-.8V10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  // Agent kinds (T93): Claude and Google Gemini are their marks from Simple Icons (CC0, simpleicons.org; the
  // trademarks stay their owners'), drawn on its 24 grid scaled to ours. Simple Icons has no OpenAI or Aider mark,
  // so Codex and Aider keep plain glyphs.
  kindClaude: '<g transform="scale(0.6667)"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></g>',
  kindCodex: '<path d="M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.7"/>',
  kindGemini: '<g transform="scale(0.6667)"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></g>',
  kindAider: '<path d="M2.6 3.4h8.8v6.2H6.6l-2.6 2.4V9.6H2.6Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M12.8 6.2h.6v6.2H12v2l-2.2-2h-2.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  dots: '<circle cx="3.6" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.4" cy="8" r="1.4"/>',
  mail: '<rect x="2.4" y="3.8" width="11.2" height="8.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m2.8 4.6 5.2 4 5.2-4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
};

// Solenoid's Settings select: the select in its wrap, the Lucide caret over its right end (theme/controls.css).
const CARET = '<svg class="solenoid-settings__select-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
export function selectWrap(select) {
  select.classList.add('solenoid-settings__select');
  const wrap = h('span', { class: 'solenoid-settings__select-wrap' }, select);
  wrap.insertAdjacentHTML('beforeend', CARET);
  return wrap;
}

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${P[name] || ''}</svg>`;
}

// A notice, after Solenoid's toasts: it stays 6.5 s (longer while pointed at), a press on it dismisses it, it has a
// close button, and it can carry one action (the home for an Undo): { action: { label, run } }.
const TOAST_MS = 6500;
export function toast(text, kind = 'info', { action } = {}) {
  // In the map's frame, at its bottom, where there is room to read them (T94); a phone's map scrolls with the page,
  // so there they stay fixed at the bottom of the screen.
  const frame = !matchMedia('(max-width: 860px)').matches && document.getElementById('map-wrap');
  const parent = frame || document.body;
  let host = parent.querySelector(':scope > .toasts');
  if (!host) {
    document.querySelector('.toasts')?.remove();
    host = h('div', { class: `toasts${frame ? ' in-map' : ''}`, role: 'status', 'aria-live': 'polite' });
    parent.append(host);
  }
  const close = h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss' });
  setHtml(close, icon('close'));
  const act = action ? h('button', { class: 'btn sm toast-act', type: 'button' }, action.label) : null;
  const t = h('div', { class: `toast ${kind}` }, h('span', { class: 'toast-text' }, text), act || '', close);
  host.append(t);
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, TOAST_MS);
  };
  t.addEventListener('pointerenter', () => clearTimeout(timer));
  t.addEventListener('pointerleave', arm);
  t.addEventListener('click', (e) => {
    if (act && act.contains(e.target)) action.run();
    dismiss();
  });
  arm();
  return dismiss;
}

// Copies text and says so; where the clipboard is out of reach, the toast shows the text to copy by hand.
export function copyText(text, done = 'Copied.') {
  const ok = () => toast(done);
  const fail = () => toast(text);
  try {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, fail);
    else fail();
  } catch {
    fail();
  }
}

export function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience; the page works without it.
  }
}

// ---------------------------------------------------------------------------------------------
// Timers. An age reads in compact units with no "ago" (47s, 12m, 1h 05m); the one thing actively
// running (an agent's current turn of work) reads as a stopwatch (4:07). A timer past its `warn`
// threshold turns warn-colored and past `over` danger-colored. The absolute start is the tooltip.

export function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 10) return `${hr}h ${String(m % 60).padStart(2, '0')}m`;
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function stopwatch(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hr = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return hr ? `${hr}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function timer(at, { watch = false, warn = 0, over = 0, cls = '' } = {}, now = Date.now()) {
  // Only ever a number reaches the markup, whatever the log held.
  const since = Number(at) || now;
  const ms = now - since;
  const state = over && ms >= over ? ' over' : warn && ms >= warn ? ' late' : '';
  return `<span class="timer${state}${cls ? ` ${cls}` : ''}" data-since="${since}"${watch ? ' data-watch' : ''}${warn ? ` data-warn="${Number(warn)}"` : ''}${over ? ` data-over="${Number(over)}"` : ''}>${watch ? stopwatch(ms) : dur(ms)}</span>`;
}

// Ticks every timer on the page once a second, in place, without a render.
export function startTimers(getNow) {
  setInterval(() => {
    const now = getNow();
    for (const el of document.querySelectorAll('.timer[data-since]')) {
      const ms = now - Number(el.dataset.since);
      const text = 'watch' in el.dataset ? stopwatch(ms) : dur(ms);
      if (el.textContent !== text) el.textContent = text;
      const over = Number(el.dataset.over || 0);
      const warn = Number(el.dataset.warn || 0);
      el.classList.toggle('over', !!over && ms >= over);
      el.classList.toggle('late', !!warn && ms >= warn && !(over && ms >= over));
    }
  }, 1000);
}

// ---------------------------------------------------------------------------------------------
// One Escape for the whole page, after Solenoid's escape layers: each thing that can be open registers a rank and
// Escape closes the highest-ranked one that is open (a menu, then a popover, then the drawer, then the search),
// wherever focus is. First, though, Escape in a one-line field with a draft clears the draft and goes no further.
export const ESC = { search: 10, drawer: 20, popover: 30, menu: 40 };
const escLayers = [];
export function escapeLayer(rank, isOpen, close) {
  const layer = { rank, isOpen, close };
  escLayers.push(layer);
  if (escLayers.length === 1) {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
        const f = e.target;
        const top = escLayers.filter((l) => l.isOpen()).sort((a, b) => b.rank - a.rank)[0];
        if (f instanceof HTMLInputElement && ['text', 'search', ''].includes(f.type) && f.value) {
          f.value = '';
          f.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (top) top.close();
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
  }
  return () => escLayers.splice(escLayers.indexOf(layer), 1);
}
