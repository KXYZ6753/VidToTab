// A plucked-string guitar for testing the listener (public/shared/listen.js).
//
// Extended Karplus-Strong (Jaffe & Smith 1983, Välimäki et al. 1996): each of
// the six strings is a delay line closed through a loss filter, so a new pluck
// on a string stops what that string was playing while the other five keep
// ringing — which is exactly the situation the listener has to cope with when a
// chord changes. Per string:
//
//   excitation (noise → dynamics lowpass → pick-position comb)
//     → [delay N] → tuning allpass (fractional delay) → stiffness allpasses
//     → one-pole loss filter → back into the delay line (and out)
//
// The loss filter is designed from two decay times (at the fundamental and at
// 3 kHz), so high partials die first and plain strings ring longer and brighter
// than wound ones. The stiffness allpasses make the partials progressively
// sharp (f_h = h·f0·√(1+B·h²)) with a B typical of steel strings, and the loop
// is tuned so the fundamental lands on the requested pitch exactly.
//
// Techniques: h/p re-tune a sounding string without a new pluck (a small energy
// bump stands in for the finger), slides and bends glide the delay length
// (Lagrange-interpolated while moving), x is a muted thunk, harm a pure,
// quiet natural harmonic. Everything is deterministic for a given seed.

import { writeFileSync } from 'node:fs';

export const STANDARD_TUNING = [64, 59, 55, 50, 45, 40]; // string 1 (high e) … 6 (low E)
export const standardMidi = (string, fret, capo = 0) => STANDARD_TUNING[string - 1] + capo + fret;

const TAU = 2 * Math.PI;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-string character, index 0 = string 1 (high e).
const B_OPEN = [2e-5, 3e-5, 4.5e-5, 6e-5, 8e-5, 1e-4]; // inharmonicity of the open string
const T60_LOW = [6, 5.5, 5, 4.5, 4, 3.5]; // s, at the fundamental
const T60_HIGH = [0.8, 0.65, 0.5, 0.42, 0.36, 0.3]; // s, at 3 kHz
const DISPERSION_SECTIONS = 3; // runString() has them unrolled

// Phase delay (samples) of the first-order allpass (a + z⁻¹)/(1 + a·z⁻¹) at w.
function apDelay(a, w) {
  const c = Math.cos(w);
  const s = Math.sin(w);
  let ph = Math.atan2(-s, a + c) - Math.atan2(-a * s, 1 + a * c);
  while (ph > Math.PI) ph -= TAU;
  while (ph <= -Math.PI) ph += TAU;
  return -ph / w;
}
// One-pole lowpass b/(1 + a·z⁻¹): magnitude (without b) and phase delay.
const lpMag = (a, w) => 1 / Math.hypot(1 + a * Math.cos(w), a * Math.sin(w));
const lpDelay = (a, w) => Math.atan2(-a * Math.sin(w), 1 + a * Math.cos(w)) / w;

function bisect(f, lo, hi, iters = 48) {
  // f(lo) and f(hi) have opposite signs; returns the root.
  let flo = f(lo);
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Loop design for one note: fundamental f1 (Hz), inharmonicity B, decay times.
function design(sr, f1, B, t60lo, t60hi) {
  const w1 = (TAU * f1) / sr;
  const D1 = sr / f1;
  // Loss filter: per-period gain G0 at f1 and G1 at 3 kHz.
  const G0 = 10 ** (-3 / (f1 * t60lo));
  const G1 = 10 ** (-3 / (f1 * t60hi));
  const wh = (TAU * Math.min(3000, 0.4 * sr)) / sr;
  const ratio = (a) => ((1 + a) * lpMag(a, wh)) / ((1 + a) * lpMag(a, w1));
  const la = ratio(-0.999) < G1 / G0 ? bisect((a) => ratio(a) - G1 / G0, -0.999, 0) : -0.999;
  const lb = (G0 / ((1 + la) * lpMag(la, w1))) * (1 + la);
  // Stiffness: the loop must be shorter at partial h than at the fundamental.
  const hRef = Math.max(2, Math.min(10, Math.floor(3000 / f1)));
  const stretch = Math.sqrt((1 + B * hRef * hRef) / (1 + B));
  const wRef = w1 * hRef * stretch;
  const target = D1 * (1 - 1 / stretch);
  const lpDiff = lpDelay(la, w1) - lpDelay(la, wRef);
  const M = DISPERSION_SECTIONS;
  let da = 0;
  if (lpDiff < target) {
    const f = (a) => M * (apDelay(a, w1) - apDelay(a, wRef)) + lpDiff - target;
    da = f(-0.95) > 0 ? bisect(f, -0.95, 0) : -0.95;
  }
  const filterDelay = (w) => M * apDelay(da, w) + lpDelay(la, w);
  const rem = D1 - filterDelay(w1);
  const N = Math.max(2, Math.floor(rem - 0.5));
  const d = rem - N;
  const eta = bisect((e) => apDelay(e, w1) - d, -0.99, 0.99);
  return { f1, D1, N, eta, da, la, lb, pureDelay: (f) => sr / f - filterDelay((TAU * f) / sr) };
}

const BUF = 8192; // delay line length (power of two), enough for E2 at 96 kHz
const MASK = BUF - 1;

function newString() {
  return {
    buf: new Float64Array(BUF),
    active: false,
    midi: null,
    d: null, // current design
    N: 2, eta: 0, apx1: 0, apy1: 0,
    da: 0, dx: new Float64Array(DISPERSION_SECTIONS), dy: new Float64Array(DISPERSION_SECTIONS),
    la: 0, lb: 0, ly1: 0,
    exc: null, excPos: 0,
    glide: null,
    peak: 0,
  };
}

export function pink(n, rnd) {
  // Paul Kellet's refined pink filter on white noise.
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

// Room noise: pink noise plus mains hum at 120 Hz (and a little 240/360 Hz).
export function roomNoise(n, sampleRate, rnd, rms = 1) {
  const out = pink(n, rnd);
  const ph = rnd() * TAU;
  let p = 0;
  for (let i = 0; i < n; i++) p += out[i] * out[i];
  const pinkRms = Math.sqrt(p / Math.max(1, n)) || 1;
  const humAmp = pinkRms * 0.45;
  for (let i = 0; i < n; i++) {
    const t = (TAU * 120 * i) / sampleRate + ph;
    out[i] += humAmp * (Math.sin(t) + 0.5 * Math.sin(2 * t + 0.3) + 0.3 * Math.sin(3 * t + 1.1));
  }
  let q = 0;
  for (let i = 0; i < n; i++) q += out[i] * out[i];
  const k = rms / (Math.sqrt(q / Math.max(1, n)) || 1);
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

// RBJ biquad, applied in place.
export function biquad(x, sampleRate, type, f0, q = Math.SQRT1_2) {
  const w = (TAU * f0) / sampleRate;
  const cs = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; } else { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
  const a0 = 1 + alpha;
  const a1 = -2 * cs;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = (b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

// Power of the loud part of a signal: mean power of 20 ms blocks within 20 dB
// of the loudest block. SNR is quoted against this, so "10 dB" means the noise
// sits 10 dB under the notes while they sound, not under an average that
// includes the silences between them.
export function activePower(x, sampleRate) {
  const blk = Math.max(1, Math.round(sampleRate * 0.02));
  const pw = [];
  for (let i = 0; i + blk <= x.length; i += blk) {
    let s = 0;
    for (let j = i; j < i + blk; j++) s += x[j] * x[j];
    pw.push(s / blk);
  }
  const max = Math.max(0, ...pw);
  if (!max) return 0;
  const loud = pw.filter((p) => p >= max * 0.01);
  return loud.reduce((a, b) => a + b, 0) / loud.length;
}

const techsOf = (note) => [].concat(note.tech ?? []).map(String);

function stringFor(midi) {
  // Highest string on which the note can be fretted: the usual choice.
  for (let s = 1; s <= 6; s++) if (midi >= STANDARD_TUNING[s - 1]) return s;
  return 6;
}

// One string, samples [i0, i1), added into out. State lives in locals for
// the length of the block.
function runString(s, i0, i1, out, sr) {
  const buf = s.buf;
  let N = s.N, eta = s.eta, apx1 = s.apx1, apy1 = s.apy1;
  const da = s.da, lb = s.lb, la = s.la;
  let ly1 = s.ly1;
  let dx0 = s.dx[0], dx1 = s.dx[1], dx2 = s.dx[2], dy0 = s.dy[0], dy1 = s.dy[1], dy2 = s.dy[2];
  let exc = s.exc;
  let excPos = s.excPos;
  let peak = s.peak;
  for (let i = i0; i < i1; i++) {
    let v;
    const g = s.glide;
    if (g) {
      // Raised-cosine glide in log frequency, Lagrange-3 fractional read.
      const u = Math.min(1, (i - g.i0) / g.len);
      const shape = 0.5 - 0.5 * Math.cos(Math.PI * u);
      g.fNow = g.f0 * (g.f1 / g.f0) ** shape;
      const D = s.d.pureDelay(g.fNow);
      const x = i - D;
      const k = Math.floor(x);
      const f = x - k;
      const ym1 = buf[(k - 1) & MASK], y0 = buf[k & MASK], y1 = buf[(k + 1) & MASK], y2 = buf[(k + 2) & MASK];
      v = -f * (f - 1) * (f - 2) / 6 * ym1 + (f + 1) * (f - 1) * (f - 2) / 2 * y0
        - (f + 1) * f * (f - 2) / 2 * y1 + (f + 1) * f * (f - 1) / 6 * y2;
      apy1 = v;
      if (u >= 1) {
        // Hand back to the allpass tuner at the new length.
        N = Math.max(2, Math.floor(D - 0.5));
        eta = bisect((e) => apDelay(e, (TAU * g.f1) / sr) - (D - N), -0.99, 0.99, 30);
        apx1 = buf[(i - 1 - N) & MASK];
        s.glide = null;
      }
    } else {
      const xn = buf[(i - N) & MASK];
      v = eta * xn + apx1 - eta * apy1;
      apx1 = xn;
      apy1 = v;
    }
    let y = da * v + dx0 - da * dy0; dx0 = v; dy0 = y; v = y;
    y = da * v + dx1 - da * dy1; dx1 = v; dy1 = y; v = y;
    y = da * v + dx2 - da * dy2; dx2 = v; dy2 = y; v = y;
    v = lb * v - la * ly1;
    ly1 = v;
    if (exc) {
      v += exc[excPos++];
      if (excPos >= exc.length) exc = null;
    }
    buf[i & MASK] = v;
    out[i] += v;
    const av = v < 0 ? -v : v;
    if (av > peak) peak = av;
    if ((i & 1023) === 0) {
      if (peak < 1e-7 && !exc && !s.glide) { s.active = false; peak = 0; break; }
      peak = 0;
    }
  }
  s.N = N; s.eta = eta; s.apx1 = apx1; s.apy1 = apy1; s.ly1 = ly1;
  s.dx[0] = dx0; s.dx[1] = dx1; s.dx[2] = dx2; s.dy[0] = dy0; s.dy[1] = dy1; s.dy[2] = dy2;
  s.exc = exc;
  s.excPos = excPos;
  s.peak = peak;
}

export function synth({
  sampleRate = 48000,
  duration,
  events = [],
  detuneCents = 0,
  noiseDb = null,
  laptopMic = false,
  seed = 1,
} = {}) {
  const sr = sampleRate;
  const rnd = mulberry32(seed * 2654435761 + 12345);
  const n = Math.max(1, Math.ceil(duration * sr));
  const out = new Float32Array(n);
  const strings = Array.from({ length: 6 }, newString);

  const designFor = (midi, string, opts = {}) => {
    const fret = Math.max(0, midi - STANDARD_TUNING[string - 1]);
    const B = B_OPEN[string - 1] * 2 ** (fret / 6);
    const fretDecay = 0.95 ** (fret / 2);
    const lo = (opts.t60lo ?? T60_LOW[string - 1]) * fretDecay;
    const hi = (opts.t60hi ?? T60_HIGH[string - 1]) * fretDecay;
    return design(sr, hz(midi + detuneCents / 100), B, lo, Math.min(hi, lo * 0.9));
  };

  const excitation = (L, amp, bright, beta) => {
    const e = new Float64Array(L);
    let y = 0;
    const p = Math.min(0.95, Math.max(0, 1 - bright));
    for (let i = 0; i < L; i++) { y = (1 - p) * (rnd() * 2 - 1) + p * y; e[i] = y; }
    const P = Math.max(1, Math.round(beta * L));
    for (let i = L - 1; i >= P; i--) e[i] -= e[i - P];
    let mean = 0;
    for (let i = 0; i < L; i++) mean += e[i];
    mean /= L;
    let pw = 0;
    for (let i = 0; i < L; i++) { e[i] -= mean; pw += e[i] * e[i]; }
    const k = amp / (Math.sqrt(pw / L) || 1);
    for (let i = 0; i < L; i++) e[i] *= k;
    return e;
  };

  const setDesign = (s, d, resetState) => {
    s.d = d; s.N = d.N; s.eta = d.eta; s.da = d.da; s.la = d.la; s.lb = d.lb;
    if (resetState) { s.apx1 = 0; s.apy1 = 0; s.dx.fill(0); s.dy.fill(0); s.ly1 = 0; }
  };

  const pluck = (s, string, midi, vel, kind = 'normal') => {
    const opts = kind === 'mute' ? { t60lo: 0.07, t60hi: 0.03 } : kind === 'harm' ? { t60lo: T60_LOW[string - 1] * 1.3 } : {};
    const d = designFor(midi, string, opts);
    s.buf.fill(0); // the pick stops whatever the string was doing
    setDesign(s, d, true);
    s.glide = null;
    s.midi = midi;
    const L = Math.max(4, Math.round(d.D1));
    const amp = 0.12 * vel * (kind === 'harm' ? 0.45 : kind === 'mute' ? 1.3 : 1);
    const bright = kind === 'harm' ? 0.15 : kind === 'mute' ? 0.5 : 0.45 + 0.45 * vel;
    const beta = kind === 'harm' ? 0.5 : 0.1 + 0.1 * rnd();
    s.exc = excitation(L, amp, bright, beta);
    s.excPos = 0;
    s.active = true;
    s.peak = 1;
  };

  const legato = (s, string, midi, vel, bump) => {
    // Hammer-on / pull-off: same string, new length, no pick.
    const d = designFor(midi, string);
    setDesign(s, d, false);
    s.glide = null;
    s.midi = midi;
    const L = Math.max(4, Math.round(d.D1));
    s.exc = excitation(L, 0.12 * vel * bump, 0.5, 0.15);
    s.excPos = 0;
    s.active = true;
    s.peak = 1;
  };

  const glideTo = (s, i, midi, seconds) => {
    // Glide the pure delay from the current pitch to midi; filters stay put.
    if (!s.d) return;
    const f0 = s.glide ? s.glide.fNow : hz(s.midi + detuneCents / 100);
    const f1 = hz(midi + detuneCents / 100);
    s.glide = { i0: i, len: Math.max(1, Math.round(seconds * sr)), f0, f1, fNow: f0, midi };
    s.midi = midi;
  };

  // Schedule: every note becomes one or more timed actions.
  const acts = [];
  for (const ev of events) {
    const notes = (ev.notes || []).map((nt) => ({ ...nt, string: nt.string || stringFor(nt.midi) }));
    const order = [...notes].sort((a, b) => (ev.dir === 'up' ? a.string - b.string : b.string - a.string));
    const strum = Number(ev.strumMs) || 0;
    order.forEach((nt, k) => {
      const off = order.length > 1 ? (strum / 1000) * (k / (order.length - 1)) : 0;
      const at = Math.round((ev.t + off) * sr);
      const vel = (nt.vel ?? 1) * (order.length > 1 ? 0.92 + 0.16 * rnd() : 1);
      const tech = techsOf(nt);
      acts.push({ at, note: nt, vel, tech });
    });
  }
  acts.sort((a, b) => a.at - b.at);

  const apply = (act, i) => {
    const { note, vel, tech } = act;
    const s = strings[note.string - 1];
    const has = (x) => tech.includes(x);
    if (has('h') || has('p')) {
      if (s.active && s.d) legato(s, note.string, note.midi, vel, has('p') ? 0.35 : 0.25);
      else pluck(s, note.string, note.midi, vel);
    } else if (has('/') || has('\\') || has('s')) {
      if (!(s.active && s.d)) {
        pluck(s, note.string, note.midi + (has('\\') ? 2 : -2), vel);
        pending.push({ at: i + Math.round(0.03 * sr), fn: (j) => glideTo(s, j, note.midi, 0.08) });
      } else glideTo(s, i, note.midi, 0.08);
    } else if (has('b')) {
      pluck(s, note.string, note.midi, vel);
      const semis = Number(note.bend ?? 2);
      pending.push({ at: i + Math.round(0.05 * sr), fn: (j) => glideTo(s, j, note.midi + semis, 0.12) });
    } else if (has('x')) {
      pluck(s, note.string, note.midi ?? STANDARD_TUNING[note.string - 1], vel, 'mute');
    } else if (has('harm')) {
      pluck(s, note.string, note.midi, vel, 'harm');
    } else {
      pluck(s, note.string, note.midi, vel);
    }
  };
  const pending = [];

  // Run every sounding string from one scheduled change to the next.
  let ai = 0;
  let i = 0;
  while (i < n) {
    while (ai < acts.length && acts[ai].at <= i) apply(acts[ai++], i);
    for (let k = pending.length - 1; k >= 0; k--) if (pending[k].at <= i) { const p = pending[k]; pending.splice(k, 1); p.fn(i); }
    let end = n;
    if (ai < acts.length) end = Math.min(end, acts[ai].at);
    for (const p of pending) end = Math.min(end, p.at);
    end = Math.max(end, i + 1);
    for (let si = 0; si < 6; si++) if (strings[si].active) runString(strings[si], i, end, out, sr);
    i = end;
  }

  if (noiseDb != null && Number.isFinite(noiseDb)) {
    const p = activePower(out, sr);
    const rms = p > 0 ? Math.sqrt(p) / 10 ** (noiseDb / 20) : 0.01;
    const nz = roomNoise(n, sr, rnd, rms);
    for (let i = 0; i < n; i++) out[i] += nz[i];
  }
  if (laptopMic) {
    biquad(out, sr, 'hp', 100);
    biquad(out, sr, 'lp', Math.min(10000, sr * 0.45));
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.95) for (let i = 0; i < n; i++) out[i] *= 0.95 / peak;
  return out;
}

export function writeWav(file, pcm, sampleRate) {
  const n = pcm.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  writeFileSync(file, buf);
}
