// The side column, most urgent first: what needs the person (the inbox), the person's own window (their queue
// and the blocks they keep), then a window per agent. Windows are drop targets; their trays are where tiles go.

import { HUMAN, presence, presenceSince, openQuestions, activityOf, isIdleFree, readsSoon, blockMeta, agentName, clock, queueEntries, queuePlan, blockedItems } from '../core/model.js';
import { h, icon, setHtml, setText, toggle, esc, timer, initials, dur, toast } from './dom.js';
import { colorOf, inkOf } from './map.js';
import { itemHtml } from './itemview.js';
import { openPopover, refreshPopover } from './popover.js';

const RANK = { question: 0, permission: 0, review: 1, working: 2, quiet: 2, blocked: 3, stale: 4, idle: 5, done: 6, gone: 7 };
const WORD = { working: 'Working', question: 'Question', permission: 'Permission', review: 'Review', blocked: 'Blocked', quiet: 'Quiet', stale: 'Gone quiet', idle: 'Idle', done: 'Done', gone: 'Left' };
const QUIET_MS = 5 * 60_000;
const MIN = 60_000;
const SUB_FADE = 4 * MIN;
const ROSTER_AT = 5;
// How many of one block's queued items Up next shows before folding the rest, and how many lined-up items a window shows.
const QUEUE_SHOWN = 3;
const LINED_SHOWN = 5;
// How long an auto-applied suggestion stays in Needs you with its Undo.
const APPLIED_SHOWN_MS = 10 * 60_000;

// What an agent's state is, in the words the person acts on: a question to answer, a permission to grant
// (in its terminal); else working, quiet, gone quiet or idle.
export function agentState(st, a, now) {
  let p = presence(st, a.id, now);
  let since = presenceSince(st, a.id, now);
  if (p === 'waiting') p = openQuestions(st, a.id).length ? 'question' : 'permission';
  // A finished turn is idle, whatever it has lined up: the board wakes it for that work, so nothing waits on the person.
  if (p === 'review') p = 'idle';
  if (p === 'working' && now - a.lastSeen > QUIET_MS) {
    p = 'quiet';
    since = a.lastSeen;
  }
  return { p, since };
}

export function createSide(ctx, root) {
  const wins = new Map();
  const inbox = h('section', { class: 'win inbox', hidden: true, 'data-win': 'inbox' });
  const you = youWindow();
  const upNext = queueWindow();
  const mergeHost = h('div', { class: 'merge-host', hidden: true });
  const agentsHost = h('div', { class: 'agents' });
  const empty = h('div', { class: 'side-empty' });
  root.append(inbox, upNext.el, you.el, mergeHost, agentsHost, empty);

  inbox.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const { act, arg } = b.dataset;
    if (act === 'read') readLast(b, arg);
    else if (act === 'message') openMessage(arg);
    else if (act === 'merge') ctx.act.copyMerge(arg);
    else if (act === 'fix') ctx.act.askFix(arg);
    else if (act === 'rebase') ctx.act.askRebase(arg);
    else if (act === 'open') openQuestion(b, arg);
    else if (act === 'suggestion') openSuggestion(b, arg);
    else if (act === 'undo-apply') ctx.act.undoApply?.(arg);
    else if (act === 'block') ctx.select(arg);
  });

  // A suggestion whole: who would take which item, in which block, and why; applied or dismissed by the person.
  function openSuggestion(button, id) {
    const st = ctx.view || ctx.live;
    const sug = st.items[id];
    if (!sug) return;
    const lines = (sug.plan || []).map((p) => {
      const it = st.items[p.item];
      const where = it?.block ? ` in ${esc(blockMeta(st, it.block)?.name || it.block)}` : '';
      const holder = it?.block && st.blocks[it.block]?.holder;
      const busy = holder && holder !== p.agent ? ` <span class="pop-meta">(reserved by ${esc(agentName(st, holder))}: it will be queued)</span>` : '';
      return `<li><b>${esc(agentName(st, p.agent))}</b> takes ${esc(p.item)}${it ? `: ${esc(it.title)}` : ''}${where}${busy}</li>`;
    });
    const html = [
      `<p class="pop-meta">${esc(agentName(st, sug.by))} suggested this at ${esc(clock(sug.createdAt))} (${esc(sug.id)}). Applying gives each item to its agent, and its block too when free.</p>`,
      `<ul class="pop-list">${lines.join('')}</ul>`,
      sug.detail ? `<p class="pop-text">${esc(sug.detail)}</p>` : '',
    ].join('');
    openPopover({
      key: `s:${id}`,
      anchor: button,
      title: `Suggestion from ${agentName(st, sug.by)}`,
      html,
      actions: [
        { label: 'Apply', kind: 'confirm', needsValue: false, run: () => ctx.act.applySuggestion(id) },
        { label: 'Dismiss', needsValue: false, run: () => ctx.act.updateItem(id, { status: 'wontfix', note: 'dismissed' }) },
      ],
    });
  }

  // One act button in a row: its own icon, label and tooltip.
  // The tooltip names the act; the aria-label also names the agent, so rows read apart.
  const ACT_TIP = { read: 'Read what it said last', message: 'Message' };
  function actBtn(act, arg, ic, label) {
    return `<button class="icon-btn" type="button" data-act="${act}" data-arg="${esc(arg)}" ${act === 'read' ? `data-pop="l:${esc(arg)}" aria-haspopup="dialog" aria-expanded="false" ` : ''}aria-label="${esc(label)}" title="${esc(ACT_TIP[act] || label)}"${ctx.replayTs ? ' disabled' : ''}>${icon(ic)}</button>`;
  }

  // What an agent said at the end of its last turn, posted by its Stop hook, in the popover.
  function readLast(button, id) {
    const st = ctx.view || ctx.live;
    const a = st.agents[id];
    if (!a?.last) return;
    openPopover({
      key: `l:${id}`,
      anchor: button,
      title: `${a.name}, last`,
      html: `<p class="pop-meta">At the end of its turn, ${esc(clock(a.last.ts))}</p><p class="pop-text">${esc(a.last.text)}</p>`,
      actions: [],
      closeLabel: 'Close',
    });
  }

  // The message box behind the window's chevron, opened and focused.
  function openMessage(id) {
    const w = wins.get(id);
    if (!w) return;
    if (!w.open) w.more.click();
    w.input.focus();
  }

  // The person's Wake: the board wakes the agent's idle background session with what waits for it (POST /api/wake).
  async function wake(id) {
    const r = await post('wake', { agent: id });
    toast(r.message, r.ok ? 'info' : 'error');
  }

  // Starting an agent in a checkout (POST /api/launch): the server runs claude --bg there to take the next queued work.
  async function start(worktree) {
    const r = await post('launch', { op: 'start', ...(worktree ? { worktree } : {}) });
    toast(r.message, r.ok ? 'info' : 'error');
  }
  ctx.startAgent = start;

  async function post(name, body) {
    if (ctx.replayTs) return { ok: false, message: 'Back to live to act on the board.' };
    const token = new URLSearchParams(location.search).get('token');
    try {
      const res = await fetch(`api/${name}${token ? `?token=${encodeURIComponent(token)}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-queuebox': '1' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      return { ok: res.ok && out.ok !== false, message: out.message || out.error || `The board answered ${res.status}.` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // A question whole, in the popover: what was asked, its detail, the block it's about, and the answer.
  function openQuestion(button, id) {
    const st = ctx.view || ctx.live;
    const q = st.items[id];
    if (!q) return;
    const block = q.block ? blockMeta(st, q.block)?.name || q.block : '';
    const html = [
      `<p class="pop-meta">${esc(agentName(st, q.by))} asked at ${esc(clock(q.createdAt))}${block ? ` about <b>${esc(block)}</b>` : ''} (${esc(q.id)})</p>`,
      `<p class="pop-text">${esc(q.title)}</p>`,
      q.detail ? `<p class="pop-text">${esc(q.detail)}</p>` : '',
    ].join('');
    openPopover({
      key: `q:${id}`,
      anchor: button,
      title: `Question from ${agentName(st, q.by)}`,
      html,
      field: { label: 'Your answer', placeholder: 'It lands in their inbox on the board.' },
      quick: ['yes', 'nah', 'NO WAY', 'IDK', 'IDC'],
      actions: [{ label: 'Answer', kind: 'confirm', run: (text) => ctx.act.answer(id, text) }],
    });
  }

  // The queue is the team's, not the person's: its own window with no one's disc. Queuing gives a block to no one;
  // the next free agent takes the top of it (`qb next`).
  // Ask agents to finish and stop, or resume them (T38): the board stops handing them queued work, and each hears it.
  async function setFinishing(ids, on) {
    if (!ids.length) return false;
    const list = [];
    for (const id of ids) {
      list.push({ type: 'agent.finish', agent: id, on });
      list.push({ type: 'msg', auto: true, to: id, text: on ? "Finish and stop: complete what you're on now, post a `qb note` with what's done and what's left, release with `qb release --landed`, and take nothing new until the person resumes you." : 'The person resumed you: queued work can come to you again.' });
    }
    const who = ids.length === 1 ? agentName(ctx.live, ids[0]) : `${ids.length} agents`;
    try {
      await ctx.source.commit(list);
      toast(on ? `${who} will finish and stop.` : `${who} ${ids.length === 1 ? 'is' : 'are'} resumed.`);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  function queueWindow() {
    const count = h('span', { class: 'win-count' });
    const tray = h('div', { class: 'tray' });
    const hint = h('p', { class: 'upnext-empty' }, 'Nothing queued. Drop a block here, or Queue in its details; the next free agent takes it.');
    const disc = h('span', { class: 'disc plain' });
    setHtml(disc, icon('queue'));
    // Start an agent in the main checkout to take the top of the queue (T25); each worktree has its own in the strip.
    const startBtn = h('button', { class: 'btn sm', type: 'button', title: 'Start a Claude Code session in the main checkout that takes the next queued work' }, 'Start an agent');
    startBtn.addEventListener('click', () => start(''));
    // Even Out: shown while an idle agent could take lined-up work off a busy one; it proposes, the person applies.
    const evenBtn = h('button', { class: 'btn sm', type: 'button', hidden: true, 'data-pop': 'even-out', 'aria-haspopup': 'dialog' }, 'Even Out');
    evenBtn.addEventListener('click', () => openEvenOut(evenBtn));
    // Finish All (T38): every agent completes what it has and takes nothing new; Resume All undoes it.
    const allBtn = h('button', { class: 'btn sm', type: 'button', title: 'Every agent finishes what it has now and takes no queued work' }, 'Finish All');
    allBtn.addEventListener('click', () => {
      const agents = Object.values(ctx.live.agents).filter((a) => a.id !== HUMAN && !a.leftAt);
      const all = agents.length && agents.every((a) => a.finishing);
      setFinishing(agents.filter((a) => !!a.finishing === all).map((a) => a.id), !all);
    });
    // The less-used acts fold into a More menu, so the header fits the column with Start an agent in full (B26). The
    // two buttons above stay as the state the menu reads (whether Even Out applies, Finish All or Resume All).
    const moreBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More acts for Up next', title: 'More', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-pop': 'upnext-more', html: icon('dots') });
    moreBtn.addEventListener('click', () => {
      const actions = [];
      if (!evenBtn.hidden) actions.push({ label: 'Even Out', needsValue: false, run: () => (setTimeout(() => openEvenOut(moreBtn), 0), true) });
      if (!allBtn.hidden) actions.push({ label: allBtn.textContent, needsValue: false, run: () => (allBtn.click(), true) });
      openPopover({ key: 'upnext-more', anchor: moreBtn, title: 'Up next', html: `<p class="pop-meta">${esc(evenBtn.hidden ? 'Finish All asks every agent to finish what it has and take nothing new.' : 'Even Out proposes moving lined-up work from busy agents to idle ones; Finish All asks every agent to finish what it has.')}</p>`, actions, closeLabel: 'Close' });
    });
    // Anything for the team, typed straight in (B31): a task with no block, queued as it lands.
    const askField = h('input', { class: 'field', type: 'text', autocomplete: 'off', placeholder: 'Anything for the team', 'aria-label': 'Add to Up next' });
    const askForm = h('form', { class: 'msg upnext-ask' }, askField, h('button', { class: 'icon-btn', type: 'submit', 'aria-label': 'Add to Up next', title: 'Add to Up next', html: icon('send') }));
    askForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = askField.value.trim();
      if (!title || ctx.replayTs) return;
      ctx.act.queueText(title).then((ok) => {
        if (ok) askField.value = '';
      });
    });
    const el = h('section', { class: 'win upnext', 'data-drop': 'queue', 'data-win': 'queue', 'aria-label': 'Up next' }, h('div', { class: 'win-head' }, disc, h('div', { class: 'win-name' }, 'Up next'), count, startBtn, moreBtn), h('div', { class: 'win-body' }, tray, hint, askForm));
    return { el, tray, count, evenBtn, allBtn, moreBtn };
  }

  // An agent's item rows: Now holds what it is doing, Lined up what it was given and hasn't started. Each row has
  // its block's button, a destination and the Queue button that sends it there; moving an item it is doing asks first.
  // An item it is doing (Now) shows just itself: no block tag, no destination, no Queue, which made it look unfiled (T62).
  function paintAgentItems(st, w, agentId) {
    const mine = Object.values(st.items).filter((it) => it.assignee === agentId && ['open', 'doing', 'blocked'].includes(it.status) && it.kind !== 'suggestion');
    const keep = new Set();
    const others = Object.values(st.agents).filter((a) => a.id !== agentId && a.id !== HUMAN && !a.leftAt);
    for (const it of mine) {
      keep.add(it.id);
      let row = w.rows.get(it.id);
      if (!row) {
        // Rows keep the order they arrived in, after the tiles: a new one joins the end, never the top (B24).
        w.seq = (w.seq || 0) + 1;
        row = { el: h('div', { class: 'q-item', 'data-drag-item': it.id }), sig: '', id: it.id };
        row.el.style.order = String(1000 + w.seq);
        row.el.addEventListener('click', (e) => {
          const cur = ctx.view.items[row.id];
          if (!cur) return;
          if (e.target.closest('[data-q="show"]')) ctx.select(cur.block);
          const opener = e.target.closest('[data-q="open"]');
          if (opener) openItem(cur, opener);
          const go = e.target.closest('[data-q="send"]');
          if (go) sendItem(cur, row.el.querySelector('.q-dest')?.value || 'queue', go);
        });
        w.rows.set(it.id, row);
      }
      const blockName = blockMeta(st, it.block)?.name || it.block || '';
      const sig = [it.kind, it.title, it.status, blockName, others.map((a) => a.id + a.name).join(), !!ctx.replayTs].join('|');
      if (sig !== row.sig) {
        row.sig = sig;
        const opts = others.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
        setHtml(row.el, `${icon(it.kind === 'bug' ? 'bug' : it.kind === 'question' ? 'question' : it.kind === 'decision' ? 'decision' : 'task')}<span class="q-id">${esc(it.id)}</span><span class="q-title">${esc(it.title)}</span><button class="icon-btn q-open" type="button" data-q="open" aria-haspopup="dialog" aria-expanded="false" aria-label="Read ${esc(it.id)} in full" title="Read in full">${icon('note')}</button>${it.status === 'doing' ? '' : `${blockName ? `<button class="q-block" type="button" data-q="show" aria-label="Show ${esc(blockName)}" title="Show the block">${esc(blockName)}</button>` : ''}<select class="q-dest" aria-label="Destination for ${esc(it.id)}"${ctx.replayTs ? ' disabled' : ''}><option value="queue" selected>General Queue</option>${opts}</select><button class="btn sm q-send" type="button" data-q="send"${ctx.replayTs ? ' disabled' : ''}>Queue</button>`}`);
      }
      const into = it.status === 'doing' ? w.tray : w.lined;
      if (row.el.parentElement !== into) into.append(row.el);
    }
    for (const [iid, row] of w.rows) if (!keep.has(iid)) {
      row.el.remove();
      w.rows.delete(iid);
    }
    // A long Lined up shows its first few and says how many more, so one busy agent can't push the others off the
    // column (T57). The button opens the rest.
    const lined = [...w.rows.values()].filter((r) => r.el.parentElement === w.lined).sort((x, y) => Number(x.el.style.order) - Number(y.el.style.order));
    lined.forEach((r, i) => (r.el.hidden = !w.linedAll && i >= LINED_SHOWN));
    if (!w.moreBtn) {
      w.moreBtn = h('button', { class: 'btn sm q-more', type: 'button' });
      w.moreBtn.style.order = '99999';
      w.moreBtn.addEventListener('click', () => {
        w.linedAll = !w.linedAll;
        update();
      });
    }
    const extra = lined.length - LINED_SHOWN;
    w.moreBtn.hidden = extra <= 0;
    setText(w.moreBtn, w.linedAll ? 'Show fewer' : `${extra} more lined up`);
    if (extra > 0 && w.moreBtn.parentElement !== w.lined) w.lined.append(w.moreBtn);
  }

  // An item whole, in a popover from its row's open button: the row keeps to two lines.
  function openItem(it, anchor) {
    openPopover({ key: `it:${it.id}`, anchor, title: it.id, html: itemHtml(ctx.view, it), closeLabel: 'Close' });
  }

  // Sending an item to a destination, from its Queue button or a drag: an item its agent is doing asks first, since
  // moving it stops that work.
  function sendItem(it, to, anchor) {
    const from = it.assignee;
    if (!to || to === from || to === HUMAN) return;
    // The General Queue: it is no one's again, and waits there for whoever is free.
    if (to === 'queue') {
      const back = () => (from ? ctx.act.updateItem(it.id, { assignee: '', status: 'open' }) : Promise.resolve()).then(() => it.block && !it.queued && ctx.act.queueItem(it));
      if (it.status === 'doing' && from) {
        return openPopover({
          key: `mv:${it.id}`,
          anchor,
          title: `Move ${it.id}`,
          html: `<p class="pop-text">${esc(agentName(ctx.view, from))} is working on ${esc(it.id)}: ${esc(it.title)}. Moving it stops that work.</p>`,
          actions: [{ label: 'Back To General Queue', kind: 'confirm', needsValue: false, run: back }],
        });
      }
      return back();
    }
    if (it.status === 'doing' && from) {
      openPopover({
        key: `mv:${it.id}`,
        anchor,
        title: `Move ${it.id}`,
        html: `<p class="pop-text">${esc(agentName(ctx.view, from))} is working on ${esc(it.id)}: ${esc(it.title)}. Moving it stops that work.</p>`,
        actions: [{ label: `Queue For ${agentName(ctx.view, to)}`, kind: 'confirm', needsValue: false, run: () => moveItem(it, from, to) }],
      });
    } else moveItem(it, from, to);
  }
  ctx.sendItem = sendItem;

  // Even Out's proposal: lined-up items move from the agents with the most lined up to agents with nothing to do,
  // one at a time, while the giver still keeps more than the taker. An item stays with an agent that reserves its
  // block, unless that agent is working on something else right now.
  function evenOutPlan(st, now) {
    const takers = Object.values(st.agents).filter((a) => !a.leftAt && a.id !== HUMAN && isIdleFree(st, a.id, now)).map((a) => ({ id: a.id, n: 0 }));
    if (!takers.length) return [];
    const givers = Object.values(st.agents)
      .filter((a) => !a.leftAt && a.id !== HUMAN)
      .map((a) => {
        const working = presence(st, a.id, now) === 'working';
        const items = linedOf(st, a.id, now).items.filter((it) => working || st.blocks[it.block]?.holder !== a.id);
        return { id: a.id, items, n: linedOf(st, a.id, now).items.length };
      })
      .filter((g) => g.items.length);
    const plan = [];
    for (;;) {
      givers.sort((x, y) => y.n - x.n);
      takers.sort((x, y) => x.n - y.n);
      const g = givers.find((x) => x.items.length);
      const t = takers[0];
      // A move helps while the giver has more lined up than the taker.
      if (!g || g.n <= t.n) break;
      const it = g.items.shift();
      plan.push({ item: it, from: g.id, to: t.id });
      g.n--;
      t.n++;
    }
    return plan;
  }
  function openEvenOut(anchor) {
    const st = ctx.view;
    const plan = evenOutPlan(st, ctx.viewNow);
    if (!plan.length) return;
    openPopover({
      key: 'even-out',
      anchor,
      title: 'Even Out',
      html: `<ul class="pop-list">${plan.map((p) => `<li><b>${esc(agentName(st, p.to))}</b> takes ${esc(p.item.id)}: ${esc(p.item.title)}, from ${esc(agentName(st, p.from))}</li>`).join('')}</ul>`,
      actions: [{ label: 'Apply', kind: 'confirm', needsValue: false, run: async () => {
        for (const p of plan) if ((await moveItem(ctx.live.items[p.item.id] || p.item, p.from, p.to)) === false) return false;
        return true;
      } }],
    });
  }

  // What an agent has lined up: open items given to it, and blocks it reserves but isn't in now.
  function linedOf(st, agentId, now) {
    const items = Object.values(st.items).filter((it) => it.assignee === agentId && (it.status === 'open' || it.status === 'blocked') && it.kind !== 'suggestion');
    const blocks = Object.values(st.blocks).filter((b) => b.holder === agentId && !isNow(st, agentId, b.id, now)).map((b) => b.id);
    return { items, blocks, count: items.length + blocks.length };
  }
  // Its lined-up items go back to Up next unassigned, its lined-up blocks are released, and it is told.
  async function returnLined(agentId) {
    const st = ctx.live;
    const { items, blocks } = linedOf(st, agentId, Date.now());
    for (const it of items) {
      if ((await ctx.act.updateItem(it.id, { assignee: null, status: 'open' })) === false) return;
      if (it.block) await ctx.act.queueItem(it);
    }
    for (const b of blocks) await ctx.act.release(b);
    const what = [...items.map((it) => it.id), ...blocks].join(', ');
    if (what) await ctx.act.message(agentId, `Your lined-up work went back to Up next: ${what}. Keep going on what you're doing now.`);
  }

  // Moving an item: it is the new agent's and open; both agents are told. A block the old agent reserves for it and
  // hasn't touched lately goes along.
  async function moveItem(it, from, to) {
    const st = ctx.live;
    const toName = agentName(st, to);
    const ok = await ctx.act.updateItem(it.id, { assignee: to, status: 'open' });
    if (ok === false) return false;
    if (from && from !== HUMAN) await ctx.act.message(from, `Moved ${it.id} (${it.title}) to ${toName}. Drop it.`);
    // Taken off the queue, if it was waiting there: it is someone's now.
    if (it.queued && it.block) await ctx.act.unqueueItem(it);
    await ctx.act.message(to, `Assigned to you: ${it.id}, ${it.title}.${it.block ? ` \`qb show ${it.block}\` has its block.` : ''}`);
    const b = it.block && st.blocks[it.block];
    if (b && b.holder === from && !isNow(st, from, it.block, Date.now())) await ctx.act.assign(it.block, to);
    return true;
  }

  // Up next holds the queue's entries in order: a whole block as its tile (placed by the page, ordered by `order`), an
  // item as its own row with its block and the buttons that act on it.
  const qRows = new Map();
  const foldBtns = new Map();
  const openFolds = new Set();
  // Who the board would hand each entry to right now, and why (T55): the same plan its wakes use (queuePlan), over
  // the agents it could hand work to: idle with nothing in hand, not finishing, and not in a terminal it can't wake.
  function predicted(st, now) {
    const free = Object.values(st.agents).filter((a) => {
      if (a.id === HUMAN || a.leftAt || a.finishing || !isIdleFree(st, a.id, now)) return false;
      // One known to sit in a plain terminal can't be woken to take it; one the page knows nothing about might.
      return ctx.sessions?.[a.id]?.kind !== 'interactive';
    });
    const plan = queuePlan(st, free.map((a) => a.id), now, { waitMin: st.board?.waitForContext || 0 });
    // Under Wait for context an entry can be held for a busy agent who knows it better (T58): marked as waiting.
    return new Map([...plan.map((p) => [p.entry.key, p]), ...(plan.waiting || []).map((p) => [p.entry.key, { ...p, waits: true }])]);
  }

  function paintQueue(st) {
    const entries = queueEntries(st).filter((q) => q.kind === 'item' || !st.blocks[q.block]?.holder);
    const plan = ctx.replayTs ? new Map() : predicted(st, ctx.viewNow || Date.now());
    toggle(upNext.el, 'has-queue', entries.length > 0);
    {
      const agents = Object.values(st.agents).filter((a) => a.id !== HUMAN && !a.leftAt);
      setText(upNext.allBtn, agents.length && agents.every((a) => a.finishing) ? 'Resume All' : 'Finish All');
      upNext.allBtn.hidden = !agents.length;
      upNext.allBtn.disabled = !!ctx.replayTs;
    }
    setText(upNext.count, entries.length ? String(entries.length) : '');
    const keep = new Set();
    // Past a few queued items of one block, the rest fold under one button per block ('197 more in Side column'),
    // so a long queue can't push Needs you and the agents out of reach (T57).
    const perBlock = new Map();
    const folded = new Map();
    entries.forEach((q, i) => {
      if (q.kind !== 'item') return;
      const it = st.items[q.item];
      if (!it) return;
      keep.add(it.id);
      const n = (perBlock.get(it.block) || 0) + 1;
      perBlock.set(it.block, n);
      const hide = n > QUEUE_SHOWN && !openFolds.has(it.block);
      if (n > QUEUE_SHOWN) folded.set(it.block, { count: (folded.get(it.block)?.count || 0) + 1, at: folded.get(it.block)?.at ?? i });
      let row = qRows.get(it.id);
      if (!row) {
        row = { el: h('div', { class: 'q-item', 'data-drag-item': it.id }), sig: '' };
        row.el.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b || ctx.replayTs) return;
          const cur = ctx.view.items[row.id];
          if (b.dataset.q === 'open' && cur) return openItem(cur, b);
          if (b.dataset.q === 'show') ctx.select(cur?.block);
          else if (b.dataset.q === 'unqueue' && cur) ctx.act.unqueueItem(cur);
        });
        qRows.set(it.id, row);
      }
      row.id = it.id;
      const blockName = blockMeta(st, it.block)?.name || it.block;
      const next = plan.get(it.id);
      const holder = st.blocks[it.block]?.holder;
      const taker = next?.waits ? `Waits for ${agentName(st, next.agent)}, busy now: ${next.why}` : next ? `Goes to ${agentName(st, next.agent)}: ${next.why}` : holder ? `Waits for ${agentName(st, holder)}, who has ${blockName}` : 'Waits for a free agent';
      const sig = [it.kind, it.title, blockName, !!ctx.replayTs, taker].join('|');
      if (sig !== row.sig) {
        row.sig = sig;
        setHtml(row.el, `${icon(it.kind === 'bug' ? 'bug' : it.kind === 'question' ? 'question' : it.kind === 'decision' ? 'decision' : 'task')}<span class="q-id">${esc(it.id)}</span><span class="q-title">${esc(it.title)}</span><button class="icon-btn q-open" type="button" data-q="open" aria-haspopup="dialog" aria-expanded="false" aria-label="Read ${esc(it.id)} in full" title="Read in full">${icon('note')}</button>${it.block ? `<button class="q-block" type="button" data-q="show" aria-label="Show ${esc(blockName)}" title="Show the block">${esc(blockName)}</button>` : '<span class="q-noblock">No block yet</span>'}<button class="icon-btn" type="button" data-q="unqueue" aria-label="Take ${esc(it.id)} off the queue" title="Take off the queue"${ctx.replayTs ? ' disabled' : ''}>${icon('close')}</button>${ctx.replayTs ? '' : `<span class="q-why">${esc(taker)}</span>`}`);
      }
      row.el.style.order = String(i);
      row.el.hidden = hide;
      if (row.el.parentElement !== upNext.tray) upNext.tray.append(row.el);
    });
    for (const [id, row] of qRows) if (!keep.has(id)) {
      row.el.remove();
      qRows.delete(id);
    }
    for (const [block, f] of folded) {
      let btn = foldBtns.get(block);
      if (!btn) {
        btn = h('button', { class: 'btn sm q-more', type: 'button' });
        btn.addEventListener('click', () => {
          if (openFolds.has(block)) openFolds.delete(block);
          else openFolds.add(block);
          update();
        });
        foldBtns.set(block, btn);
      }
      const name = blockMeta(st, block)?.name || block;
      setText(btn, openFolds.has(block) ? `Fold ${name}` : `${f.count} more in ${name}`);
      btn.style.order = String(openFolds.has(block) ? 1e6 + f.at : f.at);
      if (btn.parentElement !== upNext.tray) upNext.tray.append(btn);
    }
    for (const [block, btn] of foldBtns) if (!folded.has(block)) {
      btn.remove();
      foldBtns.delete(block);
      openFolds.delete(block);
    }
    // The whole-block tiles take their place in the same order.
    const pos = new Map(entries.map((q, i) => [q.block, i]).filter((_, i) => entries[i].kind === 'block'));
    for (const t of upNext.tray.querySelectorAll(':scope > .tile')) t.style.order = String(pos.get(t.dataset.block) ?? 0);
  }

  // The person's own window shows only while they reserve something, and nothing lands in it by a drop: keeping a
  // block yourself is an explicit act (Keep agents out, in the block's menu or its details).
  function youWindow() {
    const name = h('div', { class: 'win-name' });
    const disc = h('span', { class: 'disc' });
    const heldTray = h('div', { class: 'tray', 'data-label': 'Yours, agents stay out' });
    const el = h('section', { class: 'win you', 'data-win': 'human', hidden: true }, h('div', { class: 'win-head' }, disc, name), h('div', { class: 'win-body' }, heldTray));
    el.style.setProperty('--ac', 'var(--human)');
    el.style.setProperty('--aci', 'var(--slot-gray-ink)');
    return { el, name, disc, heldTray };
  }

  function agentWindow(id) {
    if (wins.has(id)) return wins.get(id);
    const name = h('div', { class: 'win-name' });
    const disc = h('span', { class: 'disc' });
    const lines = h('span', { class: 'win-lines', title: 'Lines changed' });
    const state = h('span', { class: 'state' });
    // What it is doing this second (reading, testing...), tinted with its color, beside the state.
    const tag = h('span', { class: 'act-tag' });
    const more = h('button', { class: 'win-more', type: 'button', 'aria-expanded': 'false', 'aria-label': 'More', html: icon('chev') });
    // Acts that work from the board, each its own button (B12): read what it said last, wake it, message it.
    const readBtn = h('button', { class: 'icon-btn win-act', type: 'button', 'data-act': 'read', 'data-arg': id, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-pop': `l:${id}`, html: icon('note') });
    const wakeBtn = h('button', { class: 'icon-btn win-act', type: 'button', html: icon('bell') });
    const msgBtn = h('button', { class: 'icon-btn win-act', type: 'button', html: icon('mail') });
    readBtn.addEventListener('click', () => readLast(readBtn, id));
    wakeBtn.addEventListener('click', () => wake(id));
    msgBtn.addEventListener('click', () => openMessage(id));
    const task = h('div', { class: 'win-task' });
    // What it is doing this second: the activity tag (running, testing…) leads the line, out of the crowded header.
    const doingText = h('span', { class: 'win-doing-text' });
    const doing = h('div', { class: 'win-doing' }, tag, doingText);
    const subs = h('ul', { class: 'subs', 'aria-label': 'Subagents' });
    // Now: the blocks it edits in and the items it is doing. Lined up: what it was given or reserved and hasn't
    // started, which the person can move to another agent without breaking its work.
    const tray = h('div', { class: 'tray', 'data-drop': `agent:${id}`, 'data-label': 'Now' });
    const lined = h('div', { class: 'tray', 'data-drop': `agent:${id}`, 'data-label': 'Lined up' });
    // Return Lined Up: what it hasn't started goes back to the team; what it is on now stays.
    const returnBtn = h('button', { class: 'btn sm win-return', type: 'button', hidden: true }, 'Return Lined Up');
    returnBtn.addEventListener('click', () => returnLined(id));
    const feed = h('ul', { class: 'feed' });
    const input = h('input', { class: 'field', id: `msg-${id}`, autocomplete: 'off', 'aria-label': 'Message' });
    const unread = h('span', { class: 'unread', hidden: true });
    const form = h('form', { class: 'msg' }, input, unread, h('button', { class: 'icon-btn', type: 'submit', 'aria-label': 'Send', title: 'Send', html: icon('send') }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      ctx.act.message(id, text).then((ok) => {
        if (ok) input.value = '';
      });
    });
    // The log and the message box sit behind the chevron, so every agent fits on screen.
    // Report: the agent posts where it is as a board note (the board wakes an idle one for the message).
    const reportBtn = h('button', { class: 'btn sm', type: 'button' }, 'Report');
    reportBtn.addEventListener('click', () => ctx.act.message(id, "Report: post a `qb note` saying what you're on, what's done, what's left and anything blocking. Then carry on."));
    // Finish And Stop (T38): it completes what it has now and gets no queued work until Resume.
    const finishBtn = h('button', { class: 'btn sm', type: 'button' }, 'Finish And Stop');
    finishBtn.addEventListener('click', () => setFinishing([id], !ctx.live.agents[id]?.finishing));
    const acts = h('div', { class: 'win-acts' }, reportBtn, finishBtn);
    const details = h('div', { class: 'win-details', hidden: true }, acts, feed, form);
    const el = h('section', { class: 'win', 'data-drop': `agent:${id}`, 'data-win': id }, h('div', { class: 'win-head' }, disc, name, lines, state, readBtn, wakeBtn, msgBtn, more), h('div', { class: 'win-body' }, task, doing, subs, tray, lined, returnBtn, details));
    const w = { el, name, disc, lines, tag, doingText, state, more, readBtn, wakeBtn, msgBtn, finishBtn, task, doing, subs, tray, lined, returnBtn, rows: new Map(), details, feed, input, unread, open: false };
    more.addEventListener('click', () => {
      w.open = !w.open;
      details.hidden = !w.open;
      more.setAttribute('aria-expanded', String(w.open));
      el.classList.toggle('open', w.open);
      update();
    });
    wins.set(id, w);
    return w;
  }

  function update() {
    const st = ctx.view;
    const now = ctx.viewNow;
    const human = st.agents[HUMAN];
    setText(you.name, human.name);
    setText(you.disc, initials(human.name));
    you.el.hidden = !human.held.length;
    paintQueue(st);
    upNext.evenBtn.hidden = !!ctx.replayTs || !evenOutPlan(st, now).length;
    upNext.moreBtn.hidden = !!ctx.replayTs || (upNext.evenBtn.hidden && upNext.allBtn.hidden);

    const agents = Object.values(st.agents)
      // Left a while ago, or silent for hours holding nothing (a crashed session never says goodbye): off the column.
      // One that only filed or read from elsewhere never joined (joinedAt 0) and never gets a window.
      .filter((a) => a.id !== HUMAN && (a.held.length || (!a.leftAt ? now - a.lastSeen < 6 * 60 * MIN : a.joinedAt && now - a.leftAt < 10 * MIN)))
      .map((a) => ({ a, ...agentState(st, a, now) }))
      .sort((x, y) => RANK[x.p] - RANK[y.p] || x.a.joinedAt - y.a.joinedAt);

    paintInbox(st, now, agents);
    toggle(root, 'roster', agents.length >= ROSTER_AT);
    const keep = new Set();
    for (const entry of agents) {
      keep.add(entry.a.id);
      paintAgent(st, now, agentWindow(entry.a.id), entry);
    }
    for (const [key, w] of wins) {
      if (keep.has(key)) continue;
      w.el.remove();
      wins.delete(key);
    }
    agents.forEach(({ a }, i) => {
      const el = wins.get(a.id).el;
      if (agentsHost.children[i] !== el) agentsHost.insertBefore(el, agentsHost.children[i] || null);
    });
    empty.hidden = agents.length > 0 || ctx.mode === 'snapshot';
    if (!agents.length) setHtml(empty, 'No agents yet. Start Claude Code in this repository and it shows up here on its own. Other agents join with <code>qb join</code>.');
  }

  // One row per thing the person can act on, with the act beside it.
  function paintInbox(st, now, agents) {
    const rows = [];
    for (const { a, p, since } of agents) {
      const who = `<span class="disc" style="--ac:${colorOf(st, a.id)};--aci:${inkOf(st, a.id)}">${esc(initials(a.name))}</span><span class="ib-who">${esc(a.name)}</span>`;
      const t = timer(since, { warn: 5 * MIN, over: 15 * MIN }, now);
      if (p === 'question') {
        // Every open question gets its own row and answer field, each timed from when it was asked.
        for (const q of openQuestions(st, a.id)) {
          const qt = timer(q.createdAt, { warn: 5 * MIN, over: 15 * MIN }, now);
          // One line; the whole question and the answer field open in the popover, from its own button.
          rows.push({ key: `q:${q.id}`, html: `<div class="ib-row">${who}<span class="ib-what">${esc(q.title)}</span>${qt}<button class="icon-btn" type="button" data-act="open" data-arg="${esc(q.id)}" data-pop="q:${esc(q.id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="Read and answer ${esc(q.id)}" title="Read and answer"${ctx.replayTs ? ' disabled' : ''}>${icon('note')}</button></div>` });
        }
      } else if (p === 'blocked') {
        // Blocked (T85): each blocked item, with what it waits on (its last note), the block to open, and a message box.
        const items = blockedItems(st, a.id);
        if (!items.length) rows.push({ key: `k:${a.id}`, html: `<div class="ib-row">${who}<span class="ib-what">Blocked${a.doing ? `: ${esc(a.doing)}` : ''}</span>${t}${actBtn('message', a.id, 'mail', `Message ${a.name}`)}</div>` });
        for (const it of items) {
          const why = (it.history || []).findLast((x) => x.status === 'blocked' && x.note)?.note || it.title;
          const kt = timer((it.history || []).findLast((x) => x.status === 'blocked')?.ts || since, { warn: 5 * MIN, over: 15 * MIN }, now);
          rows.push({ key: `k:${a.id}:${it.id}`, html: `<div class="ib-row">${who}<span class="ib-what">${esc(it.id)} blocked: ${esc(why)}</span>${kt}${it.block ? `<button class="btn sm" type="button" data-act="block" data-arg="${esc(it.block)}">Show</button>` : ''}${actBtn('message', a.id, 'mail', `Message ${a.name}`)}</div>` });
        }
      } else if (p === 'permission') {
        // Granted in its terminal; from here the person can read what it said last and message it (B12).
        rows.push({ key: `p:${a.id}`, html: `<div class="ib-row">${who}<span class="ib-what">${esc(a.doing || 'Waiting for permission')}</span>${t}${a.last ? actBtn('read', a.id, 'note', `Read what ${a.name} said last`) : ''}${actBtn('message', a.id, 'mail', `Message ${a.name}`)}</div>` });

      }
    }
    const head = ctx.mergeRows?.find((r) => r.entry.status === 'ready');
    if (head) {
      const t = timer(head.entry.readyAt, {}, now);
      const name = `<span class="ib-who">${esc(head.label)}</span>`;
      if (head.level === 'ok') rows.push({ key: `m:${head.entry.worktree}`, html: `<div class="ib-row"><span class="disc plain">${icon('branch')}</span>${name}<span class="ib-what">Ready to merge into ${esc(ctx.worktrees?.base || 'the base')}</span>${t}<button class="btn sm confirm" type="button" data-act="merge" data-arg="${esc(head.entry.worktree)}">Merge</button></div>` });
      else if (head.level === 'danger') rows.push({ key: `f:${head.entry.worktree}`, html: `<div class="ib-row"><span class="disc plain danger">${icon('branch')}</span>${name}<span class="ib-what">${esc(head.verdict)}</span>${t}<button class="btn sm" type="button" data-act="fix" data-arg="${esc(head.entry.worktree)}">Ask To Fix</button></div>` });
      else if (head.checks[0]?.action === 'rebase') rows.push({ key: `b:${head.entry.worktree}`, html: `<div class="ib-row"><span class="disc plain">${icon('branch')}</span>${name}<span class="ib-what">${esc(head.verdict)}</span>${t}<button class="btn sm" type="button" data-act="rebase" data-arg="${esc(head.entry.worktree)}">Rebase</button></div>` });
    }
    // A suggestion the board applied by itself (Auto-Apply, T59): what moved, and Undo, for ten minutes, and only
    // until the person acts on that suggestion (applies the rest, dismisses it, undoes it) or it goes away (T64).
    for (const n of st.notes || []) {
      if (!n.applied || now - n.ts > APPLIED_SHOWN_MS) continue;
      const sug = st.items[n.applied.suggestion];
      if (!sug || sug.history?.some((x) => x.ts > n.ts)) continue;
      const t = timer(n.ts, {}, now);
      rows.push({ key: `a:${n.id}`, quiet: true, html: `<div class="ib-row ib-quiet"><span class="disc plain">${icon('check')}</span><span class="ib-what">${esc(n.text)}</span>${t}<button class="btn sm" type="button" data-act="undo-apply" data-arg="${esc(n.id)}" aria-label="Undo: ${esc(n.text)}"${ctx.replayTs || !ctx.act.undoApply ? ' disabled' : ''}>Undo</button></div>` });
    }
    // An agent's suggested distribution of work: one line, opened whole in the popover to apply or dismiss.
    for (const sug of Object.values(st.items)) {
      if (sug.kind !== 'suggestion' || sug.status !== 'open') continue;
      const who = `<span class="disc" style="--ac:${colorOf(st, sug.by)};--aci:${inkOf(st, sug.by)}">${esc(initials(agentName(st, sug.by)))}</span><span class="ib-who">${esc(agentName(st, sug.by))}</span>`;
      const t = timer(sug.createdAt, {}, now);
      rows.push({ key: `s:${sug.id}`, html: `<div class="ib-row">${who}<span class="ib-what">suggests: ${esc(sug.title)}</span>${t}<button class="icon-btn" type="button" data-act="suggestion" data-arg="${esc(sug.id)}" data-pop="s:${esc(sug.id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="Review suggestion ${esc(sug.id)}" title="Review and apply"${ctx.replayTs ? ' disabled' : ''}>${icon('note')}</button></div>` });
    }
    // A quiet row (an auto-apply's Undo) asks nothing of the person, so it doesn't count toward Needs you.
    ctx.inboxCount = rows.filter((r) => !r.quiet).length;
    inbox.hidden = !rows.length;
    if (!rows.length) {
      setHtml(inbox, '');
      inbox.__keys = '';
      return refreshPopover();
    }
    // Rows are kept by key, so an answer being typed survives the next render.
    const html = `<div class="win-head"><span class="disc plain">${icon('inbox')}</span><div class="win-name">Needs you</div><span class="win-count">${ctx.inboxCount || ''}</span></div><div class="ib-list">${rows.map((r) => `<div class="ib" data-key="${esc(r.key)}">${r.html}</div>`).join('')}</div>`;
    // While the person types in it, the same rows aren't redrawn (their timers tick on their own).
    const typing = inbox.contains(document.activeElement) ? document.activeElement : null;
    const keys = rows.map((r) => r.key).join('|');
    if (typing && inbox.__keys === keys) return;
    const drafts = {};
    for (const f of inbox.querySelectorAll('input')) drafts[f.id] = f.value;
    setHtml(inbox, html);
    for (const f of inbox.querySelectorAll('input')) if (drafts[f.id]) f.value = drafts[f.id];
    inbox.__keys = keys;
    if (typing?.id) document.getElementById(typing.id)?.focus();
    refreshPopover();
  }

  // Its subagents, one line each: what it was sent to do, a running timer, then done or failed, fading out over a few
  // minutes once it ends. Nothing more: they have no window, disc, tray or lane of their own.
  function paintSubs(w, a, now) {
    const rows = (a.subs || []).filter((s) => s.state === 'running' || now - s.end < SUB_FADE);
    const html = rows
      .map((s) => {
        const ended = s.state !== 'running';
        const fade = ended ? Math.max(0.35, 1 - (now - s.end) / SUB_FADE).toFixed(2) : '1';
        const right = ended ? `<span class="sub-end">${s.state === 'failed' ? 'failed' : 'done'} · ${esc(dur(s.end - s.since))}</span>` : timer(s.since, { watch: true }, now);
        return `<li class="sub ${s.state}" style="opacity:${fade}"><span class="sub-dot"></span><span class="sub-desc">${esc(s.desc || s.kind || 'Subagent')}</span>${right}</li>`;
      })
      .join('');
    setHtml(w.subs, html);
    w.subs.hidden = !rows.length;
  }

  function paintAgent(st, now, w, { a, p, since }) {
    w.el.style.setProperty('--ac', colorOf(st, a.id));
    w.el.style.setProperty('--aci', inkOf(st, a.id));
    toggle(w.el, 'gone', p === 'gone');
    toggle(w.el, 'needs', p === 'question' || p === 'permission' || p === 'blocked');
    // Read when it has said something; Wake once its turn is over (the server says why when it can't); Message always.
    w.readBtn.hidden = !a.last;
    w.readBtn.setAttribute('aria-label', `Read what ${a.name} said last`);
    w.readBtn.title = 'Read what it said last';
    const kind = ctx.sessions?.[a.id]?.kind;
    w.wakeBtn.hidden = !!ctx.replayTs || !['review', 'idle', 'stale', 'quiet'].includes(p) || kind === 'interactive';
    w.wakeBtn.setAttribute('aria-label', `Wake ${a.name}`);
    w.wakeBtn.title = 'Wake: hand it what waits for it on the board';
    w.msgBtn.setAttribute('aria-label', `Message ${a.name}`);
    w.msgBtn.title = 'Message';
    setText(w.disc, initials(a.name));
    setText(w.name, a.name);
    // One count of lines: the worktree's, against the base, when git knows it and the agent has it to itself;
    // in a shared worktree, what its own edits reported.
    const wt = ctx.worktrees?.list.find((x) => x.agents?.length === 1 && x.agents[0] === a.id);
    const add = wt ? wt.add : a.added;
    const del = wt ? wt.del : a.removed;
    setText(w.lines, add || del ? `+${add} −${del}` : '');
    w.state.className = `state ${p}`;
    toggle(w.el, 'idle-free', p === 'idle');
    const act = p === 'question' || p === 'permission' ? '' : activityOf(st, a.id, now);
    setText(w.tag, act);
    w.tag.title = act ? 'Right now' : '';
    const t =
      p === 'working' ? timer(since, { watch: true }, now)
      : p === 'question' || p === 'permission' || p === 'review' || p === 'blocked' ? timer(since, { warn: 5 * MIN, over: 15 * MIN }, now)
      : p === 'quiet' ? timer(since, { warn: 10 * MIN }, now)
      : p === 'stale' ? timer(since, { over: 2 * 60 * MIN }, now)
      : timer(since, {}, now);
    // Asked to finish (T38): Finishing while it works, Stopped once it has ended its turn.
    const word = a.finishing && p === 'working' ? 'Finishing' : a.finishing && (p === 'idle' || p === 'review') ? 'Stopped' : WORD[p] || p;
    setHtml(w.state, p === 'working' && !a.finishing ? t : `${word} ${t}`);
    toggle(w.el, 'finishing', !!a.finishing);
    setText(w.finishBtn, a.finishing ? 'Resume' : 'Finish And Stop');
    w.finishBtn.disabled = !!ctx.replayTs || p === 'gone';
    w.state.title = word;

    paintAgentItems(st, w, a.id);
    w.returnBtn.hidden = !!ctx.replayTs || !linedOf(st, a.id, now).count;
    setText(w.task, a.task);
    w.task.hidden = !a.task;
    const doing = a.doing || (a.lastRun && now - a.lastRun.ts < 10 * MIN ? a.lastRun.cmd : '');
    const shown = doing.replace(/\S*\/(\S+)/g, '$1');
    const same = !!a.task && shown.includes(a.task);
    setText(w.doingText, same ? '' : shown);
    w.doing.hidden = p === 'gone' || (!w.tag.textContent && (!doing || same));
    paintSubs(w, a, now);

    if (w.open) {
      const lines = feedLines(st, ctx.eventsOf(a.id), now, 5);
      setHtml(w.feed, lines.map((l) => `<li class="k-${l.k}"><time>${clock(l.ts)}</time>${icon(l.icon)}<span class="t">${esc(l.text)}</span></li>`).join(''));
    }
    w.unread.hidden = !a.inbox.length;
    const later = a.inbox.length && !readsSoon(st, a.id, now, ctx.sessions);
    setText(w.unread, a.inbox.length ? `${a.inbox.length} unread${later ? `, delivered when ${a.name} next runs` : ''}` : '');
    w.unread.title = later ? 'Its turn has ended; messages reach it on its next prompt or tool call.' : '';
    w.input.placeholder = `Message ${a.name}`;
    w.input.disabled = !!a.leftAt || !!ctx.replayTs;
  }

  return {
    update,
    mergeHost,
    trayFor(key, block) {
      if (key === 'queue') return upNext.tray;
      if (key === HUMAN) return you.heldTray;
      const w = wins.get(key);
      if (!w) return null;
      return block && !isNow(ctx.view, key, block, ctx.viewNow) ? w.lined : w.tray;
    },
    focusAnswer() {
      inbox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      inbox.querySelector('input')?.focus();
    },
    windowOf(id) {
      return wins.get(id)?.el;
    },
  };
}

// A block is in an agent's Now while it edits there or just took it: a touch of its own, or the reservation, in the
// last 20 minutes, or an item there it is doing. Otherwise it is lined up.
const NOW_MS = 20 * MIN;
export function isNow(st, agentId, blockId, now) {
  const b = st.blocks[blockId];
  if (!b) return true;
  if (b.holder === agentId && now - (b.since || 0) < NOW_MS) return true;
  for (let i = b.touches.length - 1; i >= 0; i--) {
    const t = b.touches[i];
    if (now - t.ts >= NOW_MS) break;
    if (t.agent === agentId) return true;
  }
  return Object.values(st.items).some((it) => it.block === blockId && it.assignee === agentId && it.status === 'doing');
}

// The last few things an agent did, newest first, with repeats folded together.
export function feedLines(st, events, now, n) {
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i];
    if (e.ts > now) continue;
    const line = feedLine(st, e);
    if (!line) continue;
    const prev = out[out.length - 1];
    if (prev && prev.k === line.k && prev.text === line.text) continue;
    out.push(line);
  }
  return out;
}

function feedLine(st, e) {
  const name = (id) => blockMeta(st, id)?.name || id;
  switch (e.type) {
    case 'block.reserve':
      return { ts: e.ts, k: 'reserve', icon: e.mode === 'watch' ? 'eye' : 'reserve', text: `${e.mode === 'watch' ? 'Watching' : 'Took'} ${name(e.block)}${typeof e.agent === 'string' && e.agent !== e.by ? ` from ${agentName(st, e.by)}` : ''}` };
    case 'block.release':
      return { ts: e.ts, k: 'release', icon: 'release', text: `${e.outcome === 'landed' ? 'Landed' : 'Released'} ${name(e.block)}` };
    case 'touch':
      if (e.op === 'run') return { ts: e.ts, k: 'run', icon: 'run', text: e.cmd || 'Ran a command' };
      return { ts: e.ts, k: 'edit', icon: e.op === 'read' ? 'file' : 'edit', text: (e.files || []).map((f) => f.split('/').pop()).join(', ') };
    case 'test':
      return { ts: e.ts, k: e.ok ? 'test-ok' : 'test-fail', icon: e.ok ? 'check' : 'cross', text: e.summary || (e.ok ? 'Tests pass' : 'Tests fail') };
    case 'item.add':
      return { ts: e.ts, k: e.item.kind === 'question' ? 'ask' : e.item.kind === 'bug' ? 'bug' : 'task', icon: e.item.kind === 'question' ? 'question' : e.item.kind === 'bug' ? 'bug' : 'task', text: e.item.title };
    case 'item.update':
      if (e.answer) return { ts: e.ts, k: 'ask', icon: 'question', text: e.answer };
      return e.status === 'done' ? { ts: e.ts, k: 'task', icon: 'done', text: st.items[e.item]?.title || e.item } : null;
    case 'merge.ready':
      return { ts: e.ts, k: 'release', icon: 'branch', text: 'Ready to merge' };
    case 'note':
      return { ts: e.ts, k: 'note', icon: 'note', text: e.text };
    case 'msg':
      return e.auto ? null : { ts: e.ts, k: 'note', icon: 'mail', text: e.text };
    case 'agent.join':
      return { ts: e.ts, k: 'join', icon: 'join', text: 'Joined' };
    case 'agent.leave':
      return { ts: e.ts, k: 'join', icon: 'join', text: 'Left' };
    default:
      return null;
  }
}
