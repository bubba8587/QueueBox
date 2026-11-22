// Where the page's events come from: the live board server when the page is served by `qb serve`, or the
// session `qb snapshot` wrote beside it when it's opened anywhere else.

export async function connect({ onBoard, onEvents, onReset, onStatus, onWorktrees, onVersion, onSessions }) {
  const token = new URLSearchParams(location.search).get('token');
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  // The board server marks the pages it serves; anywhere else there is no API to ask.
  const served = !!document.querySelector('meta[name="queuebox"][content="server"]');
  const live = served ? await tryLive(q, { onBoard, onEvents, onReset, onStatus, onWorktrees, onVersion, onSessions }) : null;
  if (live) return live;
  return snapshot({ onStatus });
}

// The page takes events from the stream only, in the log's order; a commit just waits for its own events to come
// back on it. Each batch's id is the log's byte offset after it, so a dropped stream resumes exactly where it
// left off (the browser sends the last id it saw; before any, the offset the first read ended at).
async function tryLive(q, { onBoard, onEvents, onReset, onStatus, onWorktrees, onVersion, onSessions }) {
  let board;
  let events;
  let from = null;
  try {
    const res = await fetch(`api/board${q}`, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    board = await res.json();
    const log = await fetch(`api/events${q}`, { cache: 'no-store' });
    from = log.headers.get('x-queuebox-offset');
    events = await log.json();
  } catch {
    return null;
  }
  const seen = new Set(events.map((e) => e.id));
  const waiting = new Map();
  const arrived = (list) => {
    for (const e of list) {
      const done = waiting.get(e.id);
      if (done) {
        waiting.delete(e.id);
        done();
      }
    }
  };
  const take = (list) => {
    const fresh = list.filter((e) => !seen.has(e.id));
    for (const e of fresh) seen.add(e.id);
    if (fresh.length) onEvents(fresh);
    arrived(list);
  };
  const es = new EventSource(`api/stream${q}${from !== null ? `${q ? '&' : '?'}from=${encodeURIComponent(from)}` : ''}`);
  es.addEventListener('hello', () => onStatus('live'));
  es.addEventListener('events', (m) => take(JSON.parse(m.data)));
  es.addEventListener('board', (m) => onBoard(JSON.parse(m.data)));
  es.addEventListener('worktrees', (m) => onWorktrees(JSON.parse(m.data)));
  // A stamp of the page's own code (ui/ and core/): sent on connect and whenever it changes.
  es.addEventListener('version', (m) => onVersion?.(JSON.parse(m.data).v));
  // Which agents run as background sessions the board can wake ({ agentId: { kind, status } }).
  es.addEventListener('sessions', (m) => onSessions?.(JSON.parse(m.data)));
  es.addEventListener('reset', (m) => {
    const list = JSON.parse(m.data).events;
    seen.clear();
    for (const e of list) seen.add(e.id);
    onReset(list);
    arrived(list);
  });
  es.addEventListener('problem', (m) => onStatus('problem', JSON.parse(m.data).message));
  es.onerror = () => onStatus('offline');
  return {
    mode: 'live',
    board,
    events,
    // A change to the board itself (where districts sit, which district a block is in). The answer carries the new
    // board; the stream sends it too.
    async boardOp(op) {
      const res = await fetch(`api/board${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-queuebox': '1' },
        body: JSON.stringify(op),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.message || body.error || `The board answered ${res.status}.`);
      return body.board;
    },
    async commit(list) {
      const res = await fetch(`api/commit${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-queuebox': '1' },
        body: JSON.stringify({ events: list }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The board answered ${res.status}.`);
      const accepted = body.accepted || [];
      // Resolves once the stream has delivered them (it was sent before this answer), or after a few seconds.
      const pending = accepted.filter((e) => !seen.has(e.id)).map((e) => new Promise((done) => waiting.set(e.id, done)));
      let timer;
      await Promise.race([Promise.all(pending), new Promise((done) => (timer = setTimeout(done, 4000)))]);
      clearTimeout(timer);
      for (const e of accepted) waiting.delete(e.id);
      return accepted;
    },
  };
}

// A page opened without a board server: the session `qb snapshot` wrote beside it (board.json, events.json),
// replayed and read-only. Nothing here changes; the timeline scrubs it.
async function snapshot({ onStatus }) {
  const [boardRes, logRes] = await Promise.all([fetch('board.json', { cache: 'no-store' }), fetch('events.json', { cache: 'no-store' })]);
  if (!boardRes.ok || !logRes.ok) throw new Error('No board server answered, and there is no snapshot (board.json and events.json, from `qb snapshot`) beside this page.');
  const board = await boardRes.json();
  const events = await logRes.json();
  onStatus('snapshot');
  const readOnly = async () => {
    throw new Error('This is a snapshot of a session: it shows what happened and changes nothing.');
  };
  return { mode: 'snapshot', board, events, boardOp: readOnly, commit: readOnly };
}
