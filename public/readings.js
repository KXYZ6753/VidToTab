// What each page of the open songsheet says, as notes: read once, kept for the
// session, and replaced by the corrected version wherever someone fixed it.
//
// A page is identified by the SHA-1 of its clean image, which is what the
// stored corrections are keyed by (library.js cleanTranscript). Reading is
// done on the clean render whatever look is showing: it is the one that is
// guaranteed to be ink on white.
//
// The songsheet's timing (library.js cleanTiming) is kept here too, keyed the
// same way: when each page's notes sound in its video, and the unsure digits
// the video's recording settled. Those fixes are applied to a fresh reading
// only — a page someone corrected is read from the stored correction, which
// wins.

import { sha1 } from '/shared/sha1.js';
import { applyFixes } from '/shared/timing.js';
import { edited, fromStored, toStored } from '/shared/transcript.js';

const pagesOf = (stored) => (stored && stored.pages && typeof stored.pages === 'object' ? { ...stored.pages } : {});

export function createReadings({ loadImage, grabBlob, onSaved }) {
  const bySrc = new Map(); // item.src → Promise<{ hash, reading, corrected }>
  let transcript = { v: 1, pages: {} };
  let timing = { v: 1, pages: {} };
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
  // if there is one, otherwise from the reader (with any fixes the video's
  // recording made to its unsure digits).
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
      return { hash, reading: applyFixes(reading, timing.pages[hash]?.fixes), corrected: false };
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
    // A songsheet opened from the library brings its corrections and timing;
    // a new scan starts with none. Cached readings belong to the previous
    // songsheet.
    reset(stored, storedTiming = null) {
      transcript = { v: 1, pages: pagesOf(stored) };
      timing = { v: 1, pages: pagesOf(storedTiming) };
      bySrc.clear();
      generation++;
    },
    // The stored corrections of the songsheet these pages turn out to belong
    // to (a scan picked up again after a reload). Adopted as soon as the
    // binding is known, before anything can be edited; a page fixed in that
    // moment anyway loses to the stored one, which holds every earlier fix.
    // Timing heard in this session is newer than any stored, and wins.
    adopt(stored, storedTiming = null) {
      transcript = { v: 1, pages: { ...transcript.pages, ...pagesOf(stored) } };
      timing = { v: 1, pages: { ...pagesOf(storedTiming), ...timing.pages } };
      bySrc.clear();
    },
    // One page timed from the video (public/video-timing.js). A page whose
    // unsure digits the recording settled is read again next time it is
    // asked for, so the fixes show; a reading already handed out stays as it
    // was. gen: the generation the work was started in — a songsheet opened
    // since then gets nothing.
    setTiming(item, hash, entry, gen = generation) {
      if (gen !== generation) return false;
      timing = { v: 1, pages: { ...timing.pages, [hash]: entry } };
      if (entry.fixes?.length) bySrc.delete(item.src);
      return true;
    },
    timingFor(hash) { return timing.pages[hash] || null; },
    get transcript() { return transcript; },
    get timing() { return timing; },
    get generation() { return generation; },
    forget(src) { bySrc.delete(src); },
  };
}
