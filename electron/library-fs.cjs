// The desktop app's songsheet library: one ordinary folder per songsheet.
//
// The web build keeps songsheets in IndexedDB, which is right for a browser and
// wrong for an installed app — a songsheet there is invisible outside the app,
// cannot be backed up by copying a folder, and is tied to the origin, so a port
// change would appear to lose all of them. Here each songsheet is a folder you
// can open in Finder or Explorer:
//
//   <library>/Some Song/
//     sheet.json                         title, source, recipe, page order
//     page-001-3fa2c1d0.png …            the clean pages, black on white
//     page-001-9b0e44a1-original.png …   the video frame as-is, when it differs
//     thumb.jpg                          the video thumbnail
//
// The folder name follows the title and is for people; sheet.json's id is what
// the app goes by, so renaming or moving a folder by hand loses nothing. Only
// files this module wrote are ever deleted: page files inside a songsheet
// folder that sheet.json no longer lists, and whole folders only through the
// caller's trash().
//
// A page file is named after its content as well as its position, and never
// rewritten under the same name. That is what makes a save safe to interrupt:
// new pages are written beside the old ones, sheet.json is switched over in one
// rename, and only then are the pages it no longer lists removed. At every
// moment sheet.json lists files that exist and hold what it says. Named by
// position alone, removing page 3 of 5 rewrote pages 3 and 4 in place, and a
// crash in between left the old sheet.json pointing at shifted images.
//
// Nothing in here imports Electron, so it can be exercised with plain node.

const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;
const SHEET_FILE = 'sheet.json';
const THUMB_FILE = 'thumb.jpg';
const FORMAT = 1;
// newId() in public/lib/library.js: base-36 time, a dash, eight random chars.
const ID_RE = /^[a-z0-9]{1,16}-[a-z0-9-]{1,40}$/i;
const PAGE_RE = /^page-\d{3,4}(?:-[0-9a-f]{8})?(?:-original)?\.png$/;
const HASH_RE = /^[0-9a-f]{40}$/;
// Windows refuses these as names whatever follows the dot.
const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const EDITABLE = ['title', 'artist', 'notes', 'look', 'paper', 'practice', 'listen', 'transcript', 'timing'];

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('That is not a songsheet id.');
  return id;
}

// A title as a folder name: letters of every script survive, only what some
// filesystem rejects is dropped. Leading dots would hide the folder on macOS and
// Linux, and Windows silently strips trailing dots and spaces.
function folderName(title) {
  let s = String(title ?? '').normalize('NFKC')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 80).join('');
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) s = 'Songsheet';
  if (RESERVED_RE.test(s)) s = `${s} songsheet`;
  return s;
}

// A file name read back from sheet.json is data someone could have edited, so
// it must name a file directly inside the songsheet folder and nothing else.
function childFile(dir, name) {
  if (typeof name !== 'string' || !name || name !== path.basename(name) || name === '.' || name === '..') return null;
  if (!/^[\w.-]+$/.test(name)) return null;
  return path.join(dir, name);
}

const str = (v, max) => String(v ?? '').slice(0, max);

// cleanListen, cleanTranscript and cleanTiming in public/lib/library.js, mirrored: this
// file is packed inside the app and cannot import the browser's module, so
// the self-check below runs both on the same input instead.
const TUNING_IDS = ['standard', 'dropD', 'halfDown', 'wholeDown', 'dadgad', 'openG', 'openD', 'custom'];
function cleanListen(l) {
  if (!l || typeof l !== 'object') return null;
  const tuning = Array.isArray(l.tuning) && l.tuning.length === 6 && l.tuning.every((n) => Number.isInteger(n) && n >= 28 && n <= 76)
    ? [...l.tuning] : null;
  return {
    tuningId: TUNING_IDS.includes(l.tuningId) ? l.tuningId : 'standard',
    tuning,
    capo: Math.min(12, Math.max(0, Math.round(Number(l.capo) || 0))),
    strictness: ['lenient', 'strict', 'bass'].includes(l.strictness) ? l.strictness : 'lenient',
    mode: l.mode === 'play' ? 'play' : 'wait',
  };
}
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
function cleanTranscript(t) {
  if (!t || typeof t !== 'object' || !t.pages || typeof t.pages !== 'object') return null;
  const entries = Object.entries(t.pages)
    .filter(([hash, pg]) => /^[0-9a-f]{40}$/.test(hash) && pg && Array.isArray(pg.systems))
    .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
    .slice(0, 300);
  const pages = {};
  let size = 0;
  for (const [hash, pg] of entries) {
    const clean = {
      at: Number(pg.at) || 0,
      model: String(pg.model ?? '').slice(0, 40),
      w: Math.max(0, Math.round(Number(pg.w) || 0)),
      h: Math.max(0, Math.round(Number(pg.h) || 0)),
      systems: pg.systems.slice(0, 8).map((sys) => ({
        lines: (Array.isArray(sys?.lines) ? sys.lines : []).slice(0, 6).map(r1),
        events: (Array.isArray(sys?.events) ? sys.events : []).slice(0, 400).map((ev) => ({
          x: r1(ev?.x),
          n: (Array.isArray(ev?.n) ? ev.n : []).slice(0, 6)
            .filter((n) => Array.isArray(n) && Number.isInteger(n[0]) && n[0] >= 1 && n[0] <= 6
              && (n[1] === null || (Number.isInteger(n[1]) && n[1] >= 0 && n[1] <= 24)))
            .map((n) => [n[0], n[1], String(n[2] ?? '').replace(/[^a-z0-9~/\\()<>]/g, '').slice(0, 12), r1(n[3]), r1(n[4]), r1(n[5]), r1(n[6]), (Number(n[7]) || 0) & 7]),
        })).filter((ev) => ev.n.length),
      })),
    };
    size += JSON.stringify(clean).length;
    if (size > 1_000_000) break;
    pages[hash] = clean;
  }
  return Object.keys(pages).length ? { v: 1, pages } : null;
}
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const sysOk = (s) => Number.isInteger(s) && s >= 0 && s < 8;
function cleanTiming(t) {
  if (!t || typeof t !== 'object' || !t.pages || typeof t.pages !== 'object') return null;
  const entries = Object.entries(t.pages)
    .filter(([hash, pg]) => /^[0-9a-f]{40}$/.test(hash) && pg && Array.isArray(pg.events))
    .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
    .slice(0, 300);
  const pages = {};
  let size = 0;
  for (const [hash, pg] of entries) {
    const clean = {
      at: Number(pg.at) || 0,
      events: pg.events.filter((e) => Array.isArray(e) && sysOk(e[0]) && num(e[1]) && num(e[2]) && Math.abs(e[2]) <= 3600)
        .slice(0, 800).map((e) => [e[0], r1(e[1]), Math.round(e[2] * 100) / 100]),
      fixes: (Array.isArray(pg.fixes) ? pg.fixes : [])
        .filter((f) => Array.isArray(f) && sysOk(f[0]) && num(f[1]) && Number.isInteger(f[2]) && f[2] >= 1 && f[2] <= 6
          && Number.isInteger(f[3]) && f[3] >= 0 && f[3] <= 24)
        .slice(0, 100).map((f) => [f[0], r1(f[1]), f[2], f[3]]),
    };
    size += JSON.stringify(clean).length;
    if (size > 500_000) break;
    pages[hash] = clean;
  }
  return Object.keys(pages).length ? { v: 1, pages } : null;
}
const sha1 = (buf) => require('node:crypto').createHash('sha1').update(buf).digest('hex');

// Windows refuses to rename a folder while anything holds a file inside it —
// often only for a moment, while a virus scanner reads the PNG just written.
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
}

// The same rules as normaliseSheet() in public/lib/library.js — the self-check
// below runs both on the same input — plus the one thing a folder needs that a
// database record does not: whatever the caller left out is kept from the copy
// already on disk rather than reset, so re-saving pages cannot wipe the notes
// or the date the songsheet was first made.
function cleanMeta(input = {}, previous = {}) {
  const pick = (k) => (input[k] !== undefined ? input[k] : previous[k]);
  const rect = pick('recipe')?.rect;
  const recipe = pick('recipe') || {};
  const now = Date.now();
  return {
    id: assertId(String(input.id || previous.id || '')),
    title: str(pick('title') || 'Untitled songsheet', 300),
    artist: str(pick('artist'), 200),
    notes: str(pick('notes'), 5000),
    practice: {
      speed: Math.min(2, Math.max(0.25, Math.round((Number(pick('practice')?.speed) || 1) * 100) / 100)),
      songBpm: (() => { const b = Math.round(Number(pick('practice')?.songBpm) || 0); return b >= 20 && b <= 400 ? b : 0; })(),
    },
    listen: cleanListen(pick('listen')),
    transcript: cleanTranscript(pick('transcript')),
    timing: cleanTiming(pick('timing')),
    url: str(pick('url'), 2000),
    channel: str(pick('channel'), 300),
    duration: Number(pick('duration')) || 0,
    recipe: {
      rect: rect && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(rect[k])))
        ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
        : null,
      startTime: Math.max(0, Number(recipe.startTime) || 0),
      sensitivity: Math.min(1, Math.max(0, Number(recipe.sensitivity ?? 0.5))),
    },
    look: str(pick('look') || 'print', 40),
    paper: pick('paper') === 'a4' ? 'a4' : 'letter',
    savedAt: Number(previous.savedAt) || Number(input.savedAt) || now,
    // An import (the 0.2 migration) keeps when the songsheet was last edited;
    // stamping every copy "now" put them in reverse order under "Recently
    // edited", oldest first.
    updatedAt: (input.importing && Number(input.updatedAt)) || now,
  };
}

function toBuffer(bytes, what) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  throw new Error(`${what} arrived without its image data.`);
}

// Write through a temporary name and rename over the target, so a crash or a
// full disk leaves the previous file rather than half of a new one. Unchanged
// bytes are not rewritten: re-saving after a title edit touches no page.
async function writeFileAtomic(file, data) {
  try {
    const old = await fsp.readFile(file);
    if (old.equals(data)) return false;
  } catch { /* new file */ }
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  return true;
}

async function readRecord(dir) {
  try {
    const rec = JSON.parse(await fsp.readFile(path.join(dir, SHEET_FILE), 'utf8'));
    if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !ID_RE.test(rec.id)) return null;
    return rec;
  } catch {
    return null; // not a songsheet folder, or one mid-copy
  }
}

// Every songsheet folder directly inside the library, by id. A folder duplicated
// by hand carries the same id as its original; the newer one wins and the other
// is left alone rather than guessed about.
async function scan(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    throw friendly(e, root);
  }
  const byId = new Map();
  await Promise.all(entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map(async (d) => {
    const dir = path.join(root, d.name);
    const rec = await readRecord(dir);
    if (!rec) return;
    const had = byId.get(rec.id);
    if (!had || (Number(rec.updatedAt) || 0) > (Number(had.rec.updatedAt) || 0)) byId.set(rec.id, { dir, rec });
  }));
  return byId;
}

function friendly(e, where) {
  if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
    const err = new Error(`VidToTab can’t access ${where}. On a Mac, allow it in System Settings → Privacy & Security → Files and Folders, or choose another folder.`);
    err.code = e.code;
    return err;
  }
  if (e && e.code === 'ENOSPC') return new Error('The disk is full. Free up space to save the songsheet.');
  return e;
}

// A name nothing else in the library already has. Compared without case, since
// the default filesystems on macOS and Windows treat "Song" and "song" as one.
async function freeName(root, want, own = null) {
  let taken;
  try {
    taken = new Set((await fsp.readdir(root)).filter((n) => n !== own).map((n) => n.toLowerCase()));
  } catch {
    taken = new Set();
  }
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? want : `${want} (${i})`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  throw new Error('Too many songsheets share that title.');
}

// Follow the title. Best effort: a folder held open elsewhere (Explorer, a
// terminal) cannot be renamed on Windows, and that is no reason to fail a save.
async function followTitle(root, dir, title) {
  const want = folderName(title);
  const current = path.basename(dir);
  if (current === want) return dir;
  const name = await freeName(root, want, current);
  if (name === current) return dir;
  const next = path.join(root, name);
  try {
    await renameRetry(dir, next);
    return next;
  } catch {
    return dir;
  }
}

function summary(rec, dir, extra = {}) {
  const pages = Array.isArray(rec.pages) ? rec.pages : [];
  return {
    id: rec.id,
    title: str(rec.title || 'Untitled songsheet', 300),
    artist: str(rec.artist, 200),
    notes: str(rec.notes, 5000),
    practice: rec.practice && typeof rec.practice === 'object' ? rec.practice : { speed: 1, songBpm: 0 },
    listen: cleanListen(rec.listen),
    url: str(rec.url, 2000),
    channel: str(rec.channel, 300),
    duration: Number(rec.duration) || 0,
    recipe: rec.recipe && typeof rec.recipe === 'object' ? rec.recipe : { rect: null, startTime: 0, sensitivity: 0.5 },
    look: str(rec.look || 'print', 40),
    paper: rec.paper === 'a4' ? 'a4' : 'letter',
    savedAt: Number(rec.savedAt) || 0,
    updatedAt: Number(rec.updatedAt) || Number(rec.savedAt) || 0,
    pageCount: pages.length,
    folder: path.basename(dir),
    path: dir,
    ...extra,
  };
}

async function folderBytes(dir) {
  let total = 0;
  try {
    for (const f of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      try { total += (await fsp.stat(path.join(dir, f.name))).size; } catch { /* went away */ }
    }
  } catch { /* went away */ }
  return total;
}

async function readThumb(dir, rec) {
  const file = childFile(dir, rec.thumb);
  if (!file) return null;
  try { return await fsp.readFile(file); } catch { return null; }
}

// ---------------------------------------------------------------- the library

// Newest first, with thumbnails, every songsheet — the full browser is the
// point, so there is no limit here.
async function list(root) {
  const byId = await scan(root);
  const out = await Promise.all([...byId.values()].map(async ({ dir, rec }) => summary(rec, dir, {
    thumb: await readThumb(dir, rec),
    bytes: await folderBytes(dir),
  })));
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function get(root, id) {
  assertId(id);
  const hit = (await scan(root)).get(id);
  if (!hit) return null;
  const { dir, rec } = hit;
  const pages = [];
  // Pages sheet.json lists but that could not be read: deleted by hand, or an
  // online-only file in a synced Documents folder while offline. Reported, so
  // the app can refuse to save this songsheet back — a save sends only what it
  // was given, and would drop these for good.
  let missing = 0;
  for (const [i, p] of (Array.isArray(rec.pages) ? rec.pages : []).entries()) {
    const file = childFile(dir, p?.file);
    if (!file) { missing++; continue; }
    let clean;
    try { clean = await fsp.readFile(file); } catch { missing++; continue; }
    let color = null;
    const cfile = childFile(dir, p.color);
    if (cfile) { try { color = await fsp.readFile(cfile); } catch { color = null; } }
    pages.push({
      index: i,
      tStart: Number(p.tStart) || 0,
      tEnd: Number(p.tEnd) || 0,
      alsoAt: Array.isArray(p.alsoAt) ? p.alsoAt.slice(0, 64) : [],
      w: Number(p.w) || 0,
      h: Number(p.h) || 0,
      clean,
      color,
    });
  }
  // The corrected readings and the notes' times travel only with the full
  // songsheet, not in the list the library screen draws from.
  return {
    ...summary(rec, dir, { thumb: await readThumb(dir, rec) }),
    transcript: cleanTranscript(rec.transcript),
    timing: cleanTiming(rec.timing),
    pageCount: pages.length,
    missing,
    pages,
  };
}

// pages: [{ tStart, tEnd, alsoAt, w, h, clean: bytes, color: bytes|null }]
// thumb: bytes, or null to keep whatever thumbnail the songsheet already has.
async function save(root, meta, pages = [], thumb = null) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('A songsheet needs at least one page.');
  const id = assertId(meta?.id);
  const hit = (await scan(root)).get(id);
  const prev = hit?.rec || {};
  const clean = cleanMeta(meta, prev);
  try {
    await fsp.mkdir(root, { recursive: true });
    let dir;
    if (hit) {
      dir = await followTitle(root, hit.dir, clean.title);
    } else {
      dir = path.join(root, await freeName(root, folderName(clean.title)));
      await fsp.mkdir(dir);
    }

    // What the previous save already wrote, by content, so an unchanged page
    // keeps its file rather than being written again under a new name.
    const have = new Map();
    for (const p of Array.isArray(prev.pages) ? prev.pages : []) {
      for (const [name, hash] of [[p?.file, p?.sha1], [p?.color, p?.colorSha1]]) {
        const file = childFile(dir, name);
        if (file && HASH_RE.test(String(hash)) && fs.existsSync(file)) have.set(hash, name);
      }
    }
    const width = pages.length > 999 ? 4 : 3;
    const place = async (bytes, pos, suffix, what) => {
      const buf = toBuffer(bytes, what);
      const hash = sha1(buf);
      let name = have.get(hash);
      if (!name) {
        name = `page-${String(pos).padStart(width, '0')}-${hash.slice(0, 8)}${suffix}.png`;
        await writeFileAtomic(path.join(dir, name), buf);
        have.set(hash, name);
      }
      return { name, hash };
    };

    const keep = new Set();
    const entries = [];
    for (const [i, p] of pages.entries()) {
      const clean = await place(p?.clean, i + 1, '', `Page ${i + 1}`);
      keep.add(clean.name);
      let color = null;
      if (p.color) {
        color = await place(p.color, i + 1, '-original', `Page ${i + 1}`);
        keep.add(color.name);
      }
      entries.push({
        file: clean.name,
        sha1: clean.hash,
        color: color?.name || null,
        colorSha1: color?.hash || null,
        tStart: Number(p.tStart) || 0,
        tEnd: Number(p.tEnd) || 0,
        alsoAt: Array.isArray(p.alsoAt) ? p.alsoAt.slice(0, 64).map(Number).filter(Number.isFinite) : [],
        w: Number(p.w) || 0,
        h: Number(p.h) || 0,
      });
    }

    let thumbName = childFile(dir, prev.thumb) && fs.existsSync(childFile(dir, prev.thumb)) ? prev.thumb : null;
    if (thumb) {
      await writeFileAtomic(path.join(dir, THUMB_FILE), toBuffer(thumb, 'The thumbnail'));
      thumbName = THUMB_FILE;
    }

    const rec = { format: FORMAT, app: 'VidToTab', ...clean, thumb: thumbName, pages: entries };
    await writeFileAtomic(path.join(dir, SHEET_FILE), Buffer.from(JSON.stringify(rec, null, 2) + '\n'));

    // Only now that sheet.json no longer lists them: the pages this save
    // dropped. Nothing but page files is touched.
    for (const f of await fsp.readdir(dir)) {
      if (PAGE_RE.test(f) && !keep.has(f)) await fsp.rm(path.join(dir, f), { force: true });
    }
    return summary(rec, dir);
  } catch (e) {
    throw friendly(e, root);
  }
}

// Title, artist, notes, look, paper — the things that can change without
// touching a single page.
async function update(root, id, patch = {}) {
  assertId(id);
  const hit = (await scan(root)).get(id);
  if (!hit) throw new Error('Songsheet not found in the library folder.');
  const allowed = {};
  for (const k of EDITABLE) if (patch[k] !== undefined) allowed[k] = patch[k];
  const clean = cleanMeta({ ...allowed, id }, hit.rec);
  try {
    const dir = await followTitle(root, hit.dir, clean.title);
    const rec = { ...hit.rec, ...clean, format: FORMAT, app: 'VidToTab' };
    await writeFileAtomic(path.join(dir, SHEET_FILE), Buffer.from(JSON.stringify(rec, null, 2) + '\n'));
    return summary(rec, dir, { thumb: await readThumb(dir, rec), bytes: await folderBytes(dir) });
  } catch (e) {
    throw friendly(e, root);
  }
}

async function locate(root, id) {
  assertId(id);
  return (await scan(root)).get(id)?.dir || null;
}

// trash(dir) is the shell's — the Trash or Recycle Bin, never an unlink here.
async function remove(root, ids, trash) {
  const byId = await scan(root);
  let removed = 0;
  for (const id of ids) {
    assertId(id);
    const hit = byId.get(id);
    if (!hit) continue;
    await trash(hit.dir);
    removed++;
  }
  return removed;
}

// Moving the library: only songsheet folders go, never anything else that
// happens to live beside them. A rename where it can be; across disks, where it
// cannot, every folder is copied first and the originals deleted only once all
// copies exist. Any failure undoes what was done, so the library is either
// wholly in the old folder or wholly in the new one — never split between the
// two, where half of it would be out of sight.
async function move(from, to) {
  const byId = await scan(from);
  await fsp.mkdir(to, { recursive: true });
  const done = [];
  try {
    for (const { dir } of byId.values()) {
      const target = path.join(to, await freeName(to, path.basename(dir)));
      try {
        await renameRetry(dir, target);
        done.push({ dir, target, copied: false });
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        await fsp.cp(dir, target, { recursive: true, errorOnExist: true, force: false });
        done.push({ dir, target, copied: true });
      }
    }
  } catch (e) {
    for (const d of done.reverse()) {
      try {
        if (d.copied) await fsp.rm(d.target, { recursive: true, force: true });
        else await renameRetry(d.target, d.dir);
      } catch { /* left where it is: still a whole songsheet, in one place or the other */ }
    }
    throw friendly(e, to);
  }
  // Every copy exists; the originals can go. One that cannot be removed stays
  // behind as a spare in the old folder, which the library no longer reads.
  for (const d of done) if (d.copied) await fsp.rm(d.dir, { recursive: true, force: true }).catch(() => {});
  return done.length;
}

const isSheetFolder = async (dir) => Boolean(await readRecord(dir));

// ---------------------------------------------------------------- self-check

async function selfCheck() {
  const assert = require('node:assert/strict');
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vtt-lib-'));
  const lib = path.join(root, 'library');
  const png = (n) => Buffer.from(`\x89PNG fake page ${n}`);
  const page = (n, extra = {}) => ({ tStart: n * 10, tEnd: n * 10 + 9, alsoAt: [], w: 800, h: 200, clean: png(n), color: null, ...extra });
  try {
    assert.equal(folderName('  Song: A/B?  '), 'Song A B', 'separators and reserved characters go');
    assert.equal(folderName('..hidden.'), 'hidden', 'no leading or trailing dots');
    assert.equal(folderName('CON'), 'CON songsheet', 'Windows device names are not folder names');
    assert.equal(folderName('夜に駆ける (TAB)'), '夜に駆ける (TAB)', 'every script survives');
    assert.equal(folderName(''), 'Songsheet');
    assert.equal(Array.from(folderName('x'.repeat(300))).length, 80);
    assert.equal(childFile('/a', '../b'), null);
    assert.equal(childFile('/a', 'b/c.png'), null);
    assert.equal(childFile('/a', 'page-001.png'), path.join('/a', 'page-001.png'));
    assert.throws(() => assertId('../../etc'), /id/);

    assert.deepEqual(await list(lib), [], 'a library that does not exist yet is empty, not an error');

    const a = await save(lib, { id: 'abc-00000001', title: 'First Song', url: 'https://example.test/v', savedAt: 1000 },
      [page(1), page(2, { color: png('2c') })], Buffer.from('jpeg'));
    assert.equal(a.folder, 'First Song');
    assert.equal(a.savedAt, 1000, 'a migrated sheet keeps the date it was made');
    const files = (await fsp.readdir(path.join(lib, 'First Song'))).sort();
    const count = (re) => files.filter((f) => re.test(f)).length;
    assert.equal(files.length, 5);
    assert.equal(count(/^page-001-[0-9a-f]{8}\.png$/), 1);
    assert.equal(count(/^page-002-[0-9a-f]{8}\.png$/), 1);
    assert.equal(count(/^page-002-[0-9a-f]{8}-original\.png$/), 1);
    assert.ok(files.includes('sheet.json') && files.includes('thumb.jpg'));

    // Same title, different songsheet: a second folder, not an overwrite.
    const b = await save(lib, { id: 'abc-00000002', title: 'first song' }, [page(1)]);
    assert.equal(b.folder, 'first song (2)', 'names are unique without regard to case');

    const got = await get(lib, 'abc-00000001');
    assert.equal(got.pages.length, 2);
    assert.ok(got.pages[1].color.equals(png('2c')));
    assert.ok(got.thumb.equals(Buffer.from('jpeg')));

    // Metadata-only edits: the notes stick, the folder follows the title, pages
    // are untouched.
    await update(lib, 'abc-00000001', { notes: 'capo 2', artist: 'Someone', pages: 'ignored', practice: { speed: 0.6, songBpm: 88 } });
    const renamed = await update(lib, 'abc-00000001', { title: 'Renamed Song' });
    assert.equal(renamed.folder, 'Renamed Song');
    assert.equal(renamed.notes, 'capo 2', 'an edit to one field keeps the others');
    assert.equal(renamed.pageCount, 2);
    assert.ok(!fs.existsSync(path.join(lib, 'First Song')));

    // Re-saving with fewer pages and no thumbnail: the extra page files go, the
    // notes, first-saved date and thumbnail stay.
    const before = (await get(lib, 'abc-00000001')).savedAt;
    const again = await save(lib, { id: 'abc-00000001', title: 'Renamed Song' }, [page(1)], null);
    assert.equal(again.notes, 'capo 2');
    assert.deepEqual(again.practice, { speed: 0.6, songBpm: 88 }, 'a page save keeps the practice pace');
    assert.equal(again.savedAt, before);
    const after = (await fsp.readdir(path.join(lib, 'Renamed Song'))).sort();
    assert.equal(after.length, 3, 'stale pages removed, thumbnail kept');
    assert.match(after[0], /^page-001-[0-9a-f]{8}\.png$/);

    // Removing a middle page leaves every other page's file untouched — the
    // property that makes an interrupted save harmless.
    const three = await save(lib, { id: 'abc-00000005', title: 'Three' }, [page(1), page(2), page(3)]);
    const before3 = JSON.parse(await fsp.readFile(path.join(three.path, 'sheet.json'), 'utf8')).pages.map((p) => p.file);
    await save(lib, { id: 'abc-00000005', title: 'Three' }, [page(1), page(3)]);
    const after3 = JSON.parse(await fsp.readFile(path.join(three.path, 'sheet.json'), 'utf8')).pages.map((p) => p.file);
    assert.deepEqual(after3, [before3[0], before3[2]], 'the pages either side keep their files');
    assert.ok(!fs.existsSync(path.join(three.path, before3[1])), 'the removed page goes once sheet.json has moved on');
    const back = await get(lib, 'abc-00000005');
    assert.ok(back.pages[1].clean.equals(png(3)), 'page 3 is still page 3, not a copy of page 2');
    // A page that cannot be read is reported rather than silently left out.
    await fsp.rm(path.join(three.path, after3[1]));
    const holed = await get(lib, 'abc-00000005');
    assert.equal(holed.missing, 1);
    assert.equal(holed.pages.length, 1);
    const trashedThree = [];
    await remove(lib, ['abc-00000005'], async (d) => { trashedThree.push(d); await fsp.rm(d, { recursive: true }); });

    // Things a person might put in there by hand are never touched.
    await fsp.writeFile(path.join(lib, 'Renamed Song', 'my-notes.txt'), 'mine');
    await fsp.mkdir(path.join(lib, 'Not a songsheet'));
    await save(lib, { id: 'abc-00000001', title: 'Renamed Song' }, [page(1)]);
    assert.ok(fs.existsSync(path.join(lib, 'Renamed Song', 'my-notes.txt')));
    assert.equal((await list(lib)).length, 2, 'folders without a sheet.json are not songsheets');

    // A hand-edited sheet.json pointing outside its folder reads nothing.
    const evil = path.join(lib, 'Renamed Song', 'sheet.json');
    const rec = JSON.parse(await fsp.readFile(evil, 'utf8'));
    rec.pages.push({ file: '../first song (2)/page-001.png' });
    rec.thumb = '../../x';
    await fsp.writeFile(evil, JSON.stringify(rec));
    const safe = await get(lib, 'abc-00000001');
    assert.equal(safe.pages.length, 1);
    assert.equal(safe.thumb, null);

    // Moving the whole library, then deleting through the caller's trash.
    // A move that fails part way is undone, not left split across two folders.
    const blocked = path.join(root, 'blocked');
    await fsp.writeFile(blocked, 'a file where a folder should be');
    await assert.rejects(move(lib, blocked));
    assert.equal((await list(lib)).length, 2, 'nothing left the library');
    const moved = await move(lib, path.join(root, 'elsewhere'));
    assert.equal(moved, 2);
    assert.ok(fs.existsSync(path.join(lib, 'Not a songsheet')), 'only songsheets move');
    const trashed = [];
    const n = await remove(path.join(root, 'elsewhere'), ['abc-00000002', 'abc-99999999'], async (d) => { trashed.push(d); });
    assert.equal(n, 1, 'an id that is not there is skipped, not an error');
    assert.equal(path.basename(trashed[0]), 'first song (2)');
    await assert.rejects(save(lib, { id: 'abc-00000003', title: 'x' }, []), /at least one page/);
    await assert.rejects(save(lib, { id: 'abc-00000003', title: 'x' }, [{ clean: 'not bytes' }]), /image data/);

    // The browser build's rules and these must agree on every field they share.
    const { normaliseSheet } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'library.js')).href);
    const input = {
      id: 'abc-00000009', title: 'x'.repeat(400), url: 'https://example.test/v', channel: 'c', duration: '212',
      recipe: { rect: { x: 1.4, y: 2.6, w: 10, h: 20 }, startTime: -5, sensitivity: 9 }, paper: 'weird', look: 'dark',
      artist: 'a', notes: 'n', savedAt: 5, practice: { speed: 0.7, songBpm: 96.4 },
    };
    assert.equal(cleanMeta({ ...input, importing: true, updatedAt: 77 }).updatedAt, 77, 'an import keeps its edit date');
    assert.notEqual(cleanMeta({ ...input, updatedAt: 77 }).updatedAt, 77, 'an ordinary save is stamped now');
    input.listen = { tuningId: 'custom', tuning: [62, 57, 55, 50, 45, 38], capo: 3.6, strictness: 'bass', mode: 'x' };
    input.transcript = { pages: { ['b'.repeat(40)]: { at: 9, model: 'm', w: 9.4, h: 3, systems: [{ lines: [1.26], events: [{ x: 3.33, n: [[2, 12, 'hx!', 1, 2, 3, 4, 3], [9, 1, '', 0, 0, 0, 0, 0]] }] }] }, bad: {} } };
    input.timing = { pages: {
      ['b'.repeat(40)]: { at: 9, events: [[0, 3.33, -1.234], [8, 1, 1], [0, 2, 'x'], [1, 7.07, 4005]], fixes: [[0, 3.33, 2, 7], [0, 3, 0, 7], [0, 3, 2, 30]] },
      ['c'.repeat(40)]: { at: 4, events: [] },
      bad: { events: [[0, 1, 1]] },
    } };
    // Compared after every field is set: listen and transcript used to be set
    // only after the comparison had run, so both sides were null and agreed.
    const web = normaliseSheet(input);
    const desk = cleanMeta(input);
    assert.ok(web.listen && web.transcript && web.timing, 'the comparison has something to compare');
    for (const k of ['id', 'title', 'artist', 'notes', 'practice', 'listen', 'transcript', 'timing', 'url', 'channel', 'duration', 'recipe', 'look', 'paper', 'savedAt']) {
      assert.deepEqual(desk[k], web[k], `desktop and browser disagree about ${k}`);
    }
    // The times are the full songsheet's, like the corrections: saved and
    // updated, read back by get(), never in the list.
    await save(lib, { id: 'abc-0000000a', title: 'Timed', timing: input.timing }, [page(1)]);
    assert.deepEqual((await get(lib, 'abc-0000000a')).timing, web.timing);
    assert.equal((await list(lib)).find((x) => x.id === 'abc-0000000a').timing, undefined, 'not in the list');
    await update(lib, 'abc-0000000a', { timing: { pages: { ['d'.repeat(40)]: { at: 1, events: [[0, 1, 2]] } } } });
    assert.deepEqual((await get(lib, 'abc-0000000a')).timing.pages['d'.repeat(40)].events, [[0, 1, 2]]);
    await save(lib, { id: 'abc-0000000a', title: 'Timed again' }, [page(1)]);
    assert.ok((await get(lib, 'abc-0000000a')).timing, 'a re-save that does not mention the times keeps them');
    await update(lib, 'abc-0000000a', { timing: null });
    assert.equal((await get(lib, 'abc-0000000a')).timing, null, 'and null clears them');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
  console.log('library-fs.cjs self-check passed');
}

if (require.main === module) {
  selfCheck().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { list, get, save, update, remove, move, locate, isSheetFolder, folderName, cleanMeta, ID_RE };
