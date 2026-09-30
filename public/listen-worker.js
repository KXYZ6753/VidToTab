// The listening worker: takes the microphone's chunks from the capture worklet
// (public/listen-worklet.js) and feeds them to the follow-along engine, off
// both the audio thread and the page's.
//
// The engine is public/shared/listen.js. If it is missing, fails to load, or
// has no createEngine, the worker still runs and reports the worklet's level
// meter, so the microphone path can be checked end to end without it.
//
// From the page:
//   { type: 'init', sampleRate, hop, port }          port: the worklet's channel, transferred
//   { type: 'call', id?, method, args }              an engine method (setMode, setTargets, arm,
//                                                    setStrictness, calibrateNoise, setOffsetCents…)
// To the page:
//   { type: 'ready', engine: boolean, sampleRate, hop, reason? }
//   every message the engine produces — 'level' at most 20 a second
//   { type: 'level', frame, rms, peak, clip }        the worklet's meter, when the engine sends none
//   { type: 'return', id, value } / { type: 'return', id, error }   for a call that carried an id
//   { type: 'error', message, method? }
//
// The engine contract assumed here: createEngine({ sampleRate, hop, emit })
// returns an object with push(samples, frame), whose return value — nothing, a
// message, an array of them, or a promise of either — is forwarded, as is
// anything it passes to emit(). A chunk's array is the engine's to keep; it is
// only handed back to the worklet for reuse if the engine sets
// `copiesInput: true`.

const LEVEL_GAP_MS = 50;        // at most 20 level messages a second
const ENGINE_LEVEL_HOLD_MS = 250; // the engine's own meter wins while it is sending one

let engine = null;
let capture = null;
let ready = false;
const early = [];

// ------------------------------------------------------------ out to the page

let lastLevelAt = -Infinity;
let pendingLevel = null;
let levelTimer = 0;
let engineLevelAt = -Infinity;

function mergeLevel(a, b) {
  if (!a) return b;
  const m = { ...b };
  if (typeof a.peak === 'number' && typeof b.peak === 'number') m.peak = Math.max(a.peak, b.peak);
  if (typeof a.clip === 'number' && typeof b.clip === 'number') m.clip = a.clip + b.clip;
  return m;
}

function flushLevel() {
  levelTimer = 0;
  if (!pendingLevel) return;
  lastLevelAt = performance.now();
  self.postMessage(pendingLevel);
  pendingLevel = null;
}

// A level that arrives too soon is not dropped but folded into the next one,
// so a clip or a peak between two sends still shows.
function sendLevel(msg) {
  pendingLevel = mergeLevel(pendingLevel, msg);
  const wait = LEVEL_GAP_MS - (performance.now() - lastLevelAt);
  if (wait <= 0) {
    if (levelTimer) clearTimeout(levelTimer);
    flushLevel();
  } else if (!levelTimer) {
    levelTimer = setTimeout(flushLevel, wait);
  }
}

function send(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'level') {
    engineLevelAt = performance.now();
    sendLevel(msg);
    return;
  }
  self.postMessage(msg);
}

function forward(out) {
  if (!out) return;
  if (typeof out.then === 'function') {
    out.then(forward, (err) => reportError(err));
    return;
  }
  if (Array.isArray(out)) out.forEach(send);
  else send(out);
}

// An engine that throws on every chunk would otherwise send ninety errors a
// second; the same message goes out at most once a second.
let lastError = '';
let lastErrorAt = -Infinity;
function reportError(err, method) {
  const message = String(err?.message || err || 'Unknown error');
  const now = performance.now();
  if (message === lastError && now - lastErrorAt < 1000) return;
  lastError = message;
  lastErrorAt = now;
  self.postMessage(method ? { type: 'error', message, method } : { type: 'error', message });
}

// ------------------------------------------------------------ from the worklet

function onCapture(e) {
  const m = e.data;
  if (!m) return;
  if (m.type === 'chunk') {
    if (engine) {
      try {
        forward(engine.push(m.samples, m.frame));
      } catch (err) {
        reportError(err);
      }
      if (engine.copiesInput !== true) return;
    }
    capture.postMessage({ type: 'recycle', samples: m.samples }, [m.samples.buffer]);
  } else if (m.type === 'level') {
    if (performance.now() - engineLevelAt > ENGINE_LEVEL_HOLD_MS) sendLevel(m);
  }
}

// ------------------------------------------------------------ from the page

async function call({ id, method, args }) {
  const reply = (r) => { if (id !== undefined && id !== null) self.postMessage({ type: 'return', id, ...r }); };
  // No engine yet (it is being written, or failed to load): calls are accepted
  // and do nothing, so the page does not have to know.
  if (!engine) return reply({ value: undefined });
  try {
    if (typeof method !== 'string' || method.startsWith('_') || typeof engine[method] !== 'function' || method === 'push') {
      throw new Error(`The listening engine has no method "${method}".`);
    }
    const value = await engine[method](...(Array.isArray(args) ? args : []));
    reply({ value: structuredSafe(value) });
  } catch (err) {
    reportError(err, method);
    reply({ error: String(err?.message || err) });
  }
}

// A return value that cannot be cloned (a function, say) must not take the
// reply down with it.
function structuredSafe(v) {
  try { structuredClone(v); return v; } catch { return undefined; }
}

async function init({ sampleRate, hop, port }) {
  if (capture) return; // once
  let reason;
  try {
    const mod = await import(new URL('./shared/listen.js', import.meta.url).href);
    if (typeof mod.createEngine === 'function') {
      try {
        engine = await mod.createEngine({ sampleRate, hop, emit: forward });
        if (!engine || typeof engine.push !== 'function') {
          reason = 'createEngine() did not return an engine with push()';
          engine = null;
        }
      } catch (err) {
        reason = `createEngine() failed: ${err?.message || err}`;
        reportError(err);
        engine = null;
      }
    } else {
      reason = 'shared/listen.js has no createEngine';
    }
  } catch (err) {
    reason = `shared/listen.js did not load: ${err?.message || err}`;
  }
  capture = port;
  capture.onmessage = onCapture;
  ready = true;
  self.postMessage(reason ? { type: 'ready', engine: false, sampleRate, hop, reason } : { type: 'ready', engine: true, sampleRate, hop });
  for (const m of early.splice(0)) call(m);
}

self.onmessage = (e) => {
  const m = e.data;
  if (m?.type === 'init' && m.port) init(m);
  else if (m?.type === 'call') {
    if (ready) call(m);
    else early.push(m);
  }
};
