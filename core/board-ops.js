// Reshaping the board: split a block into a district of sub-blocks, dissolve a district or join blocks into one,
// move a block, rename, and the page's district layout. Pure, so it runs in Node and in the browser (the page
// can check a change before it sends it); the write itself is the store's `writeBoard`.
//
// Districts stay a flat list; a district nested in another names it as `parent`. A refusal is thrown as
// `{ code, message }`: `held`, `queued` or `frozen` (an affected block is busy), `unknown`, `invalid`, `cycle`.

import { compileIndex, blockForPath } from './glob.js';
import { HUMAN, validId, agentName } from './model.js';

export const BOARD_OPS = ['split', 'dissolve', 'join', 'move', 'rename', 'layout', 'settings'];

const refuse = (code, message) => {
  throw { code, message };
};

// The new board for `op`, or a refusal. `state` (the folded live state) lets it refuse changes to busy blocks;
// `files` (the repository's paths) lets a split draft its sub-blocks from folders and check no file changes block.
export function applyBoardOp(board, op, opts = {}) {
  return planBoardOp(board, op, opts).board;
}

// The same, with what the change did: a one-line summary for the log, and `remap` (old block id to new) for the
// open items of blocks that went away.
export function planBoardOp(board, op, { state = null, actor = HUMAN, files = null } = {}) {
  if (!op || typeof op !== 'object' || !BOARD_OPS.includes(op.op)) refuse('invalid', `Board changes are ${BOARD_OPS.join(', ')}.`);
  const next = structuredClone(board);
  next.districts = next.districts || [];
  next.blocks = next.blocks || [];
  const plan = OPS[op.op](next, op, { state, actor, files });
  validateBoard(next);
  return { board: next, summary: plan.summary, remap: plan.remap || {}, affected: plan.affected || [] };
}

const OPS = {
  rename(b, op) {
    const name = cleanName(op.name);
    const target = findBlock(b, op.id, false) || findDistrict(b, op.id, false);
    if (!target) refuse('unknown', `No block or district "${op.id}".`);
    const was = target.name;
    target.name = name;
    return { summary: `renamed ${was} to ${name}` };
  },

  move(b, op, ctx) {
    const block = findBlock(b, op.block);
    const district = findDistrict(b, op.district);
    busy(ctx, [block.id]);
    if (op.before !== undefined && op.before !== null) {
      const before = findBlock(b, op.before);
      if (before.district !== district.id) refuse('invalid', `${before.name} isn't in ${district.name}.`);
      if (before.id === block.id) return { summary: `left ${block.name} where it was`, affected: [block.id] };
    }
    const from = b.districts.find((d) => d.id === block.district);
    b.blocks.splice(b.blocks.indexOf(block), 1);
    block.district = district.id;
    // Before the named block, else after the district's last block, else at the end.
    let at = op.before ? b.blocks.findIndex((x) => x.id === op.before) : lastIndex(b.blocks, (x) => x.district === district.id) + 1;
    if (at <= 0 && !op.before) at = b.blocks.length;
    b.blocks.splice(at, 0, block);
    return { summary: from?.id === district.id ? `moved ${block.name} within ${district.name}` : `moved ${block.name} to ${district.name}`, affected: [block.id] };
  },

  // Board-wide switches the page's Settings writes: nudgeIdle (the board wakes idle agents for waiting work) and
  // waitForContext (minutes a queued entry may wait for a busy agent with much more context; 0 is off), and
  // autoApply (the board applies agents' suggestions as they land, within guards; T59).
  settings(b, op) {
    const said = [];
    if (op.nudgeIdle !== undefined) {
      if (typeof op.nudgeIdle !== 'boolean') refuse('invalid', 'nudgeIdle is true or false.');
      b.nudgeIdle = op.nudgeIdle;
      said.push(op.nudgeIdle ? 'turned on nudging idle agents' : 'turned off nudging idle agents');
    }
    if (op.waitForContext !== undefined) {
      if (!Number.isInteger(op.waitForContext) || op.waitForContext < 0 || op.waitForContext > 120) refuse('invalid', 'waitForContext is whole minutes, 0 to 120.');
      b.waitForContext = op.waitForContext;
      said.push(op.waitForContext ? `queued work waits up to ${op.waitForContext} min for the agent who knows it` : 'queued work never waits for context');
    }
    if (op.autoApply !== undefined) {
      if (typeof op.autoApply !== 'boolean') refuse('invalid', 'autoApply is true or false.');
      b.autoApply = op.autoApply;
      said.push(op.autoApply ? "turned on applying agents' suggestions as they land" : "turned off applying agents' suggestions");
    }
    if (!said.length) refuse('invalid', 'Settings are { nudgeIdle?: true | false, waitForContext?: minutes, autoApply?: true | false }.');
    return { summary: said.join('; ') };
  },

  layout(b, op) {
    if (op.districts === null) {
      delete b.layout;
      return { summary: 'tidied the map' };
    }
    if (!op.districts || typeof op.districts !== 'object') refuse('invalid', 'A layout is { districts: { <id>: { x, y, cols? } } }, or districts: null to tidy.');
    const known = new Set(b.districts.map((d) => d.id));
    const into = { ...(b.layout?.districts || {}) };
    for (const [id, pos] of Object.entries(op.districts)) {
      if (!known.has(id)) continue;
      into[id] = layoutEntry(pos, id);
    }
    b.layout = { ...(b.layout || {}), districts: into };
    return { summary: 'arranged the map' };
  },

  split(b, op, ctx) {
    const { files } = ctx;
    const block = findBlock(b, op.block);
    busy(ctx, [block.id]);
    // The only block of a district (as a dissolve leaves one) splits back into that district; any other becomes a
    // district of its own id and name, inside the one it was in.
    const lone = !b.blocks.some((x) => x !== block && x.district === block.district) && !b.districts.some((d) => d.parent === block.district);
    const home = lone ? block.district : block.id;
    if (!lone && b.districts.some((d) => d.id === block.id)) refuse('invalid', `A district is already called ${block.id}.`);
    const taken = new Set([...b.blocks.map((x) => x.id), ...b.districts.map((d) => d.id)]);
    taken.delete(block.id);
    let children;
    if (op.into !== undefined) {
      if (!Array.isArray(op.into) || op.into.length < 2) refuse('invalid', 'A split needs at least two parts: into: [{ name, paths }, ...].');
      children = op.into.map((c, i) => ({
        id: c?.id ?? freeId(taken, `${block.id}-${slug(c?.name || String(i + 1))}`),
        name: cleanName(c?.name),
        district: home,
        about: typeof c?.about === 'string' ? c.about : '',
        paths: cleanPaths(c?.paths, c?.name),
        docs: [...(block.docs || [])],
        keywords: Array.isArray(c?.keywords) ? c.keywords : [],
      }));
      for (const c of children) {
        if (!validId(c.id)) refuse('invalid', `"${String(c.id).slice(0, 40)}" isn't a valid block id.`);
        if (taken.has(c.id)) refuse('invalid', `The id ${c.id} is taken.`);
        taken.add(c.id);
      }
    } else {
      if (!files) refuse('invalid', `Splitting ${block.name} by folder needs the repository's files; name the parts instead.`);
      children = draftParts(b, block, files, taken, home);
    }
    const at = b.blocks.indexOf(block);
    b.blocks.splice(at, 1, ...children);
    if (!lone) {
      const parent = b.districts.findIndex((d) => d.id === block.district);
      b.districts.splice(parent + 1, 0, { id: block.id, name: block.name, parent: block.district });
    }
    if (files) checkOwners(board0(b, block, children), b, files, block, children);
    // Open items of the block go to its biggest part (the first, when no files are known).
    const biggest = files ? largest(b, children, files) : children[0];
    return { summary: `split ${block.name} into ${children.map((c) => c.name).join(', ')}`, remap: { [block.id]: biggest.id }, affected: [block.id] };
  },

  dissolve(b, op, ctx) {
    const district = findDistrict(b, op.district);
    const subtree = descendants(b, district.id);
    const members = b.blocks.filter((x) => subtree.has(x.district));
    if (!members.length) refuse('invalid', `${district.name} has no blocks to dissolve.`);
    // A nested district gives way to one block of its id in its parent; a top-level one stays, holding one block.
    const home = district.parent || district.id;
    const id = op.into ?? (district.parent ? district.id : members[0].id);
    const gone = new Set([...subtree].filter((d) => d !== home));
    return mergeInto(b, ctx, members, { id, name: op.name ?? district.name, district: home, goneDistricts: gone, what: district.name });
  },

  join(b, op, ctx) {
    if (!Array.isArray(op.members) || op.members.length < 2) refuse('invalid', 'Join at least two blocks or districts: members: [...].');
    if (op.into === undefined) refuse('invalid', 'Say what the joined block is called: into: <id>.');
    const members = [];
    const goneDistricts = new Set();
    let home = op.district ?? null;
    for (const m of op.members) {
      const block = findBlock(b, m, false);
      if (block) {
        if (!members.includes(block)) members.push(block);
        home ??= block.district;
        continue;
      }
      const d = findDistrict(b, m, false);
      if (!d) refuse('unknown', `No block or district "${m}".`);
      for (const sub of descendants(b, d.id)) goneDistricts.add(sub);
      for (const x of b.blocks) if (goneDistricts.has(x.district) && !members.includes(x)) members.push(x);
      home ??= d.parent || null;
    }
    if (!home) refuse('invalid', 'Say which district the joined block goes in: district: <id>.');
    if (goneDistricts.has(home)) refuse('invalid', `The joined block can't go in ${home}, which the join takes apart.`);
    findDistrict(b, home);
    if (members.length < 2) refuse('invalid', 'Join at least two blocks.');
    return mergeInto(b, ctx, members, { id: op.into, name: op.name ?? (findBlock(b, op.into, false)?.name || title(op.into)), district: home, goneDistricts, what: members.map((m) => m.name).join(', ') });
  },
};

// Members become one block: their paths, docs and keywords together, at the first member's place.
function mergeInto(b, ctx, members, { id, name, district, goneDistricts, what }) {
  busy(ctx, members.map((m) => m.id));
  if (!validId(id)) refuse('invalid', `"${String(id).slice(0, 40)}" isn't a valid block id: up to 80 letters, digits, _, . and -.`);
  const ids = new Set(members.map((m) => m.id));
  if (b.blocks.some((x) => x.id === id && !ids.has(x.id))) refuse('invalid', `A block is already called ${id}.`);
  if (b.districts.some((d) => d.id === id && !goneDistricts.has(d.id))) refuse('invalid', `A district is already called ${id}.`);
  const union = (k) => [...new Set(members.flatMap((m) => m[k] || []))];
  const merged = {
    id,
    name: cleanName(name),
    district,
    about: members.length === 1 ? members[0].about || '' : `Was ${members.map((m) => m.name).join(', ')}.`,
    paths: union('paths'),
    docs: union('docs'),
    keywords: union('keywords'),
  };
  const at = b.blocks.indexOf(members[0]);
  b.blocks.splice(at, 0, merged);
  b.blocks = b.blocks.filter((x) => x === merged || !ids.has(x.id));
  b.districts = b.districts.filter((d) => !goneDistricts.has(d.id));
  if (b.layout?.districts) for (const d of goneDistricts) delete b.layout.districts[d];
  const remap = Object.fromEntries(members.filter((m) => m.id !== id).map((m) => [m.id, id]));
  return { summary: `joined ${what} into ${merged.name}`, remap, affected: members.map((m) => m.id) };
}

// A busy block can't be reshaped: reserved by someone other than the one asking, queued, or frozen.
function busy(ctx, ids) {
  const st = ctx.state;
  if (!st) return;
  for (const id of ids) {
    const s = st.blocks[id];
    if (!s) continue;
    const name = st.board?.blocks?.find((x) => x.id === id)?.name || id;
    if (s.holder && s.holder !== ctx.actor) refuse('held', `${name} is reserved by ${agentName(st, s.holder)}; it can be reshaped once it's released.`);
    if (s.queued) refuse('queued', `${name} is in the queue; take it off the queue first.`);
    if (s.frozen) refuse('frozen', `${name} is frozen; unfreeze it first.`);
  }
}

// Sub-blocks from the folders under the block's files: one per folder one level below where they all sit, and
// one for the files right there. When everything sits in one folder, it looks one level further down.
function draftParts(b, block, files, taken, home) {
  const index = compileIndex(b.blocks);
  const mine = files.filter((f) => blockForPath(index, f) === block.id);
  if (!mine.length) refuse('invalid', `${block.name} owns no files, so there's nothing to split by folder.`);
  let base = commonDir(mine);
  let groups;
  for (;;) {
    groups = new Map();
    const loose = [];
    for (const f of mine) {
      const rest = base ? f.slice(base.length + 1) : f;
      if (rest.includes('/')) {
        const sub = rest.split('/')[0];
        if (!groups.has(sub)) groups.set(sub, []);
        groups.get(sub).push(f);
      } else loose.push(f);
    }
    if (groups.size === 1 && !loose.length) {
      base = base ? `${base}/${[...groups.keys()][0]}` : [...groups.keys()][0];
      continue;
    }
    if (loose.length) groups.set('', loose);
    break;
  }
  if (groups.size < 2) refuse('invalid', `All of ${block.name} sits in one folder (${base || 'the top'}), so there are no folders to split by; name the parts instead.`);
  const ownerOf = (paths) => compileIndex([...b.blocks.filter((x) => x.id !== block.id), { id: '\u0000', paths }]);
  const parts = [];
  for (const [sub, list] of groups) {
    const dir = sub ? (base ? `${base}/${sub}` : sub) : base;
    // A folder pattern, unless it would take files from another block or leave some of its own behind; then the
    // files by name.
    let paths = sub ? [`${dir}/`] : [base ? `${base}/*` : '*'];
    if (!sub && !base) paths = [...list];
    const idx = ownerOf(paths);
    const claims = files.filter((f) => blockForPath(idx, f) === '\u0000');
    const exact = claims.length !== list.length || claims.some((f) => !list.includes(f));
    if (exact) paths = [...list];
    const name = sub ? title(sub) : `${block.name} (files)`;
    parts.push({
      id: uniqueId(taken, `${block.id}-${slug(sub || 'files')}`),
      name,
      district: home,
      about: sub ? `Everything under ${dir}/.` : `The files directly in ${base || 'the top level'}.`,
      paths,
      docs: [...(block.docs || [])],
      keywords: sub ? [sub.toLowerCase()] : [],
    });
  }
  return parts;
}

// Every file keeps its block, except the split block's, which each go to one of its parts.
function board0(b, block, children) {
  const before = b.blocks.filter((x) => !children.includes(x));
  before.push(block);
  return before;
}
function checkOwners(beforeBlocks, b, files, block, children) {
  const was = compileIndex(beforeBlocks);
  const now = compileIndex(b.blocks);
  const parts = new Set(children.map((c) => c.id));
  const moved = [];
  for (const f of files) {
    const a = blockForPath(was, f);
    const z = blockForPath(now, f);
    if (a === block.id ? !parts.has(z) : a !== z) moved.push(`${f} (${a || 'no block'} to ${z || 'no block'})`);
  }
  if (moved.length) refuse('invalid', `That split would move files between blocks: ${moved.slice(0, 5).join(', ')}${moved.length > 5 ? ` and ${moved.length - 5} more` : ''}.`);
}

function largest(b, children, files) {
  const index = compileIndex(b.blocks);
  const n = new Map(children.map((c) => [c.id, 0]));
  for (const f of files) {
    const id = blockForPath(index, f);
    if (n.has(id)) n.set(id, n.get(id) + 1);
  }
  return children.reduce((best, c) => (n.get(c.id) > n.get(best.id) ? c : best), children[0]);
}

// The whole board, checked: ids, names, paths, the districts' nesting and the layout. Throws a refusal.
export function validateBoard(b) {
  if (!b || !Array.isArray(b.districts) || !Array.isArray(b.blocks)) refuse('invalid', 'A board has districts and blocks.');
  const districts = new Map();
  for (const d of b.districts) {
    if (!d || !validId(d.id)) refuse('invalid', `"${String(d?.id).slice(0, 40)}" isn't a valid district id.`);
    if (districts.has(d.id)) refuse('invalid', `Two districts are called ${d.id}.`);
    if (typeof d.name !== 'string' || !d.name.trim()) refuse('invalid', `District ${d.id} needs a name.`);
    districts.set(d.id, d);
  }
  for (const d of b.districts) {
    if (d.parent === undefined || d.parent === null) continue;
    if (!districts.has(d.parent)) refuse('unknown', `District ${d.id} sits in ${d.parent}, which isn't a district.`);
    const seen = new Set([d.id]);
    for (let p = d.parent; p; p = districts.get(p)?.parent) {
      if (seen.has(p)) refuse('cycle', `District ${d.id} ends up inside itself.`);
      seen.add(p);
    }
  }
  const blocks = new Set();
  for (const x of b.blocks) {
    if (!x || !validId(x.id)) refuse('invalid', `"${String(x?.id).slice(0, 40)}" isn't a valid block id.`);
    if (blocks.has(x.id)) refuse('invalid', `Two blocks are called ${x.id}.`);
    blocks.add(x.id);
    if (typeof x.name !== 'string' || !x.name.trim()) refuse('invalid', `Block ${x.id} needs a name.`);
    if (!districts.has(x.district)) refuse('unknown', `Block ${x.id} sits in ${x.district}, which isn't a district.`);
    if (!Array.isArray(x.paths) || !x.paths.length || x.paths.some((p) => typeof p !== 'string' || !p.trim())) refuse('invalid', `Block ${x.id} needs paths.`);
  }
  if (b.layout !== undefined && b.layout !== null) {
    if (typeof b.layout !== 'object') refuse('invalid', 'The layout is an object.');
    const into = {};
    for (const [id, pos] of Object.entries(b.layout.districts || {})) if (districts.has(id)) into[id] = layoutEntry(pos, id);
    b.layout.districts = into;
  }
  return b;
}

function layoutEntry(pos, id) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) refuse('invalid', `District ${id}'s place needs finite x and y.`);
  const out = { x: pos.x, y: pos.y };
  if (pos.cols !== undefined && pos.cols !== null) {
    if (!Number.isInteger(pos.cols) || pos.cols < 1) refuse('invalid', `District ${id}'s cols is a whole number of at least 1.`);
    out.cols = pos.cols;
  }
  return out;
}

// The districts inside one, itself included.
export function descendants(b, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of b.districts) {
      if (d.parent && out.has(d.parent) && !out.has(d.id)) {
        out.add(d.id);
        grew = true;
      }
    }
  }
  return out;
}

function findBlock(b, id, must = true) {
  const x = b.blocks.find((y) => y.id === id);
  if (!x && must) refuse('unknown', `No block "${String(id).slice(0, 40)}".`);
  return x || null;
}
function findDistrict(b, id, must = true) {
  const d = b.districts.find((y) => y.id === id);
  if (!d && must) refuse('unknown', `No district "${String(id).slice(0, 40)}".`);
  return d || null;
}
function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) refuse('invalid', 'A name is a few words.');
  if (name.length > 80) refuse('invalid', 'A name is at most 80 characters.');
  return name.trim();
}
function cleanPaths(paths, name) {
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string' || !p.trim())) refuse('invalid', `${name || 'Each part'} needs paths.`);
  return paths.map((p) => p.trim());
}
function commonDir(files) {
  const dirs = files.map((f) => f.split('/').slice(0, -1));
  let n = 0;
  while (dirs.every((d) => d.length > n && d[n] === dirs[0][n])) n++;
  return dirs[0].slice(0, n).join('/');
}
function lastIndex(list, fn) {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return i;
  return -1;
}
function freeId(taken, base) {
  let id = base.slice(0, 80);
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 76)}-${n}`;
  return id;
}
function uniqueId(taken, base) {
  let id = base.slice(0, 80);
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 76)}-${n}`;
  taken.add(id);
  return id;
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';
}
function title(s) {
  const t = String(s).replace(/[-_.]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
