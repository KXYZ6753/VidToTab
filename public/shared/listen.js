// Listening along: has the player just played the note or chord the tab says
// comes next?
//
// This is verification, not transcription. The tab already says which pitches
// to expect (and on which strings), so the question per event is narrow: are
// these pitches sounding now, were they struck after we started waiting, and is
// something else — a fret off, an octave off, last chord still ringing — the
// better explanation of what the microphone hears. Primary case: an acoustic
// guitar in front of a laptop microphone in an ordinary room.
//
// Per hop of ~10.7 ms (512 samples at 44.1/48 kHz, 256 at 16–24 kHz):
//   front end  60 Hz high-pass (removes DC too). Noise spectrum, onset
//              statistics and RMS floor from calibrateNoise(); minimum
//              statistics otherwise, falling at once but rising only 6 dB/s, so
//              a note ringing for seconds never becomes "noise".
//   onsets     SuperFlux-like: 2048-sample frame, log-compressed semitone
//              filterbank, positive flux against a 3-band max filter of the
//              previous frame, online peak picking (w1 3, w3 8, w5 3, ≥ 32 ms)
//              over max(δ0, median + 4·MAD).
//   spectrum   decimated to 12 kHz, 85 ms Hann frame zero-padded ×2 (5.9 Hz
//              bins); spectral subtraction (1.5·N), Klapuri whitening (30
//              bands, ν 0.33), a local floor (25th percentile per third-octave,
//              never under the whitened noise), peaks with log-parabolic
//              interpolation.
//   notes      per expected note, its partials h·f0·√(1+B·h²) (B from the
//              string and fret) ±40 cents. A note is present when its partials
//              are there as peaks (support: 75 % of their weight, and half of
//              the partials no other sounding note shares), checked against an
//              explanation by non-negative least squares over the expected
//              notes, ±1 and ±12 distractors and the last event's notes (with
//              an L1 cost on the distractors), and two octave tests (the octave
//              below must not explain it; its own odd partials must be there).
//   newness    a present note counts for the armed event only if it was
//              attacked after arming: after an onset, its own partials rose
//              (per partial, judged on frames that no longer straddle the
//              onset when the note was already ringing; a re-plucked ringing
//              note by its upper partials, even ones too, unless the rise is
//              only every 2nd or 3rd partial: an octave or fifth above);
//              without one, a 6 dB rise (4 dB for hammer-ons, pull-offs and
//              slides).
//   decision   lenient (all of ≤ 2 notes, all but one of ≥ 3), strict (all, no
//              louder intruder a semitone off), bass (lowest exact, the rest by
//              pitch class); in wait mode evidence accumulates for 3 s.
//              Lenient also listens one event ahead: accept {index: i + 1,
//              skipped: [i]} when the next event is struck with partials of
//              its own, and what it heard of the next event carries over
//              when that one is armed.
//
// Pure module: no DOM and no Node APIs, so a browser Worker and Node share it.
// Run `node public/shared/listen.js` for the self-check; scripts/listen-test.mjs
// is the benchmark against synthetic guitar recordings.

const TAU = Math.PI * 2;
const OPEN = [64, 59, 55, 50, 45, 40]; // standard tuning, string 1 (high e) … 6
// Inharmonicity of each open string: 1e-4 on the low E down to 2e-5 on the
// high e, geometric in between; fretting shortens the string and raises it.
const B_OPEN = OPEN.map((_, i) => 2e-5 * 5 ** (i / 5));

export const midiToHz = (m, a4 = 440) => a4 * 2 ** ((m - 69) / 12);
export const hzToMidi = (hz, a4 = 440) => 69 + 12 * Math.log2(hz / a4);

// Every constant can be overridden through createEngine({ params }).
const DEFAULTS = {
  // --- partials
  highpassHz: 60,
  fmax: 5000, // highest partial used
  maxHarmonics: 10,
  tolCents: 40, // window around each expected partial…
  tolBins: 0.6, // …but at least this many bins (5.9 Hz) either side
  slideTolCents: 50,
  rowMergeCents: 30, // partials of different notes closer than this are one observation
  ownCents: 50, // a partial is a note's own when no other sounding note has one this close
  lowFundamentalHz: 110, // below this, h = 1 counts half (laptop mics lose it)
  inharmFretExp: 3, // B ×2^(fret/exp)
  lowestMidi: 38, // lowest playable note (drop D); no octave distractors below it
  // --- spectrum
  subtract: 1.5, // spectral subtraction factor
  whitenNu: 0.33,
  whitenFloor: 0.01, // band RMS floor relative to the loudest band
  floorPercentile: 0.25, // local spectral floor (per third-octave)
  floorK: 2, // a peak counts only above floorK × local floor
  floorNoise: 0.3, // the local floor is at least this share of the (whitened) noise
  // --- presence
  supportHarmonics: 8,
  supportK: 2, // a partial counts when its peak stands supportK × floor over the floor…
  supportRel: 0.05, // …and at least this share of the frame's largest peak
  supportMin: 0.75, // weighted share of partials present (lenient, bass)
  supportStrict: 0.85,
  supportIntruder: 0.6, // a distractor needs less to count as played
  supportFit: 0.7, // …and so does a note the fit clearly wants
  neighbourMargin: 0, // support over any unexpected semitone neighbour's (0: off)
  uniqueShare: 0.15, // partials no other sounding note has, if they weigh this much…
  uniqueMin: 0.5, // …must be at least half there
  shareMin: 0.15, // the fit: coefficient vs the largest one…
  residualMin: 0.02, // …and removing the template raises the cost this much (of ‖o‖²)
  snrDb: 6, // note salience over the noise's
  tonalK: 1, // note salience over the local floor's
  nnlsIters: 30,
  looIters: 12,
  maxTemplates: 24,
  // L1 cost per template role, relative to ‖template‖·‖observation in its windows‖
  costNear: 0.2,
  costOctave: 0.2,
  costRing: 0.05,
  // With the octave below sounding too (a distractor or last event's note),
  // the note must show up as extra energy on that note's even partials: Σ even
  // / Σ max(odd neighbours) at least this (a single string's partials form a
  // smooth envelope, so alone it is about 1). In chords only when the fit
  // gives that octave octaveTrigger of the note's weight.
  octaveExcess: 1.5,
  octaveTrigger: 0.1,
  octaveUpMax: 3, // the note's own Σ even / Σ max(odd neighbours) when the octave above sounds
  presentAfter: 0.04, // nothing is present until this long after the latest onset
  // --- newness
  matureAfter: 0.06, // a note's attack is judged on frames at least this long after it
  riseOnsetDb: 3, // with a broadband onset
  riseAloneDb: 6, // without one
  legatoRiseDb: 4, // hammer-on / pull-off target
  legatoFallDb: 3, // …while the note it came from falls
  slideRiseDb: 4,
  freshShare: 0.4, // share of the note's partials asked that must rise…
  allShare: 0.5, // …or of all its own partials, odd and even (see riseShare)…
  oddRiseShare: 0.3, // …if this share of the odd ones rose too (an octave above raises only evens)
  prominentDb: 6, // …counting those that stand this far over the local floor
  ringingDb: 12, // a partial this far over the floor before the onset was already sounding
  clearDb: 12, // without an onset, partials must stand this far over the floor to count
  cleanAfter: 0.08, // frames this long after an onset no longer straddle it
  riseBefore: 0.06, // an attack judged at an onset must not have begun this long before arming
  // --- decision
  onsetBefore: 0.03, // an onset up to 30 ms before arming still belongs to the event
  collectMin: 0.06, // earliest accept after the first onset
  noteWithin: 0.4, // a note must be held within this long after its onset
  expireWait: 3, // s: evidence lifetime in wait mode (arpeggios accumulate)
  expirePlay: 0.8,
  lookAhead: true, // lenient: accept the next event (skipping this one) when it is fully played
  // --- wrong notes
  wrongAfter: 0.2,
  wrongDominance: 0.5,
  wrongSnrDb: 10,
  wrongFrames: 3,
  wrongEvery: 1,
  wrongTop: 6,
  clipLevel: 0.985,
  clipCount: 3,
  // --- onsets
  onsetDelta0: 1.5, // absolute floor of the onset threshold (flux units)
  onsetMadK: 4,
  onsetLambda: 1e4,
  onsetW1: 3,
  onsetW3: 8,
  onsetW5: 3,
  onsetMinGap: 0.032,
  // --- noise
  noiseWindow: 2, // s: minimum-statistics window
  noiseBias: 1.7, // minimum statistics of the smoothed spectrum → its mean
  noiseSmooth: 0.9, // per-bin smoothing before the minimum is taken
  noiseWarmup: 2, // s before the floor's rise is limited…
  noiseRiseDb: 6, // …to this many dB per second
  lineOverNoise: 8, // a bin this far over the noise spectrum is worth pitch work
  // --- reporting
  levelRate: 20,
  tunerRate: 20,
  driftAlpha: 0.1,
  driftClamp: 60,
  driftStep: 3,
  driftTol: 35,
};

// ---------------------------------------------------------------- FFT

class ComplexFFT {
  constructor(n) {
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n >> 1);
    this.sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) {
      this.cos[i] = Math.cos((-TAU * i) / n);
      this.sin[i] = Math.sin((-TAU * i) / n);
    }
  }

  run(re, im) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // first two stages as one radix-4 pass: no multiplications
    for (let i = 0; i < n; i += 4) {
      const a0r = re[i], a0i = im[i], a1r = re[i + 1], a1i = im[i + 1];
      const a2r = re[i + 2], a2i = im[i + 2], a3r = re[i + 3], a3i = im[i + 3];
      const b0r = a0r + a1r, b0i = a0i + a1i, b1r = a0r - a1r, b1i = a0i - a1i;
      const b2r = a2r + a3r, b2i = a2i + a3i, b3r = a2r - a3r, b3i = a2i - a3i;
      re[i] = b0r + b2r; im[i] = b0i + b2i;
      re[i + 2] = b0r - b2r; im[i + 2] = b0i - b2i;
      re[i + 1] = b1r + b3i; im[i + 1] = b1i - b3r;
      re[i + 3] = b1r - b3i; im[i + 3] = b1i + b3r;
    }
    const cs = this.cos;
    const sn = this.sin;
    for (let size = 8; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let k = 0; k < half; k++) {
        const wr = cs[k * step];
        const wi = sn[k * step];
        for (let a = k; a < n; a += size) {
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

// Real FFT of length n through one complex FFT of length n/2.
class RealFFT {
  constructor(n) {
    this.n = n;
    this.m = n >> 1;
    this.c = new ComplexFFT(this.m);
    this.zr = new Float64Array(this.m);
    this.zi = new Float64Array(this.m);
    this.wr = new Float64Array(this.m + 1);
    this.wi = new Float64Array(this.m + 1);
    for (let k = 0; k <= this.m; k++) {
      this.wr[k] = Math.cos((-TAU * k) / n);
      this.wi[k] = Math.sin((-TAU * k) / n);
    }
  }

  // x: length n. Writes bins 0..limit (default n/2) into outRe/outIm.
  run(x, outRe, outIm, limit = this.m) {
    const m = this.m;
    const zr = this.zr;
    const zi = this.zi;
    for (let i = 0; i < m; i++) { zr[i] = x[2 * i]; zi[i] = x[2 * i + 1]; }
    this.c.run(zr, zi);
    const top = Math.min(limit, m);
    for (let k = 0; k <= top; k++) {
      const k1 = k === m ? 0 : k;
      const k2 = k === 0 ? 0 : m - k;
      const ar = zr[k1];
      const ai = zi[k1];
      const br = zr[k2];
      const bi = -zi[k2];
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai + bi);
      const or = 0.5 * (ai - bi);
      const oi = -0.5 * (ar - br);
      const wr = this.wr[k];
      const wi = this.wi[k];
      outRe[k] = er + wr * or - wi * oi;
      outIm[k] = ei + wr * oi + wi * or;
    }
  }
}

// Spectrum of a real signal whose length is a power of two: bins 0..n/2.
export function fftReal(x) {
  const n = x.length;
  const f = new RealFFT(n);
  const re = new Float64Array((n >> 1) + 1);
  const im = new Float64Array((n >> 1) + 1);
  f.run(x, re, im);
  return { re, im };
}

// Periodic Hann window.
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((TAU * i) / n);
  return w;
}

// ---------------------------------------------------------------- McLeod

// McLeod pitch method: normalised square difference function via an FFT
// autocorrelation, first key maximum above 0.9 of the highest one, parabolic
// refinement. Returns { hz, clarity }; hz is 0 when nothing periodic is found.
function makeMcleod(n) {
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const fft = new ComplexFFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const nsdf = new Float64Array(n);
  return (frame, sampleRate, fmin = 55, fmax = 1500) => {
    const len = Math.min(n, frame.length);
    re.fill(0);
    im.fill(0);
    let mean = 0;
    for (let i = 0; i < len; i++) mean += frame[i];
    mean /= len || 1;
    for (let i = 0; i < len; i++) re[i] = frame[i] - mean;
    let m = 0;
    for (let i = 0; i < len; i++) m += re[i] * re[i];
    if (m <= 1e-12) return { hz: 0, clarity: 0 };
    const x0 = re.slice(0, len);
    fft.run(re, im);
    for (let i = 0; i < size; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    // Inverse via the forward transform of the conjugate (the power spectrum is real).
    fft.run(re, im);
    const tauMax = Math.min(len - 2, Math.floor(sampleRate / fmin));
    const tauMin = Math.max(2, Math.floor(sampleRate / fmax));
    m *= 2;
    nsdf[0] = 1;
    for (let tau = 1; tau <= tauMax + 1 && tau < len; tau++) {
      m -= x0[tau - 1] * x0[tau - 1] + x0[len - tau] * x0[len - tau];
      nsdf[tau] = m > 1e-12 ? (2 * (re[tau] / size)) / m : 0;
    }
    // Key maxima: the highest point between each positive-going and the next
    // negative-going zero crossing.
    const keys = [];
    let tau = 1;
    while (tau < tauMax && nsdf[tau] > 0) tau++;
    let best = -1;
    let bestTau = 0;
    let inPos = false;
    for (; tau <= tauMax; tau++) {
      const v = nsdf[tau];
      if (!inPos && v > 0 && nsdf[tau - 1] <= 0) { inPos = true; best = -1; }
      if (inPos) {
        if (v > best) { best = v; bestTau = tau; }
        if (v <= 0) { inPos = false; if (bestTau >= tauMin) keys.push(bestTau); }
      }
    }
    if (inPos && bestTau >= tauMin && bestTau < tauMax) keys.push(bestTau);
    if (!keys.length) return { hz: 0, clarity: 0 };
    let top = 0;
    for (const k of keys) top = Math.max(top, nsdf[k]);
    const pick = keys.find((k) => nsdf[k] >= 0.9 * top);
    const a = nsdf[pick - 1];
    const b = nsdf[pick];
    const c = nsdf[pick + 1];
    const den = a - 2 * b + c;
    const p = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    return { hz: sampleRate / (pick + p), clarity: Math.min(1, b - 0.25 * (a - c) * p) };
  };
}

export function mcleod(frame, sampleRate) {
  return makeMcleod(frame.length)(frame, sampleRate);
}

// ---------------------------------------------------------------- helpers

const salienceWeight = (f0, h) => (f0 + 52) / (h * f0 + 320);

function defaultB(midi) {
  if (midi <= 40) return B_OPEN[5];
  if (midi <= 64) return B_OPEN[5] * (B_OPEN[0] / B_OPEN[5]) ** ((midi - 40) / 24);
  return Math.min(4e-4, B_OPEN[0] * 2 ** ((midi - 64) / DEFAULTS.inharmFretExp));
}

function techsOf(note) {
  return [].concat(note?.tech ?? []).map((t) => String(t).trim()).filter(Boolean);
}

const isSlide = (tech) => tech.includes('/') || tech.includes('\\') || tech.includes('s');
const isLegato = (tech) => tech.includes('h') || tech.includes('p');

// Median and median absolute deviation of an array (copied).
function medMad(values) {
  if (!values.length) return { med: 0, mad: 0 };
  const s = Float64Array.from(values).sort();
  const med = s[s.length >> 1];
  for (let i = 0; i < s.length; i++) s[i] = Math.abs(s[i] - med);
  s.sort();
  return { med, mad: s[s.length >> 1] };
}

// Non-negative least squares by coordinate descent on the normal equations,
// with an optional L1 cost per template: min ‖o − A·c‖² + Σ 2·lam_j·c_j, c ≥ 0.
// G: J×J Gram matrix, b: Aᵀo, c: coefficients (warm start, modified in place).
// The cost is what makes the expected notes the default explanation: a
// distractor (a fret or an octave away) has to explain clearly more than the
// expected notes can before it takes their partials.
function nnls(G, b, c, J, iters, skip = -1, lam = null) {
  let scale = 0;
  for (let j = 0; j < J; j++) if (c[j] > scale) scale = c[j];
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let j = 0; j < J; j++) {
      if (j === skip) continue;
      const row = j * J;
      const gjj = G[row + j];
      if (gjj <= 0) continue;
      let g = b[j] - (lam ? lam[j] : 0);
      for (let k = 0; k < J; k++) g -= G[row + k] * c[k];
      let nc = c[j] + g / gjj;
      if (nc < 0) nc = 0;
      moved = Math.max(moved, Math.abs(nc - c[j]));
      if (nc > scale) scale = nc;
      c[j] = nc;
    }
    if (moved <= 1e-4 * scale + 1e-12) break;
  }
}

// ‖o − A·c‖² + Σ 2·lam_j·c_j, from the normal equations.
function residual(G, b, c, J, oo, lam = null) {
  let r = oo;
  for (let j = 0; j < J; j++) {
    const cj = c[j];
    if (!cj) continue;
    r -= 2 * cj * (b[j] - (lam ? lam[j] : 0));
    const row = j * J;
    for (let k = 0; k < J; k++) if (c[k]) r += cj * G[row + k] * c[k];
  }
  return r;
}

// ---------------------------------------------------------------- engine

// createEngine({ sampleRate, params? }) — `hop` and `emit` from the worker's
// contract are accepted and ignored: the engine picks its own hop (about
// 10.7 ms: 256 at 16–24 kHz, 512 at 32–48 kHz, 1024 at 88–96 kHz, exposed as
// engine.hop), push() takes chunks of any length, and every message is
// returned from push().
export function createEngine({ sampleRate, params = {} } = {}) {
  const sr = Number(sampleRate) || 48000;
  const P = { ...DEFAULTS, ...params };
  const hop = 2 ** Math.max(7, Math.min(11, Math.ceil(Math.log2(sr / 96))));
  const onN = hop * 4;
  const pwN = hop * 8;
  const pN = hop * 16;
  const ringN = pwN;
  const ringMask = ringN - 1;
  const frameDt = hop / sr;

  // --- input conditioning: 2nd-order Butterworth high-pass (also removes DC)
  const hp = (() => {
    const w = (TAU * P.highpassHz) / sr;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    return { b0: (1 + cs) / 2 / a0, b1: -(1 + cs) / a0, b2: (1 + cs) / 2 / a0, a1: (-2 * cs) / a0, a2: (1 - alpha) / a0 };
  })();
  let hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0;
  const ring = new Float64Array(ringN);
  let wpos = 0;
  let fill = 0;
  let samplesIn = 0;
  let frameNo = 0;
  let ringSq = 0; // running sum of squares over the ring (the pitch frame)

  // level / clipping
  let lvSum = 0, lvN = 0, lvPeak = 0, lvClip = 0, lvHops = 0;
  const levelEvery = Math.max(1, Math.ceil(sr / hop / P.levelRate));
  let hopClip = 0;
  let clipUntil = -1;

  // --- onset detection
  const onFFT = new RealFFT(onN);
  const onWin = hann(onN);
  const onBuf = new Float64Array(onN);
  const onRe = new Float64Array(onN / 2 + 1);
  const onIm = new Float64Array(onN / 2 + 1);
  const onBw = sr / onN;
  const onNorm = 4 / onN;
  const bandLo = [];
  const bandHi = [];
  {
    const top = Math.min(16000, sr * 0.45);
    let start = Math.max(1, Math.ceil(midiToHz(35.5) / onBw));
    for (let m = 36; midiToHz(m + 0.5) < top; m++) {
      const end = Math.floor(midiToHz(m + 0.5) / onBw) + 1;
      if (end > start) { bandLo.push(start); bandHi.push(end); start = end; }
    }
  }
  const nBands = bandLo.length;
  let Lcur = new Float64Array(nBands);
  let Lprev = new Float64Array(nBands);
  const fluxHist = new Float64Array(16);
  const fluxRun = new Float64Array(256);
  let fluxRunN = 0;
  let fluxThr = P.onsetDelta0;
  let calFluxThr = 0;
  let lastOnsetFrame = -1e9;
  let lastOnsetT = -1e9;
  const onsets = []; // recent {t, strength}

  // --- pitch spectrum. Nothing it looks at is above ~5.3 kHz, so the signal
  // is first decimated to 11–16 kHz (Kaiser-windowed sinc, 45 dB); the frame
  // keeps its length in time and the bins their width, at a quarter of the
  // FFT at 48 kHz.
  let D = 1;
  while (sr / (D * 2) >= 11000 && pwN / (D * 2) >= 256) D *= 2;
  const dsr = sr / D;
  const dwN = pwN / D;
  const dN = pN / D;
  const fPass = Math.min(P.fmax * 1.05, 0.45 * dsr);
  let fir = null;
  let firL = 0;
  if (D > 1) {
    const fStop = dsr - fPass;
    const atten = 45;
    const beta = 0.1102 * (atten - 8.7);
    firL = Math.ceil((atten - 7.95) / (14.36 * ((fStop - fPass) / sr))) | 1;
    const fc = (fPass + fStop) / 2 / sr;
    const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
    fir = new Float64Array(firL);
    const M = (firL - 1) / 2;
    let sum = 0;
    for (let n = 0; n < firL; n++) {
      const x = n - M;
      const sinc = x === 0 ? 2 * fc : Math.sin(TAU * fc * x) / (Math.PI * x);
      fir[n] = sinc * (i0(beta * Math.sqrt(1 - (x / M) ** 2)) / i0(beta));
      sum += fir[n];
    }
    for (let n = 0; n < firL; n++) fir[n] /= sum;
  }
  const hist = new Float64Array(2 * Math.max(1, firL));
  const firMid = (firL - 1) >> 1;
  let hpos = 0;
  let dcount = 0;
  const dring = D > 1 ? new Float64Array(dwN) : null;
  let dpos = 0;
  const pFFT = new RealFFT(dN);
  const pWin = hann(dwN);
  const pBuf = new Float64Array(dN);
  const bw = sr / pN;
  const kMax = Math.min(dN / 2 - 2, Math.ceil(fPass / bw));
  const kLo = Math.max(2, Math.floor(45 / bw));
  const pRe = new Float64Array(dN / 2 + 1);
  const pIm = new Float64Array(dN / 2 + 1);
  const pNorm = 4 / dwN;
  const X = new Float64Array(kMax + 1);
  const S = new Float64Array(kMax + 1);
  const Y = new Float64Array(kMax + 1);
  const F = new Float64Array(kMax + 1);
  const noise = new Float64Array(kMax + 1);
  const calNoise = new Float64Array(kMax + 1);
  let haveCal = false;

  // minimum statistics
  const U = 8;
  const V = Math.max(4, Math.round((P.noiseWindow * sr) / hop / U));
  const psm = new Float64Array(kMax + 1);
  let psmStarted = false;
  const subMin = new Float64Array(kMax + 1).fill(Infinity);
  const mins = new Float64Array(U * (kMax + 1)).fill(Infinity);
  const minAll = new Float64Array(kMax + 1).fill(Infinity);
  let subCount = 0;
  let subSlot = 0;
  let rmsSub = Infinity;
  const rmsMins = new Float64Array(U).fill(Infinity);
  let rmsFloor = 1e-5;
  let rmsTrack = 0;
  const track = new Float64Array(kMax + 1);
  const riseStep = 10 ** ((P.noiseRiseDb * frameDt) / 20);
  let calRms = 0;
  let frameRms = 0;

  // calibration
  let calLeft = 0;
  let calFrames = 0;
  let calRmsSum = 0;
  const calFlux = [];
  const calSum = new Float64Array(kMax + 1);

  // whitening bands (Klapuri 2006)
  const wbC = [];
  for (let b = 0; b < 32; b++) wbC.push(229 * (10 ** ((b + 1) / 21.4) - 1));
  const nWb = wbC.length;
  const wbLow = new Int16Array(kMax + 1);
  const wbFrac = new Float64Array(kMax + 1);
  const wbWsum = new Float64Array(nWb);
  for (let k = 0; k <= kMax; k++) {
    const f = k * bw;
    let b = 0;
    while (b < nWb - 2 && wbC[b + 1] <= f) b++;
    const fr = Math.max(0, Math.min(1, (f - wbC[b]) / (wbC[b + 1] - wbC[b])));
    wbLow[k] = b;
    wbFrac[k] = fr;
    if (k >= kLo) { wbWsum[b] += 1 - fr; wbWsum[b + 1] += fr; }
  }
  const wbPow = new Float64Array(nWb);
  const wbGam = new Float64Array(nWb);

  // local floor bands: thirds of an octave, but never narrower than three
  // main lobes of the window, so the percentile lands between partials
  const fbLo = [];
  const fbHi = [];
  {
    const minW = Math.round(3 * 4 * (pN / pwN));
    let lo = kLo;
    while (lo < kMax) {
      let hi = Math.max(lo + minW, Math.round(lo * 2 ** (1 / 3)));
      if (hi > kMax) hi = kMax;
      if (kMax - hi < minW) hi = kMax;
      fbLo.push(lo);
      fbHi.push(hi);
      lo = hi;
    }
  }
  const fbCen = fbLo.map((lo, i) => 0.5 * (lo + fbHi[i] - 1));
  const fbVal = new Float64Array(fbLo.length);
  const scratch = new Float64Array(kMax + 1);
  // q-quantile of a[lo..hi) by quickselect on a scratch copy
  function percentile(a, lo, hi, q) {
    const n = hi - lo;
    for (let i = 0; i < n; i++) scratch[i] = a[lo + i];
    const k = Math.floor(q * (n - 1));
    let l = 0;
    let r = n - 1;
    while (l < r) {
      const pivot = scratch[(l + r) >> 1];
      let i = l;
      let j = r;
      while (i <= j) {
        while (scratch[i] < pivot) i++;
        while (scratch[j] > pivot) j--;
        if (i <= j) { const t = scratch[i]; scratch[i] = scratch[j]; scratch[j] = t; i++; j--; }
      }
      if (k <= j) r = j; else if (k >= i) l = i; else break;
    }
    return scratch[k];
  }

  // spectral peaks
  const maxPeaks = 1024;
  const pkF = new Float64Array(maxPeaks);
  const pkM = new Float64Array(maxPeaks);
  let npk = 0;
  let maxPeak = 0;

  // --- global per-MIDI salience (default inharmonicity), for rises and noise
  const M_LO = 36;
  const M_HI = 100;
  const NM = M_HI - M_LO + 1;
  let gStart, gKlo, gKhi, gW, gLo, gHi;
  let eCur, eNoise, eHist, eFb, eFu; // per partial window: now, noise, history (dB), floor band
  const fxVal = new Float64Array(fbLo.length); // floor of the raw spectrum per floor band
  let fxHist = null; // …and its history (dB), per band
  const rx = new Float64Array(NM);
  const rn = new Float64Array(NM);
  const HL = 64;
  const rxHist = new Float64Array(NM * HL).fill(-200);
  const histT = new Float64Array(HL).fill(-1e9);
  let rnAge = 1e9;

  let offsetCents = 0;
  let drift = 0;
  let driftSent = 0;

  function buildGlobal() {
    const starts = [0];
    const klo = [], khi = [], w = [], flo = [], fhi = [];
    for (let m = M_LO; m <= M_HI; m++) {
      const f0 = midiToHz(m + offsetCents / 100);
      const B = defaultB(m);
      const H = Math.max(1, Math.min(P.maxHarmonics, Math.floor(P.fmax / f0)));
      for (let h = 1; h <= H; h++) {
        const fh = h * f0 * Math.sqrt(1 + B * h * h);
        const lo = Math.min(fh * 2 ** (-P.tolCents / 1200), fh - P.tolBins * bw);
        const hi = Math.max(fh * 2 ** (P.tolCents / 1200), fh + P.tolBins * bw);
        if (hi / bw >= kMax - 1) break;
        const kc = Math.round(fh / bw);
        klo.push(Math.max(1, Math.min(kc, Math.floor(lo / bw + 0.5))));
        khi.push(Math.min(kMax - 1, Math.max(kc, Math.floor(hi / bw + 0.5))));
        flo.push(lo);
        fhi.push(hi);
        let g = salienceWeight(f0, h);
        if (h === 1 && f0 < P.lowFundamentalHz) g *= 0.5;
        w.push(g);
      }
      starts.push(klo.length);
    }
    gStart = Int32Array.from(starts);
    gKlo = Int32Array.from(klo);
    gKhi = Int32Array.from(khi);
    gW = Float64Array.from(w);
    gLo = Float64Array.from(flo);
    gHi = Float64Array.from(fhi);
    eCur = new Float64Array(klo.length);
    eNoise = new Float64Array(klo.length);
    eHist = new Float32Array(klo.length * HL).fill(-200);
    fxHist = new Float32Array(fbLo.length * HL).fill(-200);
    // each window's place among the floor bands, for its prominence
    eFb = new Int16Array(klo.length);
    eFu = new Float64Array(klo.length);
    for (let e = 0; e < klo.length; e++) {
      const kc = 0.5 * (klo[e] + khi[e]);
      let i = 0;
      while (i < fbCen.length - 2 && fbCen[i + 1] <= kc) i++;
      eFb[e] = i;
      eFu[e] = fbCen.length > 1 ? Math.max(0, Math.min(1, (kc - fbCen[i]) / (fbCen[i + 1] - fbCen[i]))) : 0;
    }
    rnAge = 1e9;
  }
  buildGlobal();

  // Salience of every note (Σ weight × largest bin in each partial window);
  // each window's own value goes to perEntry, for per-partial rises.
  function salienceOn(spec, out, perEntry) {
    for (let i = 0; i < NM; i++) {
      let s = 0;
      for (let e = gStart[i]; e < gStart[i + 1]; e++) {
        let mx = 0;
        for (let k = gKlo[e]; k <= gKhi[e]; k++) if (spec[k] > mx) mx = spec[k];
        perEntry[e] = mx;
        s += gW[e] * mx;
      }
      out[i] = s;
    }
  }

  const histIdx = (frame) => ((frame % HL) + HL) % HL;
  // min / max of a note's raw salience (dB) over frames with time in [t0, t1]
  function histMin(mi, t0, t1) {
    let v = Infinity;
    let at = -1e9;
    for (let d = 0; d < HL; d++) {
      const f = histIdx(frameNo - d);
      const tt = histT[f];
      if (tt > t1) continue;
      if (tt < t0) break;
      const x = rxHist[mi * HL + f];
      if (x < v) { v = x; at = tt; }
    }
    return { v, at };
  }
  // (mi < 0: of partial window en instead)
  function histMax(mi, t0, t1, en = 0) {
    const arr = mi < 0 ? eHist : rxHist;
    const base = (mi < 0 ? en : mi) * HL;
    let v = -Infinity;
    for (let d = 0; d < HL; d++) {
      const f = histIdx(frameNo - d);
      const tt = histT[f];
      if (tt > t1) continue;
      if (tt < t0) break;
      const x = arr[base + f];
      if (x > v) v = x;
    }
    return v;
  }
  function histAt(mi, t) {
    for (let d = 0; d < HL; d++) {
      const f = histIdx(frameNo - d);
      if (histT[f] <= t) return rxHist[mi * HL + f];
    }
    return -200;
  }
  const mIndex = (midi) => Math.max(0, Math.min(NM - 1, Math.round(midi) - M_LO));

  // --- tuner
  const tunerFn = makeMcleod(pwN);
  const tunerFrame = new Float64Array(pwN);
  const tunerEvery = Math.max(1, Math.ceil(sr / hop / P.tunerRate));

  // --- targets and the armed event
  let mode = 'idle';
  let targets = [];
  let strictness = 'lenient';
  let ev = null;
  let evNext = null; // look-ahead: the event after the armed one (lenient)
  let lastWrongT = -1e9;

  function normNote(n) {
    const tech = techsOf(n);
    const midi = Number(n?.midi);
    const string = Number(n?.string) >= 1 && Number(n?.string) <= 6 ? Number(n.string) : null;
    // a bend may go up to bendTo (default a whole tone)
    const bt = Number(n?.bendTo) - midi;
    const bendTop = Number.isFinite(bt) && bt >= 0.5 && bt <= 4 ? bt : 2;
    return { midi: Number.isFinite(midi) ? midi : null, string, required: n?.required !== false, tech, bendTop };
  }

  function candidateEntries(c) {
    const f0 = midiToHz(c.midi + offsetCents / 100);
    let B;
    if (c.string) {
      const fret = Math.max(0, c.midi - OPEN[c.string - 1]);
      B = B_OPEN[c.string - 1] * 2 ** (fret / P.inharmFretExp);
    } else B = defaultB(c.midi);
    B = Math.min(B, 1e-3);
    const H = c.harm ? 3 : Math.max(1, Math.min(P.maxHarmonics, Math.floor(P.fmax / f0)));
    const tol = c.slide ? P.slideTolCents : P.tolCents;
    const topRatio = c.bend ? 2 ** (c.bendTop / 12) : 1;
    const out = [];
    for (let h = 1; h <= H; h++) {
      const st = Math.sqrt(1 + B * h * h);
      const fh = h * f0 * st;
      // (never narrower than tolBins: a low partial's interpolated peak is
      // off by a few hertz while the note is young)
      const lo = Math.min(fh * 2 ** (-tol / 1200), fh - P.tolBins * bw);
      const hi = Math.max(fh * topRatio * 2 ** (tol / 1200), fh * topRatio + P.tolBins * bw);
      if (hi / bw >= kMax - 1) break;
      let g = salienceWeight(f0, h);
      if (h === 1 && f0 < P.lowFundamentalHz) g *= 0.5;
      out.push({ f: fh, lo, hi, g });
    }
    return out;
  }

  // The state for listening to event `index`, armed at tArm.
  function buildEvent(index, tArm) {
    const e = targets[index];
    if (!e) return null;
    const notes = (e.notes || []).map(normNote);
    const pitched = notes.filter((n) => n.midi != null && !n.tech.includes('x'));
    const xNotes = notes.filter((n) => n.tech.includes('x'));
    const required = pitched.filter((n) => n.required);
    const cands = [];
    const add = (midi, role, extra = {}) => {
      if (midi == null || midi < 28 || midi > 108) return;
      if (cands.some((c) => c.midi === midi)) return;
      cands.push({ midi, role, string: null, bend: false, bendTop: 0, slide: false, harm: false, legato: false, note: null, ...extra });
    };
    for (const n of pitched) {
      add(n.midi, n.required ? 'exp' : 'opt', {
        note: n,
        string: n.string,
        bend: n.tech.includes('b'),
        bendTop: n.tech.includes('b') ? n.bendTop : 0,
        slide: isSlide(n.tech),
        harm: n.tech.includes('harm'),
        legato: isLegato(n.tech),
      });
    }
    const prev = targets[index - 1];
    const prevNotes = prev ? (prev.notes || []).map(normNote).filter((n) => n.midi != null && !n.tech.includes('x')) : [];
    for (const n of prevNotes) add(n.midi, 'ring', { string: n.string });
    for (const n of pitched) {
      const near = n.tech.includes('b') ? [-1, Math.ceil(n.bendTop) + 1] : [-1, 1];
      for (const d of near) add(n.midi + d, 'near', { string: n.string });
    }
    // (an octave below the lowest string — drop D at most — cannot be played,
    // and in a chord its partials are exactly the chord's)
    for (const n of pitched) for (const d of [-12, 12]) if (n.midi + d >= P.lowestMidi) add(n.midi + d, 'oct', {});
    const prio = { exp: 0, opt: 0, ring: 1, near: 2, oct: 3 };
    cands.sort((a, b) => prio[a.role] - prio[b.role]);
    cands.length = Math.min(cands.length, P.maxTemplates);
    const J = cands.length;

    // Rows: one per group of coinciding partials (centres within
    // rowMergeCents), so a peak shared by two notes is one observation that
    // both can explain. A peak goes to the row whose centre is nearest.
    const entries = [];
    cands.forEach((c, j) => {
      c.entries = candidateEntries(c);
      c.entries.forEach((en, q) => entries.push({ ...en, j, q }));
    });
    entries.sort((a, b) => a.f - b.f);
    const rowLo = [];
    const rowHi = [];
    const rowC = [];
    const rowOf = new Int32Array(entries.length);
    const mergeRatio = 2 ** (P.rowMergeCents / 1200);
    let lnSum = 0;
    let cnt = 0;
    entries.forEach((en, i) => {
      const r = rowLo.length - 1;
      if (r >= 0 && en.f <= rowC[r] * mergeRatio) {
        rowLo[r] = Math.min(rowLo[r], en.lo);
        rowHi[r] = Math.max(rowHi[r], en.hi);
        lnSum += Math.log(en.f);
        cnt++;
        rowC[r] = Math.exp(lnSum / cnt);
        rowOf[i] = r;
      } else {
        lnSum = Math.log(en.f);
        cnt = 1;
        rowLo.push(en.lo);
        rowHi.push(en.hi);
        rowC.push(en.f);
        rowOf[i] = rowLo.length - 1;
      }
    });
    const nRows = rowLo.length;
    const colRows = cands.map(() => []);
    const colW = cands.map(() => []);
    entries.forEach((en, i) => {
      const r = rowOf[i];
      const rows = colRows[en.j];
      const at = rows.indexOf(r);
      if (at >= 0) colW[en.j][at] += en.g; else { rows.push(r); colW[en.j].push(en.g); }
    });
    const A = new Float64Array(nRows * J);
    cands.forEach((c, j) => colRows[j].forEach((r, q) => { A[r * J + j] = colW[j][q]; }));
    const G = new Float64Array(J * J);
    for (let r = 0; r < nRows; r++) {
      for (let j = 0; j < J; j++) {
        const a = A[r * J + j];
        if (!a) continue;
        for (let k = 0; k < J; k++) G[j * J + k] += a * A[r * J + k];
      }
    }
    // For support: each partial's row, and whether any other note that may
    // really be sounding (expected, or last event's) shares that row.
    const sounding = (c) => c.role === 'exp' || c.role === 'opt' || c.role === 'ring';
    cands.forEach((c) => { c.entryRow = new Int32Array(c.entries.length); c.unique = new Uint8Array(c.entries.length).fill(1); });
    entries.forEach((en, i) => { cands[en.j].entryRow[en.q] = rowOf[i]; });
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      for (let k = i + 1; k < entries.length && entries[k].f <= a.f * mergeRatio; k++) {
        const b = entries[k];
        if (a.j === b.j) continue;
        if (sounding(cands[b.j])) cands[a.j].unique[a.q] = 0;
        if (sounding(cands[a.j])) cands[b.j].unique[b.q] = 0;
      }
    }
    // Which harmonics of each note (on the global per-note table) no other
    // sounding note shares, looking up to 24 partials of the others.
    const series = cands.filter(sounding).map((c) => ({ c, f0: midiToHz(c.midi + offsetCents / 100) }));
    cands.forEach((c) => {
      const mi = mIndex(c.midi);
      const n = gStart[mi + 1] - gStart[mi];
      c.ownH = new Uint8Array(n);
      for (let h = 0; h < n; h++) {
        const f = 0.5 * (gLo[gStart[mi] + h] + gHi[gStart[mi] + h]);
        let own = 1;
        for (const { c: o, f0 } of series) {
          if (o === c) continue;
          const k = Math.round(f / f0);
          if (k < 1 || k > 24) continue;
          const fk = k * f0 * Math.sqrt(1 + defaultB(o.midi) * k * k);
          if (Math.abs(1200 * Math.log2(f / fk)) < P.ownCents) { own = 0; break; }
        }
        c.ownH[h] = own;
      }
    });
    cands.forEach((c, j) => {
      c.rows = Int32Array.from(colRows[j]);
      c.w = Float64Array.from(colW[j]);
      c.floorBins = Int32Array.from(c.entries.map((en) => Math.min(kMax, Math.max(0, Math.round(en.f / bw)))));
      c.mi = mIndex(c.midi);
      c.bits = 0;
      c.present = false;
      c.held = false;
      c.cf = 0;
      c.share = 0;
      c.dres = 0;
      c.tonal = 0;
      c.snr = 0;
      c.heardAt = null;
      c.octave = null;
      // a semitone from an expected note without being one (strict mode's intruders)
      c.neighbour = c.role !== 'exp' && c.role !== 'opt' && pitched.some((n) => Math.abs(n.midi - c.midi) === 1);
      c.bendSubs = null;
      if (c.bend) {
        c.bendSubs = [];
        for (let st = 0; st <= c.bendTop + 1e-9; st += 0.5) {
          const sub = { ...c, midi: c.midi + st, bend: false, bendSubs: null };
          sub.entries = candidateEntries(sub);
          sub.floorBins = Int32Array.from(sub.entries.map((en) => Math.min(kMax, Math.max(0, Math.round(en.f / bw)))));
          sub.unique = new Uint8Array(sub.entries.length).fill(1);
          c.bendSubs.push(sub);
        }
      }
      c.support = 0;
      c.uniqueSupport = 1;
      {
        // weight of its first partials no other sounding note has (up to
        // their 24th)
        const e0 = gStart[c.mi];
        const nq = Math.min(P.supportHarmonics, c.ownH.length);
        let wa = 0;
        let wu = 0;
        for (let q = 0; q < nq; q++) { wa += gW[e0 + q]; if (c.ownH[q]) wu += gW[e0 + q]; }
        c.ownShare = wa > 0 ? wu / wa : 0;
      }
      const bi = cands.findIndex((q) => q.midi === c.midi - 12 && (q.role === 'oct' || q.role === 'ring'));
      c.below = (c.role === 'exp' || c.role === 'opt') && bi >= 0 ? bi : null;
      const ai = cands.findIndex((q) => q.midi === c.midi + 12 && (q.role === 'oct' || q.role === 'ring'));
      c.above = (c.role === 'exp' || c.role === 'opt') && ai >= 0 ? ai : null;
      // the note this one came from on the same string (hammer-on, pull-off, slide)
      c.from = null;
      if (c.string && c.legato) {
        const pn = prevNotes.find((n) => n.string === c.string && n.midi !== c.midi);
        if (pn) c.from = mIndex(pn.midi);
      }
    });

    const evt = {
      index,
      id: e.id,
      tArm,
      pitchless: Boolean(e.pitchless) || (pitched.length === 0 && xNotes.length === 0),
      xOnly: pitched.length === 0 && xNotes.length > 0 && !e.pitchless,
      hasX: xNotes.length > 0,
      required,
      pitchedCount: new Set(pitched.map((n) => n.midi)).size,
      expected: new Set(pitched.map((n) => n.midi)),
      cands,
      J,
      nRows,
      rowLo: Float64Array.from(rowLo),
      rowHi: Float64Array.from(rowHi),
      rowC: Float64Array.from(rowC),
      G,
      o: new Float64Array(nRows),
      b: new Float64Array(J),
      c: new Float64Array(J),
      c2: new Float64Array(J),
      pen: Float64Array.from(cands.map((cd, j) => Math.sqrt(G[j * J + j]) * (cd.role === 'near' ? P.costNear : cd.role === 'oct' ? P.costOctave : cd.role === 'ring' ? P.costRing : 0))),
      lam: new Float64Array(J),
      heard: new Map(),
      onsets: [],
      earlyOnsets: [], // onsets before arming that may still count (see arm)
      firstOnset: null,
      firstAttack: null,
      attacks: new Map(), // midi → when its attack began (onset, or start of its rise)
      how: new Map(), // midi → how it was found new (freshness result)
      done: false,
      intruded: null,
      sentHeard: '',
      wrong: { onset: null, pitch: null, frames: 0, reported: false },
    };
    // An onset in the 30 ms before arming belongs to this event.
    for (const o of onsets) if (o.t >= tArm - P.onsetBefore) onsetTo(evt, o.t);
    return evt;
  }

  // Arm event `index`; in lenient mode also listen ahead to the one after
  // it, so a player who has moved on (or a note in the tab nobody plays) does
  // not stall Wait mode.
  function arm(index) {
    const tArm = samplesIn / sr;
    const prev = ev;
    const ahead = evNext;
    ev = buildEvent(index, tArm);
    // Arming the event that was being listened ahead to, right after the
    // one before it was accepted: what was already heard of it stands (a
    // player often strikes it while the last one is still being confirmed),
    // when it stood on its own (aheadCounts) and was not the accepted
    // event's note too (that attack was the accepted event's). Such notes
    // may also still be found struck at an onset since then (see freshness).
    // Only attacks after the accepted event's own (tab is played in order),
    // and not of a note of the chord before that (its strum may still have
    // been going on).
    if (ev && ahead && prev && prev.done && ahead.index === index) {
      const after = (prev.from ?? -Infinity) + 0.03;
      const theirs = (m) => prev.expected.has(m) || (prev.before != null && prev.before.size >= 3 && prev.before.has(m));
      ev.earlyOnsets = ahead.onsets.filter((to) => to < tArm - P.onsetBefore && to > after);
      for (const cd of ev.cands) if ((cd.role === 'exp' || cd.role === 'opt') && !theirs(cd.midi)) cd.early = ahead.tArm;
      for (const cd0 of ahead.cands) {
        const m = cd0.midi;
        if (cd0.role !== 'exp' || theirs(m) || !aheadCounts(ahead, cd0)) continue;
        const at = ahead.heard.get(m);
        const a = ahead.attacks.get(m) ?? at;
        if (a <= after) continue;
        ev.heard.set(m, at);
        ev.attacks.set(m, a);
        ev.how.set(m, ahead.how.get(m));
        const cd = ev.cands.find((c) => c.midi === m);
        if (cd) cd.heardAt = at;
        if (ev.firstAttack == null || a < ev.firstAttack) ev.firstAttack = a;
      }
    }
    if (ev) ev.before = prev ? prev.expected : null;
    evNext = ev && strictness === 'lenient' && P.lookAhead ? buildEvent(index + 1, tArm) : null;
    if (evNext && (evNext.pitchless || evNext.xOnly || !evNext.required.length)) evNext = null;
  }

  function onsetTo(e, t) {
    e.onsets.push(t);
    if (e.onsets.length > 32) e.onsets.shift();
    if (e.firstOnset == null) e.firstOnset = t;
  }

  // ------------------------------------------------------------ per hop

  function levelStep(msgs) {
    // clip: samples at |x| ≥ clipLevel since the last level message (as the
    // worklet's meter counts them); more than clipCount in one hop is clipping.
    if (hopClip > P.clipCount) clipUntil = samplesIn / sr + 0.3;
    lvClip += hopClip;
    hopClip = 0;
    if (++lvHops >= levelEvery) {
      const rms = Math.sqrt(lvSum / Math.max(1, lvN));
      msgs.push({ type: 'level', rms, peak: lvPeak, clip: lvClip });
      lvSum = 0; lvN = 0; lvPeak = 0; lvClip = 0; lvHops = 0;
    }
  }

  function onsetStep(t) {
    for (let i = 0; i < onN; i++) onBuf[i] = ring[(wpos - onN + i + ringN * 4) & ringMask] * onWin[i];
    onFFT.run(onBuf, onRe, onIm, bandHi[nBands - 1] + 1);
    const lam = P.onsetLambda * onNorm;
    for (let b = 0; b < nBands; b++) {
      let e = 0;
      for (let k = bandLo[b]; k < bandHi[b]; k++) e += Math.sqrt(onRe[k] * onRe[k] + onIm[k] * onIm[k]);
      Lcur[b] = Math.log10(1 + lam * e);
    }
    let flux = 0;
    for (let b = 0; b < nBands; b++) {
      let m = Lprev[b];
      if (b > 0 && Lprev[b - 1] > m) m = Lprev[b - 1];
      if (b < nBands - 1 && Lprev[b + 1] > m) m = Lprev[b + 1];
      const d = Lcur[b] - m;
      if (d > 0) flux += d;
    }
    const tmp = Lprev; Lprev = Lcur; Lcur = tmp;
    if (frameNo < 2) flux = 0;

    // running statistics of the detection function
    fluxRun[fluxRunN % fluxRun.length] = flux;
    fluxRunN++;
    if (fluxRunN % 16 === 0 && fluxRunN >= 64) {
      const { med, mad } = medMad(fluxRun.subarray(0, Math.min(fluxRunN, fluxRun.length)));
      fluxThr = Math.max(P.onsetDelta0, med + P.onsetMadK * mad, calFluxThr);
    }
    if (calLeft > 0) calFlux.push(flux);

    const fi = frameNo % 16;
    fluxHist[fi] = flux;
    let isMax = true;
    for (let d = 1; d <= P.onsetW1; d++) if (fluxHist[(fi - d + 16) % 16] > flux) isMax = false;
    let mean = 0;
    for (let d = 0; d <= P.onsetW3; d++) mean += fluxHist[(fi - d + 16) % 16];
    mean /= P.onsetW3 + 1;
    if (
      isMax &&
      flux >= mean + fluxThr &&
      frameNo - lastOnsetFrame >= P.onsetW5 &&
      t - lastOnsetT >= P.onsetMinGap &&
      calLeft <= 0
    ) {
      lastOnsetFrame = frameNo;
      lastOnsetT = t;
      const o = { t, strength: flux };
      onsets.push(o);
      if (onsets.length > 16) onsets.shift();
      return o;
    }
    return null;
  }

  function spectrumStep(t) {
    if (dring) {
      const m = dwN - 1;
      for (let i = 0; i < dwN; i++) pBuf[i] = dring[(dpos + i) & m] * pWin[i];
    } else for (let i = 0; i < pwN; i++) pBuf[i] = ring[(wpos - pwN + i + ringN * 4) & ringMask] * pWin[i];
    pFFT.run(pBuf, pRe, pIm, kMax);
    for (let k = 0; k <= kMax; k++) X[k] = Math.sqrt(pRe[k] * pRe[k] + pIm[k] * pIm[k]) * pNorm;
    frameRms = Math.sqrt(Math.max(0, ringSq) / ringN);

    // minimum statistics on the smoothed magnitude spectrum
    for (let k = 0; k <= kMax; k++) {
      const v = psmStarted ? P.noiseSmooth * psm[k] + (1 - P.noiseSmooth) * X[k] : X[k];
      psm[k] = v;
      if (v < subMin[k]) subMin[k] = v;
    }
    psmStarted = true;
    if (frameRms < rmsSub) rmsSub = frameRms;
    if (++subCount >= V) {
      const base = subSlot * (kMax + 1);
      for (let k = 0; k <= kMax; k++) mins[base + k] = subMin[k];
      rmsMins[subSlot] = rmsSub;
      subSlot = (subSlot + 1) % U;
      subCount = 0;
      subMin.fill(Infinity);
      rmsSub = Infinity;
      for (let k = 0; k <= kMax; k++) {
        let m = Infinity;
        for (let u = 0; u < U; u++) { const v = mins[u * (kMax + 1) + k]; if (v < m) m = v; }
        minAll[k] = m;
      }
    }
    // The tracked floor falls at once but rises only slowly after the first
    // seconds: a room gets noisier gradually, while a note that rings for
    // seconds must not become "noise" and be subtracted from itself.
    const warm = frameNo * frameDt < P.noiseWarmup;
    for (let k = 0; k <= kMax; k++) {
      const m = Math.min(minAll[k], subMin[k]);
      let tr = P.noiseBias * (Number.isFinite(m) ? m : 0);
      if (!warm && tr > track[k] * riseStep) tr = track[k] * riseStep;
      track[k] = tr;
      noise[k] = haveCal ? Math.max(calNoise[k], 0.5 * tr) : tr;
    }
    let rm = rmsSub;
    for (let u = 0; u < U; u++) if (rmsMins[u] < rm) rm = rmsMins[u];
    let rt = Number.isFinite(rm) ? rm : 0;
    if (!warm && rt > rmsTrack * riseStep) rt = rmsTrack * riseStep;
    rmsTrack = rt;
    rmsFloor = Math.max(1e-5, calRms, rt);

    if (calLeft > 0) {
      for (let k = 0; k <= kMax; k++) calSum[k] += X[k];
      calRmsSum += frameRms;
      calFrames++;
    }

    salienceOn(X, rx, eCur);
    if (++rnAge >= 8) { salienceOn(noise, rn, eNoise); rnAge = 0; }
    const hf = histIdx(frameNo);
    histT[hf] = t;
    for (let i = 0; i < NM; i++) rxHist[i * HL + hf] = 20 * Math.log10(rx[i] + 1e-10);
    // prominence of each partial window over the local floor of the raw
    // spectrum: a broadband burst lifts both, so only a partial's own attack
    // makes it rise
    for (let i = 0; i < fbLo.length; i++) {
      fxVal[i] = percentile(X, fbLo[i], fbHi[i], P.floorPercentile);
      fxHist[i * HL + hf] = 20 * Math.log10(fxVal[i] + 1e-10);
    }
    for (let e = 0; e < eCur.length; e++) eHist[e * HL + hf] = 20 * Math.log10(eCur[e] + 1e-10);
  }

  function finishCalibration(msgs) {
    if (calFrames > 0) {
      for (let k = 0; k <= kMax; k++) calNoise[k] = calSum[k] / calFrames;
      calRms = calRmsSum / calFrames;
      haveCal = true;
      const { med, mad } = medMad(calFlux);
      calFluxThr = med + P.onsetMadK * mad;
      fluxThr = Math.max(fluxThr, calFluxThr, P.onsetDelta0);
      rnAge = 1e9;
    }
    msgs.push({ type: 'calib', noiseDb: 20 * Math.log10(Math.max(1e-7, calRms)) });
    calSum.fill(0);
    calFrames = 0;
    calRmsSum = 0;
    calFlux.length = 0;
  }

  // Whitened, noise-subtracted spectrum, its local floor and its peaks.
  function analyseSpectrum() {
    const sub = P.subtract;
    for (let k = 0; k <= kMax; k++) {
      const s = X[k] - sub * noise[k];
      S[k] = s > 0 ? s : 0;
    }
    wbPow.fill(0);
    for (let k = kLo; k <= kMax; k++) {
      const b = wbLow[k];
      const fr = wbFrac[k];
      const s2 = S[k] * S[k];
      wbPow[b] += s2 * (1 - fr);
      wbPow[b + 1] += s2 * fr;
    }
    let smax = 0;
    for (let b = 0; b < nWb; b++) {
      const s = wbWsum[b] > 0 ? Math.sqrt(wbPow[b] / wbWsum[b]) : 0;
      wbPow[b] = s;
      if (s > smax) smax = s;
    }
    const sfl = Math.max(1e-12, P.whitenFloor * smax);
    const e = P.whitenNu - 1;
    for (let b = 0; b < nWb; b++) wbGam[b] = Math.max(wbPow[b], sfl) ** e;
    for (let k = 0; k <= kMax; k++) {
      if (k < kLo) { Y[k] = 0; continue; }
      const b = wbLow[k];
      const fr = wbFrac[k];
      Y[k] = S[k] * (wbGam[b] * (1 - fr) + wbGam[b + 1] * fr);
    }
    // local floor: a low percentile per third-octave, interpolated
    for (let i = 0; i < fbLo.length; i++) fbVal[i] = percentile(Y, fbLo[i], fbHi[i], P.floorPercentile);
    let fi = 0;
    for (let k = 0; k <= kMax; k++) {
      while (fi < fbCen.length - 1 && fbCen[fi + 1] <= k) fi++;
      if (k <= fbCen[0]) F[k] = fbVal[0];
      else if (fi >= fbCen.length - 1) F[k] = fbVal[fbCen.length - 1];
      else {
        const u = (k - fbCen[fi]) / (fbCen[fi + 1] - fbCen[fi]);
        F[k] = fbVal[fi] * (1 - u) + fbVal[fi + 1] * u;
      }
      // Subtraction zeroes most noise bins, which would sink a percentile
      // floor to nothing and let every leftover noise peak pass for a
      // partial: the floor is never below the noise itself, whitened.
      if (k >= kLo) {
        const b = wbLow[k];
        const fr = wbFrac[k];
        const nz = P.floorNoise * noise[k] * (wbGam[b] * (1 - fr) + wbGam[b + 1] * fr);
        if (nz > F[k]) F[k] = nz;
      }
    }
    // peaks, log-parabolic interpolation
    npk = 0;
    maxPeak = 0;
    const fk = P.floorK;
    for (let k = kLo + 1; k < kMax - 1 && npk < maxPeaks; k++) {
      const yk = Y[k];
      if (yk <= 1e-12 || yk <= Y[k - 1] || yk < Y[k + 1]) continue;
      const net = yk - fk * F[k];
      if (net <= 0) continue;
      const a = Math.log(Y[k - 1] + 1e-12);
      const b = Math.log(yk + 1e-12);
      const c = Math.log(Y[k + 1] + 1e-12);
      const den = a - 2 * b + c;
      let p = den < 0 ? (0.5 * (a - c)) / den : 0;
      if (p > 0.5) p = 0.5; else if (p < -0.5) p = -0.5;
      const mag = Math.exp(b - 0.25 * (a - c) * p);
      pkF[npk] = (k + p) * bw;
      pkM[npk] = Math.max(0, mag - fk * F[k]);
      if (pkM[npk] > maxPeak) maxPeak = pkM[npk];
      npk++;
    }
  }

  // largest peak with frequency in [lo, hi], starting the search at pointer p
  function peakIn(lo, hi) {
    let a = 0;
    let b = npk;
    while (a < b) { const m = (a + b) >> 1; if (pkF[m] < lo) a = m + 1; else b = m; }
    let mx = 0;
    for (let q = a; q < npk && pkF[q] <= hi; q++) if (pkM[q] > mx) mx = pkM[q];
    return mx;
  }

  function analyseEvent(e, t) {
    const { J, nRows, o, b, c, G, cands } = e;
    o.fill(0);
    const rc = e.rowC;
    let r = 0;
    for (let q = 0; q < npk; q++) {
      const f = pkF[q];
      while (r < nRows - 1 && rc[r + 1] <= f) r++;
      // nearest centre (in log frequency) among r and r + 1
      let best = r;
      if (r < nRows - 1 && f > rc[r] && rc[r + 1] / f < f / rc[r]) best = r + 1;
      if (f >= e.rowLo[best] && f <= e.rowHi[best]) { if (pkM[q] > o[best]) o[best] = pkM[q]; continue; }
      const other = best === r ? r + 1 : r;
      if (other < nRows && f >= e.rowLo[other] && f <= e.rowHi[other] && pkM[q] > o[other]) o[other] = pkM[q];
    }
    let oo = 0;
    for (let i = 0; i < nRows; i++) oo += o[i] * o[i];
    for (let j = 0; j < J; j++) {
      const cd = cands[j];
      let s = 0;
      for (let q = 0; q < cd.rows.length; q++) s += cd.w[q] * o[cd.rows[q]];
      b[j] = s;
    }
    if (oo <= 0) {
      for (const cd of cands) { cd.present = false; cd.cf = 0; cd.share = 0; cd.dres = 0; }
      c.fill(0);
      return;
    }
    // a distractor's cost scales with the energy in its own partial windows
    for (let j = 0; j < J; j++) {
      if (!e.pen[j]) { e.lam[j] = 0; continue; }
      const cd = cands[j];
      let s2 = 0;
      for (let q = 0; q < cd.rows.length; q++) s2 += o[cd.rows[q]] * o[cd.rows[q]];
      e.lam[j] = e.pen[j] * Math.sqrt(s2);
    }
    nnls(G, b, c, J, P.nnlsIters, -1, e.lam);
    const res = residual(G, b, c, J, oo, e.lam);
    let maxc = 0;
    for (let j = 0; j < J; j++) if (c[j] > maxc) maxc = c[j];
    const snrLin = 10 ** (P.snrDb / 20);
    for (let j = 0; j < J; j++) {
      const cd = cands[j];
      cd.cf = c[j];
      cd.share = maxc > 0 ? c[j] / maxc : 0;
      // salience over the noise's, and over the local floor's
      let rxv = rx[cd.mi];
      let rnv = rn[cd.mi];
      if (cd.bend) for (let d = 1; d <= Math.ceil(cd.bendTop); d++) { const q = Math.min(NM - 1, cd.mi + d); if (rx[q] > rxv) { rxv = rx[q]; rnv = rn[q]; } }
      cd.snr = rnv > 0 ? rxv / rnv : Infinity;
      let ps = 0;
      let fs = 0;
      for (let q = 0; q < cd.rows.length; q++) ps += cd.w[q] * o[cd.rows[q]];
      for (let q = 0; q < cd.entries.length; q++) fs += cd.entries[q].g * F[cd.floorBins[q]];
      cd.tonal = fs > 0 ? ps / fs : Infinity;
      cd.dres = 0;
      const needs = cd.role === 'exp' || cd.role === 'opt' || (cd.neighbour && strictness === 'strict') || (cd.role === 'oct' && strictness === 'bass');
      if (needs && cd.share >= P.shareMin && cd.snr >= snrLin && cd.tonal >= P.tonalK) {
        const c2 = e.c2;
        c2.set(c);
        c2[j] = 0;
        nnls(G, b, c2, J, P.looIters, j, e.lam);
        cd.dres = (residual(G, b, c2, J, oo, e.lam) - res) / oo;
      }
      const fit = cd.share >= P.shareMin && cd.dres >= P.residualMin;
      // Support: the note's own partials are there as peaks well over the
      // local floor. Notes an octave or a fifth apart share partials, so in a
      // chord the fit alone cannot tell E3 from E2 + E4; support can, and the
      // partials only this note has must be there too.
      supportOf(cd, o);
      const distractor = cd.role === 'near' || cd.role === 'oct' || cd.neighbour;
      const supMin = distractor ? P.supportIntruder : strictness === 'strict' ? P.supportStrict : P.supportMin;
      const sup = cd.support >= supMin;
      cd.present = needs && cd.snr >= snrLin && cd.tonal >= P.tonalK && cd.uniqueSupport >= P.uniqueMin && (distractor ? fit && sup : sup || (fit && cd.support >= P.supportFit));
    }
    // A note a semitone away (not expected) that has its partials about as
    // well: the evidence is not this note's.
    if (P.neighbourMargin > 0) {
      for (const cd of cands) {
        if (!cd.present || (cd.role !== 'exp' && cd.role !== 'opt')) continue;
        for (const nb of cands) {
          if (Math.abs(nb.midi - cd.midi) !== 1 || nb.role === 'exp' || nb.role === 'opt') continue;
          if (nb.support > cd.support - P.neighbourMargin) { cd.present = false; break; }
        }
      }
    }
    // An octave apart from a distractor (or last event's note) that sounds too?
    // Below: the note must add energy on that note's even partials. Above: the
    // note's own odd partials must be there, or it is only the octave above.
    for (const cd of cands) {
      cd.octave = null;
      if (!cd.present) continue;
      // In a chord the other notes supply the lower octave's odd partials (a
      // major triad is the harmonic series of the root an octave down), so
      // there it is asked only when the fit gives that octave real weight.
      // And only an octave below that was itself just struck vetoes the
      // note: in a real piece other notes (a pedal bass two octaves down, a
      // ringing note a few cents off) fill its odd partials all the time.
      if (cd.below != null && (e.pitchedCount <= 2 || cands[cd.below].cf >= P.octaveTrigger * cd.cf)) {
        const q = cands[cd.below];
        cd.octave = evenExcess(q);
        if (cd.octave < P.octaveExcess && oddAttack(q, e, t)) cd.present = false;
      }
      if (cd.present && cd.above != null && cd.entries.length >= 4) {
        const r = evenExcess(cd);
        if (r > P.octaveUpMax) { cd.octave = r; cd.present = false; }
      }
    }
  }

  function supportOf(cd, o) {
    if (cd.bendSubs) {
      // a bend sits at one pitch at a time: the best of its quarter-tone steps
      let best = 0;
      let bestU = 1;
      for (const sub of cd.bendSubs) {
        supportOf(sub, o);
        if (sub.support > best) { best = sub.support; bestU = sub.uniqueSupport; }
      }
      cd.support = best;
      cd.uniqueSupport = bestU;
      return;
    }
    const n = Math.min(P.supportHarmonics, cd.entries.length);
    // in clean input the floor is mere window leakage; a partial must also
    // be within reach of the frame's strongest one (whitened, so −26 dB is lenient)
    const relMin = P.supportRel * maxPeak;
    let wAll = 0, wOk = 0, wU = 0, wUok = 0;
    for (let q = 0; q < n; q++) {
      const en = cd.entries[q];
      const g = en.g;
      const v = peakIn(en.lo, en.hi);
      const ok = v > 0 && v >= P.supportK * F[cd.floorBins[q]] && v >= relMin;
      wAll += g;
      if (ok) wOk += g;
      if (cd.unique[q]) { wU += g; if (ok) wUok += g; }
    }
    cd.support = wAll > 0 ? wOk / wAll : 0;
    cd.uniqueSupport = wU >= P.uniqueShare * wAll ? wUok / wU : 1;
  }

  // Was this (lower-octave) note itself struck at the latest onset? Its odd
  // partials — the ones the octave above does not have — that no sounding
  // note shares and that stand clear afterwards: half of them rose by 6 dB.
  // No maturity wait: the veto it gates has to work from the first frames.
  function oddAttack(q, e, t) {
    const to = e.onsets[e.onsets.length - 1];
    if (to == null || t - to > P.noteWithin) return false;
    const e0 = gStart[q.mi];
    const n = Math.min(gStart[q.mi + 1] - e0, 8);
    let top = -Infinity;
    for (let h = 0; h < n; h++) top = Math.max(top, histMax(-1, to, t, e0 + h));
    let asked = 0;
    let rose = 0;
    for (let h = 0; h < n; h += 2) {
      if (!q.ownH[h]) continue;
      const hi = histMax(-1, to, t, e0 + h);
      if (hi < top - 30) continue;
      asked++;
      if (hi - partialMin(e0 + h, to - 0.1, to - 0.02) >= 6) rose++;
    }
    return asked > 0 && rose / asked >= 0.5;
  }

  // Lowest level (dB) of one partial window over frames in [t0, t1].
  function partialMin(en, t0, t1) {
    let v = Infinity;
    for (let d = 0; d < HL; d++) {
      const f = histIdx(frameNo - d);
      const tt = histT[f];
      if (tt > t1) continue;
      if (tt < t0) break;
      const x = eHist[en * HL + f];
      if (x < v) v = x;
    }
    return v;
  }

  // Σ of a note's even partials over Σ max(odd neighbours), on the peak spectrum.
  function evenExcess(q) {
    const en = q.entries;
    let ev = 0;
    let od = 0;
    for (let h = 2; h < en.length; h += 2) {
      ev += peakIn(en[h - 1].lo, en[h - 1].hi);
      od += Math.max(peakIn(en[h - 2].lo, en[h - 2].hi), peakIn(en[h].lo, en[h].hi));
    }
    return od > 0 ? ev / od : Infinity;
  }

  // Did the note's own partials rise? Share of its partials that rose by at
  // least db from their lowest in [r0, r1] to their highest in [p0, p1],
  // counted per partial (each alike: one partial colliding with another
  // note's must not decide), so another note's attack on the few partials it
  // shares with a ringing note does not make that note look new. Which
  // partials are asked, in order:
  //   own      odd partials no other sounding note has within 50 cents (up
  //            to its 24th) and that stand clear, if at least two carrying
  //            10 % of the note's weight — or all such, odd and even (below);
  //   ringing  odd partials that already stood clear before (the note was
  //            sounding: evens are also its octave's partials, whose attack is
  //            not its own), if at least two carrying 20 %;
  //   else     the partials that stand clear afterwards, if 30 %.
  // Partials that were sounding are judged only in frames from pLate on: a
  // frame whose window starts before a loud new note's attack splatters that
  // note over its neighbours' windows. "Clear" is promDb over the local floor
  // and within 40 dB of the note's strongest partial (in clean input the
  // floor is only leakage). Too little to go on returns 0.
  const rsLo = new Float64Array(64);
  const rsLoF = new Int32Array(64);
  const rsHi = new Float64Array(64);
  const rsHiF = new Int32Array(64);
  const rsLate = new Float64Array(64);
  let rsWhy = ''; // which partials the last riseShare asked: 'own', 'ringing', 'new'
  let rsUp = 0; // …and how many of them rose (of 'own': odd ones)
  let rsOdd = -1; // share of the odd own partials that rose (-1: too few)
  const rsOwnUp = new Int8Array(64); // per own partial: rose (1) or not (0); -1 not own
  // Could the rise be another note's, struck an octave or an octave and a
  // fifth above (or a fifth: every third of its partials), whose partials
  // are every k-th of this one's? Then those that are not every k-th must
  // have risen too, for k = 2, 3.
  function notAnInterval() {
    for (let k = 2; k <= 3; k++) {
      let n = 0;
      let u = 0;
      for (let q = 0; q < 64; q++) {
        if (rsOwnUp[q] < 0 || (q + 1) % k === 0) continue;
        n++;
        u += rsOwnUp[q];
      }
      if (n && u < Math.max(1, P.oddRiseShare * n)) return false;
    }
    return true;
  }
  const rsRise = new Float64Array(64); // per own partial: its rise (dB)
  function clearlyOff(k) {
    for (let q = 0; q < 64; q++) if (rsOwnUp[q] >= 0 && (q + 1) % k && rsRise[q] >= P.riseAloneDb) return true;
    return false;
  }
  function riseShare(mi, nh, r0, r1, p0, p1, db, pLate = p0, own = null, promDb = P.prominentDb) {
    const e0 = gStart[mi];
    const e1 = Math.min(gStart[mi + 1], e0 + nh, e0 + 64);
    const tMin = Math.min(r0, p0);
    const last = fbLo.length - 1;
    let maxLo = -Infinity;
    let maxHi = -Infinity;
    for (let e = e0; e < e1; e++) {
      let lo = Infinity, loF = 0, hi = -Infinity, hiF = 0, late = -Infinity;
      const base = e * HL;
      for (let d = 0; d < HL; d++) {
        const f = histIdx(frameNo - d);
        const tt = histT[f];
        if (tt < tMin) break;
        const v = eHist[base + f];
        if (tt >= r0 && tt <= r1 && v < lo) { lo = v; loF = f; }
        if (tt >= p0 && tt <= p1 && v > hi) { hi = v; hiF = f; }
        if (tt >= pLate && tt <= p1 && v > late) late = v;
      }
      const q = e - e0;
      rsLo[q] = lo; rsLoF[q] = loF; rsHi[q] = hi; rsHiF[q] = hiF; rsLate[q] = late;
      if (lo !== Infinity && lo > maxLo) maxLo = lo;
      if (hi > maxHi) maxHi = hi;
    }
    let wAll = 0, gOwn = 0, nOwn = 0, upOwn = 0, gOdd = 0, nOdd = 0, upOdd = 0, gPre = 0, nPre = 0, upPre = 0, gPost = 0, nPost = 0, upPost = 0;
    rsOwnUp.fill(-1);
    for (let e = e0; e < e1; e++) {
      const q = e - e0;
      const g = gW[e];
      wAll += g;
      const lo = rsLo[q], hi = rsHi[q], late = rsLate[q];
      if (lo === Infinity || hi === -Infinity) continue;
      const b = eFb[e];
      const u = eFu[e];
      const b1 = Math.min(b + 1, last);
      const floorAt = (f) => fxHist[b * HL + f] * (1 - u) + fxHist[b1 * HL + f] * u;
      const preClear = lo - floorAt(rsLoF[q]) >= P.ringingDb && lo >= maxLo - 40;
      const postClear = hi - floorAt(rsHiF[q]) >= promDb && hi >= maxHi - 40;
      const up = late - lo >= db ? 1 : 0;
      if (q % 2 === 0 && preClear) { gPre += g; nPre++; upPre += up; }
      if (own && own[q] && (preClear || (late - floorAt(rsHiF[q]) >= promDb && late >= maxHi - 40))) {
        gOwn += g; nOwn++; upOwn += up;
        rsOwnUp[q] = up;
        rsRise[q] = late - lo;
        if (q % 2 === 0) { gOdd += g; nOdd++; upOdd += up; }
      }
      if (postClear) { gPost += g; nPost++; if (hi - lo >= db) upPost++; }
    }
    // A re-pluck of a ringing note shows mostly on its upper partials (the
    // fundamental of a low string has hardly decayed), even ones too; but
    // the octave above, struck, raises only the evens: so all own partials
    // count once some of the odd ones rose as well.
    // (A higher bar, allShare: a fifth above, struck, raises every third.)
    let all = gOwn >= 0.1 * wAll && nOwn >= 2 && notAnInterval() ? upOwn / nOwn : 0;
    if (all < P.allShare) all = 0;
    // (only the odd ones may skip an event: see aheadSatisfied)
    // (less than half of the odd ones only if, for k = 2 and 3, one partial
    // that is not every k-th rose clearly: riseAloneDb)
    let odd = gOdd >= 0.1 * wAll && nOdd >= 2 ? upOdd / nOdd : -1;
    if (odd > 0 && odd < 0.5 && !(clearlyOff(2) && clearlyOff(3))) odd = 0;
    if (odd >= 0 || all) { rsWhy = 'own'; rsUp = upOdd; rsOdd = odd; return Math.max(odd, all); }
    if (gPre >= 0.2 * wAll && nPre >= 2) { rsWhy = 'ringing'; rsUp = upPre; return upPre / nPre; }
    rsWhy = 'new';
    rsUp = upPost;
    return gPost > 0 && gPost >= 0.3 * wAll ? upPost / nPost : 0;
  }

  // Was the note attacked after arming? Returns a description or null.
  function freshness(cd, t, e) {
    const mi = cd.mi;
    const nh = cd.harm ? 3 : 99;
    const w0 = e.tArm - P.onsetBefore;
    // with a broadband onset
    for (let i = e.onsets.length - 1; i >= 0; i--) {
      const to = e.onsets[i];
      if (t - to > P.noteWithin) break;
      if (t < to + P.matureAfter) continue; // the frame must hold enough of the note
      const ref = histMin(mi, to - 0.1, to - 0.02);
      if (!Number.isFinite(ref.v) || ref.at < e.tArm - P.riseBefore) continue;
      const sh = riseShare(mi, nh, to - 0.1, to - 0.02, to - 0.03, Math.min(t, to + 0.15), P.riseOnsetDb, to + P.cleanAfter, cd.ownH);
      if (sh >= P.freshShare) return { how: 'onset', at: to, share: sh, why: rsWhy, up: rsUp, odd: rsWhy === 'own' ? rsOdd : -1 };
    }
    // …or at one heard while listening ahead, before this event was armed
    // (see arm): then only as the look-ahead counts a note, on its own
    // partials — the last event's notes were struck at those onsets too.
    if (cd.early != null) {
      for (let i = e.earlyOnsets.length - 1; i >= 0; i--) {
        const to = e.earlyOnsets[i];
        if (t - to > P.noteWithin) break;
        if (t < to + P.matureAfter) continue;
        const ref = histMin(mi, to - 0.1, to - 0.02);
        if (!Number.isFinite(ref.v) || ref.at < cd.early - P.riseBefore) continue;
        const sh = riseShare(mi, nh, to - 0.1, to - 0.02, to - 0.03, Math.min(t, to + 0.15), P.riseOnsetDb, to + P.cleanAfter, cd.ownH);
        if (rsWhy === 'own' && rsUp >= 2 && rsOdd >= 0.75) return { how: 'onset', at: to, share: sh, why: rsWhy, up: rsUp, odd: rsOdd };
      }
    }
    // a rise alone (hammer-ons, slides, onsets the detector missed)
    const t0 = Math.max(w0, t - 0.3);
    const ref = histMin(mi, t0, t - 0.03);
    if (!Number.isFinite(ref.v)) return null;
    if (t0 === w0) {
      // …that did not start before arming
      const before = histMin(mi, w0 - 0.1, w0).v;
      if (Number.isFinite(before) && histAt(mi, w0) - before > 1.5) return null;
    }
    if (t < ref.at + P.matureAfter) return null;
    // A rise around a detected onset is the onset path's to judge (above);
    // this path is for rises with none: hammer-ons, slides, missed onsets.
    for (const o of onsets) if (o.t >= t0 - 0.03 && o.t <= t) return null;
    // (without an onset, only partials standing well clear count: a noisy
    // room makes weak windows wander by several dB)
    const share = (db) => riseShare(mi, nh, t0, t - 0.03, t - 0.02, t, db, t - 0.02, cd.ownH, P.clearDb) >= P.freshShare;
    if (cd.legato && share(P.legatoRiseDb)) {
      if (cd.from == null) return { how: 'legato', at: ref.at };
      const fall = histMax(cd.from, t0, t - 0.03) - rxHist[cd.from * HL + histIdx(frameNo)];
      if (fall >= P.legatoFallDb) return { how: 'legato', at: ref.at };
    }
    if (cd.slide && share(P.slideRiseDb)) return { how: 'slide', at: ref.at };
    if (share(P.riseAloneDb)) return { how: 'rise', at: ref.at };
    return null;
  }

  function heardList(e) {
    return [...e.heard.keys()].sort((a, b) => a - b);
  }

  function isHeardFor(n, bassLowest, e) {
    if (e.heard.has(n.midi)) return true;
    if (strictness === 'bass' && !bassLowest) {
      for (const m of e.heard.keys()) if (((m - n.midi) % 12 + 12) % 12 === 0) return true;
    }
    return false;
  }

  function satisfied(t, e) {
    const req = e.required;
    if (e.hasX && e.firstOnset == null) return false;
    if (!req.length) return e.heard.size > 0 || e.firstOnset != null;
    if (strictness === 'strict') {
      if (!req.every((n) => e.heard.has(n.midi))) return false;
      // an unexpected neighbour louder than the quietest required note blocks
      let minC = Infinity;
      for (const cd of e.cands) if (cd.role === 'exp') minC = Math.min(minC, cd.cf);
      if (!Number.isFinite(minC)) minC = 0;
      for (const cd of e.cands) {
        if (!cd.neighbour || !cd.held || cd.cf <= minC) continue;
        if (freshness(cd, t, e)) e.intruded = t;
      }
      // …and keeps blocking until the next strum
      const lastOnset = e.onsets[e.onsets.length - 1] ?? -Infinity;
      return !(e.intruded != null && e.intruded >= lastOnset);
    }
    if (strictness === 'bass') {
      let lowest = req[0];
      for (const n of req) if (n.midi < lowest.midi) lowest = n;
      if (!e.heard.has(lowest.midi)) return false;
      return req.every((n) => n === lowest || isHeardFor(n, false, e));
    }
    const need = req.length <= 2 ? req.length : req.length - 1;
    let got = 0;
    for (const n of req) if (e.heard.has(n.midi)) got++;
    return got >= need;
  }

  function accept(t, msgs, e, skipped = null) {
    e.done = true;
    // latency from the attack that completed the event: the earliest attack
    // among the notes heard in the last 300 ms (a strum's first string, an
    // arpeggio's last note), not a wrong note played before it
    let from = Infinity;
    for (const [m, at] of e.heard) if (at >= t - 0.3) from = Math.min(from, e.attacks.get(m) ?? at);
    if (!Number.isFinite(from)) from = e.firstOnset ?? e.firstAttack ?? t;
    e.from = from;
    const m = { type: 'accept', index: e.index, t, heard: heardList(e), latencyMs: Math.round((t - from) * 1000) };
    if (skipped) m.skipped = skipped;
    msgs.push(m);
    driftUpdate(msgs, e);
  }

  function driftUpdate(msgs, e) {
    let sum = 0;
    let wsum = 0;
    for (const cd of e.cands) {
      if (cd.role !== 'exp' || !e.heard.has(cd.midi) || cd.bend || cd.slide || cd.share < 0.5 || cd.snr < 10) continue;
      let dev = 0;
      let wt = 0;
      for (let q = 0; q < cd.entries.length && q < 4; q++) {
        const en = cd.entries[q];
        if (en.f > 1500) break;
        let a = 0;
        let bb = npk;
        while (a < bb) { const m = (a + bb) >> 1; if (pkF[m] < en.lo) a = m + 1; else bb = m; }
        let best = -1;
        for (let k = a; k < npk && pkF[k] <= en.hi; k++) if (best < 0 || pkM[k] > pkM[best]) best = k;
        if (best < 0 || pkM[best] <= 0) continue;
        const cents = 1200 * Math.log2(pkF[best] / en.f);
        if (Math.abs(cents) > P.driftTol) continue;
        dev += cents * pkM[best];
        wt += pkM[best];
      }
      if (wt > 0) { sum += dev / wt; wsum++; }
    }
    if (!wsum) return;
    const d = sum / wsum;
    drift = Math.max(-P.driftClamp, Math.min(P.driftClamp, drift + P.driftAlpha * (d - drift)));
    if (Math.abs(drift - driftSent) > P.driftStep) {
      driftSent = drift;
      msgs.push({ type: 'drift', cents: Math.round(drift * 10) / 10 });
    }
  }

  // Wrong notes: nothing required turned up after an onset, so name the
  // dominant pitch the player did play.
  const wrongCols = [];
  function scanWrong(t, msgs) {
    const e = ev;
    const w = e.wrong;
    const to = e.onsets[e.onsets.length - 1];
    if (to == null || t < to + P.wrongAfter || t > to + 0.8) return;
    if (w.onset !== to) { w.onset = to; w.pitch = null; w.frames = 0; w.reported = false; }
    if (w.reported) return;
    for (const cd of e.cands) if ((cd.role === 'exp') && (cd.held || (cd.heardAt != null && cd.heardAt >= to))) return;
    // salience of every note from E2 to E6 on the peak spectrum
    const lo = Math.max(M_LO, 40) - M_LO;
    const hi = Math.min(M_HI, 88) - M_LO;
    const sal = new Float64Array(hi - lo + 1);
    for (let i = lo; i <= hi; i++) {
      let s = 0;
      for (let en = gStart[i]; en < gStart[i + 1]; en++) s += gW[en] * peakIn(gLo[en], gHi[en]);
      sal[i - lo] = s;
    }
    wrongCols.length = 0;
    for (let i = 0; i < sal.length; i++) {
      if (sal[i] <= 0) continue;
      if ((i > 0 && sal[i - 1] > sal[i]) || (i < sal.length - 1 && sal[i + 1] > sal[i])) continue;
      wrongCols.push(i + lo);
    }
    wrongCols.sort((a, b) => sal[b - lo] - sal[a - lo]);
    wrongCols.length = Math.min(wrongCols.length, P.wrongTop);
    const Jw = wrongCols.length;
    if (!Jw) return;
    // small NNLS over the top peaks
    const ent = [];
    wrongCols.forEach((mi, j) => {
      for (let en = gStart[mi]; en < gStart[mi + 1]; en++) ent.push({ lo: gLo[en], hi: gHi[en], g: gW[en], j });
    });
    ent.sort((a, b) => a.lo - b.lo);
    const rows = [];
    for (const en of ent) {
      const r = rows[rows.length - 1];
      if (r && en.lo <= r.hi) { r.hi = Math.max(r.hi, en.hi); r.w[en.j] += en.g; } else { const nw = new Float64Array(Jw); nw[en.j] = en.g; rows.push({ lo: en.lo, hi: en.hi, w: nw }); }
    }
    const Gw = new Float64Array(Jw * Jw);
    const bw2 = new Float64Array(Jw);
    let oo = 0;
    for (const r of rows) {
      const ov = peakIn(r.lo, r.hi);
      oo += ov * ov;
      for (let j = 0; j < Jw; j++) {
        if (!r.w[j]) continue;
        bw2[j] += r.w[j] * ov;
        for (let k = 0; k < Jw; k++) Gw[j * Jw + k] += r.w[j] * r.w[k];
      }
    }
    const cw = new Float64Array(Jw);
    nnls(Gw, bw2, cw, Jw, P.nnlsIters);
    let best = 0;
    for (let j = 0; j < Jw; j++) if (cw[j] > cw[best]) best = j;
    // A note's upper partials look like notes an octave, a twelfth, two
    // octaves… above it: prefer the fundamental below the winner, and do not
    // let its own overtone notes count against its dominance.
    const above = [12, 19, 24, 28, 31, 34, 36];
    for (let j = 0; j < Jw; j++) {
      if (cw[j] >= 0.3 * cw[best] && above.includes(wrongCols[best] - wrongCols[j])) best = j;
    }
    let sum = 0;
    for (let j = 0; j < Jw; j++) if (!above.includes(wrongCols[j] - wrongCols[best])) sum += cw[j];
    const mi = wrongCols[best];
    const midi = mi + M_LO;
    const ok = sum > 0 && cw[best] / sum >= P.wrongDominance && !e.expected.has(midi) && !(evNext && evNext.expected.has(midi)) && rn[mi] >= 0 && rx[mi] >= rn[mi] * 10 ** (P.wrongSnrDb / 20);
    if (!ok) { w.pitch = null; w.frames = 0; return; }
    if (w.pitch === midi) w.frames++; else { w.pitch = midi; w.frames = 1; }
    if (w.frames >= P.wrongFrames && t - lastWrongT >= P.wrongEvery && t > clipUntil) {
      w.reported = true;
      lastWrongT = t;
      msgs.push({ type: 'wrong', index: e.index, heard: [midi], expected: [...e.expected].sort((a, b) => a - b), t });
    }
  }

  function eventStep(t, onset, msgs) {
    const e = ev;
    if (onset && onset.t >= e.tArm - P.onsetBefore) {
      onsetTo(e, onset.t);
      if (evNext) onsetTo(evNext, onset.t);
    }
    if (e.pitchless) {
      if (e.firstOnset != null) accept(t, msgs, e);
      return;
    }
    if (e.xOnly) {
      // A muted strum: an onset that left no pitched note behind it. 150 ms
      // on, a note the onset started still stands within 20 dB of how loud
      // the attack was and 10 dB over what was there before; a thunk is gone.
      const to = e.onsets[e.onsets.length - 1];
      if (to != null && t >= to + 0.15) {
        let rose = false;
        const lo = Math.max(M_LO, 40) - M_LO;
        const hi = Math.min(M_HI, 88) - M_LO;
        let attack = -Infinity;
        for (let i = lo; i <= hi; i++) attack = Math.max(attack, histMax(i, to, to + 0.08));
        for (let i = lo; i <= hi && !rose; i++) {
          const ref = histMin(i, to - 0.1, to - 0.02).v;
          const now = rxHist[i * HL + histIdx(frameNo)];
          if (Number.isFinite(ref) && now - ref >= 10 && now >= attack - 20 && rx[i] >= rn[i] * 10) rose = true;
        }
        if (!rose) accept(t, msgs, e);
        else e.onsets.length = 0;
      }
      return;
    }
    // Pitch work only when something stands out of the noise: the frame is
    // 6 dB over the RMS floor, or some bin is 12 dB over the noise spectrum
    // (a note ringing on in a noisy room can be quieter than the room in RMS
    // and still clear as a line).
    let loud = frameRms >= rmsFloor * 2;
    if (!loud) for (let k = kLo; k <= kMax; k++) if (X[k] > P.lineOverNoise * noise[k] + 1e-9) { loud = true; break; }
    if (loud) {
      analyseSpectrum();
      analyseEvent(e, t);
      if (evNext) analyseEvent(evNext, t);
    } else {
      npk = 0;
      for (const cd of e.cands) cd.present = false;
      if (evNext) for (const cd of evNext.cands) cd.present = false;
    }
    // Right after an onset the frame holds only a sliver of the new note, too
    // little to tell a note from its octave: nothing counts as present yet.
    const early = onsets.length && t < onsets[onsets.length - 1].t + P.presentAfter;
    const grew = updateHeard(e, t, early);
    if (grew) {
      const list = heardList(e);
      const key = list.join(',');
      if (key !== e.sentHeard) {
        e.sentHeard = key;
        msgs.push({ type: 'heard', index: e.index, midi: list, t });
      }
    }
    const start = e.firstOnset ?? e.firstAttack;
    if (start != null && t >= start + P.collectMin && satisfied(t, e)) {
      accept(t, msgs, e);
      return;
    }
    if (evNext) {
      updateHeard(evNext, t, early);
      if (aheadSatisfied(t)) {
        e.done = true;
        accept(t, msgs, evNext, [e.index]);
        return;
      }
    }
    if (loud && e.firstOnset != null && npk > 0) scanWrong(t, msgs);
  }

  // Presence history, held notes, and which held notes are new (heard).
  function updateHeard(e, t, early) {
    if (early) for (const cd of e.cands) cd.present = false;
    const expire = mode === 'play' ? P.expirePlay : P.expireWait;
    for (const [m, at] of e.heard) if (t - at > expire) e.heard.delete(m);
    let grew = false;
    for (const cd of e.cands) {
      cd.bits = ((cd.bits << 1) | (cd.present ? 1 : 0)) & 7;
      const n = (cd.bits & 1) + ((cd.bits >> 1) & 1) + ((cd.bits >> 2) & 1);
      cd.held = n >= 2;
      if ((cd.role === 'exp' || cd.role === 'opt') && cd.held && !e.heard.has(cd.midi)) {
        const fr = freshness(cd, t, e);
        if (fr) {
          e.heard.set(cd.midi, t);
          e.attacks.set(cd.midi, fr.at);
          e.how.set(cd.midi, fr);
          cd.heardAt = t;
          if (e.firstAttack == null) e.firstAttack = fr.at;
          grew = true;
        }
      }
    }
    if (strictness === 'bass') {
      // octave substitutes count for their pitch class
      for (const cd of e.cands) {
        if (cd.role !== 'oct' || !cd.held || e.heard.has(cd.midi)) continue;
        const fr = freshness(cd, t, e);
        if (fr) { e.heard.set(cd.midi, t); e.attacks.set(cd.midi, fr.at); grew = true; }
      }
    }
    return grew;
  }

  // The event after the armed one is fully there, with attacks of its own:
  // the player has moved on. Not when its notes are all the armed event's
  // (a repeated chord must not jump ahead), and only on notes the armed
  // event does not have — at least one, and all of them for one or two.
  //
  // Those notes must stand on their own: struck at an onset (not a legato
  // rise), with partials of their own that the armed event's notes do not
  // also have — the next chord's notes are often overtones of this one's.
  function aheadSatisfied(t) {
    const a = evNext;
    const start = a.firstOnset ?? a.firstAttack;
    if (start == null || t < start + P.collectMin) return false;
    const own = a.cands.filter((cd) => cd.role === 'exp' && !ev.expected.has(cd.midi));
    if (!own.length) return false;
    let got = 0;
    // counted: struck at an onset and decided on its own partials, at least
    // two of them rising and three quarters of those asked
    let countable = 0;
    for (const cd of own) {
      if (cd.ownShare < P.uniqueShare) continue;
      countable++;
      if (aheadCounts(a, cd)) got++;
    }
    if (!got || got < countable - (countable >= 3 ? 1 : 0)) return false;
    return satisfied(t, a);
  }

  function aheadCounts(a, cd) {
    const fr = a.how.get(cd.midi);
    return cd.ownShare >= P.uniqueShare && a.heard.has(cd.midi) && fr && fr.how === 'onset' && fr.why === 'own' && fr.up >= 2 && fr.odd >= 0.75;
  }

  function tunerStep(t, msgs) {
    if (frameNo % tunerEvery) return;
    frameRms = Math.sqrt(Math.max(0, ringSq) / ringN);
    if (frameRms < Math.max(rmsFloor * 2, 1e-4)) return;
    for (let i = 0; i < pwN; i++) tunerFrame[i] = ring[(wpos - pwN + i + ringN * 4) & ringMask];
    const { hz, clarity } = tunerFn(tunerFrame, sr, 55, 1400);
    if (!hz) return;
    const mf = hzToMidi(hz) - offsetCents / 100;
    const midi = Math.round(mf);
    msgs.push({ type: 'tuner', midi, cents: Math.round((mf - midi) * 1000) / 10, hz: Math.round(hz * 100) / 100, clarity: Math.round(clarity * 1000) / 1000 });
  }

  function processHop(msgs) {
    frameNo++;
    const t = samplesIn / sr;
    levelStep(msgs);
    // calibration runs in any mode
    if (calLeft <= 0) {
      if (mode === 'idle') return;
      if (mode === 'tuner') { tunerStep(t, msgs); return; }
    }
    const onset = onsetStep(t);
    if (onset) msgs.push({ type: 'onset', t: onset.t, strength: Math.round(onset.strength * 100) / 100 });
    spectrumStep(t);
    if (calLeft > 0) {
      calLeft--;
      if (calLeft === 0) finishCalibration(msgs);
      return;
    }
    if (ev && !ev.done && (mode === 'wait' || mode === 'play')) eventStep(t, onset, msgs);
  }

  function push(pcm) {
    const msgs = [];
    if (!pcm || !pcm.length) return msgs;
    const { b0, b1, b2, a1, a2 } = hp;
    for (let i = 0; i < pcm.length; i++) {
      let x = +pcm[i];
      if (!(x === x)) x = 0; // NaN guard
      const ax = x < 0 ? -x : x;
      if (ax > lvPeak) lvPeak = ax;
      if (ax >= P.clipLevel) hopClip++;
      lvSum += x * x;
      lvN++;
      const y = b0 * x + b1 * hx1 + b2 * hx2 - a1 * hy1 - a2 * hy2;
      hx2 = hx1; hx1 = x; hy2 = hy1; hy1 = y;
      const old = ring[wpos];
      ring[wpos] = y;
      ringSq += y * y - old * old;
      wpos = (wpos + 1) & ringMask;
      if (fir) {
        hist[hpos] = y;
        hist[hpos + firL] = y;
        if (++hpos === firL) hpos = 0;
        if (++dcount === D) {
          dcount = 0;
          // symmetric taps: fold the two halves
          let acc = fir[firMid] * hist[hpos + firMid];
          for (let k = 0, j = hpos + firL - 1; k < firMid; k++, j--) acc += fir[k] * (hist[hpos + k] + hist[j]);
          dring[dpos] = acc;
          dpos = (dpos + 1) & (dwN - 1);
        }
      }
      samplesIn++;
      if (++fill === hop) {
        fill = 0;
        if (frameNo % 4096 === 0) { ringSq = 0; for (let k = 0; k < ringN; k++) ringSq += ring[k] * ring[k]; }
        processHop(msgs);
      }
    }
    return msgs;
  }

  return {
    hop,
    copiesInput: true, // push() copies samples into its own ring; callers may reuse buffers
    push,
    setMode(m) {
      if (!['idle', 'wait', 'play', 'tuner'].includes(m)) throw new Error(`unknown mode ${m}`);
      mode = m;
    },
    setTargets(events) {
      targets = Array.isArray(events) ? events : [];
      ev = null;
      evNext = null;
    },
    arm(index) {
      arm(Number(index));
    },
    setStrictness(s) {
      if (!['lenient', 'strict', 'bass'].includes(s)) throw new Error(`unknown strictness ${s}`);
      strictness = s;
      if (s !== 'lenient') evNext = null;
    },
    calibrateNoise(seconds = 3) {
      calLeft = Math.max(1, Math.round((seconds * sr) / hop));
      calFrames = 0;
      calRmsSum = 0;
      calSum.fill(0);
      calFlux.length = 0;
    },
    setOffsetCents(c) {
      offsetCents = Number(c) || 0;
      buildGlobal();
      if (ev && targets[ev.index]) arm(ev.index);
    },
    state() {
      const e = ev;
      return {
        mode,
        t: samplesIn / sr,
        hop,
        strictness,
        offsetCents,
        drift,
        calibrating: calLeft > 0,
        noiseDb: 20 * Math.log10(Math.max(1e-7, rmsFloor)),
        onsetThreshold: fluxThr,
        index: e ? e.index : null,
        ahead: evNext ? { index: evNext.index, heard: heardList(evNext) } : null,
        done: e ? e.done : null,
        heard: e ? heardList(e) : [],
        rows: e && P.debug ? [...e.o].map((v, r) => ({ lo: Math.round(e.rowLo[r]), hi: Math.round(e.rowHi[r]), o: +v.toFixed(4) })) : undefined,
        peaks: P.debug ? [...pkF.subarray(0, npk)].map((f, i) => [Math.round(f * 10) / 10, +pkM[i].toFixed(4)]) : undefined,
        noiseSpectrum: P.debug ? Array.from(noise) : undefined,
        spectrum: P.debug ? Array.from(X) : undefined,
        candidates: e
          ? e.cands.map((c) => ({
            midi: c.midi,
            role: c.role,
            c: c.cf,
            share: c.share,
            dres: c.dres,
            snr: c.snr,
            tonal: c.tonal,
            present: c.present,
            held: c.held,
            octave: c.octave,
            support: c.support,
            unique: c.uniqueSupport,
            partials: P.debug ? c.entries.slice(0, P.supportHarmonics).map((en, q) => [Math.round(en.f), +peakIn(en.lo, en.hi).toFixed(3), +F[c.floorBins[q]].toFixed(3), c.unique[q]]) : undefined,
          }))
          : [],
      };
    },
  };
}

// ---------------------------------------------------------------- self-check

// Additive plucked tone: harmonics with a string's stretch, each decaying.
function pluckTone(sampleRate, midi, dur, amp = 0.2, B = 5e-5) {
  const n = Math.round(dur * sampleRate);
  const out = new Float32Array(n);
  const f0 = midiToHz(midi);
  for (let h = 1; h <= 14; h++) {
    const f = h * f0 * Math.sqrt(1 + B * h * h);
    if (f > sampleRate * 0.45) break;
    const a = (amp / h) * (h % 7 === 0 ? 0.2 : 1);
    const tau = 1.5 / (1 + 0.25 * h);
    for (let i = 0; i < n; i++) out[i] += a * Math.exp(-i / sampleRate / tau) * Math.sin((TAU * f * i) / sampleRate + h);
  }
  return out;
}

function mix(sampleRate, dur, parts) {
  const out = new Float32Array(Math.round(dur * sampleRate));
  for (const [t, x] of parts) {
    const s = Math.round(t * sampleRate);
    for (let i = 0; i < x.length && s + i < out.length; i++) out[s + i] += x[i];
  }
  return out;
}

function runChunks(engine, pcm, onMsg) {
  const all = [];
  for (let i = 0; i < pcm.length; i += engine.hop) {
    for (const m of engine.push(pcm.subarray(i, i + engine.hop))) { all.push(m); onMsg?.(m); }
  }
  return all;
}

export function selfCheck(assert) {
  // FFT against a direct DFT
  const n = 64;
  const x = new Float64Array(n).map((_, i) => Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.3) + (i % 5) * 0.1);
  const { re, im } = fftReal(x);
  for (const k of [0, 1, 7, 31, 32]) {
    let dr = 0;
    let di = 0;
    for (let i = 0; i < n; i++) { dr += x[i] * Math.cos((TAU * k * i) / n); di -= x[i] * Math.sin((TAU * k * i) / n); }
    assert.ok(Math.abs(dr - re[k]) < 1e-9 && Math.abs(di - im[k]) < 1e-9, `fft bin ${k}`);
  }
  const w = hann(8);
  assert.equal(w[0], 0);
  assert.ok(Math.abs(w[4] - 1) < 1e-12);
  assert.ok(Math.abs(hzToMidi(midiToHz(52.3)) - 52.3) < 1e-9);
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);

  // McLeod on a pure tone and on a low, harmonic-rich one
  const sr = 48000;
  const sine = new Float64Array(4096).map((_, i) => Math.sin((TAU * 440 * i) / sr));
  const m1 = mcleod(sine, sr);
  assert.ok(Math.abs(m1.hz - 440) < 0.5 && m1.clarity > 0.95, `mcleod 440 → ${m1.hz}`);
  const low = pluckTone(sr, 40, 0.2).subarray(0, 4096);
  const m2 = mcleod(low, sr);
  assert.ok(Math.abs(hzToMidi(m2.hz) - 40) < 0.1, `mcleod E2 → ${m2.hz}`);

  // The engine: the expected note is accepted, a fret off is not.
  const run = (expectMidi, playMidi, extra = {}) => {
    const eng = createEngine({ sampleRate: sr });
    eng.setMode('wait');
    eng.setTargets([{ id: 'a', notes: expectMidi.map((m) => ({ midi: m, required: true, tech: [] })) }]);
    if (extra.strictness) eng.setStrictness(extra.strictness);
    eng.arm(0);
    const parts = playMidi.map((m, i) => [0.5 + i * 0.01, pluckTone(sr, m, 1.2)]);
    return runChunks(eng, mix(sr, 1.8, parts));
  };
  const hit = run([57], [57]);
  const acc = hit.find((m) => m.type === 'accept');
  assert.ok(acc, 'a plain A3 is accepted');
  assert.ok(acc.t > 0.5 && acc.t < 0.7, `accepted promptly (${acc.t})`);
  assert.ok(hit.some((m) => m.type === 'onset' && m.t > 0.49 && m.t < 0.56), 'onset found');
  assert.ok(hit.some((m) => m.type === 'level'), 'levels reported');
  const off = run([57], [58]);
  assert.ok(!off.some((m) => m.type === 'accept'), 'a fret off is not accepted');
  assert.ok(off.some((m) => m.type === 'wrong' && m.heard[0] === 58 && m.expected[0] === 57), 'and is named');
  assert.ok(!run([57], [45]).some((m) => m.type === 'accept'), 'an octave down is not accepted');
  assert.ok(run([48, 52, 55], [48, 52, 55]).some((m) => m.type === 'accept'), 'a C major triad is accepted');

  // A ringing note is not new because another string is plucked over it.
  {
    const eng = createEngine({ sampleRate: sr });
    eng.setMode('wait');
    eng.setTargets([{ notes: [{ midi: 45 }] }, { notes: [{ midi: 45 }] }]);
    eng.arm(0);
    const msgs = runChunks(eng, mix(sr, 2.2, [[0.5, pluckTone(sr, 45, 1.7)], [1.4, pluckTone(sr, 52, 0.8)]]), (m) => {
      if (m.type === 'accept' && m.index === 0) eng.arm(1);
    });
    assert.ok(msgs.some((m) => m.type === 'accept' && m.index === 0), 'A2 accepted');
    assert.ok(!msgs.some((m) => m.type === 'accept' && m.index === 1), 'ringing A2 not accepted again on an E3 pluck');
  }

  // Nothing played: no accept, even after arming.
  const quiet = createEngine({ sampleRate: sr });
  quiet.setMode('wait');
  quiet.setTargets([{ id: 'q', notes: [{ midi: 60 }] }]);
  quiet.arm(0);
  assert.ok(!runChunks(quiet, new Float32Array(sr)).some((m) => m.type === 'accept'), 'silence is not a note');

  // Calibration reports the room level; the tuner reads a tone.
  const cal = createEngine({ sampleRate: sr });
  cal.setMode('wait');
  cal.calibrateNoise(0.5);
  const hum = new Float32Array(sr).map((_, i) => 0.01 * Math.sin((TAU * 120 * i) / sr));
  const cm = runChunks(cal, hum).find((m) => m.type === 'calib');
  assert.ok(cm && cm.noiseDb < -35 && cm.noiseDb > -50, `calibration level ${cm?.noiseDb}`);
  const tun = createEngine({ sampleRate: sr });
  tun.setMode('tuner');
  tun.setOffsetCents(0);
  const tm = runChunks(tun, pluckTone(sr, 45, 1)).filter((m) => m.type === 'tuner');
  assert.ok(tm.length > 5, 'tuner messages');
  const last = tm[tm.length - 1];
  assert.equal(last.midi, 45);
  assert.ok(Math.abs(last.cents) < 5, `tuner cents ${last.cents}`);

  // 16 kHz input uses the smaller hop.
  assert.equal(createEngine({ sampleRate: 16000 }).hop, 256);
  assert.equal(createEngine({ sampleRate: 44100 }).hop, 512);
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
  console.log('listen.js self-check passed');
}
