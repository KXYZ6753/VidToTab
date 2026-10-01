// Timing a fresh scan's notes from its video, in the background, once the
// scan is done and while the video is still on the server: each page is read
// (readings.js), its events built with the songsheet's Listen settings, its
// window of the video's sound fetched (/api/audio) and run through the
// listening engine in a worker (timing-worker.js, shared/timing.js). The
// times land in readings, which the songsheet stores (sheet.timing) and Play
// mode scores against (follow.js playTimes).
//
// A fresh scan's Listen settings are the defaults, and most tab videos are
// played with a capo (or a retuned low string) the settings do not know about
// yet. So the first few pages are followed at a range of pitch shifts first
// (shared/timing.js probeShift) and every page is timed at the one that hears
// the most.
//
// One page at a time, and quietly: the songsheet step shows how far it has
// got, nothing else. A failure is a note in the console — the even spread
// Play mode used before is still there. Another video or songsheet cancels
// the run (cancel(), and `still` checked after every wait).

import { buildEvents } from '/shared/follow.js';
import { SAMPLE_RATE, pageWindow } from '/shared/timing.js';

// The unsure-digit check against the recording. Off: on the eval videos it
// changed no reading for the better (scripts/tabread-eval.mjs --audio), so it
// stays a measured experiment rather than something that edits tab.
export const CHECK_DIGITS = false;

const SAVE_EVERY = 5; // pages between saves of what has been timed so far
const PROBE_PAGES = 6; // pages the pitch is judged on (the shift on the first 3)…
const PROBE_MIN_EVENTS = 4; // …each with at least this many events

// onProgress(done, total), or (null) when there is nothing to show.
// onTimed(save): a page's times are in readings; save says now is a good
// moment to write them (every few pages, and at the end) — the rest wait for
// the next write, or for whatever replaces this songsheet to flush them.
export function createVideoTiming({ readings, onProgress, onTimed, onPitch }) {
  let run = 0;
  let worker = null;
  const calls = new Map();
  let nextId = 0;

  function stopWorker() {
    worker?.terminate();
    worker = null;
    for (const c of calls.values()) c.reject(new Error('stopped'));
    calls.clear();
  }

  function call(msg, transfer) {
    if (!worker) {
      worker = new Worker(new URL('./timing-worker.js', import.meta.url).href, { type: 'module' });
      worker.onmessage = (e) => {
        const c = calls.get(e.data?.id);
        if (!c) return;
        calls.delete(e.data.id);
        if (e.data.error) c.reject(new Error(e.data.error));
        else c.resolve(e.data);
      };
      worker.onerror = (e) => {
        const err = new Error(e.message || 'The timing worker failed to start.');
        for (const c of calls.values()) c.reject(err);
        calls.clear();
        worker?.terminate();
        worker = null;
      };
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  function cancel() {
    run++;
    stopWorker();
    onProgress(null);
  }

  // 404: the video has no sound (or is gone); nothing more to time.
  class NoSound extends Error {}
  async function soundOf(it) {
    const { from, to } = pageWindow(it.tStart, it.tEnd);
    const res = await fetch(`/api/audio?from=${from.toFixed(2)}&to=${to.toFixed(2)}`);
    if (res.status === 404) throw new NoSound('the video has no sound to time the notes from');
    if (!res.ok) throw new Error(`the video's sound could not be read (${res.status})`);
    return { pcm: new Float32Array(await res.arrayBuffer()), offset: from - it.tStart };
  }

  // items: the scan's pages ({ src, tStart, tEnd }); settings(): the
  // songsheet's Listen settings; still(): whether this scan, with its video,
  // is still the one on screen.
  async function start(items, { settings, still }) {
    cancel();
    const token = run;
    const gen = readings.generation;
    const live = () => token === run && readings.generation === gen && still();
    // Read once: the probe's shift is relative to these, and onPitch may
    // change the Listen settings while this run goes on.
    const base = settings();
    const pages = [...new Map(items.filter((it) => it && Number.isFinite(it.tStart)).map((it) => [it.src, it])).values()];
    const tally = { pages: 0, timed: 0, events: 0, fixes: 0, failed: 0, shift: 0, low: 0 };
    const sound = new Map(); // src → audio fetched for the probe, used again for the page
    try {
      onProgress(0, pages.length);
      // The pitch the video is played at, from its first pages with notes.
      const probe = [];
      for (const it of pages) {
        if (probe.length >= PROBE_PAGES) break;
        const { reading } = await readings.readingFor(it).catch(() => ({}));
        if (!live()) return;
        const events = reading ? buildEvents(reading, base) : [];
        if (events.length < PROBE_MIN_EVENTS) continue;
        const a = await soundOf(it);
        if (!live()) return;
        sound.set(it.src, a);
        probe.push({ pcm: a.pcm.slice(), events });
      }
      if (probe.length) {
        const got = await call({ type: 'probe', pages: probe, sampleRate: SAMPLE_RATE }, probe.map((p) => p.pcm.buffer));
        if (!live()) return;
        tally.shift = got.shift;
        tally.low = got.low;
        onPitch?.(base, got.shift, got.low);
      }
      for (let k = 0; k < pages.length; k++) {
        if (!live()) return;
        const it = pages[k];
        try {
          const { hash, reading, corrected } = await readings.readingFor(it);
          if (!live()) return;
          // The same page shown twice, or timed in an earlier session.
          if (readings.timingFor(hash)) continue;
          const events = buildEvents(reading, base);
          if (!events.length) continue;
          const { pcm, offset } = sound.get(it.src) || await soundOf(it);
          sound.delete(it.src);
          if (!live()) return;
          const out = await call({
            type: 'page', pcm, sampleRate: SAMPLE_RATE, events, offset, shift: tally.shift, low: tally.low, digits: CHECK_DIGITS && !corrected,
          }, [pcm.buffer]);
          if (!live()) return;
          readings.setTiming(it, hash, { at: Date.now(), events: out.events, fixes: out.fixes }, gen);
          tally.pages++;
          tally.timed += out.events.length;
          tally.events += out.total;
          tally.fixes += out.fixes.length;
          onTimed(tally.pages % SAVE_EVERY === 0);
        } catch (err) {
          if (!live() || err instanceof NoSound) throw err;
          tally.failed++;
          console.info(`Timing the notes: page ${k + 1} of ${pages.length} was not timed — ${err.message}`);
        } finally {
          if (live()) onProgress(k + 1, pages.length);
        }
      }
      if (tally.pages) onTimed(true);
      console.info(`Timed ${tally.timed} of ${tally.events} notes from the video on ${tally.pages} page${tally.pages === 1 ? '' : 's'}`
        + `${tally.shift || tally.low ? ` (heard ${tally.shift > 0 ? '+' : ''}${tally.shift} semitones from the Listen settings, the low string ${tally.low > 0 ? '+' : ''}${tally.low} more)` : ''}`
        + `${tally.fixes ? `; the recording settled ${tally.fixes} unsure digit${tally.fixes === 1 ? '' : 's'}` : ''}`
        + `${tally.failed ? `; ${tally.failed} page${tally.failed === 1 ? '' : 's'} failed` : ''}.`);
    } catch (err) {
      if (live()) console.info(`Timing the notes stopped: ${err.message}`);
      if (tally.pages && live()) onTimed(true);
    } finally {
      // A cancelled run's line is the canceller's to clear.
      if (token === run) {
        stopWorker();
        onProgress(null);
      }
    }
  }

  return { start, cancel };
}
