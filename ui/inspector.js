// The block inspector: what a block is, who holds it, its open items, its docs and paths, and what
// happened in it lately. Actions here write events, the same ones `qb` writes.

import { HUMAN, UNMAPPED, blockMeta, agentName, presence, clock, footprints } from '../core/model.js';
import { h, icon, esc, timer, dur, initials, setHtml, selectWrap, escapeLayer, ESC, storageGet, storageSet } from './dom.js';
import { colorOf, inkOf } from './map.js';
import { changesByBlock } from '../core/merges.js';
import { openNewItem } from './newitem.js';
import { openPopover } from './popover.js';

const KIND_ICON = { bug: 'bug', task: 'task', decision: 'decision', question: 'question', note: 'note' };
const KIND_WORD = { bug: 'Bugs', task: 'Tasks', decision: 'Your call', question: 'Questions', note: 'Notes' };

export function createInspector(ctx, root, scrim) {
  let id = null;
  let kindFilter = 'all';
  // A block's long item lists (T57): a filter, a sort, how many show (Show More adds a page), and the Done section.
  let itemQuery = '';
  let itemSort = 'kind';
  let itemLimit = 60;
  let doneOpen = false;
  let doneLimit = 30;
  let openItem = null;
  // Items open in the Items list (the whole title and its detail), by id.
  const allOpen = new Set();
  // An item's own button for the rest of it: the title past two lines, its detail, answer and acts.
  function moreButton(isOpen, onClick) {
    const b = h('button', { class: 'it-more', type: 'button', 'aria-expanded': String(isOpen) }, isOpen ? 'Less' : 'More');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }
  let sig = '';

  const head = h('div', { class: 'in-head' });
  const body = h('div', { class: 'in-body' });
  const itemsSec = h('div', { class: 'in-sec' });
  const chgSec = h('div', { class: 'in-sec in-changes' });
  const addSec = h('div', { class: 'in-sec' });
  const staticSec = h('div', {});
  // Activity and Reserved By are sections of their own, spaced like every other section in the drawer (T66).
  const actSec = h('div', {});
  body.append(itemsSec, chgSec, addSec, actSec, staticSec);
  // The drawer shows a picked block or, opened from the Items button, every open item on the board, newest first,
  // marking what was filed since the person last looked. Off phones it is a column left of the map that takes no
  // space until one of those is open, and folds away on close.
  let listOpen = false;
  const listClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close', html: icon('close') });
  listClose.addEventListener('click', () => closeList());
  const allList = h('ul', { class: 'items' });
  const allChips = h('div', { class: 'chips' });
  const allCount = h('span', { class: 'win-count' });
  const newBtn = h('button', { class: 'btn sm', type: 'button' }, 'New Item');
  newBtn.addEventListener('click', () => openNewItem(ctx, newBtn));
  const empty = h('div', { class: 'in-all' }, h('div', { class: 'in-sec' }, h('div', { class: 'in-all-top' }, h('span', { class: 'disc plain', html: icon('task') }), h('div', { class: 'win-name' }, 'Items'), allCount, listClose), h('div', { class: 'in-all-bar' }, allChips, newBtn), allList), h('p', { class: 'in-hint' }, "Pick a block on the map for its state, activity, docs and paths."));
  root.append(empty, head, body);
  const docked = matchMedia('(min-width: 861px)');
  let allKind = 'all';
  let allSig = '';
  let seenAt = Number(storageGet('queuebox.itemsSeen', 0)) || 0;
  let shownAt = 0;
  // What counts as new: filed after the person last had this list in front of them.
  const markSeen = () => {
    if (!shownAt) return;
    seenAt = shownAt;
    shownAt = 0;
    storageSet('queuebox.itemsSeen', seenAt);
  };
  addEventListener('pagehide', markSeen);
  document.addEventListener('visibilitychange', () => document.hidden && markSeen());
  function paintEmpty() {
    const shown = !!id || listOpen;
    empty.hidden = !!id || !listOpen;
    head.hidden = body.hidden = !id;
    document.body.classList.toggle('docked', shown);
    root.classList.toggle('open', shown);
    scrim.classList.toggle('on', shown);
    root.setAttribute('aria-hidden', shown ? 'false' : 'true');
    document.getElementById('items-btn')?.setAttribute('aria-pressed', String(listOpen && !id));
    if (!listOpen || id) markSeen();
    else paintAll();
    // The map's frame changed width.
    ctx.map?.refit?.();
  }
  function toggleList() {
    if (listOpen && !id) return closeList();
    listOpen = true;
    if (id) close();
    else paintEmpty();
    ctx.render();
  }
  function closeList() {
    listOpen = false;
    paintEmpty();
    ctx.render();
  }
  // An item's own acts, on its expanded row: close it as done or won't fix, open it again, or delete one filed by
  // mistake (which asks first).
  function itemActs(it) {
    const row = h('div', { class: 'it-acts' });
    row.addEventListener('click', (e) => e.stopPropagation());
    const closed = it.status === 'done' || it.status === 'wontfix';
    if (closed) row.append(button('Reopen', () => ctx.act.updateItem(it.id, { status: 'open' }, `${it.id} is open again.`)));
    else {
      row.append(button('Done', () => ctx.act.updateItem(it.id, { status: 'done' }, `${it.id} is done.`)));
      row.append(button("Won't Fix", () => ctx.act.updateItem(it.id, { status: 'wontfix' }, `${it.id} won't be fixed.`)));
    }
    const del = button('Delete', () =>
      openPopover({
        key: `del:${it.id}`,
        anchor: del,
        title: `Delete ${it.id}`,
        html: `<p class="pop-text">${esc(it.title)}</p><p class="pop-meta">It leaves the board; the log keeps it, so a replay still shows it.</p>`,
        actions: [{ label: 'Delete', kind: 'confirm', needsValue: false, run: () => ctx.act.deleteItem(it.id) }],
      }),
    );
    row.append(del);
    for (const b of row.children) b.classList.add('sm');
    return row;
  }

  // Look Into: an agent investigates an item read-only and posts what it found; idle agents are listed first.
  function lookInto(st, it) {
    const now = ctx.viewNow;
    const agents = Object.values(st.agents).filter((a) => a.id !== HUMAN && !a.leftAt).sort((a, b) => (presence(st, b.id, now) === 'idle') - (presence(st, a.id, now) === 'idle'));
    const sel = h('select', { class: 'solenoid-settings__select', 'aria-label': `Look into ${it.id}` }, h('option', { value: '' }, 'Look Into'), ...agents.map((a) => h('option', { value: a.id }, `${a.name}, ${presence(st, a.id, now)}`)));
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
      const to = sel.value;
      sel.value = '';
      if (!to) return;
      const where = it.block ? ` --block ${it.block}` : '';
      ctx.act.message(to, `Look into ${it.id} (${it.title}) without changing anything: reproduce it, find the cause and estimate the work. Post what you found with \`qb note "${it.id}: ..."${where}\`, file follow-ups with \`qb task\` or \`qb bug\`, reserve nothing and edit nothing. Then go back to what you were doing.`);
    });
    return h('div', { class: 'it-look' }, selectWrap(sel));
  }

  function paintAll() {
    const st = ctx.view;
    if (!st || id || !listOpen) return;
    if (!shownAt) shownAt = ctx.viewNow || Date.now();
    const open = Object.values(st.items).filter((it) => it.status !== 'done' && it.status !== 'wontfix' && it.kind !== 'suggestion' && it.kind !== 'note');
    const next = JSON.stringify([allKind, seenAt, !!ctx.replayTs, open.map((it) => [it.id, it.status, it.title, it.block, it.queued?.pos ?? null])]);
    if (next === allSig) return;
    allSig = next;
    allCount.textContent = String(open.length);
    const kinds = ['bug', 'task', 'decision', 'question'].filter((k) => open.some((it) => it.kind === k));
    allChips.textContent = '';
    allChips.hidden = kinds.length < 2;
    for (const k of ['all', ...kinds]) {
      const n = k === 'all' ? open.length : open.filter((it) => it.kind === k).length;
      const c = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(allKind === k) }, `${k === 'all' ? 'All' : KIND_WORD[k]} ${n}`);
      c.addEventListener('click', () => {
        allKind = k;
        paintAll();
      });
      allChips.append(c);
    }
    allList.textContent = '';
    const shown = open.filter((it) => allKind === 'all' || it.kind === allKind).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const it of shown.slice(0, 200)) {
      let act;
      if (it.status === 'open' && it.kind !== 'question' && it.block) {
        const queued = !!it.queued;
        act = button(queued ? 'Unqueue' : 'Queue', () => (queued ? ctx.act.unqueueItem(it) : ctx.act.queueItem(it)));
        act.classList.add('sm');
        if (queued) act.setAttribute('aria-pressed', 'true');
        act.disabled = !!ctx.replayTs;
      } else act = h('span', { class: 'it-status' }, it.status === 'doing' && it.assignee ? agentName(st, it.assignee) : it.status === 'open' ? '' : it.status);
      const fresh = seenAt && (it.createdAt || 0) > seenAt;
      // One title and its id: no block pill, no filer (B22). A new one is marked by the dot before its title. The act
      // (or who has it) sits on the id's line, so the title takes the row's whole width (T51).
      const isOpen = allOpen.has(it.id);
      const foot = h('div', { class: 'it-foot' }, h('span', { class: 'it-sub' }, it.id, moreButton(isOpen, () => {
        if (allOpen.has(it.id)) allOpen.delete(it.id);
        else allOpen.add(it.id);
        allSig = '';
        paintAll();
      })), act);
      const col = h('div', { style: { minWidth: 0 } }, h('div', { class: 'it-title' }, it.title));
      if (isOpen) {
        if (it.detail) col.append(h('div', { class: 'it-detail' }, it.detail));
        if (it.answer) col.append(h('div', { class: 'it-detail' }, it.answer));
      }
      col.append(foot);
      allList.append(h('li', { class: `item wide k-${it.kind} s-${it.status}${fresh ? ' fresh' : ''}${isOpen ? ' open' : ''}`, 'data-drag-item': it.id }, h('span', { html: icon(KIND_ICON[it.kind] || 'task') }), col));
    }
  }
  docked.addEventListener('change', paintEmpty);
  paintEmpty();

  const kindSel = h('select', { class: 'solenoid-settings__select', id: 'add-kind', 'aria-label': 'Kind' }, h('option', { value: 'bug' }, 'Bug'), h('option', { value: 'task' }, 'Task'));
  const addField = h('input', { class: 'field', id: 'add-title', placeholder: 'Title', autocomplete: 'off', 'aria-label': 'New item' });
  const addForm = h('form', { class: 'add-item' }, selectWrap(kindSel), addField, h('button', { class: 'btn', type: 'submit' }, 'Add'));
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = addField.value.trim();
    if (!title || !id) return;
    ctx.act.addItem({ kind: kindSel.value, title, block: id }).then((ok) => {
      if (ok) addField.value = '';
    });
  });
  addSec.append(addForm);
  scrim.addEventListener('click', () => close());
  escapeLayer(ESC.drawer, () => !!id || listOpen, () => (id ? close() : closeList()));

  function open(blockId) {
    if (id !== blockId) {
      kindFilter = 'all';
      itemQuery = '';
      itemLimit = 60;
      doneOpen = false;
      doneLimit = 30;
      openItem = null;
      body.scrollTop = 0;
    }
    id = blockId;
    sig = '';
    root.classList.add('open');
    scrim.classList.add('on');
    paintEmpty();
    paintStatic();
    update();
  }

  function close() {
    id = null;
    root.classList.remove('open');
    scrim.classList.remove('on');
    paintEmpty();
    ctx.selectQuiet(null);
  }

  function paintStatic() {
    const meta = blockMeta(ctx.view, id) || {};
    staticSec.textContent = '';
    if (meta.docs?.length) staticSec.append(h('div', { class: 'in-sec' }, h('h3', {}, 'Docs'), h('div', { class: 'docs' }, ...meta.docs.map((d) => h('div', {}, d)))));
    if (meta.paths?.length) {
      staticSec.append(h('div', { class: 'in-sec' }, h('h3', {}, h('span', {}, 'Paths'), h('span', { class: 'num' }, meta.files !== undefined ? `${meta.files} files` : '')), h('pre', { class: 'paths', html: breakable(meta.paths) })));
    } else if (id === UNMAPPED && ctx.board.unmapped?.sample?.length) {
      staticSec.append(h('div', { class: 'in-sec' }, h('h3', {}, 'Paths'), h('pre', { class: 'paths', html: breakable(ctx.board.unmapped.sample) })));
    }
  }

  // Changes (T61): what hasn't landed here, per agent (its stage and lines), then each of its files with its +/-.
  // A file two agents changed is marked as an overlap.
  const STAGE_WORD = { uncommitted: 'Uncommitted', committed: 'Committed', queued: 'Queued to merge' };
  function paintChanges(st, chg) {
    chgSec.textContent = '';
    chgSec.hidden = !chg;
    if (!chg) return;
    const overlap = new Set(chg.overlap);
    chgSec.append(h('h3', {}, h('span', {}, 'Changes'), h('span', { class: 'num' }, `+${chg.add} −${chg.del}`)));
    for (const a of chg.agents) {
      const who = a.agent ? agentName(st, a.agent) : 'Nobody known';
      const head = h('div', { class: 'chg-who', style: { '--sc': a.agent ? colorOf(st, a.agent) : 'var(--text-dim)' } });
      setHtml(head, `<span class="chg-dot ${a.stage}"></span><span class="chg-name">${esc(who)}</span><span class="chg-stage">${STAGE_WORD[a.stage]}</span><span class="num">+${a.add} −${a.del}</span>`);
      const list = h('ul', { class: 'chg-files' });
      for (const f of a.files) {
        const li = h('li', { class: overlap.has(f.file) ? 'overlap' : '' });
        setHtml(li, `<span class="chg-path">${esc(f.file)}</span><span class="num">+${f.add} −${f.del}</span>${overlap.has(f.file) ? '<span class="chg-flag">overlaps</span>' : ''}`);
        list.append(li);
      }
      chgSec.append(head, list);
    }
  }

  function update() {
    if (!id) return paintAll();
    const st = ctx.view;
    const now = ctx.viewNow;
    const b = st.blocks[id];
    if (!b) return close();
    const meta = blockMeta(st, id) || { name: id };
    const items = Object.values(st.items).filter((it) => it.block === id);
    const wt = ctx.wtIndex?.byBlock.get(id);
    const chg = ctx.replayTs ? null : changesByBlock(st, ctx.worktrees).get(id);
    const next = JSON.stringify([chg, id, b.holder, b.since, b.intent, b.queued, b.frozen, b.test, b.touches.length, b.history.length, wt && [wt.trees.map((t) => t.label), wt.conflict, wt.clashes.map((c) => c.a + c.b)], Object.keys(b.watchers || {}), items.map((i) => i.status + i.kind + i.title + (i.assignee || '')), kindFilter, openItem, itemQuery, itemSort, itemLimit, doneOpen, doneLimit, !!ctx.replayTs, Object.keys(st.agents).length]);
    if (next === sig) return;
    sig = next;

    const d = ctx.board.districts.find((x) => x.id === meta.district);
    head.textContent = '';
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: icon('close') });
    closeBtn.addEventListener('click', close);
    // What the block is stays a tooltip on its name; the panel's text is what is going on in it.
    head.append(h('div', { class: 'in-district' }, d?.name || 'Unclaimed'), h('div', { class: 'in-top' }, h('h2', { class: 'in-name', title: meta.about || '' }, meta.name), closeBtn));

    const stateLine = h('div', { class: 'in-state' });
    if (b.holder) {
      const a = st.agents[b.holder];
      const chip = h('span', { class: 'holder', style: { '--hc': colorOf(st, b.holder), '--hci': inkOf(st, b.holder) } });
      setHtml(chip, `<span class="dot">${esc(initials(a?.name))}</span>${esc(a?.name || b.holder)} ${timer(b.since, {}, now)}`);
      stateLine.append(chip);
    } else if (b.queued) {
      stateLine.append(h('span', { class: 'holder', html: `${icon('queue')}Up next${b.queued.items?.length ? `, ${b.queued.items.length} item${b.queued.items.length === 1 ? '' : 's'}` : ''} ${timer(b.queued.ts, {}, now)}` }));
    }
    if (b.frozen) stateLine.append(h('span', { class: 'badge', html: `${icon('lock')} Frozen` }));
    if (b.test) stateLine.append(h('span', { class: `badge ${b.test.ok ? 'ok' : 'danger'}`, html: `${icon(b.test.ok ? 'check' : 'cross')} ${b.test.ok ? 'Tests pass' : esc(b.test.summary || 'Tests fail')}` }));
    if (stateLine.children.length) head.append(stateLine);
    // The holder's intent, unless it only repeats an item listed below.
    const why = b.holder ? b.intent : b.queued?.note;
    const listed = items.some((it) => it.status !== 'done' && it.title.trim() === String(why || '').replace(/…$/, '').trim());
    if (why && !listed) head.append(h('p', { class: 'in-intent' }, why));
    // What the map's badges only count, said in words: the freeze note, the worktrees that changed the block and the
    // merges the forecast says will conflict in it, who watches it and who passed through lately.
    const said = [];
    if (b.frozen?.note) said.push(`Frozen: ${b.frozen.note}`);
    if (wt?.trees.length) said.push(`Changed in ${wt.trees.map((t) => t.label).join(', ')}`);
    if (wt?.conflict) said.push(`${wt.conflict} conflicts with the base here`);
    for (const c of wt?.clashes || []) said.push(`${c.a} and ${c.b} will conflict here`);
    const watchers = Object.keys(b.watchers || {});
    if (watchers.length) said.push(`Watched by ${watchers.map((w) => agentName(st, w)).join(', ')}`);
    const passed = footprints(b, now, 45 * 60_000);
    if (passed.length) said.push(`Passed through: ${passed.map((a) => agentName(st, a)).join(', ')}`);
    for (const line of said) head.append(h('p', { class: 'in-intent' }, line));
    paintChanges(st, chg);

    if (id !== UNMAPPED) {
      const actions = h('div', { class: 'in-actions' });
      // A destination and the Queue button that sends the block there. Choosing a destination does nothing by
      // itself. The General Queue is the default; an agent; or, last and never the default, keeping it yourself.
      const dest = h('select', { class: 'solenoid-settings__select', id: 'queue-dest', 'aria-label': 'Destination' }, h('option', { value: 'queue', selected: true }, 'General Queue'));
      for (const a of Object.values(st.agents)) {
        if (a.leftAt || a.id === HUMAN || a.id === b.holder) continue;
        dest.append(h('option', { value: a.id }, `${a.name}, ${presence(st, a.id, now)}`));
      }
      if (b.holder !== HUMAN) dest.append(h('option', { value: HUMAN }, 'Keep Agents Out'));
      const send = () => {
        if (dest.value === 'queue') return b.queued && !b.holder ? ctx.toast(`${meta.name} is in the General Queue already.`) : ctx.act.queue(id);
        return ctx.act.assign(id, dest.value);
      };
      actions.append(selectWrap(dest), button('Queue', send));
      if (b.holder) actions.append(button('Release', () => ctx.act.release(id)));
      if (b.queued) actions.append(button('Unqueue', () => ctx.act.unqueue(id)));
      actions.append(b.frozen ? button('Unfreeze', () => ctx.act.freeze(id, false)) : button('Freeze', () => ctx.act.freeze(id, true)));
      if (ctx.replayTs) for (const el of actions.querySelectorAll('button,select')) el.disabled = true;
      head.append(actions);
    }

    paintItems(st, items, b);
    paintActivity(st, b, now);
  }

  function paintItems(st, items, b) {
    const focused = itemsSec.contains(document.activeElement) ? document.activeElement.dataset.f : null;
    const caret = focused === 'q' ? document.activeElement.selectionStart : null;
    itemsSec.textContent = '';
    const q = itemQuery.trim().toLowerCase();
    const matches = (it) => !q || `${it.id} ${it.title} ${it.detail || ''}`.toLowerCase().includes(q);
    const open = items.filter((it) => it.status !== 'done' && it.status !== 'wontfix');
    const done = items.filter((it) => it.status === 'done' || it.status === 'wontfix');
    const kinds = ['bug', 'task', 'decision', 'question'].filter((k) => open.some((it) => it.kind === k));
    itemsSec.append(h('h3', {}, h('span', {}, 'Items'), h('span', { class: 'num' }, String(open.length))));
    if (kinds.length > 1) {
      const chips = h('div', { class: 'chips' });
      for (const k of ['all', ...kinds]) {
        const n = k === 'all' ? open.length : open.filter((it) => it.kind === k).length;
        const c = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(kindFilter === k) }, `${k === 'all' ? 'All' : KIND_WORD[k]} ${n}`);
        c.addEventListener('click', () => {
          kindFilter = k;
          itemLimit = 60;
          sig = '';
          update();
        });
        chips.append(c);
      }
      itemsSec.append(chips);
    }
    // A filter and a sort once there is more than a screenful (T57).
    if (open.length + done.length > 12) {
      const field = h('input', { class: 'field', type: 'search', placeholder: 'Filter by id, title or detail', 'aria-label': 'Filter items', autocomplete: 'off', 'data-f': 'q' });
      field.value = itemQuery;
      field.addEventListener('input', () => {
        itemQuery = field.value;
        itemLimit = 60;
        doneLimit = 30;
        sig = '';
        update();
      });
      const sortSel = h('select', { class: 'solenoid-settings__select', 'aria-label': 'Sort items', 'data-f': 'sort' }, ...[['kind', 'By kind'], ['queue', 'Queue order'], ['newest', 'Newest'], ['oldest', 'Oldest']].map(([v, t]) => h('option', { value: v, selected: itemSort === v }, t)));
      sortSel.addEventListener('change', () => {
        itemSort = sortSel.value;
        sig = '';
        update();
      });
      itemsSec.append(h('div', { class: 'in-find' }, field, selectWrap(sortSel)));
    }
    const order = { question: 0, bug: 1, decision: 2, task: 3, note: 4 };
    const sorters = {
      kind: (a, b) => order[a.kind] - order[b.kind] || (a.createdAt || 0) - (b.createdAt || 0),
      queue: (a, b) => (a.queued ? a.queued.pos : Infinity) - (b.queued ? b.queued.pos : Infinity) || order[a.kind] - order[b.kind],
      newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    };
    const shown = open.filter((it) => (kindFilter === 'all' || it.kind === kindFilter) && matches(it)).sort(sorters[itemSort] || sorters.kind);
    const list = h('ul', { class: 'items' });
    for (const it of shown.slice(0, itemLimit)) list.append(itemRow(st, it, b));
    itemsSec.append(list);
    // The true count, and a page more at a time.
    if (shown.length > itemLimit || q) itemsSec.append(moreLine(Math.min(itemLimit, shown.length), shown.length, () => (itemLimit += 100)));
    // Done: folded, with its count; open, newest first, filtered and paged like the rest.
    const doneShown = done.filter(matches).sort((a, b) => (b.history?.at(-1)?.ts || b.createdAt || 0) - (a.history?.at(-1)?.ts || a.createdAt || 0));
    if (done.length) {
      const toggleBtn = h('button', { class: 'in-done-head', type: 'button', 'aria-expanded': String(doneOpen) }, h('span', { html: icon('chev') }), h('span', {}, 'Done'), h('span', { class: 'num' }, q ? `${doneShown.length} of ${done.length}` : String(done.length)));
      toggleBtn.addEventListener('click', () => {
        doneOpen = !doneOpen;
        sig = '';
        update();
      });
      itemsSec.append(toggleBtn);
      if (doneOpen) {
        const dl = h('ul', { class: 'items' });
        for (const it of doneShown.slice(0, doneLimit)) dl.append(itemRow(st, it, b));
        itemsSec.append(dl);
        if (doneShown.length > doneLimit) itemsSec.append(moreLine(doneLimit, doneShown.length, () => (doneLimit += 100)));
      }
    }
    if (focused) {
      const el = itemsSec.querySelector(`[data-f="${focused}"]`);
      el?.focus();
      if (caret !== null && el?.setSelectionRange) el.setSelectionRange(caret, caret);
    }
  }

  // 'Showing 60 of 1,500' and Show More.
  function moreLine(shownN, total, more) {
    const line = h('div', { class: 'in-more' }, h('span', {}, `Showing ${shownN.toLocaleString()} of ${total.toLocaleString()}`));
    if (total > shownN) {
      const btn = h('button', { class: 'btn sm', type: 'button' }, 'Show More');
      btn.addEventListener('click', () => {
        more();
        sig = '';
        update();
      });
      line.append(btn);
    }
    return line;
  }

  function itemRow(st, it, b) {
    // The person queues an item; its status is the agents' to move (\`qb item\`), so it only reads here.
    const queued = !!b?.queued?.items?.includes(it.id);
    let side;
    if (it.status === 'open' && it.kind !== 'question') {
      side = button(queued ? 'Unqueue' : 'Queue', () => (queued ? ctx.act.unqueueItem(it) : ctx.act.queueItem(it)));
      side.classList.add('sm');
      if (queued) side.setAttribute('aria-pressed', 'true');
      side.disabled = !!ctx.replayTs;
    } else side = h('span', { class: 'it-status' }, it.status === 'doing' && it.assignee ? agentName(st, it.assignee) : it.status === 'open' ? '' : it.status);
    const from = it.source === 'import' ? it.group : `Filed by ${agentName(st, it.by)}`;
    const textCol = h('div', { style: { minWidth: 0 } }, h('div', { class: 'it-title' }, it.title), h('div', { class: 'it-sub', title: from || '' }, it.id, moreButton(openItem === it.id, () => {
      openItem = openItem === it.id ? null : it.id;
      sig = '';
      update();
    })));
    if (openItem === it.id) {
      if (it.answer) textCol.append(h('div', { class: 'it-detail' }, it.answer));
      if (it.detail) textCol.append(h('div', { class: 'it-detail' }, it.detail));
      if (from || it.ref) textCol.append(h('div', { class: 'it-sub' }, [from, it.ref].filter(Boolean).join('\n')));
      if (it.status !== 'done' && it.status !== 'wontfix' && !ctx.replayTs) textCol.append(lookInto(st, it));
      if (!ctx.replayTs) textCol.append(itemActs(it));
    }
    return h('li', { class: `item k-${it.kind} s-${it.status}${queued ? ' queued' : ''}${openItem === it.id ? ' open' : ''}`, ...(it.status === 'done' || it.status === 'wontfix' ? {} : { 'data-drag-item': it.id }) }, h('span', { html: icon(it.status === 'done' ? 'done' : KIND_ICON[it.kind] || 'task') }), textCol, side);
  }

  function paintActivity(st, b) {
    actSec.textContent = '';
    const touches = b.touches.slice(-10).reverse();
    const hist = b.history.slice(-6).reverse();
    if (touches.length) {
      const list = h('ul', { class: 'acts' });
      for (const t of touches) list.append(h('li', {}, h('time', {}, clock(t.ts)), h('i', { style: { '--fc': colorOf(st, t.agent) } }), h('span', { class: 't' }, `${agentName(st, t.agent)}, ${shortPath(t.file)}`)));
      actSec.append(h('div', { class: 'in-sec' }, h('h3', {}, 'Activity'), list));
    }
    if (hist.length) {
      const list = h('ul', { class: 'acts' });
      for (const x of hist) list.append(h('li', {}, h('time', {}, clock(x.from)), h('i', { style: { '--fc': colorOf(st, x.agent) } }), h('span', { class: 't' }, `${agentName(st, x.agent)}, ${dur(x.to - x.from)}, ${x.outcome}${x.intent ? `: ${x.intent}` : ''}`)));
      actSec.append(h('div', { class: 'in-sec' }, h('h3', {}, 'Reserved by'), list));
    }
  }

  // Long paths wrap at their slashes and commas, never inside a name.
  function breakable(lines) {
    return lines.map((l) => esc(l).replace(/([/,])/g, '$1<wbr>')).join('\n');
  }

  function shortPath(file) {
    const parts = String(file || '').split('/');
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : file;
  }

  function button(label, fn) {
    const b = h('button', { class: 'btn', type: 'button' }, label);
    b.addEventListener('click', fn);
    return b;
  }

  return { open, close, update, toggleList, get id() { return id; } };
}
