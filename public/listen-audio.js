// The microphone, for following along while someone plays. The same code runs
// in the desktop app and in a browser: plain getUserMedia into an AudioWorklet
// (listen-worklet.js) that cuts the sound into fixed chunks for a worker
// (listen-worker.js), which runs the follow-along engine (shared/listen.js).
// The page thread only ever sees the engine's messages.
//
//   const mic = await openMic();
//   const off = mic.on('level', ({ rms, peak, clip }) => …);
//   mic.call('setMode', 'follow');
//   await mic.close();
//
// Every failure is an Error with a .code the interface can word for people:
//   insecure     not https or localhost, so the browser will not offer a microphone
//   unsupported  no getUserMedia, AudioWorklet or Worker here
//   denied       permission refused (by the person, the browser, or the system —
//                on the desktop, window.vidtotab.mic.status() says which)
//   nodevice     no microphone, or not the one asked for
//   busy         the microphone is there but another app holds it, or it failed to start
//   failed       anything else; .cause has the original

const HOP = 512;

function codedError(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

function gumError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return codedError('denied', 'Microphone access was not allowed.', err);
    case 'NotFoundError':
    case 'OverconstrainedError':
      return codedError('nodevice', 'No microphone was found.', err);
    case 'NotReadableError':
    case 'AbortError':
      return codedError('busy', 'The microphone could not be started. Another app may be using it.', err);
    default:
      return codedError('failed', `The microphone could not be opened${err?.message ? `: ${err.message}` : '.'}`, err);
  }
}

/**
 * Open the microphone and start listening.
 * @param {{ deviceId?: string, hop?: number }} [opts]
 */
export async function openMic({ deviceId, hop = HOP } = {}) {
  if (!window.isSecureContext) {
    throw codedError('insecure', 'The microphone is only available on a secure page (https, or this computer).');
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined' || typeof Worker === 'undefined') {
    throw codedError('unsupported', 'This browser cannot listen to a microphone here.');
  }

  // Made before asking for the microphone, while the click that got us here
  // still counts: Safari will not start an AudioContext after the wait for a
  // permission prompt, and Chrome is happier this way too.
  let context;
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
  } catch (err) {
    throw codedError('unsupported', 'This browser could not start its audio engine.', err);
  }
  if (context.state !== 'running') context.resume().catch(() => {});

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        // A guitar is not a voice on a call: all three of these eat sustained
        // notes and bend levels, and none of them helps pitch tracking.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (err) {
    context.close().catch(() => {});
    throw gumError(err);
  }

  const track = stream.getAudioTracks()[0];
  let worker = null;
  let node = null;
  let source = null;
  let sink = null;
  try {
    if (!track) throw codedError('nodevice', 'No microphone was found.');
    await context.audioWorklet.addModule(new URL('./listen-worklet.js', import.meta.url).href);
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'vtt-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { hop },
    });
    // The worklet writes nothing to its output. It is wired to the speakers
    // through a gain of zero only so that every browser keeps pulling audio
    // through it; an unconnected node is not guaranteed to run.
    sink = context.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);

    worker = new Worker(new URL('./listen-worker.js', import.meta.url).href, { type: 'module' });
    const channel = new MessageChannel();
    worker.postMessage({ type: 'init', sampleRate: context.sampleRate, hop, port: channel.port1 }, [channel.port1]);
    node.port.postMessage({ type: 'port', port: channel.port2 }, [channel.port2]);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    worker?.terminate();
    context.close().catch(() => {});
    throw err.code ? err : codedError('failed', `Listening could not start: ${err?.message || err}`, err);
  }

  // ---------------------------------------------------------------- events

  const listeners = new Map(); // type -> Set<fn>; '*' hears everything
  const emit = (msg) => {
    for (const key of [msg.type, '*']) {
      const set = listeners.get(key);
      if (!set) continue;
      for (const fn of [...set]) {
        try { fn(msg); } catch (e) { setTimeout(() => { throw e; }); }
      }
    }
  };
  const on = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  };

  // The worker says once whether the engine loaded ({ engine, reason? }); a
  // worker that never started counts as no engine.
  let settle;
  const ready = new Promise((r) => { settle = r; });
  on('ready', (m) => settle(m));

  let closed = false;
  let seq = 0;
  const waiting = new Map(); // call id -> { resolve, reject }
  worker.onmessage = (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'return') {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if ('error' in msg) w.reject(new Error(msg.error));
      else w.resolve(msg.value);
      return;
    }
    emit(msg);
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    const message = e.message || 'The listening worker failed to start.';
    settle({ type: 'ready', engine: false, reason: message });
    emit({ type: 'error', message });
  };
  // The microphone went away: unplugged, taken by the system, or its
  // permission revoked mid-session.
  track.addEventListener('ended', () => emit({ type: 'ended' }));

  /** Call an engine method in the worker; resolves with what it returns. */
  const call = (method, ...args) => {
    if (closed) return Promise.reject(new Error('The microphone is closed.'));
    const id = ++seq;
    const p = new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ type: 'call', id, method, args });
    });
    p.catch(() => {}); // a fire-and-forget call is not an unhandled rejection; errors also arrive as 'error'
    return p;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    stream.getTracks().forEach((t) => t.stop());
    try { node.port.postMessage({ type: 'stop' }); } catch { /* gone */ }
    try { source.disconnect(); node.disconnect(); sink.disconnect(); } catch { /* already */ }
    worker.terminate();
    for (const w of waiting.values()) w.reject(new Error('The microphone is closed.'));
    waiting.clear();
    await context.close().catch(() => {});
    listeners.clear();
  };

  const listDevices = async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    const current = track.getSettings().deviceId;
    return all.filter((d) => d.kind === 'audioinput').map((d) => ({
      deviceId: d.deviceId,
      groupId: d.groupId,
      label: d.label,
      current: d.deviceId === current,
    }));
  };

  const settings = track.getSettings();
  return {
    context,
    stream,
    track,
    settings,
    label: track.label,
    warnings: warningsFor(settings, track.label),
    sampleRate: context.sampleRate,
    hop,
    worker,
    ready,
    on,
    call,
    listDevices,
    close,
    get closed() { return closed; },
  };
}

/**
 * Whether the page may use the microphone without asking, as far as the
 * browser will say: 'granted', 'denied', 'prompt', or 'unknown' where the
 * question cannot be asked (older Firefox and Safari).
 */
export async function micPermissionState() {
  try {
    const { state } = await navigator.permissions.query({ name: 'microphone' });
    return ['granted', 'denied', 'prompt'].includes(state) ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Things about the microphone that will make following along worse, worded
 * for the person holding the guitar. Empty when nothing stands out.
 * @param {MediaTrackSettings} settings  track.getSettings()
 * @param {string} [label]               track.label
 */
export function warningsFor(settings = {}, label = '') {
  const out = [];
  const rate = Number(settings.sampleRate);
  const headset = /hands-free|airpods|headset/i.test(label || '');
  if (rate > 0 && rate <= 16000) {
    out.push(`This microphone is only sending ${Math.round(rate / 1000)} kHz sound, which is what a Bluetooth headset does while its microphone is on. Notes will be hard to tell apart — the computer's own microphone or a wired one will do much better.`);
  } else if (headset) {
    out.push('Bluetooth headsets switch to low-quality call sound while their microphone is in use. If notes are missed, try the computer\'s own microphone or a wired one.');
  }
  const still = [
    settings.echoCancellation === true && 'echo cancellation',
    settings.noiseSuppression === true && 'noise suppression',
    settings.autoGainControl === true && 'automatic gain',
  ].filter(Boolean);
  if (still.length) {
    const list = still.length === 1 ? still[0] : `${still.slice(0, -1).join(', ')} and ${still[still.length - 1]}`;
    out.push(`The browser kept ${list} switched on for this microphone. It is made for voices and can swallow held notes.`);
  }
  return out;
}
