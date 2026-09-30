// The songsheet library: what keeps a scan after the next video replaces it.
//
// The server wipes work/ whenever a new video is loaded, so a saved songsheet
// cannot point at /captures/ — those files are gone as soon as you scan
// anything else. A sheet therefore owns its pixels: page images are stored as
// blobs, alongside the recipe (box, start time, sensitivity) needed to scan the
// same video again later.
//
// Two stores on purpose. 'sheets' holds only light metadata and one small
// thumbnail, so drawing the home screen never loads a single page image;
// 'pages' holds the blobs, read only when a sheet is opened.
//
// In a browser that is the whole story. Inside the desktop app the same calls
// go to a folder on disk instead (electron/library-fs.cjs, through the preload
// bridge), so a songsheet there is an ordinary folder of PNGs you can open,
// copy and back up. Callers never know which: every function below takes and
// returns Blobs either way.

const DB_NAME = 'vidtotab';
const DB_VERSION = 1;
const SHEETS = 'sheets';
const PAGES = 'pages';

// The desktop bridge, when this page is running inside the app and the shell
// offers a library folder. Guarded: a browser that blocks the property read
// must still get the IndexedDB library rather than an exception.
function folder() {
  try { return (typeof window !== 'undefined' && window.vidtotab?.library) || null; } catch { return null; }
}
export const usesFolder = () => Boolean(folder());
const hasIdb = () => typeof indexedDB !== 'undefined';
export const hasStorage = () => usesFolder() || hasIdb();

// What ipcRenderer.invoke puts in front of every error it relays. The message
// underneath was written for people; the prefix was not.
const relayed = (e) => new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''));
const toBytes = async (blob) => (blob ? new Uint8Array(await blob.arrayBuffer()) : null);
const toBlob = (bytes, type) => (bytes && bytes.byteLength ? new Blob([bytes], { type }) : null);

let dbPromise = null;

function openDb() {
  if (!hasIdb()) return Promise.reject(new Error('This browser has no local storage for songsheets.'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SHEETS)) {
        db.createObjectStore(SHEETS, { keyPath: 'id' }).createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains(PAGES)) {
        db.createObjectStore(PAGES, { keyPath: 'key' }).createIndex('sheetId', 'sheetId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the songsheet library.'));
  });
  return dbPromise;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Storing the songsheet was aborted.'));
});

const reqValue = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// ---------------------------------------------------------------- pure parts

export function newId() {
  const rnd = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rnd}`;
}

// Shape a sheet record and drop anything that should not be persisted. Kept
// pure so it can be checked without a browser: the IndexedDB paths below are
// exercised by the browser end-to-end test instead.
export function normaliseSheet(input = {}) {
  const now = Date.now();
  const rect = input.recipe?.rect;
  return {
    id: String(input.id || newId()),
    title: String(input.title || 'Untitled songsheet').slice(0, 300),
    // Typed by hand in the library, never read from the video: the channel is
    // who uploaded it, which is rarely who wrote the song.
    artist: String(input.artist ?? '').slice(0, 200),
    notes: String(input.notes ?? '').slice(0, 5000),
    // Play-along pace, set in the practice view: a speed against the video's
    // own timing, and the song's tempo if someone entered it.
    practice: {
      speed: Math.min(2, Math.max(0.25, Math.round((Number(input.practice?.speed) || 1) * 100) / 100)),
      songBpm: (() => { const b = Math.round(Number(input.practice?.songBpm) || 0); return b >= 20 && b <= 400 ? b : 0; })(),
    },
    listen: cleanListen(input.listen),
    transcript: cleanTranscript(input.transcript),
    url: String(input.url || '').slice(0, 2000),
    channel: String(input.channel || '').slice(0, 300),
    duration: Number(input.duration) || 0,
    pageCount: Math.max(0, Math.round(Number(input.pageCount) || 0)),
    recipe: {
      rect: rect && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(rect[k])))
        ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
        : null,
      startTime: Math.max(0, Number(input.recipe?.startTime) || 0),
      sensitivity: Math.min(1, Math.max(0, Number(input.recipe?.sensitivity ?? 0.5))),
    },
    look: String(input.look || 'print').slice(0, 40),
    paper: input.paper === 'a4' ? 'a4' : 'letter',
    savedAt: Number(input.savedAt) || now,
    updatedAt: now,
  };
}

// Follow-along settings saved with a songsheet: its tuning, capo, how strict
// chords are, and wait or play. Mirrored by cleanListen in
// electron/library-fs.cjs; its self-check compares the two.
const TUNING_IDS = ['standard', 'dropD', 'halfDown', 'wholeDown', 'dadgad', 'openG', 'openD', 'custom'];
export function cleanListen(l) {
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

// Pages whose reading someone corrected, keyed by the SHA-1 of the page's
// clean image — so re-saving keeps them and a new scan (new pixels) does not
// inherit them. Pages nobody touched are not stored at all: reading them again
// is quick and gets better when the reader does. Compact on purpose: a note is
// [string, fret|null, techniques, x, y, w, h, flags] (flags: 1 set by hand,
// 2 confirmed, 4 was unsure). Bounded to 300 pages, 400 events a system and
// about a megabyte; the oldest edits go first. Mirrored in library-fs.cjs.
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
export function cleanTranscript(t) {
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

export const pageKey = (sheetId, index) => `${sheetId}:${String(index).padStart(4, '0')}`;

// ---------------------------------------------------------------- storage

// Fields a save does not mention are kept from the stored copy, not reset: a
// scan re-saved after an edit knows nothing of the notes typed in the library,
// or of the thumbnail a songsheet opened from storage no longer has a URL for.
const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));

// pages: [{ tStart, tEnd, alsoAt, w, h, clean: Blob, color: Blob|null }]
async function idbSave(meta, pages, thumb) {
  const db = await openDb();
  const id = String(meta.id || newId());
  const tx = db.transaction([SHEETS, PAGES], 'readwrite');
  const sheetStore = tx.objectStore(SHEETS);
  const pageStore = tx.objectStore(PAGES);
  const prev = await reqValue(sheetStore.get(id)).catch(() => null);
  const sheet = normaliseSheet({
    artist: prev?.artist, notes: prev?.notes, practice: prev?.practice, listen: prev?.listen, transcript: prev?.transcript,
    savedAt: prev?.savedAt, ...defined(meta), id, pageCount: pages.length,
  });
  // Replacing a sheet must not leave the previous run's pages behind.
  const stale = await reqValue(pageStore.index('sheetId').getAllKeys(IDBKeyRange.only(sheet.id))).catch(() => []);
  for (const key of stale || []) pageStore.delete(key);
  sheetStore.put({ ...sheet, thumb: thumb || prev?.thumb || null });
  pages.forEach((p, i) => {
    pageStore.put({
      key: pageKey(sheet.id, i),
      sheetId: sheet.id,
      index: i,
      tStart: Number(p.tStart) || 0,
      tEnd: Number(p.tEnd) || 0,
      alsoAt: Array.isArray(p.alsoAt) ? p.alsoAt.slice(0, 64) : [],
      w: Number(p.w) || 0,
      h: Number(p.h) || 0,
      clean: p.clean || null,
      color: p.color || null,
    });
  });
  await done(tx);
  return sheet;
}

async function idbList() {
  if (!hasIdb()) return [];
  const db = await openDb();
  const tx = db.transaction(SHEETS, 'readonly');
  const all = await reqValue(tx.objectStore(SHEETS).getAll());
  return (all || []).sort((a, b) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0));
}

async function idbGet(id) {
  const db = await openDb();
  const tx = db.transaction([SHEETS, PAGES], 'readonly');
  const sheet = await reqValue(tx.objectStore(SHEETS).get(id));
  if (!sheet) return null;
  const pages = await reqValue(tx.objectStore(PAGES).index('sheetId').getAll(IDBKeyRange.only(id)));
  return { ...sheet, pages: (pages || []).sort((a, b) => a.index - b.index) };
}

async function idbUpdate(id, patch) {
  const db = await openDb();
  const tx = db.transaction(SHEETS, 'readwrite');
  const store = tx.objectStore(SHEETS);
  const prev = await reqValue(store.get(id));
  if (!prev) throw new Error('That songsheet is no longer stored.');
  const allowed = {};
  for (const k of ['title', 'artist', 'notes', 'look', 'paper', 'practice', 'listen', 'transcript']) if (patch[k] !== undefined) allowed[k] = patch[k];
  const sheet = { ...normaliseSheet({ ...prev, ...allowed }), thumb: prev.thumb || null };
  store.put(sheet);
  await done(tx);
  return sheet;
}

async function idbDelete(id) {
  const db = await openDb();
  const tx = db.transaction([SHEETS, PAGES], 'readwrite');
  tx.objectStore(SHEETS).delete(id);
  const keys = await reqValue(tx.objectStore(PAGES).index('sheetId').getAllKeys(IDBKeyRange.only(id))).catch(() => []);
  for (const key of keys || []) tx.objectStore(PAGES).delete(key);
  await done(tx);
}

// The folder library speaks bytes over IPC; everything above it speaks Blobs.
const fromFolder = (s) => (s ? { ...s, thumb: toBlob(s.thumb, 'image/jpeg') } : s);

export async function saveSheet(meta, pages = [], thumb = null) {
  const lib = folder();
  if (!lib) return idbSave(meta, pages, thumb);
  const id = String(meta.id || newId());
  const bytes = [];
  for (const p of pages) {
    bytes.push({
      tStart: p.tStart, tEnd: p.tEnd, alsoAt: p.alsoAt, w: p.w, h: p.h,
      clean: await toBytes(p.clean), color: await toBytes(p.color),
    });
  }
  try {
    return fromFolder(await lib.save({ ...defined(meta), id }, bytes, await toBytes(thumb)));
  } catch (e) { throw relayed(e); }
}

// limit: the home screen and the sidebar want the latest few; the library
// screen passes Infinity and gets every one.
export async function listSheets(limit = 60) {
  const lib = folder();
  if (!lib) return (await idbList()).slice(0, limit);
  try {
    return (await lib.list()).slice(0, limit).map(fromFolder);
  } catch (e) { throw relayed(e); }
}

export async function getSheet(id) {
  const lib = folder();
  if (!lib) return idbGet(id);
  let s;
  try { s = await lib.get(id); } catch (e) { throw relayed(e); }
  if (!s) return null;
  return {
    ...fromFolder(s),
    pages: s.pages.map((p) => ({ ...p, clean: toBlob(p.clean, 'image/png'), color: toBlob(p.color, 'image/png') })),
  };
}

// Title, artist, notes, look, paper, practice pace, follow-along settings,
// corrected readings: the edits that need no page rewritten.
export async function updateSheet(id, patch = {}) {
  const lib = folder();
  if (!lib) return idbUpdate(id, patch);
  try { return fromFolder(await lib.update(id, defined(patch))); } catch (e) { throw relayed(e); }
}

// Resolves to how many were removed. In the desktop app that is after the
// shell has asked, natively, and moved them to the Trash — so it can be 0.
export async function deleteSheets(ids) {
  const list = [...new Set(ids)].map(String);
  const lib = folder();
  if (!lib) {
    for (const id of list) await idbDelete(id);
    return list.length;
  }
  try { return await lib.remove(list); } catch (e) { throw relayed(e); }
}

export const deleteSheet = (id) => deleteSheets([id]);

// A desktop app that ran 0.2 kept its songsheets in IndexedDB. Copy each one
// into the folder once, then leave the originals exactly where they were: a copy
// that went wrong must not be able to cost anything. Every id copied is
// remembered as it is copied — that, not a single done-flag, is what stops a
// songsheet since moved to the Trash from coming back on the next launch after
// a run that stopped half way.
export async function migrateBrowserSheets() {
  const lib = folder();
  if (!lib || !hasIdb()) return 0;
  let copiedIds;
  try {
    if (localStorage.getItem('vtt.libMigrated') === '1') return 0;
    copiedIds = new Set(JSON.parse(localStorage.getItem('vtt.libMigratedIds') || '[]'));
  } catch { return 0; }
  const finish = () => { try { localStorage.setItem('vtt.libMigrated', '1'); } catch { /* storage unavailable */ } };
  // Asking for the database by name would create it; look before opening.
  try {
    const dbs = await indexedDB.databases?.();
    if (Array.isArray(dbs) && !dbs.some((d) => d.name === DB_NAME)) { finish(); return 0; }
  } catch { /* databases() unsupported: open and see */ }
  const stored = await idbList();
  const have = new Set((await lib.list()).map((s) => s.id));
  let copied = 0;
  let failed = 0;
  for (const s of stored) {
    if (have.has(s.id) || copiedIds.has(s.id)) continue;
    try {
      const full = await idbGet(s.id);
      if (!full?.pages?.length) continue;
      const bytes = [];
      for (const p of full.pages) {
        bytes.push({
          tStart: p.tStart, tEnd: p.tEnd, alsoAt: p.alsoAt, w: p.w, h: p.h,
          clean: await toBytes(p.clean), color: await toBytes(p.color),
        });
      }
      // importing: keep its edit date, so the library's "Recently edited"
      // order is the order they were really edited in.
      const meta = { ...defined(full), pages: undefined, thumb: undefined, importing: true };
      await lib.save(meta, bytes, await toBytes(full.thumb));
      copiedIds.add(s.id);
      try { localStorage.setItem('vtt.libMigratedIds', JSON.stringify([...copiedIds])); } catch { /* storage unavailable */ }
      copied++;
    } catch {
      failed++;
    }
  }
  if (!failed) finish();
  return copied;
}

// Desktop only: where the folder is, and the shell's own ways into it.
export async function folderInfo() {
  const lib = folder();
  if (!lib) return null;
  try { return await lib.info(); } catch (e) { throw relayed(e); }
}
export async function revealSheet(id) {
  try { return await folder()?.reveal(id); } catch (e) { throw relayed(e); }
}
export async function openLibraryFolder() {
  try { return await folder()?.openFolder(); } catch (e) { throw relayed(e); }
}
export async function chooseLibraryFolder() {
  try { return await folder()?.chooseFolder(); } catch (e) { throw relayed(e); }
}

// Ask the browser to keep this data rather than evict it under pressure, and
// report what it thinks is stored. Both are advisory: a private window or a
// browser with site data blocked can refuse, which is why the UI says where a
// songsheet lives rather than promising it is safe.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}

export async function usage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) return { used: est.usage || 0, quota: est.quota || 0 };
  } catch { /* not supported */ }
  return { used: 0, quota: 0 };
}

// ---------------------------------------------------------------- self-check

// Only the pure parts run here: IndexedDB does not exist in Node, and faking it
// would test the fake. The real storage path is covered by the browser E2E.
export function selfCheck(assert) {
  const a = newId();
  const b = newId();
  assert.notEqual(a, b, 'ids must be unique');
  assert.ok(/^[a-z0-9]+-[a-z0-9-]+$/i.test(a), `id shape: ${a}`);

  // Page keys sort in page order as plain strings, which is what keeps a
  // 10-page sheet from ordering 1, 10, 2 when read back.
  const keys = [0, 2, 10, 9].map((i) => pageKey('s', i));
  assert.deepEqual([...keys].sort(), [pageKey('s', 0), pageKey('s', 2), pageKey('s', 9), pageKey('s', 10)]);

  const s = normaliseSheet({
    title: 'x'.repeat(400),
    url: 'https://example.test/v',
    duration: '212',
    pageCount: 3.6,
    recipe: { rect: { x: 1.4, y: 2.6, w: 10, h: 20 }, startTime: -5, sensitivity: 9 },
    paper: 'weird',
    look: 'dark',
  });
  assert.equal(s.title.length, 300, 'title is bounded');
  assert.equal(s.duration, 212);
  assert.equal(s.pageCount, 4);
  assert.deepEqual(s.recipe.rect, { x: 1, y: 3, w: 10, h: 20 }, 'rect is rounded to whole pixels');
  assert.equal(s.recipe.startTime, 0, 'a negative start time is clamped');
  assert.equal(s.recipe.sensitivity, 1, 'sensitivity is clamped to its range');
  assert.equal(s.paper, 'letter', 'an unknown paper falls back');
  assert.equal(s.look, 'dark');
  assert.ok(s.id && s.savedAt && s.updatedAt);
  assert.equal(s.artist, '', 'no artist unless someone typed one');
  assert.deepEqual(s.practice, { speed: 1, songBpm: 0 }, 'real speed, no tempo, until someone sets them');
  assert.deepEqual(normaliseSheet({ practice: { speed: 9, songBpm: 1000 } }).practice, { speed: 2, songBpm: 0 });
  assert.equal(s.listen, null, 'no follow-along settings until someone sets them');
  assert.deepEqual(cleanListen({ tuningId: 'dropD', capo: 40, strictness: 'x', mode: 'play' }),
    { tuningId: 'dropD', tuning: null, capo: 12, strictness: 'lenient', mode: 'play' });
  const hash = 'a'.repeat(40);
  const tr = cleanTranscript({ pages: {
    [hash]: { at: 5, model: 'm1', w: 900, h: 200, systems: [{ lines: [10.04, 20, 30, 40, 50, 60], events: [
      { x: 12.34, n: [[1, 3, 'h', 10, 5, 8, 12, 1], [7, 3, '', 0, 0, 0, 0, 0], [2, 30, '', 0, 0, 0, 0, 0], [6, null, 'x', 1, 1, 1, 1, 9]] },
      { x: 20, n: [] },
    ] }] },
    'not-a-hash': { systems: [] },
  } });
  assert.deepEqual(Object.keys(tr.pages), [hash], 'only real page hashes');
  assert.deepEqual(tr.pages[hash].systems[0].events, [{ x: 12.3, n: [[1, 3, 'h', 10, 5, 8, 12, 1], [6, null, 'x', 1, 1, 1, 1, 1]] }],
    'bad strings and frets dropped, empty events dropped, flags bounded');
  assert.equal(cleanTranscript({ pages: {} }), null);
  assert.equal(normaliseSheet({ notes: 'n'.repeat(6000) }).notes.length, 5000, 'notes are bounded');
  assert.deepEqual(defined({ a: 1, b: undefined, c: null }), { a: 1, c: null }, 'only undefined means "not mentioned"');
  assert.equal(relayed(new Error("Error invoking remote method 'library:save': Error: Disk full")).message, 'Disk full');
  assert.equal(usesFolder(), false, 'no window, no desktop bridge');

  // A sheet with no usable box still saves: it can be reopened and exported,
  // it just cannot be re-scanned without drawing the box again.
  assert.equal(normaliseSheet({ recipe: { rect: { x: 'no' } } }).recipe.rect, null);
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
}
