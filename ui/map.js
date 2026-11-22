// The map: districts of slots, one tile per block, and the socket a tile leaves when it's away.
//
// Tiles are all one size; districts are packed into bands as tall as a few tiles, each district as wide as it
// needs, so the map fills its width and reads at full size. A tile carries what is live (conflicts,
// failing tests, a lock) and every open item: bugs, your calls and tasks, in every lens.

import { agentsInBlock, changesByBlock } from '../core/merges.js';
import { UNMAPPED, HUMAN, blockMeta, itemCounts, heat, recentToucher, footprints, isStale, agentName, presence } from '../core/model.js';
import { h, icon, setHtml, toggle, initials, esc, timer, storageGet, storageSet, escapeLayer, ESC, toast } from './dom.js';

// The camera's zoom, after Solenoid's viewPresets: the wheel lands on 10% steps between these, a trackpad's small
// deltas piling up toward the next one; Fit and the buttons are unsnapped.
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const ZOOM_SNAP = 0.1;
const ZOOM_STEP = 1.4;
const boundZoom = (z) => (Number.isFinite(z) ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) : 1);
const snapZoom = (z) => boundZoom(Math.round(boundZoom(z) / ZOOM_SNAP + 1e-9) * ZOOM_SNAP);
// A wheel event's zoom change: its delta in pixels times a scale, capped so one mouse notch is one step of 24%.
function wheelZoomDelta(e) {
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  return Math.max(-0.24, Math.min(0.24, -px * 0.0028));
}

// The page's size knob (--ui-scale in styles.css) is the root font size over 16. Lengths here are written at scale 1
// and multiplied by it; board.layout stores positions at scale 1 too, so turning the knob keeps a layout's shape.
export const uiScale = () => parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;
function cssLen(css, name, fallback) {
  const raw = css.getPropertyValue(name).trim();
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return fallback * uiScale();
  return raw.endsWith('rem') ? v * parseFloat(getComputedStyle(document.documentElement).fontSize) : v;
}
const HOUR = 3600_000;

// An agent's color is a palette slot (older logs may hold a hex), so it follows the palette.
export function colorOf(st, agentId) {
  if (agentId === HUMAN) return 'var(--human)';
  return slotVar(st.agents[agentId]?.color, '', 'var(--text-muted)');
}

// A color from the log reaches style attributes, so only a slot name or a hex code passes.
function slotVar(c, suffix, fallback) {
  if (typeof c !== 'string') return fallback;
  if (/^[a-z]{2,16}$/.test(c)) return `var(--slot-${c}${suffix})`;
  if (/^#[0-9a-f]{3,8}$/i.test(c)) return suffix ? '#1a1a1a' : c;
  return fallback;
}

export function inkOf(st, agentId) {
  if (agentId === HUMAN) return 'var(--slot-gray-ink)';
  return slotVar(st.agents[agentId]?.color, '-ink', '#1a1a1a');
}

export function createMap(ctx, root) {
  const slots = new Map();
  const tiles = new Map();
  const sockets = new Map();
  let districts = [];
  let fitKey = '';
  const wrap = root.parentElement;
  // The camera is the viewer's own, kept in the browser. A zoom never set frames the map once it is laid out, and a
  // camera left where Fit put it (fitted) frames it again whenever the map's frame or layout changes.
  const view = storageGet('queuebox.pan', {});
  const pan = { x: Number(view.x) || 0, y: Number(view.y) || 0 };
  let zoom = Number.isFinite(view.z) ? boundZoom(view.z) : NaN;
  let fitted = view.fit !== false;
  const saveView = () => storageSet('queuebox.pan', { x: pan.x, y: pan.y, z: zoom, fit: fitted });
  const phone = () => matchMedia('(max-width: 860px)').matches;
  // Where the person put the districts (board.layout, shared), and a move not yet written back.
  let layout = null;
  let pending = null;
  let holdStill = null;
  // Districts folded to one card, the viewer's own: a view, not a change to the board. Every block inside is still
  // reserved on its own; the card carries what its blocks carry.
  const collapsed = new Set(storageGet('queuebox.collapsed', []));

  function build(board) {
    layout = board.layout?.districts || null;
    pending = null;
    root.textContent = '';
    slots.clear();
    sockets.clear();
    districts = [];
    const byDistrict = new Map(board.districts.map((d) => [d.id, []]));
    for (const b of board.blocks) {
      if (!byDistrict.has(b.district)) byDistrict.set(b.district, []);
      byDistrict.get(b.district).push(b);
    }
    const list = [...board.districts];
    for (const id of byDistrict.keys()) if (!list.find((d) => d.id === id)) list.push({ id, name: id });
    if ((board.unmapped?.files || 0) > 0) {
      list.push({ id: '_unmapped', name: 'Unclaimed' });
      byDistrict.set('_unmapped', [{ id: UNMAPPED, name: 'Unmapped files', district: '_unmapped' }]);
    }
    // A district may sit inside another (`parent`, from splitting a block): it is drawn as a frame inside its
    // parent, after the parent's own tiles. An unknown parent or a loop puts it back at the top.
    const known = new Map(list.map((d) => [d.id, d]));
    const parentOf = (d) => {
      const seen = new Set([d.id]);
      for (let p = d.parent; p; p = known.get(p)?.parent) {
        if (!known.has(p) || seen.has(p)) return null;
        seen.add(p);
      }
      return d.parent && known.has(d.parent) ? d.parent : null;
    };
    const kidsOf = new Map();
    for (const d of list) {
      const p = parentOf(d);
      if (p) kidsOf.set(p, [...(kidsOf.get(p) || []), d.id]);
    }
    const hasBlocks = (id) => (byDistrict.get(id) || []).length > 0 || (kidsOf.get(id) || []).some(hasBlocks);
    const entries = new Map();
    for (const d of list) {
      const blocks = byDistrict.get(d.id) || [];
      if (!hasBlocks(d.id)) continue;
      const grid = h('div', { class: 'district-grid' });
      const fold = h('button', { class: 'd-fold', type: 'button' });
      setHtml(fold, icon('chev'));
      const more = h('button', { class: 'd-more', type: 'button', title: 'More', 'aria-label': `More for ${d.name}`, 'aria-haspopup': 'menu' });
      setHtml(more, icon('dots'));
      const label = h('div', { class: 'district-label' }, fold, h('span', { class: 'd-name' }, d.name), more);
      const sum = h('div', { class: 'dsum', 'data-group': d.id }, h('div', { class: 'tile-name' }, d.name), h('div', { class: 'tile-badges' }), h('div', { class: 'feet' }));
      const kidsEl = h('div', { class: 'd-kids' });
      const el = h('section', { class: 'district', 'data-district': d.id, title: d.about || '' }, label, grid, kidsEl, sum);
      const entry = { id: d.id, name: d.name, el, grid, sum, fold, kidsEl, own: blocks.map((b) => b.id), blocks: [], kids: [], parentId: parentOf(d), up: null };
      entries.set(d.id, entry);
      districts.push(entry);
      fold.addEventListener('click', () => setCollapsed(entry, !collapsed.has(d.id)));
      more.addEventListener('click', () => {
        const r = more.getBoundingClientRect();
        districtMenu(entry, r.left, r.bottom + 4, more);
      });
      label.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        districtMenu(entry, e.clientX, e.clientY, more);
      });
      paintFold(entry);
      for (const b of blocks) {
        const slot = h('div', { class: 'slot', 'data-slot': b.id });
        grid.append(slot);
        slots.set(b.id, slot);
        const tile = tiles.get(b.id) || makeTile(b.id);
        tile.classList.toggle('unmapped', b.id === UNMAPPED);
        const socket = h('div', { class: 'socket', 'data-socket': b.id, hidden: true }, h('div', { class: 'sk-name' }, b.name), h('div', { class: 'sk-foot' }, h('span', { class: 'sk-who' }), h('span', { class: 'sk-time' })));
        socket.addEventListener('click', () => ctx.select(b.id));
        sockets.set(b.id, socket);
        slot.append(socket, tile);
      }
    }
    for (const d of districts) {
      d.up = d.parentId ? entries.get(d.parentId) || null : null;
      if (d.up) d.up.kids.push(d);
    }
    for (const d of districts) (d.up ? d.up.kidsEl : root).append(d.el);
    const allOf = (d) => [...d.own, ...d.kids.flatMap(allOf)];
    for (const d of districts) {
      d.blocks = allOf(d);
      d.depth = 0;
      for (let p = d.up; p; p = p.up) d.depth++;
      d.el.classList.toggle('nested', !!d.up);
    }
    for (const id of [...collapsed]) if (!districts.some((d) => d.id === id)) collapsed.delete(id);
    for (const [id, tile] of tiles) {
      if (slots.has(id)) continue;
      tile.remove();
      tiles.delete(id);
    }
    fitKey = '';
  }

  // Pack the districts, in order, into shelves: a shelf is R tiles tall and each district on it takes
  // ceil(n / R) columns. Which districts share a shelf and how tall each shelf is are chosen together (a small
  // dynamic program over the order) for the least total height that fits the width at full size. The zoom is the
  // camera's, not the packing's: Fit frames whatever the packing made.
  // Phones get two columns everywhere (at the page's size, three truncate the names).
  function fit() {
    const barH = wrap.querySelector('.wt-bar:not([hidden])')?.offsetHeight || 0;
    // A folded district is one card, shown while any of its blocks would be.
    const visible = districts.map((d) => {
      const n = d.blocks.filter((id) => !slots.get(id).hidden).length;
      return collapsed.has(d.id) ? Math.min(1, n) : n;
    });
    const tops = districts.filter((d) => !d.up);
    const placed = pending || layout;
    const key = `${wrap.clientWidth}x${wrap.clientHeight}x${barH}x${visible.join(',')}x${[...collapsed].join(',')}x${placed ? JSON.stringify(placed) : ''}`;
    if (key === fitKey) return;
    fitKey = key;
    districts.forEach((d, i) => {
      d.el.hidden = !visible[i];
    });
    // Only the top-level districts are packed; one inside another takes its parent's columns.
    const shown = tops.filter((d) => visible[districts.indexOf(d)]);
    const inherit = () => {
      for (const d of [...districts].sort((a, b) => a.depth - b.depth)) if (d.up) d.grid.style.setProperty('--cols', d.up.grid.style.getPropertyValue('--cols') || '3');
    };
    root.classList.remove('free');
    root.style.width = root.style.height = '';
    for (const d of districts) d.el.style.left = d.el.style.top = '';
    if (phone()) {
      for (const d of districts) d.grid.style.setProperty('--cols', '2');
      placeShelves([shown]);
      root.style.transform = '';
      wrap.style.backgroundSize = wrap.style.backgroundPosition = '';
      return;
    }
    const css = getComputedStyle(document.documentElement);
    const s = uiScale();
    const uw = cssLen(css, '--unit-w', 128);
    const uh = cssLen(css, '--unit-h', 44);
    const gap = cssLen(css, '--gap', 6);
    const PAD_X = 18 * s;
    const PAD_Y = 34 * s;
    const BETWEEN = 12 * s;
    const W = wrap.clientWidth - 2 * 12 * s;
    const H = wrap.clientHeight - barH - 2 * 12 * s;
    const ns = shown.map((d) => visible[districts.indexOf(d)]);
    const m = ns.length;
    const widthOf = (n, R) => {
      const c = Math.ceil(n / R);
      return c * uw + (c - 1) * gap + PAD_X;
    };
    const shelfH = (R) => R * uh + (R - 1) * gap + PAD_Y;
    const Rmax = Math.min(12, Math.max(1, ...ns));
    // best[i]: the least height for districts i.. onward, and the shelf (end, R) that starts it.
    const best = new Array(m + 1).fill(null);
    best[m] = { h: 0 };
    for (let i = m - 1; i >= 0; i--) {
      for (let R = 1; R <= Rmax; R++) {
        let w = -BETWEEN;
        for (let j = i; j < m; j++) {
          w += BETWEEN + widthOf(ns[j], R);
          // A district too wide even alone is fine only one tile across (it then has to scroll).
          if (w > W && (j > i || Math.ceil(ns[j] / R) > 1)) break;
          const rows = Math.max(...ns.slice(i, j + 1).map((n) => Math.ceil(n / Math.ceil(n / R))));
          const h = shelfH(rows) + (j + 1 < m ? BETWEEN : 0) + best[j + 1].h;
          if (!best[i] || h < best[i].h - 0.5) best[i] = { h, end: j, R };
        }
      }
    }
    const shelves = [];
    for (let i = 0; i < m; ) {
      const { end, R } = best[i];
      const group = shown.slice(i, end + 1);
      group.forEach((d, k) => d.grid.style.setProperty('--cols', String(Math.max(1, Math.ceil(ns[i + k] / R)))));
      shelves.push(group);
      i = end + 1;
    }
    // A district the person sized keeps its columns.
    for (const d of shown) if (placed?.[d.id]?.cols) d.grid.style.setProperty('--cols', String(placed[d.id].cols));
    inherit();
    placeShelves(shelves);
    if (placed && Object.keys(placed).length) freeLayout(shown, placed);
    if (Number.isFinite(zoom) && !(fitted && !lift)) place();
    else frame();
  }

  // Once the person has moved a district the map is free: each district sits where it was put, a district never
  // placed takes its spot from the shelf packing, and then a no-overlap pass (Solenoid's separateUnits) pushes
  // whatever overlaps right or down, the district just dropped holding still, then the placed ones, then the rest
  // from the top-left. Tidy drops the layout and the shelves come back.
  function freeLayout(shown, placed) {
    const s = uiScale();
    const boxes = shown.map((d) => {
      const p = placed[d.id];
      return { d, x: p ? p.x * s : d.el.offsetLeft, y: p ? p.y * s : d.el.offsetTop, w: d.el.offsetWidth, h: d.el.offsetHeight, rank: d.id === holdStill ? 0 : p ? 1 : 2 };
    });
    separate(boxes, SEPARATE_GAP * s);
    root.classList.add('free');
    let right = 0;
    let bottom = 0;
    for (const b of boxes) {
      b.d.el.style.left = `${b.x}px`;
      b.d.el.style.top = `${b.y}px`;
      right = Math.max(right, b.x + b.w);
      bottom = Math.max(bottom, b.y + b.h);
    }
    root.style.width = `${right + 12 * s}px`;
    root.style.height = `${bottom + 12 * s}px`;
  }

  // The current place of every district on the map, as board.layout writes it.
  function snapshot() {
    const out = { ...(pending || layout || {}) };
    const s = uiScale();
    for (const d of districts) {
      if (d.el.hidden || d.up) continue;
      out[d.id] = { x: Math.round(d.el.offsetLeft / s), y: Math.round(d.el.offsetTop / s), cols: Number(d.grid.style.getPropertyValue('--cols')) || 1 };
    }
    return out;
  }

  // Undo for the layout: each change the person makes here (a district dragged, Tidy) keeps the layout it replaced.
  // Undo puts that back, from the toast or Ctrl+Z; Ctrl+Shift+Z (or Ctrl+Y) redoes. A layout is the board's, so
  // undoing writes it like any change.
  const undone = [];
  const redone = [];
  const copy = (l) => (l ? JSON.parse(JSON.stringify(l)) : null);
  function remember(prev) {
    undone.push(prev);
    if (undone.length > 20) undone.shift();
    redone.length = 0;
  }
  async function putLayout(next, said) {
    pending = null;
    layout = copy(next);
    const ok = await ctx.boardOp({ op: 'layout', districts: next });
    if (!ok) return false;
    fitKey = '';
    ctx.render();
    if (said) toast(said);
    return true;
  }
  async function undo() {
    if (!undone.length) return;
    const prev = undone.pop();
    redone.push(copy(layout));
    if (!(await putLayout(prev, 'Undone.'))) redone.pop();
  }
  async function redo() {
    if (!redone.length) return;
    const next = redone.pop();
    undone.push(copy(layout));
    if (!(await putLayout(next, 'Redone.'))) undone.pop();
  }
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || phone()) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey && undone.length) {
      e.preventDefault();
      undo();
    } else if (((k === 'z' && e.shiftKey) || k === 'y') && redone.length) {
      e.preventDefault();
      redo();
    }
  });
  const undoToast = (text) => toast(text, 'info', { action: { label: 'Undo', run: undo } });

  async function saveLayout(next, dragged) {
    const prev = copy(layout);
    pending = next;
    holdStill = dragged;
    fitKey = '';
    fit();
    place();
    holdStill = null;
    const ok = await ctx.boardOp({ op: 'layout', districts: snapshot() });
    if (!ok) {
      pending = null;
      fitKey = '';
      fit();
      place();
    } else {
      remember(prev);
      undoToast(`Moved ${districts.find((x) => x.id === dragged)?.name || 'the district'}.`);
    }
  }

  async function tidy() {
    if (layout || pending) {
      const prev = copy(layout);
      pending = null;
      layout = null;
      if (await ctx.boardOp({ op: 'layout', districts: null })) {
        remember(prev);
        undoToast('Tidied the map.');
      } else layout = prev;
    }
    home();
  }

  // A district moves by its name: drag the label. The drop snaps to the dot grid.
  let lift = null;
  wrap.addEventListener('pointerdown', (e) => {
    const label = e.target.closest('.district-label');
    if (!label || phone() || e.button !== 0 || lift || e.target.closest('button')) return;
    const d = districts.find((x) => x.el === label.parentElement);
    if (!d || d.up) return;
    lift = { d, id: e.pointerId, x: e.clientX, y: e.clientY, moving: false };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!lift || e.pointerId !== lift.id) return;
    const dx = (e.clientX - lift.x) / zoom;
    const dy = (e.clientY - lift.y) / zoom;
    if (!lift.moving) {
      if (Math.hypot(dx, dy) < 4) return;
      lift.moving = true;
      // The first move frees the map where it stands, so nothing else jumps.
      if (!root.classList.contains('free')) {
        pending = snapshot();
        fitKey = '';
        fit();
        place();
      }
      lift.ox = lift.d.el.offsetLeft;
      lift.oy = lift.d.el.offsetTop;
      lift.d.el.classList.add('lifted');
      wrap.classList.add('panning');
      try {
        wrap.setPointerCapture(e.pointerId);
      } catch {
        // The pointer already went away.
      }
    }
    lift.d.el.style.left = `${Math.max(0, lift.ox + dx)}px`;
    lift.d.el.style.top = `${Math.max(0, lift.oy + dy)}px`;
  });
  function drop(e) {
    if (!lift || (e && e.pointerId !== lift.id)) return;
    const { d, moving } = lift;
    lift = null;
    d.el.classList.remove('lifted');
    wrap.classList.remove('panning');
    if (!moving) return;
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    const s = uiScale();
    const snap = (v) => Math.max(0, Math.round(v / s / 10) * 10);
    const next = snapshot();
    next[d.id] = { ...next[d.id], x: snap(d.el.offsetLeft), y: snap(d.el.offsetTop) };
    saveLayout(next, d.id);
  }
  wrap.addEventListener('pointerup', drop);
  wrap.addEventListener('pointercancel', drop);

  // Menus. A block: its details, or split it into sub-blocks drafted from its folders. A district: fold it, or
  // dissolve it into one block. Splitting and dissolving change the board for everyone (board-ops, through the
  // server), which refuses them while a block they touch is reserved by someone else, queued or frozen.
  const reservedElsewhere = (id) => {
    const b = ctx.live?.blocks[id];
    return b?.holder && b.holder !== HUMAN ? agentName(ctx.live, b.holder) : '';
  };

  function blockMenu(id, x, y, back) {
    const meta = blockMeta(ctx.live, id);
    if (!meta || id === UNMAPPED) return;
    const who = reservedElsewhere(id);
    const mine = ctx.live?.blocks[id]?.holder === HUMAN;
    openMenu(
      x,
      y,
      [
        { label: 'Details', act: () => ctx.select(id) },
        // Taking a block yourself is this explicit act, never a drop or a default.
        mine
          ? { label: 'Let Agents In', hint: 'Release it', act: () => ctx.act.release(id) }
          : { label: 'Keep Agents Out', hint: who ? `Reserved by ${who}; takes it back` : 'Reserve it yourself', act: () => ctx.act.assign(id, HUMAN) },
        {
          label: 'Split into Sub-Blocks',
          hint: who ? `Reserved by ${who}` : 'One block per folder',
          disabled: !!who,
          act: () => ctx.boardOp({ op: 'split', block: id }, `Split ${meta.name} into sub-blocks.`),
        },
      ],
      back,
    );
  }

  function districtMenu(d, x, y, back) {
    const who = [...new Set(d.blocks.map(reservedElsewhere).filter(Boolean))];
    const folded = collapsed.has(d.id);
    openMenu(
      x,
      y,
      [
        { label: folded ? 'Expand' : 'Collapse to One Card', hint: 'Only on this screen', act: () => setCollapsed(d, !folded) },
        {
          label: 'Dissolve into One Block',
          hint: who.length ? `Reserved by ${who.join(', ')}` : `${d.blocks.length} blocks become one`,
          disabled: who.length > 0 || d.id.startsWith('_'),
          act: () => ctx.boardOp({ op: 'dissolve', district: d.id }, `Dissolved ${d.name} into one block.`),
        },
      ],
      back,
    );
  }

  let menu = null;
  function closeMenu(refocus) {
    if (!menu) return;
    const { el, back } = menu;
    menu = null;
    el.remove();
    if (refocus) back?.focus();
  }
  function openMenu(x, y, items, back) {
    closeMenu();
    const el = h('div', { class: 'map-menu', role: 'menu' });
    for (const it of items) {
      const btn = h('button', { type: 'button', role: 'menuitem', class: 'map-menu-item' }, h('span', { class: 'mm-label' }, it.label), it.hint ? h('span', { class: 'mm-hint' }, it.hint) : '');
      btn.disabled = !!it.disabled;
      btn.addEventListener('click', () => {
        closeMenu(true);
        it.act();
      });
      el.append(btn);
    }
    document.body.append(el);
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    menu = { el, back };
    el.querySelector('button:not(:disabled)')?.focus();
    el.addEventListener('keydown', (e) => {
      const list = [...el.querySelectorAll('button:not(:disabled)')];
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
      } else if (e.key === 'Tab') closeMenu(false);
    });
  }
  document.addEventListener('pointerdown', (e) => menu && !menu.el.contains(e.target) && closeMenu(false), true);
  escapeLayer(ESC.menu, () => !!menu, () => closeMenu(true));
  window.addEventListener('blur', () => closeMenu(false));
  document.addEventListener('contextmenu', (e) => {
    if (phone() || e.defaultPrevented) return;
    const tile = e.target.closest('.tile[data-block]');
    if (tile) {
      e.preventDefault();
      blockMenu(tile.dataset.block, e.clientX, e.clientY, tile);
    } else if (wrap.contains(e.target) && !e.target.closest(`${NOT_CANVAS}, .socket`)) {
      e.preventDefault();
      canvasMenu(e.clientX, e.clientY);
    }
  });

  // The empty canvas's menu: the camera and the folds, all the viewer's own, and Tidy.
  function canvasMenu(x, y) {
    const shown = districts.filter((d) => !d.el.hidden || collapsed.has(d.id));
    const anyOpen = shown.some((d) => !collapsed.has(d.id));
    const anyFolded = shown.some((d) => collapsed.has(d.id));
    openMenu(x, y, [
      { label: 'Fit', act: home },
      { label: 'Zoom to 100%', disabled: zoom === 1, act: () => zoomBy(1 / zoom) },
      { label: 'Tidy', act: tidy },
      { label: 'Collapse All', hint: 'Only on this screen', disabled: !anyOpen, act: () => foldAll(true) },
      { label: 'Expand All', hint: 'Only on this screen', disabled: !anyFolded, act: () => foldAll(false) },
    ]);
  }
  function foldAll(on) {
    for (const d of districts) {
      if (on) collapsed.add(d.id);
      else collapsed.delete(d.id);
      paintFold(d);
    }
    storageSet('queuebox.collapsed', [...collapsed]);
    fitKey = '';
    ctx.render();
  }

  // The camera: the map is one layer moved and scaled by a transform inside its frame. A drag on empty canvas pans it
  // (a finger may start on a tile too: a swipe pans, a long press still drags the tile). The wheel zooms at the
  // cursor, a trackpad's two-finger scroll and pinch included; it never pans. The buttons zoom about the middle, and
  // Fit frames the whole map. A double-click on the canvas does nothing. Phones keep the flowing page instead.
  function clampPan() {
    const w = root.offsetWidth * zoom;
    const hh = root.offsetHeight * zoom;
    const keep = 80;
    pan.x = Math.round(Math.min(Math.max(pan.x, keep - w), wrap.clientWidth - keep));
    pan.y = Math.round(Math.min(Math.max(pan.y, keep - hh), wrap.clientHeight - keep));
  }

  function place() {
    if (phone()) return;
    clampPan();
    root.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    // Far out, a tile is its name and its color: badges and discs are too small to read (Solenoid's semantic zoom).
    wrap.classList.toggle('far', zoom < 0.55);
    paintMini();
    // The dot grid is the canvas, so it moves and scales with the map.
    const g = 20 * uiScale() * zoom;
    wrap.style.backgroundSize = `${g}px ${g}px`;
    wrap.style.backgroundPosition = `${pan.x + root.offsetLeft}px ${pan.y + root.offsetTop}px`;
    wrap.dispatchEvent(new Event('map:pan'));
  }

  let swallowClick = false;
  let saveTimer = 0;

  // Zoom to z keeping the screen point (sx, sy) where it is. The layer's origin is its top-left corner, so a point
  // d pixels right of it on screen moves to d * z / zoom.
  function zoomAt(z, sx, sy) {
    z = boundZoom(z);
    if (phone() || !Number.isFinite(zoom) || z === zoom) return;
    closeMenu(false);
    const r = root.getBoundingClientRect();
    pan.x += (sx - r.left) * (1 - z / zoom);
    pan.y += (sy - r.top) * (1 - z / zoom);
    zoom = z;
    fitted = false;
    place();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveView, 250);
  }
  function zoomBy(f) {
    const r = wrap.getBoundingClientRect();
    const barH = wrap.querySelector('.wt-bar:not([hidden])')?.offsetHeight || 0;
    zoomAt(zoom * f, r.left + r.width / 2, r.top + barH + (r.height - barH) / 2);
  }

  // The minimap, after Solenoid's: shown only while some of the map is off screen. A frame of fixed size (the same
  // shape whatever the layout) shows the districts and their tiles, reserved tiles in their holder's color, and the
  // part in view. It is scaled to hold both the map and the view, so the view's rectangle is always whole. Pressing
  // or dragging on it brings that point to the middle.
  const mini = h('div', { class: 'map-mini', hidden: true, 'aria-hidden': 'true' });
  const miniView = h('div', { class: 'mm-view' });
  wrap.append(mini);
  const miniMap = { scale: 1, ox: 0, oy: 0 };
  // The size of everything shown, in map units, for Fit.
  function contentSize() {
    let w = 0;
    let hh = 0;
    for (const d of districts) {
      if (d.up || d.el.hidden) continue;
      w = Math.max(w, d.el.offsetLeft + d.el.offsetWidth);
      hh = Math.max(hh, d.el.offsetTop + d.el.offsetHeight);
    }
    const pad = 12 * uiScale();
    return { w: w + pad, h: hh + pad };
  }
  // An element's box in map units (unzoomed, from the map's top-left), whatever positions it.
  function mapBox(el, rootRect) {
    const r = el.getBoundingClientRect();
    return { x: (r.left - rootRect.left) / zoom, y: (r.top - rootRect.top) / zoom, w: r.width / zoom, h: r.height / zoom };
  }
  function paintMini() {
    if (phone() || !Number.isFinite(zoom) || zoom <= 0) return void (mini.hidden = true);
    const rootRect = root.getBoundingClientRect();
    const shown = districts.filter((d) => !d.el.hidden && d.el.offsetParent);
    const boxes = shown.map((d) => ({ d, ...mapBox(d.el, rootRect) }));
    if (!boxes.length) return void (mini.hidden = true);
    const pad = 12 * uiScale();
    const w = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
    const hh = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
    const barH = wrap.querySelector('.wt-bar:not([hidden])')?.offsetHeight || 0;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight - barH;
    const inView = pan.x >= -1 && pan.y >= -1 && pan.x + w * zoom <= W + 1 && pan.y + hh * zoom <= H + 1;
    mini.hidden = inView;
    if (mini.hidden) return;
    // The view in map units, and the world the frame shows: the map and the view together.
    const view = { x: -pan.x / zoom, y: -pan.y / zoom, w: W / zoom, h: H / zoom };
    const x0 = Math.min(0, view.x);
    const y0 = Math.min(0, view.y);
    const x1 = Math.max(w, view.x + view.w);
    const y1 = Math.max(hh, view.y + view.h);
    const MW = 168 * uiScale();
    const MH = 104 * uiScale();
    const scale = Math.min(MW / (x1 - x0), MH / (y1 - y0));
    miniMap.scale = scale;
    miniMap.ox = (MW - (x1 - x0) * scale) / 2 - x0 * scale;
    miniMap.oy = (MH - (y1 - y0) * scale) / 2 - y0 * scale;
    mini.style.width = `${Math.round(MW)}px`;
    mini.style.height = `${Math.round(MH)}px`;
    const at = (b) => `left:${(miniMap.ox + b.x * scale).toFixed(1)}px;top:${(miniMap.oy + b.y * scale).toFixed(1)}px;width:${Math.max(1, b.w * scale).toFixed(1)}px;height:${Math.max(1, b.h * scale).toFixed(1)}px`;
    const st = ctx.view;
    const parts = [];
    for (const b of boxes) {
      parts.push(`<i class="mm-d" style="${at(b)}"></i>`);
      if (collapsed.has(b.d.id)) continue;
      for (const id of b.d.own) {
        const slot = slots.get(id);
        if (!slot || slot.hidden || !slot.offsetParent) continue;
        const holder = st?.blocks[id]?.holder;
        const color = holder ? colorOf(st, holder) : '';
        parts.push(`<i class="mm-t${holder ? ' held' : ''}" style="${at(mapBox(slot, rootRect))}${color ? `;--mc:${color}` : ''}"></i>`);
      }
    }
    setHtml(mini, parts.join(''));
    Object.assign(miniView.style, { left: `${miniMap.ox + view.x * scale}px`, top: `${miniMap.oy + view.y * scale}px`, width: `${view.w * scale}px`, height: `${view.h * scale}px` });
    mini.append(miniView);
  }
  function miniGo(e) {
    const r = mini.getBoundingClientRect();
    const mx = (e.clientX - r.left - miniMap.ox) / miniMap.scale;
    const my = (e.clientY - r.top - miniMap.oy) / miniMap.scale;
    const barH = wrap.querySelector('.wt-bar:not([hidden])')?.offsetHeight || 0;
    pan.x = wrap.clientWidth / 2 - mx * zoom;
    pan.y = (wrap.clientHeight - barH) / 2 - my * zoom;
    fitted = false;
    place();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveView, 250);
  }
  mini.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    mini.setPointerCapture?.(e.pointerId);
    miniGo(e);
    const move = (ev) => miniGo(ev);
    const up = () => {
      mini.removeEventListener('pointermove', move);
      mini.removeEventListener('pointerup', up);
      mini.removeEventListener('pointercancel', up);
    };
    mini.addEventListener('pointermove', move);
    mini.addEventListener('pointerup', up);
    mini.addEventListener('pointercancel', up);
  });

  // Fit: the zoom that frames every shown district in the space under the worktree strip, centered, at most 150%.
  function frame() {
    if (phone()) return;
    const { w, h: hh } = contentSize();
    const barH = wrap.querySelector('.wt-bar:not([hidden])')?.offsetHeight || 0;
    const W = Math.max(60, wrap.clientWidth);
    const H = Math.max(60, wrap.clientHeight - barH);
    zoom = boundZoom(Math.min(W / w, H / hh, 1.5) * 0.97);
    fitted = true;
    pan.x = (W - w * zoom) / 2;
    pan.y = (H - hh * zoom) / 2;
    place();
    saveView();
  }

  function home() {
    fitKey = '';
    fit();
    frame();
  }

  const NOT_CANVAS = '.wt-bar, .map-ctrl, .map-mini, .district-label, button, input, select, textarea, a, [contenteditable]';
  let grab = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (phone() || grab || e.target.closest(NOT_CANVAS)) return;
    const onTile = !!e.target.closest('.tile');
    // A mouse on a tile drags the tile; the middle button pans from anywhere.
    if (e.pointerType === 'mouse' ? !(e.button === 1 || (e.button === 0 && !onTile)) : !e.isPrimary) return;
    grab = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, panning: false, slop: e.pointerType === 'mouse' ? 4 : 9 };
  });
  // Two fingers pinch the map, after Solenoid's flowPinch: unsnapped, the point between the fingers staying under
  // them, and nothing under the fingers can stop it. A pinch cancels a pending pan or tile press, and the click it
  // ends on within 400 ms is swallowed.
  const touches = new Map();
  let pinch = null;
  let pinchEnded = 0;
  const midDist = () => {
    const [a, b] = [...touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  wrap.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch' || phone()) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size !== 2 || !Number.isFinite(zoom)) return;
      grab = null;
      wrap.classList.remove('panning');
      document.dispatchEvent(new PointerEvent('pointercancel'));
      const m = midDist();
      const r = root.getBoundingClientRect();
      pinch = { z0: zoom, m0: m, left: r.left - pan.x, top: r.top - pan.y, ox: m.x - r.left, oy: m.y - r.top };
      closeMenu(false);
    },
    true,
  );
  wrap.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch || touches.size !== 2) return;
    const m = midDist();
    const z = boundZoom(pinch.z0 * (m.d / pinch.m0.d));
    pan.x = m.x - pinch.left - pinch.ox * (z / pinch.z0);
    pan.y = m.y - pinch.top - pinch.oy * (z / pinch.z0);
    zoom = z;
    fitted = false;
    place();
  });
  const liftFinger = (e) => {
    if (!touches.delete(e.pointerId) || !pinch) return;
    pinch = null;
    pinchEnded = Date.now();
    saveView();
  };
  wrap.addEventListener('pointerup', liftFinger);
  wrap.addEventListener('pointercancel', liftFinger);
  wrap.addEventListener(
    'click',
    (e) => {
      if (Date.now() - pinchEnded > 400) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );

  // Held Space pans from anywhere on the map, a tile or a district's name included, as the middle button does. It is
  // taken before the tile drag and the district lift see the press. A Space typed into a field, or pressed on a
  // focused tile or button (which it activates), is left alone.
  let spaceDown = false;
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || phone() || e.target.closest?.('input, textarea, select, button, a, [contenteditable], [role="button"], [role="menuitem"]')) return;
    e.preventDefault();
    spaceDown = true;
  });
  document.addEventListener('keyup', (e) => e.code === 'Space' && (spaceDown = false));
  window.addEventListener('blur', () => (spaceDown = false));
  wrap.addEventListener(
    'pointerdown',
    (e) => {
      if (!spaceDown || phone() || grab || e.button !== 0 || e.target.closest('.wt-bar, .map-ctrl')) return;
      e.stopPropagation();
      e.preventDefault();
      grab = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, panning: false, slop: 4 };
    },
    true,
  );
  // The middle button pans here, so the browser's autoscroll must not start.
  wrap.addEventListener('mousedown', (e) => e.button === 1 && !phone() && e.preventDefault());
  wrap.addEventListener('pointermove', (e) => {
    if (!grab || e.pointerId !== grab.id || pinch) return;
    if (ctx.dnd?.active) return endPan();
    const dx = e.clientX - grab.x;
    const dy = e.clientY - grab.y;
    if (!grab.panning) {
      if (Math.hypot(dx, dy) < grab.slop) return;
      grab.panning = true;
      closeMenu(false);
      wrap.classList.add('panning');
      try {
        wrap.setPointerCapture(e.pointerId);
      } catch {
        // The pointer already went away.
      }
    }
    fitted = false;
    pan.x = grab.px + dx;
    pan.y = grab.py + dy;
    place();
  });
  function endPan(e) {
    if (!grab || (e && e.pointerId !== grab.id)) return;
    if (grab.panning) {
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
      saveView();
    }
    wrap.classList.remove('panning');
    grab = null;
  }
  wrap.addEventListener('pointerup', endPan);
  wrap.addEventListener('pointercancel', endPan);
  wrap.addEventListener('lostpointercapture', endPan);
  // The click that ends a pan selects nothing.
  wrap.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  // Solenoid's flowWheel: the raw zoom runs on hidden, so a trackpad's small deltas add up, and what shows is that
  // value on its 10% step. A Ctrl+wheel (a trackpad pinch) takes the same path, so it never zooms the page.
  let rawZoom = NaN;
  let lastZoom = NaN;
  wrap.addEventListener(
    'wheel',
    (e) => {
      if (phone() || e.target.closest('.wt-bar')) return;
      e.preventDefault();
      if (!Number.isFinite(zoom)) return;
      if (zoom !== lastZoom) rawZoom = zoom;
      rawZoom = boundZoom(rawZoom * (1 + wheelZoomDelta(e)));
      lastZoom = snapZoom(rawZoom);
      zoomAt(lastZoom, e.clientX, e.clientY);
    },
    { passive: false },
  );

  const fitBtn = h('button', { class: 'icon-btn map-fit', type: 'button', title: 'Fit the map', 'aria-label': 'Fit the map' });
  setHtml(fitBtn, icon('fit'));
  fitBtn.addEventListener('click', home);
  const tidyBtn = h('button', { class: 'icon-btn map-tidy', type: 'button', title: 'Tidy: pack the districts again (T)', 'aria-label': 'Tidy the map' });
  setHtml(tidyBtn, icon('tidy'));
  tidyBtn.addEventListener('click', tidy);
  const zoomBtn = (label, path, f) => {
    const b = h('button', { class: 'icon-btn map-zoom', type: 'button', title: label, 'aria-label': label });
    setHtml(b, `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`);
    b.addEventListener('click', () => zoomBy(f));
    return b;
  };
  const outBtn = zoomBtn('Zoom out', 'M3.5 8h9', 1 / ZOOM_STEP);
  const inBtn = zoomBtn('Zoom in', 'M3.5 8h9M8 3.5v9', ZOOM_STEP);
  wrap.append(h('div', { class: 'map-ctrl' }, tidyBtn, outBtn, inBtn, fitBtn));

  // Each shelf is a row of its own, so the rows break where the packing decided, not where flex would.
  function placeShelves(groups) {
    const rows = [...root.querySelectorAll(':scope > .shelf')];
    groups.forEach((group, i) => {
      let row = rows[i];
      if (!row) {
        row = h('div', { class: 'shelf' });
        root.append(row);
        rows.push(row);
      }
      group.forEach((d, k) => {
        if (row.children[k] !== d.el) row.insertBefore(d.el, row.children[k] || null);
      });
    });
    for (const d of districts) if (!d.up && d.el.hidden && d.el.parentElement !== root) root.append(d.el);
    rows.slice(groups.length).forEach((r) => r.remove());
  }

  // A changed tile's bar (T61): one segment per agent, as wide as its lines there, in its color; hollow while
  // uncommitted, solid once committed, solid with a check once queued to merge. Where two agents changed the same
  // files the seams between their segments are red. Under Changes an unchanged tile steps back.
  function paintChanges(st, tile, chg, on) {
    toggle(tile, 'unchanged', on && !chg);
    let bar = tile.querySelector(':scope > .chg-bar');
    if (!on || !chg) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = h('div', { class: 'chg-bar', 'aria-hidden': 'true' });
      tile.append(bar);
    }
    toggle(bar, 'overlap', chg.overlap.length > 0);
    setHtml(
      bar,
      chg.agents
        .map((a) => `<i class="seg ${a.stage}" style="flex-grow:${Math.max(1, a.add + a.del)};--sc:${a.agent ? colorOf(st, a.agent) : 'var(--text-dim)'}"></i>`)
        .join(''),
    );
  }

  function makeTile(id) {
    const tile = h(
      'div',
      { class: 'tile', 'data-block': id, tabindex: '0', role: 'button' },
      h('div', { class: 'tile-name' }),
      h('div', { class: 'tile-badges' }),
      h('div', { class: 'feet' }),
      h('span', { class: 'pulse', hidden: true }),
    );
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ctx.select(id);
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const r = tile.getBoundingClientRect();
        blockMenu(id, r.left + 8, r.bottom + 4, tile);
      }
    });
    tiles.set(id, tile);
    return tile;
  }

  // Whether a block has anything going on, for the active-only view.
  function active(st, id, now, c, wtEntry) {
    const b = st.blocks[id];
    if (b.holder || b.queued || b.frozen || wtEntry || ctx.selected === id) return true;
    if (b.test && !b.test.ok && now - b.test.ts < 6 * HOUR) return true;
    const last = b.touches[b.touches.length - 1];
    if (last && now - last.ts < 2 * HOUR) return true;
    // Open bugs and your calls keep a block in view; tasks alone don't, or nearly every block would.
    return c.bug + c.decision + c.question > 0;
  }

  function paint() {
    const st = ctx.view;
    const now = ctx.viewNow;
    const q = ctx.search;
    const lens = ctx.lens;
    // Changes (T61): what hasn't landed, per block, from every checkout.
    const changes = lens === 'changes' && !ctx.replayTs ? changesByBlock(st, ctx.worktrees) : null;
    const trespass = new Set(ctx.alertList.filter((a) => a.kind === 'trespass' || a.kind === 'frozen').map((a) => a.block));
    const focusBlocks = ctx.focusWt ? ctx.wtIndex?.byTree.get(ctx.focusWt) : null;
    const focusTree = ctx.focusWt ? ctx.worktrees?.list.find((w) => w.name === ctx.focusWt) : null;
    const groupOf = new Map();
    // A block inside folded districts shows on the outermost one's card.
    for (const d of [...districts].sort((a, b) => a.depth - b.depth)) if (collapsed.has(d.id)) for (const id of d.blocks) if (!groupOf.has(id)) groupOf.set(id, d.id);
    const agg = new Map();
    for (const [id, tile] of tiles) {
      const meta = blockMeta(st, id) || { name: id };
      const b = st.blocks[id];
      if (!b) continue;
      const c = itemCounts(st, id);
      const hv = heat(b, now);
      const wtEntry = ctx.wtIndex?.byBlock.get(id);
      const [nameEl, badgesEl, feetEl, pulse] = tile.children;
      if (nameEl.textContent !== meta.name) nameEl.textContent = meta.name;
      const inTray = !!tile.closest('.tray');

      const slot = slots.get(id);
      if (slot) slot.hidden = !!ctx.activeOnly && !active(st, id, now, c, wtEntry) && !inTray;

      const parts = [];
      // A collision is red only where git says the merge would conflict: with the base, or between two
      // branches. Branches that merely touch the same block show their count, uncolored.
      const clash = wtEntry && (wtEntry.conflict || wtEntry.clash);
      if (trespass.has(id)) parts.push(`<span class="badge danger" title="Edited by an agent that hasn't reserved it">${icon('conflict')}</span>`);
      if (clash) parts.push(`<span class="badge danger" title="Will conflict at merge">${icon('branch')}${wtEntry.trees.length}</span>`);
      else if (wtEntry && wtEntry.trees.length >= 2) parts.push(`<span class="badge" title="Changed in several worktrees">${icon('branch')}${wtEntry.trees.length}</span>`);
      if (b.test && !b.test.ok && now - b.test.ts < 6 * HOUR) parts.push(`<span class="badge danger" title="Tests fail">${icon('cross')}</span>`);
      if (c.bug) parts.push(`<span class="badge danger" title="Open bugs">${icon('bug')}${c.bug}</span>`);
      // Every open kind, in every lens (T27): bugs red, your calls gold, tasks neutral.
      if (c.decision + c.question) parts.push(`<span class="badge you" title="Your call">${icon('decision')}${c.decision + c.question}</span>`);
      if (c.task) parts.push(`<span class="badge" title="Open tasks">${icon('task')}${c.task}</span>`);
      if (b.frozen) parts.push(`<span class="badge" title="Frozen">${icon('lock')}</span>`);
      const watchers = Object.keys(b.watchers);
      if (watchers.length) parts.push(`<span class="badge" title="Watched">${icon('eye')}${watchers.length}</span>`);
      const chg = changes?.get(id);
      if (chg) {
        parts.push(`<span class="badge chg-total">+${chg.add} −${chg.del}</span>`);
        if (chg.overlap.length) parts.push(`<span class="badge danger">${chg.overlap.length} ${chg.overlap.length === 1 ? 'file overlaps' : 'files overlap'}</span>`);
      }
      if (inTray && b.holder) parts.push(timer(b.since, { cls: 'badge', warn: 2 * HOUR }, now));
      else if (inTray && b.queued) parts.push(timer(b.queued.ts, { cls: 'badge' }, now));
      setHtml(badgesEl, parts.join(''));

      const toucher = recentToucher(b, now, HOUR);
      const feet = lens === 'heat' ? footprints(b, now, 45 * 60_000).slice(0, 4) : [];
      setHtml(feetEl, feet.map((a) => `<i style="--fc:${colorOf(st, a)};--fci:${inkOf(st, a)}" title="Passed through">${esc(initials(agentName(st, a)))}</i>`).join(''));
      paintChanges(st, tile, chg, lens === 'changes');
      tile.style.setProperty('--feet', String(feet.length));
      tile.style.setProperty('--tc', toucher && lens === 'heat' ? colorOf(st, toucher) : 'var(--text-muted)');
      const last = b.touches[b.touches.length - 1];
      // The dot says someone is working here now: an edit in the last three minutes by an agent still working,
      // not one that has since gone idle or stopped (T68).
      pulse.hidden = !(last && now - last.ts < 3 * 60_000 && last.agent && presence(st, last.agent, now) === 'working');

      let lv = 0;
      let lc = '';
      // Heat tints the whole tile in the color of whoever edited last, at one of three strengths by how much and how
      // lately (the Tinted-Box Rule: a colored edge only around a tinted inside).
      if (lens === 'heat' && toucher) {
        lv = hv >= 2 ? 36 : hv >= 0.8 ? 26 : hv > 0.15 ? 16 : 0;
        lc = colorOf(st, toucher);
      }
      // A focused worktree lights its blocks in its agent's color; shared by several, in the one who changed it.
      if (focusBlocks?.has(id) && focusTree?.agents?.length) {
        const who = agentsInBlock(st, focusTree, id);
        lc = who.length === 1 ? colorOf(st, who[0]) : 'var(--text-dim)';
        lv = 26;
      }
      tile.style.setProperty('--lv', `${Math.round(lv)}%`);
      tile.style.setProperty('--lc', lc || 'var(--surface)');
      toggle(tile, 'tinted', lv > 0);
      toggle(tile, 'frozen', !!b.frozen);
      toggle(tile, 'conflict', trespass.has(id) || !!clash);
      toggle(tile, 'selected', ctx.selected === id);
      const matched = q ? q.matches.has(id) : false;
      const inFocus = focusBlocks ? focusBlocks.has(id) : true;
      toggle(tile, 'dim', (!!q && !matched) || !inFocus);
      toggle(tile, 'match', !!q && matched && q.exact);
      tile.title = meta.name;

      const socket = sockets.get(id);
      if (socket) paintSocket(st, now, socket, b);

      const gid = groupOf.get(id);
      if (gid) {
        if (!agg.has(gid)) agg.set(gid, { n: 0, conflict: 0, fail: 0, bug: 0, calls: 0, task: 0, frozen: 0, queued: 0, holders: new Set(), match: false, any: false, selected: false, lv: 0, lc: '' });
        const g = agg.get(gid);
        g.n++;
        if (trespass.has(id) || clash) g.conflict++;
        if (b.test && !b.test.ok && now - b.test.ts < 6 * HOUR) g.fail++;
        g.bug += c.bug;
        g.calls += c.decision + c.question;
        g.task += c.task;
        if (b.frozen) g.frozen++;
        if (b.queued && !b.holder) g.queued++;
        if (b.holder) g.holders.add(b.holder);
        if (q && matched) g.match = true;
        if (!tile.classList.contains('dim')) g.any = true;
        if (ctx.selected === id) g.selected = true;
        if (lv > g.lv) {
          g.lv = lv;
          g.lc = lc;
        }
      }
    }
    for (const d of districts) if (collapsed.has(d.id)) paintSummary(st, d, agg.get(d.id), lens);
  }

  function paintSummary(st, d, g, lens) {
    if (!g) return;
    const [, badgesEl, feetEl] = d.sum.children;
    const parts = [`<span class="badge">${g.n} blocks</span>`];
    if (g.conflict) parts.push(`<span class="badge danger" title="Conflicts">${icon('conflict')}${g.conflict}</span>`);
    if (g.fail) parts.push(`<span class="badge danger" title="Failing tests">${icon('cross')}${g.fail}</span>`);
    if (g.bug) parts.push(`<span class="badge danger" title="Open bugs">${icon('bug')}${g.bug}</span>`);
    if (g.calls) parts.push(`<span class="badge you" title="Your call">${icon('decision')}${g.calls}</span>`);
    if (g.task) parts.push(`<span class="badge" title="Open tasks">${icon('task')}${g.task}</span>`);
    if (g.queued) parts.push(`<span class="badge" title="Up next">${icon('queue')}${g.queued}</span>`);
    if (g.frozen) parts.push(`<span class="badge" title="Frozen">${icon('lock')}${g.frozen}</span>`);
    setHtml(badgesEl, parts.join(''));
    const holders = [...g.holders];
    setHtml(feetEl, holders.slice(0, 4).map((a) => `<i style="--fc:${colorOf(st, a)};--fci:${inkOf(st, a)}" title="Reserves a block here">${esc(initials(agentName(st, a)))}</i>`).join(''));
    d.sum.style.setProperty('--lv', `${Math.round(g.lv)}%`);
    d.sum.style.setProperty('--lc', g.lc || 'var(--surface)');
    toggle(d.sum, 'conflict', g.conflict > 0);
    toggle(d.sum, 'selected', g.selected);
    toggle(d.sum, 'dim', !g.any);
    toggle(d.sum, 'match', g.match);
    d.sum.title = 'Collapsed district';
  }

  function paintFold(d) {
    const on = collapsed.has(d.id);
    d.el.classList.toggle('collapsed', on);
    d.fold.setAttribute('aria-expanded', String(!on));
    d.fold.setAttribute('aria-label', `${on ? 'Expand' : 'Collapse'} ${d.name}`);
    d.fold.title = on ? 'Expand' : 'Collapse to one card';
  }

  function setCollapsed(d, on) {
    if (on) collapsed.add(d.id);
    else collapsed.delete(d.id);
    storageSet('queuebox.collapsed', [...collapsed]);
    paintFold(d);
    fitKey = '';
    ctx.render();
  }

  function paintSocket(st, now, socket, b) {
    const away = !!(b.holder || b.queued?.whole);
    socket.hidden = !away;
    toggle(socket, 'selected', ctx.selected === b.id);
    if (!away) return;
    const [, foot] = socket.children;
    const [who, time] = foot.children;
    if (b.holder) {
      const a = st.agents[b.holder];
      socket.style.setProperty('--sc', colorOf(st, b.holder));
      socket.style.setProperty('--sci', inkOf(st, b.holder));
      socket.classList.remove('queued');
      socket.classList.add('held');
      toggle(socket, 'stale', isStale(st, b.holder, now));
      socket.title = 'Reserved';
      setHtml(who, `<span class="dot">${esc(initials(a?.name))}</span><span class="sk-agent">${esc(a?.name || '')}</span>`);
      setHtml(time, timer(b.since, { warn: 2 * HOUR }, now));
    } else {
      socket.style.removeProperty('--sc');
      socket.classList.add('queued');
      socket.classList.remove('stale', 'held');
      socket.title = 'Up next';
      setHtml(who, '<span class="sk-agent">Next</span>');
      setHtml(time, timer(b.queued.ts, {}, now));
    }
  }

  return { build, paint, fit, home, tidy, collapsed, refit: () => (fitKey = ''), tiles, slots, sockets, get zoom() { return phone() || !Number.isFinite(zoom) ? 1 : zoom; } };
}

// The no-overlap pass, after Solenoid's separateUnits: boxes are placed one at a time (by rank, then from the
// top-left), and each, while it overlaps one already placed, moves right or down, whichever is shorter, to clear
// the one it overlaps most. Moves only go right or down, so it always ends.
const SEPARATE_GAP = 12;
export function separate(boxes, gap = SEPARATE_GAP) {
  const order = [...boxes].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.x + a.y - (b.x + b.y));
  const placed = [];
  for (const b of order) {
    for (let guard = 0; guard < 1000; guard++) {
      let worst = null;
      let most = 0;
      for (const o of placed) {
        const ox = Math.min(b.x + b.w + gap, o.x + o.w + gap) - Math.max(b.x, o.x);
        const oy = Math.min(b.y + b.h + gap, o.y + o.h + gap) - Math.max(b.y, o.y);
        if (ox > 0 && oy > 0 && ox * oy > most) {
          most = ox * oy;
          worst = o;
        }
      }
      if (!worst) break;
      const right = worst.x + worst.w + gap - b.x;
      const down = worst.y + worst.h + gap - b.y;
      if (right <= down) b.x += right;
      else b.y += down;
    }
    placed.push(b);
  }
  return boxes;
}
