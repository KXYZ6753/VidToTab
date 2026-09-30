// What each page of the open songsheet says, as notes: read once, kept for the
// session, and replaced by the corrected version wherever someone fixed it.
//
// A page is identified by the SHA-1 of its clean image, which is what the
// stored corrections are keyed by (library.js cleanTranscript). Reading is
// done on the clean render whatever look is showing: it is the one that is
// guaranteed to be ink on white.

import { sha1 } from '/shared/sha1.js';
import { edited, fromStored, toStored } from '/shared/transcript.js';

export function createReadings({ loadImage, grabBlob, onSaved }) {
  const bySrc = new Map(); // item.src → Promise<{ hash, reading, corrected }>
  let transcript = { v: 1, pages: {} };
  let reader = null;
  let generation = 0; // bumped by reset(): work for the previous songsheet is dropped

  async function readerFn() {
    if (!reader) reader = import('/shared/tabread.js').then((m) => m.readPageWithModel || null);
    return reader;
  }

  async function pixels(src) {
    const img = await loadImage(src);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  // The reading for one page item ({ src, ... }), from the stored correction
  // if there is one, otherwise from the reader.
  function readingFor(item) {
    if (bySrc.has(item.src)) return bySrc.get(item.src);
    const job = (async () => {
      const blob = await grabBlob(item.src);
      if (!blob) throw new Error('This page could not be read back.');
      const hash = await sha1(blob);
      const stored = transcript.pages[hash];
      if (stored) return { hash, reading: fromStored(stored), corrected: true };
      const read = await readerFn();
      if (!read) throw new Error('The tab reader is not available in this build.');
      const reading = await read(await pixels(item.src));
      return { hash, reading, corrected: false };
    })();
    bySrc.set(item.src, job);
    job.catch(() => bySrc.delete(item.src)); // a failure may be retried
    return job;
  }

  // A corrected reading replaces the page's entry and is stored with the
  // songsheet; a page put back to exactly what the reader said is dropped.
  async function saveCorrection(item, reading, { model = '' } = {}) {
    const gen = generation;
    const { hash } = await readingFor(item);
    if (gen !== generation) return;
    const pages = { ...transcript.pages };
    if (edited(reading)) pages[hash] = toStored(reading, { model });
    else delete pages[hash];
    transcript = { v: 1, pages };
    bySrc.set(item.src, Promise.resolve({ hash, reading, corrected: edited(reading) }));
    onSaved?.(Object.keys(pages).length ? transcript : null);
  }

  return {
    readingFor,
    saveCorrection,
    // A songsheet opened from the library brings its corrections; a new scan
    // starts with none. Cached readings belong to the previous songsheet.
    reset(stored) {
      transcript = stored && stored.pages ? { v: 1, pages: { ...stored.pages } } : { v: 1, pages: {} };
      bySrc.clear();
      generation++;
    },
    // The stored corrections of the songsheet these pages turn out to belong
    // to (a scan picked up again after a reload). Adopted as soon as the
    // binding is known, before anything can be edited; a page fixed in that
    // moment anyway loses to the stored one, which holds every earlier fix.
    adopt(stored) {
      if (!stored?.pages) return;
      transcript = { v: 1, pages: { ...transcript.pages, ...stored.pages } };
      bySrc.clear();
    },
    get transcript() { return transcript; },
    forget(src) { bySrc.delete(src); },
  };
}
