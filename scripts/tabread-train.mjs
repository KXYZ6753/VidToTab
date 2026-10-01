// Trains the tab reader's glyph classifier and writes it as an ES module.
//
//   node scripts/tabread-train.mjs [--no-real] [--leave-out <video>] [--epochs 15]
//                                  [--out public/shared/tabread-model.js] [--seed 1]
//   node scripts/tabread-train.mjs --refit-temperature <model.js>
//
// A small MLP, 392 → 128 → 64 → |CLASSES|, over the reader's own view of a
// glyph (describe() in tabread.js: a 16×24 crop plus 8 measurements). Pure
// Node: Float32Array maths, a seeded PRNG, Adam, batches of 128, classes
// sampled towards balance, label smoothing 0.05, and each crop jittered as it
// is drawn (±1 px shift, 0.9–1.1 scale, thicker or thinner strokes, blur,
// gamma). Training data is the synthetic set (tabread-synth.mjs --extract)
// plus, unless --no-real, glyphs harvested from the dev videos
// (tabread-harvest.mjs), a fifth of whose pages are kept back to fit the
// softmax temperature and to report real accuracy. The weights are stored as
// int8 with one scale per output unit; the int8 model is checked against the
// float one before it is written.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, '.cache', 'tabread');
const CROP = 16 * 24;
const NF = 8;
const NIN = CROP + NF;

// ---------------------------------------------------------------- sample files

// { crops: Float32Array[] | Uint8Array, feats, labels, groups, groupNames, source }
export function saveSamples(base, { crops, feats, labels, groups, groupNames = null, source, extra = null }) {
  const n = labels.length;
  const c8 = new Uint8Array(n * CROP);
  for (let i = 0; i < n; i++) {
    const c = crops[i];
    for (let k = 0; k < CROP; k++) c8[i * CROP + k] = Math.max(0, Math.min(255, Math.round(c[k] * 255)));
  }
  const f32 = new Float32Array(n * NF);
  for (let i = 0; i < n; i++) f32.set(feats[i], i * NF);
  const lab = Uint8Array.from(labels);
  const grp = Int32Array.from(groups);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const buf = Buffer.concat([Buffer.from(c8.buffer), Buffer.from(f32.buffer), Buffer.from(lab.buffer), Buffer.alloc((4 - (lab.length % 4)) % 4), Buffer.from(grp.buffer)]);
  fs.writeFileSync(`${base}.bin`, buf);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ n, source, groupNames, extra }));
}

export function loadSamples(base) {
  const meta = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  const buf = fs.readFileSync(`${base}.bin`);
  const n = meta.n;
  let o = buf.byteOffset;
  const ab = buf.buffer;
  const crops = new Uint8Array(ab.slice(o, o + n * CROP)); o += n * CROP;
  const feats = new Float32Array(ab.slice(o, o + n * NF * 4)); o += n * NF * 4;
  const labels = new Uint8Array(ab.slice(o, o + n)); o += n + ((4 - (n % 4)) % 4);
  const groups = new Int32Array(ab.slice(o, o + n * 4));
  return { ...meta, crops, feats, labels, groups };
}

// ---------------------------------------------------------------- maths

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(R) {
  const u = Math.max(1e-9, R());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R());
}

// Weights are stored input-major (w[k * out + j]) so a sparse input only
// touches the rows it has.
function makeNet(sizes, R) {
  const layers = [];
  for (let l = 0; l + 1 < sizes.length; l++) {
    const nin = sizes[l];
    const nout = sizes[l + 1];
    const w = new Float32Array(nin * nout);
    const sd = Math.sqrt(2 / nin);
    for (let i = 0; i < w.length; i++) w[i] = gauss(R) * sd;
    layers.push({ nin, nout, w, b: new Float32Array(nout), relu: l + 2 < sizes.length });
  }
  return layers;
}

function forward(net, x, acts) {
  // acts[0] = x; acts[l+1] = output of layer l (post-ReLU for hidden layers).
  acts[0] = x;
  let a = x;
  for (let l = 0; l < net.length; l++) {
    const { nin, nout, w, b, relu } = net[l];
    const out = acts[l + 1];
    out.set(b);
    for (let k = 0; k < nin; k++) {
      const v = a[k];
      if (v === 0) continue;
      const row = k * nout;
      for (let j = 0; j < nout; j++) out[j] += v * w[row + j];
    }
    if (relu) for (let j = 0; j < nout; j++) if (out[j] < 0) out[j] = 0;
    a = out;
  }
  return a;
}

function softmax(z, T = 1, out = new Float32Array(z.length)) {
  let m = -Infinity;
  for (let i = 0; i < z.length; i++) m = Math.max(m, z[i] / T);
  let s = 0;
  for (let i = 0; i < z.length; i++) { out[i] = Math.exp(z[i] / T - m); s += out[i]; }
  for (let i = 0; i < z.length; i++) out[i] /= s;
  return out;
}

// ---------------------------------------------------------------- augmentation

function augment(src, R, out) {
  // src: Float32Array(384) in 0..1 (16 wide, 24 tall).
  const Wd = 16;
  const Ht = 24;
  let a = src;
  const tmp = new Float32Array(CROP);
  // Scale about the centre and shift, by bilinear resampling.
  const sc = 0.9 + 0.2 * R();
  const dx = R() < 0.5 ? Math.floor(R() * 3) - 1 : 0;
  const dy = R() < 0.5 ? Math.floor(R() * 3) - 1 : 0;
  if (sc !== 1 || dx || dy) {
    for (let y = 0; y < Ht; y++) {
      for (let x = 0; x < Wd; x++) {
        const sx = (x - dx - Wd / 2 + 0.5) / sc + Wd / 2 - 0.5;
        const sy = (y - dy - Ht / 2 + 0.5) / sc + Ht / 2 - 0.5;
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= Wd || yy >= Ht ? 0 : a[yy * Wd + xx]);
        tmp[y * Wd + x] = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1));
      }
    }
    a = tmp.slice();
  }
  // Thicker or thinner strokes: blend towards a 3×3 max or min.
  const u = R();
  if (u < 0.35) {
    const t = u < 0.2 ? 'max' : 'min';
    const k = 0.3 + 0.5 * R();
    const b = new Float32Array(CROP);
    for (let y = 0; y < Ht; y++) {
      for (let x = 0; x < Wd; x++) {
        let v = t === 'max' ? 0 : 1;
        for (let yy = y - 1; yy <= y + 1; yy++) {
          for (let xx = x - 1; xx <= x + 1; xx++) {
            if (Math.abs(yy - y) + Math.abs(xx - x) > 1) continue;
            const p = xx < 0 || yy < 0 || xx >= Wd || yy >= Ht ? 0 : a[yy * Wd + xx];
            v = t === 'max' ? Math.max(v, p) : Math.min(v, p);
          }
        }
        b[y * Wd + x] = (1 - k) * a[y * Wd + x] + k * v;
      }
    }
    a = b;
  }
  // Blur.
  if (R() < 0.2) {
    const k = 0.2 + 0.4 * R();
    const b = new Float32Array(CROP);
    for (let y = 0; y < Ht; y++) {
      for (let x = 0; x < Wd; x++) {
        let s = 0;
        let n = 0;
        for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) { s += xx < 0 || yy < 0 || xx >= Wd || yy >= Ht ? 0 : a[yy * Wd + xx]; n++; }
        b[y * Wd + x] = (1 - k) * a[y * Wd + x] + (k * s) / n;
      }
    }
    a = b;
  }
  // Gamma and contrast.
  const g = R() < 0.4 ? Math.exp((R() - 0.5) * 0.7) : 1;
  const c = R() < 0.3 ? 0.75 + 0.3 * R() : 1;
  for (let i = 0; i < CROP; i++) {
    let v = a[i];
    if (g !== 1 && v > 0) v = Math.pow(v, g);
    v = Math.min(1, v * c);
    out[i] = v < 0.02 ? 0 : v;
  }
}

// ---------------------------------------------------------------- training

export function inputOf(crop8, feats, i, norm, out) {
  for (let k = 0; k < CROP; k++) { const v = crop8[i * CROP + k] / 255; out[k] = v < 0.02 ? 0 : v; }
  for (let k = 0; k < NF; k++) out[CROP + k] = (Math.min(8, feats[i * NF + k]) - norm.mean[k]) / norm.std[k];
  return out;
}

export function train({ sets, classes, epochs = 15, seed = 1, batch = 128, lr0 = 2e-3, balance = 0.6, log = console.log }) {
  // sets: [{ data (loadSamples), idx: Int32Array of sample indices, weight }]
  const R = mulberry32(seed);
  const C = classes.length;
  // Feature normalisation from the training samples.
  const mean = new Float64Array(NF);
  const sq = new Float64Array(NF);
  let cnt = 0;
  for (const st of sets) {
    for (const i of st.idx) {
      for (let k = 0; k < NF; k++) { const v = Math.min(8, st.data.feats[i * NF + k]); mean[k] += v; sq[k] += v * v; }
      cnt++;
    }
  }
  const norm = { mean: [], std: [] };
  for (let k = 0; k < NF; k++) {
    const m = mean[k] / cnt;
    norm.mean.push(Math.round(m * 1e4) / 1e4);
    norm.std.push(Math.round(Math.max(0.05, Math.sqrt(sq[k] / cnt - m * m)) * 1e4) / 1e4);
  }
  // Sampling weights: per-set weight / class count^balance.
  const items = [];
  const classCount = new Float64Array(C);
  for (let si = 0; si < sets.length; si++) for (const i of sets[si].idx) classCount[sets[si].data.labels[i]] += sets[si].weight;
  let total = 0;
  const cum = [];
  for (let si = 0; si < sets.length; si++) {
    for (const i of sets[si].idx) {
      const c = sets[si].data.labels[i];
      total += sets[si].weight / Math.pow(Math.max(1, classCount[c]), balance);
      items.push([si, i]);
      cum.push(total);
    }
  }
  const cumA = Float64Array.from(cum);
  const draw = () => {
    const u = R() * total;
    let lo = 0;
    let hi = cumA.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumA[mid] < u) lo = mid + 1; else hi = mid; }
    return items[lo];
  };
  const N = items.length;
  const net = makeNet([NIN, 128, 64, C], R);
  const m1 = net.map((L) => ({ w: new Float32Array(L.w.length), b: new Float32Array(L.b.length) }));
  const v1 = net.map((L) => ({ w: new Float32Array(L.w.length), b: new Float32Array(L.b.length) }));
  const grads = net.map((L) => ({ w: new Float32Array(L.w.length), b: new Float32Array(L.b.length) }));
  const acts = [null, ...net.map((L) => new Float32Array(L.nout))];
  const deltas = net.map((L) => new Float32Array(L.nout));
  const x = new Float32Array(NIN);
  const crop = new Float32Array(CROP);
  const p = new Float32Array(C);
  const smooth = 0.05;
  const steps = Math.ceil(N / batch) * epochs;
  let step = 0;
  const b1 = 0.9;
  const b2 = 0.999;
  const wd = 1e-5;
  for (let ep = 0; ep < epochs; ep++) {
    let loss = 0;
    let right = 0;
    const t0 = Date.now();
    for (let bi = 0; bi < N; bi += batch) {
      for (const g of grads) { g.w.fill(0); g.b.fill(0); }
      const B = Math.min(batch, N - bi);
      for (let s = 0; s < B; s++) {
        const [si, i] = draw();
        const d = sets[si].data;
        for (let k = 0; k < CROP; k++) crop[k] = d.crops[i * CROP + k] / 255;
        augment(crop, R, x);
        for (let k = 0; k < NF; k++) {
          let v = Math.min(8, d.feats[i * NF + k]);
          if (k === 0 || k === 1 || k === 7) v *= 1 + 0.04 * gauss(R);
          x[CROP + k] = (v - norm.mean[k]) / norm.std[k];
        }
        const z = forward(net, x, acts);
        softmax(z, 1, p);
        const y = d.labels[i];
        loss -= Math.log(Math.max(1e-9, p[y]));
        let arg = 0;
        for (let c = 1; c < C; c++) if (p[c] > p[arg]) arg = c;
        if (arg === y) right++;
        // Backward.
        const dz = deltas[net.length - 1];
        for (let c = 0; c < C; c++) dz[c] = p[c] - (smooth / C + (c === y ? 1 - smooth : 0));
        for (let l = net.length - 1; l >= 0; l--) {
          const L = net[l];
          const a = acts[l];
          const dl = deltas[l];
          const g = grads[l];
          for (let j = 0; j < L.nout; j++) g.b[j] += dl[j];
          const prev = l > 0 ? deltas[l - 1] : null;
          for (let k = 0; k < L.nin; k++) {
            const v = a[k];
            const row = k * L.nout;
            if (v !== 0) for (let j = 0; j < L.nout; j++) g.w[row + j] += v * dl[j];
            if (prev) {
              if (v <= 0) { prev[k] = 0; continue; }
              let sum = 0;
              for (let j = 0; j < L.nout; j++) sum += L.w[row + j] * dl[j];
              prev[k] = sum;
            }
          }
        }
      }
      // Adam, cosine-decayed learning rate.
      step++;
      const lr = 1e-4 + 0.5 * (lr0 - 1e-4) * (1 + Math.cos((Math.PI * step) / steps));
      const c1 = 1 - Math.pow(b1, step);
      const c2 = 1 - Math.pow(b2, step);
      for (let l = 0; l < net.length; l++) {
        for (const key of ['w', 'b']) {
          const P = net[l][key];
          const G = grads[l][key];
          const M = m1[l][key];
          const V = v1[l][key];
          for (let i = 0; i < P.length; i++) {
            const gi = G[i] / B + (key === 'w' ? wd * P[i] : 0);
            M[i] = b1 * M[i] + (1 - b1) * gi;
            V[i] = b2 * V[i] + (1 - b2) * gi * gi;
            P[i] -= (lr * (M[i] / c1)) / (Math.sqrt(V[i] / c2) + 1e-8);
          }
        }
      }
    }
    log(`epoch ${ep + 1}/${epochs}: loss ${(loss / N).toFixed(4)}, train acc ${((100 * right) / N).toFixed(2)}% (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  return { net, norm };
}

// Logits for every sample in idx, float or int8 weights.
export function predictAll(net, norm, data, idx) {
  const acts = [null, ...net.map((L) => new Float32Array(L.nout))];
  const x = new Float32Array(NIN);
  const out = [];
  for (const i of idx) {
    inputOf(data.crops, data.feats, i, norm, x);
    out.push(Float32Array.from(forward(net, x, acts)));
  }
  return out;
}

export function quantize(net) {
  return net.map((L) => {
    const q = new Int8Array(L.w.length);
    const scale = new Float32Array(L.nout);
    for (let j = 0; j < L.nout; j++) {
      let m = 0;
      for (let k = 0; k < L.nin; k++) m = Math.max(m, Math.abs(L.w[k * L.nout + j]));
      scale[j] = m / 127 || 1e-8;
    }
    for (let k = 0; k < L.nin; k++) for (let j = 0; j < L.nout; j++) q[k * L.nout + j] = Math.round(L.w[k * L.nout + j] / scale[j]);
    return { nin: L.nin, nout: L.nout, q, scale, b: L.b, relu: L.relu };
  });
}

export function dequantize(qnet) {
  return qnet.map((L) => {
    const w = new Float32Array(L.q.length);
    for (let k = 0; k < L.nin; k++) for (let j = 0; j < L.nout; j++) w[k * L.nout + j] = L.q[k * L.nout + j] * L.scale[j];
    return { nin: L.nin, nout: L.nout, w, b: L.b, relu: L.relu };
  });
}

function nll(logits, labels, T) {
  let s = 0;
  const p = new Float32Array(logits[0].length);
  for (let i = 0; i < logits.length; i++) { softmax(logits[i], T, p); s -= Math.log(Math.max(1e-9, p[labels[i]])); }
  return s / logits.length;
}

export function fitTemperature(logits, labels) {
  let best = 1;
  let bestL = Infinity;
  for (let T = 0.5; T <= 4.0001; T += 0.05) {
    const L = nll(logits, labels, T);
    if (L < bestL) { bestL = L; best = T; }
  }
  return Math.round(best * 100) / 100;
}

const accuracy = (logits, labels) => logits.reduce((a, z, i) => { let m = 0; for (let c = 1; c < z.length; c++) if (z[c] > z[m]) m = c; return a + (m === labels[i] ? 1 : 0); }, 0) / Math.max(1, logits.length);

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');

export function moduleSource({ id, classes, temperature, norm, qnet, notes }) {
  const layers = qnet.map((L) => `  { nin: ${L.nin}, nout: ${L.nout}, relu: ${L.relu}, w: '${b64(L.q)}', scale: '${b64(L.scale)}', bias: '${b64(Float32Array.from(L.b))}' },`).join('\n');
  return `// Generated by scripts/tabread-train.mjs — do not edit by hand.
// The tab reader's glyph classifier: an MLP ${[qnet[0].nin, ...qnet.map((L) => L.nout)].join(' → ')} over the
// 16×24 crop and 8 measurements describe() in tabread.js gives every glyph.
// Weights are int8, input-major, one scale per output unit (base64).
// ${notes}
import { makeClassifier } from './tabread.js';

export const id = '${id}';
export const classes = ${JSON.stringify(classes)};
export const temperature = ${temperature};
export const norm = ${JSON.stringify(norm)};
export const layers = [
${layers}
];

// classify(glyph, sys) → { label, conf, probs }, for readPage(img, { classify }).
export const classify = makeClassifier({ id, classes, temperature, norm, layers });
export default { id, classes, temperature, norm, layers, classify };
`;
}

// ---------------------------------------------------------------- main

export async function trainAndWrite({ out, leaveOut = null, useReal = true, epochs = 15, seed = 1, log = console.log, realWeight = 4, synthWeight = 1, extraSynth = [] }) {
  const { CLASSES } = await import('../public/shared/tabread.js');
  const t0 = Date.now();
  const synth = loadSamples(path.join(DATA, 'synth', 'glyphs'));
  const sets = [{ data: synth, idx: Int32Array.from({ length: synth.labels.length }, (_, i) => i), weight: synthWeight }];
  for (const base of extraSynth) {
    const d = loadSamples(base);
    sets.push({ data: d, idx: Int32Array.from({ length: d.labels.length }, (_, i) => i), weight: synthWeight });
  }
  // Validation: every 20th synthetic page, and (with real glyphs) every
  // fifth page of each dev video. The temperature is fitted on both: the real
  // pages are what it must be right for, but they are read so nearly without
  // error that on their own they would only push it towards overconfidence.
  const vals = [];
  {
    const keep = [];
    const hold = [];
    for (let i = 0; i < synth.labels.length; i++) (synth.groups[i] % 20 === 7 ? hold : keep).push(i);
    sets[0].idx = Int32Array.from(keep);
    vals.push({ data: synth, idx: Int32Array.from(hold), name: 'synthetic' });
  }
  const realBase = path.join(DATA, 'real', 'glyphs');
  if (useReal && fs.existsSync(`${realBase}.json`)) {
    const real = loadSamples(realBase);
    // Pages are groups; every fifth page of each video is kept back.
    const tr = [];
    const va = [];
    const pageRank = new Map();
    for (let i = 0; i < real.labels.length; i++) {
      const gname = real.groupNames[real.groups[i]];
      const video = gname.split('/')[0];
      if (leaveOut && video === leaveOut) continue;
      if (!pageRank.has(gname)) pageRank.set(gname, [...pageRank.keys()].filter((k) => k.startsWith(`${video}/`)).length);
      (pageRank.get(gname) % 5 === 2 ? va : tr).push(i);
    }
    sets.push({ data: real, idx: Int32Array.from(tr), weight: realWeight });
    if (va.length) vals.push({ data: real, idx: Int32Array.from(va), name: 'real dev' });
    log(`real glyphs: ${tr.length} train, ${va.length} validation${leaveOut ? ` (without ${leaveOut})` : ''}`);
  }
  const n = sets.reduce((a, s) => a + s.idx.length, 0);
  log(`training on ${n} glyphs (${sets.map((s) => s.idx.length).join(' + ')}), ${CLASSES.length} classes, ${epochs} epochs`);
  const { net, norm } = train({ sets, classes: CLASSES, epochs, seed, log });
  const qnet = quantize(net);
  const dq = dequantize(qnet);
  const allZ = [];
  const allL = [];
  const report = [];
  let accF = 0;
  let accQ = 0;
  for (const v of vals) {
    const labels = Array.from(v.idx, (i) => v.data.labels[i]);
    const zf = predictAll(net, norm, v.data, v.idx);
    const zq = predictAll(dq, norm, v.data, v.idx);
    const af = accuracy(zf, labels);
    const aq = accuracy(zq, labels);
    report.push(`${v.name} ${labels.length}: float ${(100 * af).toFixed(2)}%, int8 ${(100 * aq).toFixed(2)}% (loss ${(100 * (af - aq)).toFixed(2)} pt)`);
    allZ.push(...zq);
    allL.push(...labels);
    accF = af;
    accQ = aq;
  }
  const temperature = fitTemperature(allZ, allL);
  log(`validation — ${report.join('; ')}; temperature ${temperature}`);
  const id = `tabread-${new Date().toISOString().slice(0, 10)}-${leaveOut ? `lovo-${leaveOut}` : useReal ? 'real' : 'synth'}-s${seed}`;
  const src = moduleSource({ id, classes: CLASSES, temperature, norm, qnet, notes: `Trained on ${n} glyphs (synthetic${useReal ? ' + real dev' : ''}${leaveOut ? `, without ${leaveOut}` : ''}); validation (int8) ${report.map((r) => r.replace(/: float [^,]*, int8 /, ' ').replace(/ \(loss.*$/, '')).join(', ')}.` });
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, src);
    log(`wrote ${path.relative(ROOT, out)} (${(src.length / 1024).toFixed(1)} KB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  return { id, src, accF, accQ, temperature };
}

// Fit the temperature of an existing model file again (same validation as
// trainAndWrite) and rewrite it with the new value.
export async function refitTemperature(file, { leaveOut = null, log = console.log } = {}) {
  const { loadModel } = await import('./tabread-eval.mjs');
  const m = await loadModel(file);
  const b = (str, T) => { const u = Buffer.from(str, 'base64'); return new T(u.buffer, u.byteOffset, u.byteLength / T.BYTES_PER_ELEMENT); };
  const qnet = m.layers.map((L) => ({ nin: L.nin, nout: L.nout, relu: L.relu, q: b(L.w, Int8Array), scale: b(L.scale, Float32Array), b: b(L.bias, Float32Array) }));
  const dq = dequantize(qnet);
  const synth = loadSamples(path.join(DATA, 'synth', 'glyphs'));
  const allZ = [];
  const allL = [];
  const hold = [];
  for (let i = 0; i < synth.labels.length; i++) if (synth.groups[i] % 20 === 7) hold.push(i);
  allZ.push(...predictAll(dq, m.norm, synth, hold));
  allL.push(...hold.map((i) => synth.labels[i]));
  const realBase = path.join(DATA, 'real', 'glyphs');
  if (fs.existsSync(`${realBase}.json`)) {
    const real = loadSamples(realBase);
    const pageRank = new Map();
    const va = [];
    for (let i = 0; i < real.labels.length; i++) {
      const gname = real.groupNames[real.groups[i]];
      const video = gname.split('/')[0];
      if (leaveOut && video === leaveOut) continue;
      if (!pageRank.has(gname)) pageRank.set(gname, [...pageRank.keys()].filter((k) => k.startsWith(`${video}/`)).length);
      if (pageRank.get(gname) % 5 === 2) va.push(i);
    }
    allZ.push(...predictAll(dq, m.norm, real, va));
    allL.push(...va.map((i) => real.labels[i]));
  }
  const T = fitTemperature(allZ, allL);
  const src = fs.readFileSync(file, 'utf8').replace(/export const temperature = [0-9.]+;/, `export const temperature = ${T};`);
  fs.writeFileSync(file, src);
  log(`${path.basename(file)}: temperature ${m.temperature} → ${T} (${allL.length} validation glyphs)`);
  return T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
  const flag = (name) => argv.includes(name);
  if (flag('--refit-temperature')) {
    await refitTemperature(path.resolve(arg('--refit-temperature')), { leaveOut: arg('--leave-out', null) });
    process.exit(0);
  }
  await trainAndWrite({
    out: path.resolve(arg('--out', path.join(ROOT, 'public', 'shared', 'tabread-model.js'))),
    leaveOut: arg('--leave-out', null),
    useReal: !flag('--no-real'),
    epochs: Number(arg('--epochs', 15)),
    seed: Number(arg('--seed', 1)),
    realWeight: Number(arg('--real-weight', 4)),
  });
}
