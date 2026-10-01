// Times a page's notes from the video's recording, off the page's thread: the
// engine runs several times faster than real time, but a songsheet's worth of
// pages is still seconds of work the songsheet step should not stutter
// through. One request per message (shared/timing.js):
//
//   { id, type: 'probe', pages: [{ pcm, events }], sampleRate }
//       → { id, shift, low, scores, lowScores }    probeShift
//   { id, type: 'page', pcm, sampleRate, events, offset, shift, low, digits }
//       → { id, events, fixes, total }             timePage
//   either → { id, error } on failure. pcm arrays arrive transferred.

import { createEngine } from '/shared/listen.js';
import { probeShift, timePage } from '/shared/timing.js';

self.onmessage = (e) => {
  const { id, type, ...m } = e.data || {};
  try {
    if (type === 'probe') {
      self.postMessage({ id, ...probeShift(m.pages, { make: createEngine, sampleRate: m.sampleRate }) });
    } else {
      self.postMessage({ id, ...timePage({ ...m, make: createEngine }) });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
