// Dragging tiles between the map, the agent windows and the queue. Pointer events, so a mouse
// drags at once and a finger drags after a long press (a plain swipe still scrolls the page).

import { HUMAN, UNMAPPED } from '../core/model.js';

export function enableDnd(ctx) {
  let press = null;
  let ghost = null;
  let over = null;

  const dist = (e) => Math.hypot(e.clientX - press.x, e.clientY - press.y);

  document.addEventListener('pointerdown', (e) => {
    // A block's tile, or an item's row (in an agent's window, Up next or a list): both drag.
    const tile = e.target.closest('.tile, [data-drag-item]');
    if (!tile || e.button !== 0 || e.target.closest('input,button,select,textarea')) return;
    press = { id: tile.dataset.block, item: tile.dataset.dragItem || '', x: e.clientX, y: e.clientY, el: tile, touch: e.pointerType !== 'mouse', armed: e.pointerType === 'mouse', dragging: false };
    if (press.touch) {
      press.timer = setTimeout(() => {
        if (!press) return;
        press.armed = true;
        begin(e);
        try {
          navigator.vibrate?.(8);
        } catch {
          // No vibration here.
        }
      }, 340);
    }
  });

  document.addEventListener('pointermove', (e) => {
    if (!press) return;
    if (!press.dragging) {
      if (press.touch && !press.armed && dist(e) > 9) return cancel();
      if (!press.touch && dist(e) > 5) begin(e);
      return;
    }
    move(e);
  });

  // Once a finger drag is armed, the page must not scroll under it.
  document.addEventListener(
    'touchmove',
    (e) => {
      if (press?.dragging) e.preventDefault();
    },
    { passive: false },
  );

  document.addEventListener('pointerup', (e) => {
    if (!press) return;
    if (press.dragging) drop(e);
    else if (dist(e) < 8 && !press.item) ctx.select(press.id);
    cancel();
  });
  document.addEventListener('pointercancel', () => press && !press.dragging && cancel());

  function begin(e) {
    if (ctx.replayTs) {
      ctx.toast('Back to live to move blocks.');
      return cancel();
    }
    if (press.item) {
      const it = ctx.view.items[press.item];
      if (!it || ['done', 'wontfix'].includes(it.status)) return cancel();
      return lift(e);
    }
    const st = ctx.view.blocks[press.id];
    // Unmapped files are no block to move, but their queued items are work to hand out: that tile drags while it's queued.
    if (!st || (press.id.startsWith('_') && !(press.id === UNMAPPED && st.queued))) return cancel();
    if (st.frozen) {
      ctx.toast('Frozen. Unfreeze it in its details first.');
      return cancel();
    }
    lift(e);
  }

  function lift(e) {
    press.dragging = true;
    // The press that became a drag mustn't have started selecting the text it crossed.
    document.getSelection()?.removeAllRanges();
    ghost = press.el.cloneNode(true);
    ghost.classList.add('ghost');
    // A row is carried at its own size, from where it was grabbed; a tile, centred under the pointer.
    if (press.item) {
      const r = press.el.getBoundingClientRect();
      press.grab = { x: press.x - r.left, y: press.y - r.top };
      ghost.style.width = `${r.width}px`;
      ghost.style.height = `${r.height}px`;
    }
    ghost.classList.remove('selected', 'dim', 'match');
    ghost.removeAttribute('tabindex');
    document.body.append(ghost);
    press.el.classList.add('dragging');
    document.body.classList.add('dragging-tile');
    move(e);
  }

  function move(e) {
    ghost.style.left = `${e.clientX - (press.grab?.x || 0)}px`;
    ghost.style.top = `${e.clientY - (press.grab?.y || 0)}px`;
    const target = targetAt(e.clientX, e.clientY);
    if (target?.el !== over?.el || target?.before !== over?.before) {
      over?.el.classList.remove('drop-ok');
      over?.slot?.classList.remove('drop-before');
      over = target;
      over?.el.classList.add('drop-ok');
      over?.slot?.classList.add('drop-before');
    }
  }

  function targetAt(x, y) {
    ghost.hidden = true;
    const hit = document.elementFromPoint(x, y);
    ghost.hidden = false;
    const el = hit?.closest('[data-drop]');
    if (!el) return null;
    // A tile from the map, over a district, goes into it: before the slot it's over, or at the end.
    if (el.dataset.drop === 'map' && press.el.closest('.map')) {
      const district = hit?.closest('.district[data-district]');
      if (district && !district.dataset.district.startsWith('_')) {
        const slot = hit.closest('.slot[data-slot]');
        const before = slot && slot.dataset.slot !== press.id ? slot.dataset.slot : null;
        return { kind: 'map', el: district, district: district.dataset.district, before, slot: before ? slot : null, onSelf: slot?.dataset.slot === press.id };
      }
    }
    // Dropping never makes the person a block's holder: that is an explicit act ("Keep agents out"), not a drop.
    if (el.dataset.drop === `agent:${HUMAN}`) return null;
    return { kind: el.dataset.drop, el: el.closest('.win') || el };
  }

  function drop(e) {
    const target = targetAt(e.clientX, e.clientY);
    if (press.item) return dropItem(target);
    const id = press.id;
    const b = ctx.view.blocks[id];
    if (!target) return;
    if (target.kind === 'map') {
      if (id === UNMAPPED) ctx.act.unqueue(id);
      else if (b.holder) ctx.act.release(id);
      else if (b.queued) ctx.act.unqueue(id);
      else if (target.district && !target.onSelf) moveBlock(id, target.district, target.before);
    } else if (target.kind === 'queue') {
      if (!b.queued || b.holder) ctx.act.queue(id);
    } else if (target.kind.startsWith('agent:')) {
      const agent = target.kind.slice(6);
      if (agent !== HUMAN && b.holder !== agent) ctx.act.assign(id, agent);
    }
  }

  // An item onto an agent's window is sent to that agent (asking first if its agent is doing it); onto Up next it is queued,
  // and no longer anyone's.
  function dropItem(target) {
    const it = ctx.live.items[press.item];
    if (!target || !it) return;
    if (target.kind.startsWith('agent:')) ctx.sendItem?.(it, target.kind.slice(6), target.el);
    else if (target.kind === 'queue' && it.block && !it.queued) {
      (it.assignee ? ctx.act.updateItem(it.id, { assignee: '', status: 'open' }) : Promise.resolve()).then(() => ctx.act.queueItem(it));
    }
  }

  // Into another district, or to another place in its own: a change to the board, so only if it changes anything.
  function moveBlock(id, district, before) {
    const blocks = ctx.board.blocks;
    const self = blocks.find((x) => x.id === id);
    if (!self) return;
    if (self.district === district) {
      const mine = blocks.filter((x) => x.district === district).map((x) => x.id);
      const after = mine[mine.indexOf(id) + 1] || null;
      if (before === after) return;
    }
    const name = ctx.board.districts.find((d) => d.id === district)?.name || district;
    ctx.boardOp({ op: 'move', block: id, district, ...(before ? { before } : {}) }, self.district === district ? '' : `Moved ${self.name} to ${name}.`);
  }

  function cancel() {
    if (press?.timer) clearTimeout(press.timer);
    press?.el.classList.remove('dragging');
    ghost?.remove();
    ghost = null;
    over?.el.classList.remove('drop-ok');
    over?.slot?.classList.remove('drop-before');
    over = null;
    document.body.classList.remove('dragging-tile');
    press = null;
  }

  return { get active() { return !!press?.dragging; } };
}
