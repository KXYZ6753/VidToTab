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
// Everything here is browser-side, which is what makes the desktop app and the
// hosted web version behave identically with no server storage to manage.

const DB_NAME = 'vidtotab';
const DB_VERSION = 1;
const SHEETS = 'sheets';
const PAGES = 'pages';

export const hasStorage = () => typeof indexedDB !== 'undefined';

let dbPromise = null;

function openDb() {
  if (!hasStorage()) return Promise.reject(new Error('This browser has no local storage for songsheets.'));
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
    url: String(input.url || ''),
    channel: String(input.channel || ''),
    duration: Number(input.duration) || 0,
    pageCount: Math.max(0, Math.round(Number(input.pageCount) || 0)),
    recipe: {
      rect: rect && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(rect[k])))
        ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
        : null,
      startTime: Math.max(0, Number(input.recipe?.startTime) || 0),
      sensitivity: Math.min(1, Math.max(0, Number(input.recipe?.sensitivity ?? 0.5))),
    },
    look: String(input.look || 'print'),
    paper: input.paper === 'a4' ? 'a4' : 'letter',
    savedAt: Number(input.savedAt) || now,
    updatedAt: now,
  };
}

export const pageKey = (sheetId, index) => `${sheetId}:${String(index).padStart(4, '0')}`;

// ---------------------------------------------------------------- storage

// pages: [{ tStart, tEnd, alsoAt, w, h, clean: Blob, color: Blob|null }]
export async function saveSheet(meta, pages = [], thumb = null) {
  const db = await openDb();
  const sheet = normaliseSheet({ ...meta, pageCount: pages.length });
  const tx = db.transaction([SHEETS, PAGES], 'readwrite');
  const sheetStore = tx.objectStore(SHEETS);
  const pageStore = tx.objectStore(PAGES);
  // Replacing a sheet must not leave the previous run's pages behind.
  const stale = await reqValue(pageStore.index('sheetId').getAllKeys(IDBKeyRange.only(sheet.id))).catch(() => []);
  for (const key of stale || []) pageStore.delete(key);
  sheetStore.put({ ...sheet, thumb: thumb || null });
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

export async function listSheets(limit = 60) {
  if (!hasStorage()) return [];
  const db = await openDb();
  const tx = db.transaction(SHEETS, 'readonly');
  const all = await reqValue(tx.objectStore(SHEETS).getAll());
  return (all || [])
    .sort((a, b) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0))
    .slice(0, limit);
}

export async function getSheet(id) {
  const db = await openDb();
  const tx = db.transaction([SHEETS, PAGES], 'readonly');
  const sheet = await reqValue(tx.objectStore(SHEETS).get(id));
  if (!sheet) return null;
  const pages = await reqValue(tx.objectStore(PAGES).index('sheetId').getAll(IDBKeyRange.only(id)));
  return { ...sheet, pages: (pages || []).sort((a, b) => a.index - b.index) };
}

export async function deleteSheet(id) {
  const db = await openDb();
  const tx = db.transaction([SHEETS, PAGES], 'readwrite');
  tx.objectStore(SHEETS).delete(id);
  const keys = await reqValue(tx.objectStore(PAGES).index('sheetId').getAllKeys(IDBKeyRange.only(id))).catch(() => []);
  for (const key of keys || []) tx.objectStore(PAGES).delete(key);
  await done(tx);
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

  // A sheet with no usable box still saves: it can be reopened and exported,
  // it just cannot be re-scanned without drawing the box again.
  assert.equal(normaliseSheet({ recipe: { rect: { x: 'no' } } }).recipe.rect, null);
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
}
