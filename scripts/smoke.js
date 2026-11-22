// A browser smoke test of the board: boots a throwaway board seeded from a recorded session (test/fixtures/,
// so the same every run), drives the page the way a person would, and fails on any console error. Needs
// Playwright with a Chromium (not a dependency of QueueBox; it's found wherever `require('playwright')` resolves,
// NODE_PATH included).
//
//   node scripts/smoke.js               the checks, on the seeded board
//   node scripts/smoke.js --url <url>   the checks, on a board already running (the live one, say)
//   node scripts/smoke.js --keep        just serve the seeded board and print its address, to try a page change on
//                                       it (no Playwright needed); Ctrl+C stops it

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serve } from '../server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] || true : null);

// The recorded session, moved in time so it ends a minute ago: its agents are present, its timers sensible.
function seededBoard() {
  const fixtures = path.join(HERE, '..', 'test', 'fixtures');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-smoke-'));
  const boardDir = path.join(dir, '.queuebox');
  fs.mkdirSync(path.join(boardDir, 'live'), { recursive: true });
  fs.copyFileSync(path.join(fixtures, 'session.board.json'), path.join(boardDir, 'board.json'));
  const events = fs.readFileSync(path.join(fixtures, 'session.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const shift = Date.now() - 60_000 - events.at(-1).ts;
  fs.writeFileSync(path.join(boardDir, 'live', 'events.jsonl'), events.map((e) => JSON.stringify({ ...e, ts: e.ts + shift })).join('\n') + '\n');
  process.env.QUEUEBOX_DIR = boardDir;
  process.env.QUEUEBOX_WAKE = 'off';
  delete process.env.QUEUEBOX_LIVE;
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const given = typeof arg('--url') === 'string' ? arg('--url') : null;
const seeded = given ? null : seededBoard();
const server = given ? null : await serve({ port: 0, quiet: true });
const url = given || `http://127.0.0.1:${server.address().port}/`;

if (arg('--keep')) {
  console.log(`smoke: the seeded board is at ${url} (Ctrl+C stops it)`);
  const stop = () => {
    seeded?.done();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('smoke: Playwright is not installed here; skipped.');
  seeded?.done();
  process.exit(0);
}

const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

const browser = await chromium.launch();
const errors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => window.queuebox?.live && document.querySelectorAll('.win[data-win^="cc-"], .win[data-win^="cx-"], .win[data-win^="gm-"], .win[data-win^="wt-"]').length > 0, null, { timeout: 15_000 });

  const tiles = await page.locator('.tile').count();
  const blocks = await page.evaluate(() => window.queuebox.board.blocks.length);
  check(tiles >= blocks, `a tile per block (${tiles} for ${blocks})`);
  const fits = await page.evaluate(() => {
    const w = document.getElementById('map-wrap');
    return w.scrollHeight <= w.clientHeight + 1 && w.scrollWidth <= w.clientWidth + 1;
  });
  check(fits, 'the whole map fits at 1440x900 without scrolling');
  check((await page.locator('#tethers path').count()) === 0, 'no tethers until you point at an agent');

  // Drag a free tile into an agent's window: the agent holds it.
  const free = await page.evaluate(() => Object.values(window.queuebox.live.blocks).find((b) => !b.holder && !b.queued && !b.frozen && !b.id.startsWith('_'))?.id);
  const agent = await page.evaluate(() => Object.values(window.queuebox.live.agents).find((a) => a.id !== 'human' && !a.leftAt)?.id);
  const from = await page.locator(`.tile[data-block="${free}"]`).boundingBox();
  const to = await page.locator(`.win[data-win="${agent}"]`).boundingBox();
  await page.mouse.move(from.x + 20, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 20, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  check((await page.evaluate((id) => window.queuebox.live.blocks[id].holder, free)) === agent, 'dragging a tile to a window gives the block to that agent');

  // The inspector opens on a block and closes on Escape.
  await page.evaluate((id) => window.queuebox.select(id), free);
  await page.waitForTimeout(350);
  check(await page.locator('.inspector.open').isVisible(), 'the inspector opens');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  check(!(await page.locator('.inspector.open').count()), 'Escape closes it');

  // Focusing a worktree lights its blocks.
  const wt = await page.evaluate(() => window.queuebox.worktrees?.list.find((w) => !w.main && w.files.length)?.name);
  if (wt) {
    await page.click(`.wt-tab[data-wt="${wt}"]`);
    await page.waitForTimeout(300);
    const lit = await page.locator('.map .tile:not(.dim)').count();
    const dim = await page.locator('.map .tile.dim').count();
    check(lit > 0 && dim > 0 && (await page.locator('.wt-detail').isVisible()), `focusing ${wt} lights its blocks (${lit} lit, ${dim} dimmed)`);
    await page.click('.wt-tab[data-wt=""]');
  }

  // The merge queue reorders from the keyboard, and the head gets the act that fits it.
  const ready = await page.locator('.mq-grip').count();
  if (ready > 1) {
    const name = await page.locator('.mq-grip').last().getAttribute('data-name');
    for (let i = 0; i < ready - 1; i++) {
      await page.focus(`.mq-grip[data-name="${name}"]`);
      const place = () => page.evaluate((n) => [...document.querySelectorAll('.mq-grip')].findIndex((g) => g.dataset.name === n), name);
      const before = await place();
      await page.keyboard.press('ArrowUp');
      // Each move lands once the log streams it back, and a press before that is ignored, so wait for it.
      await page.waitForFunction(([n, b]) => [...document.querySelectorAll('.mq-grip')].findIndex((g) => g.dataset.name === n) < b, [name, before], { timeout: 5000 }).catch(() => {});
    }
    const head = await page.evaluate(() => window.queuebox.mergeRows.find((r) => r.entry.status === 'ready'));
    check(head?.entry.worktree === name, `arrow keys move ${name} to the head of the merge queue`);
    const act = await page.locator('.mq-row').first().locator('.btn').textContent().catch(() => '');
    const want = head.level === 'danger' ? 'Ask to fix' : head.checks.some((c) => c.action === 'rebase') ? 'Rebase' : head.level === 'ok' ? 'Merge' : '';
    check((act || '') === want, `the head's button says ${want || 'nothing'} (${act || 'none'})`);
  }

  // Active only keeps the blocks with something going on.
  await page.click('#active-only');
  await page.waitForTimeout(300);
  const hidden = await page.locator('.slot[hidden]').count();
  check(hidden > 0, `Active hides the quiet blocks (${hidden})`);
  await page.click('#active-only');

  // Scrubbing the timeline replays the past; Live returns.
  const tl = await page.locator('.tl-svg').boundingBox();
  if (tl) {
    await page.mouse.click(tl.x + tl.width * 0.4, tl.y + tl.height / 2);
    await page.waitForTimeout(300);
    check(!!(await page.evaluate(() => window.queuebox.replayTs)), 'scrubbing the timeline replays');
    await page.click('.tl-head button:has-text("Live")');
    check(!(await page.evaluate(() => window.queuebox.replayTs)), 'Live returns');
  }

  // Under load (T57): the stress board, served on its own. Needs you and the first agent window stay on screen, the
  // side column stays short, and a long list says its true count.
  if (!given) {
    const { writeStress } = await import('./stress.js');
    const stressDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuebox-stress-'));
    const saved = process.env.QUEUEBOX_DIR;
    process.env.QUEUEBOX_DIR = writeStress(stressDir, { end: Date.now() }).boardDir;
    const stress = await serve({ port: 0, quiet: true });
    try {
      const sp = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      sp.on('pageerror', (e) => errors.push(`stress: ${e.message}`));
      await sp.goto(`http://127.0.0.1:${stress.address().port}/`);
      await sp.waitForFunction(() => document.querySelectorAll('.side .win[data-win^="cc-"]').length >= 20, null, { timeout: 30_000 });
      const lay = await sp.evaluate(() => {
        const top = (el) => el?.getBoundingClientRect().top ?? Infinity;
        return {
          side: document.getElementById('side').scrollHeight,
          firstWin: top(document.querySelector('.side .win[data-win^="cc-"]')),
          upNext: document.querySelector('.win.upnext')?.getBoundingClientRect().height ?? 0,
          more: document.querySelector('.upnext .q-more')?.textContent || '',
        };
      });
      check(lay.firstWin < 900, `stress: the first agent window is on screen (${Math.round(lay.firstWin)}px down)`);
      check(lay.side < 6000, `stress: the side column stays short (${lay.side}px)`);
      check(/^197 more in /.test(lay.more), `stress: Up next folds the rest of a block (${lay.more})`);
      await sp.evaluate(() => window.queuebox.select('side'));
      await sp.waitForTimeout(500);
      const count = await sp.locator('.inspector .in-more').first().textContent().catch(() => '');
      check(/Showing 60 of 1,500/.test(count || ''), `stress: a block's long list says its true count (${count})`);
      const done = await sp.locator('.inspector .in-done-head').textContent().catch(() => '');
      check(/3500/.test(done || ''), `stress: Done says its count (${done})`);
    } finally {
      stress.close();
      if (saved === undefined) delete process.env.QUEUEBOX_DIR;
      else process.env.QUEUEBOX_DIR = saved;
      fs.rmSync(stressDir, { recursive: true, force: true });
    }
  }

  // A phone never scrolls sideways.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await phone.goto(url);
  await phone.waitForTimeout(2500);
  const overflow = await phone.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);

  check(!errors.length, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server?.close();
  seeded?.done();
}

if (failures.length) {
  console.error(`smoke: ${failures.length} failed`);
  process.exit(1);
}
console.log('smoke: all passed');
process.exit(0);
