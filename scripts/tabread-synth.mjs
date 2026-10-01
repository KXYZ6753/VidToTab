// Synthetic tab pages with exact ground truth, for training the tab reader.
//
//   node scripts/tabread-synth.mjs [--pages 2000] [--seed 1] [--par 4]
//       Renders pages in headless Chrome (installed Chrome, over CDP) and caches
//       them under .cache/tabread/synth/pages/: <n>.gray.gz (8-bit luma) and
//       <n>.json (size, string lines, every mark drawn with its class and box).
//   node scripts/tabread-synth.mjs --extract
//       Cuts every cached page with the reader's own segmentPage and labels each
//       glyph by the marks it covers → .cache/tabread/synth/glyphs.{bin,json}.
//       Run again whenever segmentation changes; rendering need not be redone.
//   node scripts/tabread-synth.mjs --eval [--pages 200]
//       Renders a separate set (seeds from 900001, .cache/tabread/synth-eval/)
//       that is never trained on, for tabread-eval.mjs --synth.
//   node scripts/tabread-synth.mjs --show <n>
//       Writes page n as a PNG with its marks boxed, to look at.
//
// Pages are drawn at 1.5–3× and shrunk, then degraded (blur, a detour through
// a lower resolution, JPEG, noise, levels) the way a video frame of a tab is.
// Every mark carries its class — a CLASSES entry, "|" for barlines or "other"
// for anything that is not a note mark (words, clef letters, time signatures,
// rests, arcs, circled string names, chord-name text, specks, video leftovers).

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SYNTH = path.join(ROOT, '.cache', 'tabread', 'synth');
const PAGES = path.join(SYNTH, 'pages');
// Pages for end-to-end evaluation, never trained on: their own seeds and folder.
export const EVAL_PAGES = path.join(ROOT, '.cache', 'tabread', 'synth-eval', 'pages');
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };
const flag = (name) => argv.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
         '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Chromium found. Set CHROME_PATH.');
  return found;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// One page target over CDP: send(method, params) and evaluate(expr).
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

// ---------------------------------------------------------------- the renderer (runs in the page)

/* eslint-disable no-undef */
function installRenderer() {
  const FONT_CANDIDATES = [
    'Helvetica', 'Helvetica Neue', 'Arial', 'Arial Narrow', 'Avenir', 'Avenir Next', 'Avenir Next Condensed',
    'DIN Alternate', 'DIN Condensed', 'Courier', 'Courier New', 'Menlo', 'Monaco', 'Times', 'Times New Roman',
    'Georgia', 'Verdana', 'Trebuchet MS', 'Futura', 'Gill Sans', 'Tahoma', 'Palatino', 'Optima', 'Baskerville',
    'American Typewriter', 'Andale Mono', 'PT Mono', 'PT Sans', 'Lucida Grande', 'Geneva', 'Comic Sans MS',
    'Chalkboard', 'Arial Rounded MT Bold', 'Book Antiqua', 'Consolas', 'Segoe UI', 'DejaVu Sans', 'Liberation Sans',
    'JetBrains Mono', 'Sora',
  ];
  const MONO = new Set(['Courier', 'Courier New', 'Menlo', 'Monaco', 'Andale Mono', 'PT Mono', 'Consolas', 'JetBrains Mono']);

  // A font is here if text set in it measures differently from every generic fallback.
  function available() {
    const c = document.createElement('canvas').getContext('2d');
    const probe = 'mmmmmmmmmmlli0123456789WQ';
    const base = {};
    for (const g of ['monospace', 'serif', 'sans-serif']) { c.font = `72px ${g}`; base[g] = c.measureText(probe).width; }
    return FONT_CANDIDATES.filter((f) => {
      if (!document.fonts.check(`72px "${f}"`)) return false;
      return ['monospace', 'serif', 'sans-serif'].some((g) => { c.font = `72px "${f}", ${g}`; return c.measureText(probe).width !== base[g]; });
    });
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const WORDS = ['Sheet Music', 'sl.', 'pizz.', 'let ring', 'P.M.', 'harm.', 'rit.', 'a tempo', 'Fine', 'D.S.', 'Capo 2', 'mute', 'tr', 'Tab', 'www.tabs.com', 'arr. by', 'Verse', 'Chorus', 'Intro', 'Outro', 'Bridge', 'Solo', 'Riff', 'x2', 'N.C.', 'simile'];
  const CHORDS = ['C', 'Cm', 'G', 'G#', 'D', 'D/F#', 'Em', 'Am7', 'Bm7', 'F', 'Bb', 'A', 'E7', 'Cmaj7', 'Dsus4', 'F#m', 'Eb', 'Gm', 'Asus2', 'C#m7b5'];
  const STRING_NAMES = [['e', 'B', 'G', 'D', 'A', 'E'], ['E', 'B', 'G', 'D', 'A', 'E'], ['e', 'b', 'g', 'd', 'a', 'e'], ['D', 'A', 'F', 'C', 'G', 'D']];

  window.synthFonts = available();

  window.synthPage = async function synthPage(seed) {
    const R = mulberry32(seed * 7919 + 17);
    const rnd = (a, b) => a + (b - a) * R();
    const irnd = (a, b) => Math.floor(rnd(a, b + 1));
    const pick = (arr) => arr[Math.floor(R() * arr.length)];
    const chance = (p) => R() < p;
    const wpick = (pairs) => { let t = 0; for (const [, w] of pairs) t += w; let u = R() * t; for (const [v, w] of pairs) { if ((u -= w) < 0) return v; } return pairs[pairs.length - 1][0]; };
    const fonts = window.synthFonts;

    // ---- geometry: final spacing sF, drawn at f times that
    const sF = Math.exp(rnd(Math.log(17), Math.log(56)));
    const f = pick([1.5, 2, 2, 2, 2.5, 3]);
    const s = sF * f;
    const style = wpick([['broken', 0.36], ['dashes', 0.26], ['through', 0.22], ['boxed', 0.08], ['halo', 0.08]]);
    let family = pick(fonts);
    if (style === 'dashes' && chance(0.35)) family = pick(fonts.filter((x) => MONO.has(x))) || family;
    const mono = MONO.has(family);
    const weight = chance(0.45) ? pick(['bold', '600', '700', '800']) : pick(['normal', '400', '500']);
    const italic = chance(0.05) ? 'italic ' : '';
    const digitH = rnd(0.55, 0.85) * s;
    const ink = irnd(0, 45);
    const inkCol = `rgb(${ink},${ink},${ink})`;
    const lineGray = chance(0.5) ? irnd(0, 60) : irnd(70, 175);
    const lineCol = `rgb(${lineGray},${lineGray},${lineGray})`;
    const lineW = Math.max(0.6, rnd(0.6, 2.6)) * f;
    const nSys = chance(0.06) ? 2 : 1;
    const stems = chance(0.2) ? (chance(0.75) ? 'below' : 'above') : null;
    const topM = rnd(0.35, 3.5) * s;
    const botM = rnd(0.35, 3.8) * s;
    const sysGap = rnd(stems ? 4.5 : 2.5, stems ? 7 : 5) * s;
    const W = Math.round(Math.min(1920, Math.max(420, sF * rnd(20, 66))) * f);
    const H = Math.round(topM + nSys * 5 * s + (nSys - 1) * sysGap + botM);

    const cv = new OffscreenCanvas(W, H);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    const marks = [];
    const truth = [];
    const systemsOut = [];

    // Font metrics at a reference size.
    const fontAt = (px, fam = family, wt = weight) => `${italic}${wt} ${px.toFixed(2)}px "${fam}", sans-serif`;
    ctx.font = fontAt(100);
    const m0 = ctx.measureText('0');
    const capRatio = (m0.actualBoundingBoxAscent + m0.actualBoundingBoxDescent) / 100;
    const fsDigit = digitH / capRatio;
    const letterSpace = rnd(-0.04, 0.12) * digitH;

    // Draw one character; record and return its ink box.
    const drawChar = (ch, x, base, fs, cls, string, col = inkCol, fam = family, wt = weight) => {
      ctx.font = fontAt(fs, fam, wt);
      ctx.fillStyle = col;
      ctx.fillText(ch, x, base);
      const m = ctx.measureText(ch);
      const box = [x - m.actualBoundingBoxLeft, base - m.actualBoundingBoxAscent, x + m.actualBoundingBoxRight, base + m.actualBoundingBoxDescent];
      if (cls && box[2] > box[0] && box[3] > box[1]) marks.push({ c: cls, b: box, s: string });
      return { box, adv: m.width };
    };
    const measure = (ch, fs, fam = family, wt = weight) => { ctx.font = fontAt(fs, fam, wt); const m = ctx.measureText(ch); return { adv: m.width, asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent, l: m.actualBoundingBoxLeft, r: m.actualBoundingBoxRight }; };
    const other = (b, kind) => marks.push({ c: 'other', b, s: 0, k: kind });
    const runWidth = (chars, fs) => chars.reduce((a, ch) => a + measure(ch, fs).adv + letterSpace, -letterSpace);

    const fretOf = () => {
      const u = R();
      if (u < 0.5) return irnd(0, 5);
      if (u < 0.85) return irnd(6, 12);
      return irnd(13, 24);
    };
    const classOf = (ch) => {
      if (ch >= '0' && ch <= '9') return ch;
      if (ch === 'x' || ch === 'X') return 'x';
      if (ch === 'H') return 'h';
      if (ch === 'P') return 'p';
      if (ch === 'S') return 's';
      return ch;
    };

    for (let si = 0; si < nSys; si++) {
      const y0 = topM + si * (5 * s + sysGap);
      const ys = [0, 1, 2, 3, 4, 5].map((k) => y0 + k * s + (chance(0.1) ? rnd(-0.03, 0.03) * s : 0));
      // Where the staff starts and what sits before it.
      let xStart = rnd(0.1, 1.2) * s;
      const lead = wpick([['none', 0.5], ['names', 0.12], ['circled', 0.1], ['clef', 0.28]]);
      let xNotes;
      if (lead === 'names' || lead === 'circled') {
        const names = pick(STRING_NAMES);
        const cx = xStart + rnd(0.4, 0.8) * s;
        const fsN = rnd(0.45, 0.75) * s / capRatio;
        for (let k = 0; k < 6; k++) {
          const mm = measure(names[k], fsN);
          const bx = cx - (mm.l + mm.r) / 2 + mm.l;
          const base = ys[k] + (mm.asc - mm.desc) / 2;
          const col = lead === 'circled' ? pick([inkCol, lineCol]) : inkCol;
          const bb = drawChar(names[k], bx, base, fsN, null, 0, col).box;
          if (lead === 'circled') {
            const rr = rnd(0.36, 0.48) * s;
            ctx.strokeStyle = col;
            ctx.lineWidth = rnd(0.6, 1.6) * f;
            ctx.beginPath(); ctx.arc(cx, ys[k], rr, 0, Math.PI * 2); ctx.stroke();
            other([cx - rr - 1, ys[k] - rr - 1, cx + rr + 1, ys[k] + rr + 1], 'circle');
            if (chance(0.7)) {
              // An arrowhead pointing at the staff.
              const ax = cx + rr + rnd(0.1, 0.3) * s;
              const ah = rnd(0.15, 0.3) * s;
              ctx.fillStyle = col;
              ctx.beginPath(); ctx.moveTo(ax, ys[k] - ah); ctx.lineTo(ax + ah * 1.3, ys[k]); ctx.lineTo(ax, ys[k] + ah); ctx.closePath(); ctx.fill();
              other([ax - 1, ys[k] - ah - 1, ax + ah * 1.3 + 1, ys[k] + ah + 1], 'arrowhead');
            }
          } else other(bb, 'name');
        }
        xNotes = cx + rnd(0.7, 1.4) * s;
        if (lead === 'names' && chance(0.5)) xStart = cx + rnd(0.4, 0.7) * s; // lines start after the names
        else if (lead === 'circled') xStart = cx + rnd(0.3, 1.2) * s;
      } else xNotes = xStart + rnd(0.6, 1.8) * s;
      const xEnd = W - rnd(0, 1.5) * s;
      systemsOut.push({ lines: ys.map((y) => y / f), xStart: xStart / f, xEnd: xEnd / f });

      // ---- the events, left to right: each is a list of notes, each note a list of tokens.
      const events = [];
      // The TAB clef (and a time signature after it) takes room before the notes.
      let clef = null;
      if (lead === 'clef') {
        const fsC = rnd(1.2, 1.7) * s / capRatio;
        const cx = xNotes - rnd(0.1, 0.5) * s;
        const clefFam = chance(0.6) ? family : pick(fonts);
        const clefW = Math.max(...['T', 'A', 'B'].map((L) => measure(L, fsC, clefFam, 'bold').adv));
        clef = { fsC, cx, clefFam, ts: null, end: cx + clefW };
        if (chance(0.45)) {
          clef.ts = pick([['4', '4'], ['3', '4'], ['6', '8'], ['2', '4'], ['12', '8'], ['5', '4']]);
          clef.fsT = rnd(1.4, 2.1) * s / capRatio;
          clef.tx = cx + clefW + rnd(0.3, 0.8) * s;
          clef.end = clef.tx + Math.max(runWidth([...clef.ts[0]], clef.fsT), runWidth([...clef.ts[1]], clef.fsT));
        }
      }
      const edgeLeft = lead === 'none' && chance(0.08);
      let x = edgeLeft ? rnd(-0.3, 0.1) * s : clef ? clef.end + rnd(0.7, 1.5) * s : xNotes;
      const hasBars = style !== 'dashes' ? chance(0.6) : chance(0.3);
      let barEvery = irnd(3, 9);
      let sinceBar = 0;
      const dense = rnd(0.75, 1.6);
      while (x < xEnd + (chance(0.15) ? 0.4 * s : -0.8 * s)) {
        if (hasBars && sinceBar >= barEvery) {
          events.push({ bar: true, x });
          x += rnd(0.6, 1.4) * s * dense;
          sinceBar = 0;
          barEvery = irnd(3, 9);
          continue;
        }
        const kind = wpick([['single', 0.44], ['chord', 0.26], ['legato', 0.08], ['bend', 0.04], ['slide', 0.05], ['vib', 0.03], ['ghost', 0.03], ['harm', 0.025], ['mute', 0.05], ['grace', 0.03], ['empty', 0.02]]);
        const ev = { x, notes: [], kind };
        if (kind === 'single' || kind === 'mute' || kind === 'empty') {
          if (kind !== 'empty') {
            const k = irnd(1, 6);
            ev.notes.push({ string: k, toks: kind === 'mute' ? [chance(0.7) ? 'x' : 'X'] : String(fretOf()).split(''), tech: kind === 'mute' ? ['x'] : [] });
            if (kind === 'mute' && chance(0.5)) for (let k2 = 1; k2 <= 6; k2++) if (k2 !== k && chance(0.5)) ev.notes.push({ string: k2, toks: ['x'], tech: ['x'] });
          }
        } else if (kind === 'chord') {
          const n = irnd(2, 6);
          const top = irnd(1, 7 - n);
          const base = chance(0.3) ? irnd(0, 3) : irnd(0, 14);
          for (let k = top; k < top + n; k++) {
            if (n > 3 && chance(0.12)) continue;
            const fr = chance(0.25) ? 0 : Math.max(0, base + irnd(0, 4));
            ev.notes.push({ string: k, toks: chance(0.05) ? ['x'] : String(Math.min(24, fr)).split(''), tech: [] });
          }
          for (const nn of ev.notes) if (nn.toks[0] === 'x') nn.tech = ['x'];
        } else {
          const k = irnd(1, 6);
          const a = fretOf();
          if (kind === 'legato') {
            const chain = [a];
            const len = chance(0.3) ? 3 : 2;
            for (let i = 1; i < len; i++) chain.push(Math.max(0, Math.min(24, chain[i - 1] + (chance(0.5) ? 1 : -1) * irnd(1, 3))));
            // One event per fret, letters between them, written tight.
            ev.notes.push({ string: k, toks: String(chain[0]).split(''), tech: [] });
            ev.chain = chain.slice(1).map((b, i) => ({ string: k, lead: (b > chain[i] ? (chance(0.85) ? 'h' : 'H') : (chance(0.85) ? 'p' : 'P')), toks: String(b).split('') }));
          } else if (kind === 'slide') {
            const b = Math.max(0, Math.min(24, a + (chance(0.5) ? 1 : -1) * irnd(1, 4)));
            ev.notes.push({ string: k, toks: String(a).split(''), tech: [] });
            const lead = chance(0.3) ? (chance(0.8) ? 's' : 'S') : (b > a ? '/' : '\\');
            ev.chain = [{ string: k, lead, toks: String(b).split('') }];
          } else if (kind === 'bend') {
            const b = Math.min(24, a + irnd(1, 2));
            const r = chance(0.25);
            ev.notes.push({ string: k, toks: [...String(a)], after: [r ? 'r' : 'b', ...String(r ? Math.max(0, a - 1) : b)], tech: [r ? 'r' : 'b'], bendTo: r ? Math.max(0, a - 1) : b });
          } else if (kind === 'vib') {
            ev.notes.push({ string: k, toks: [...String(a)], after: ['~'], tech: ['~'] });
          } else if (kind === 'ghost') {
            ev.notes.push({ string: k, toks: [...String(a)], before: ['('], after: [')'], tech: ['ghost'] });
          } else if (kind === 'harm') {
            ev.notes.push({ string: k, toks: [...String(pick([5, 7, 12, 12, 19]))], before: ['<'], after: ['>'], tech: ['harm'] });
          } else if (kind === 'grace') {
            ev.notes.push({ string: k, toks: [...String(a)], tech: ['grace'], small: rnd(0.5, 0.68) });
            ev.graceOf = { string: k, toks: [...String(Math.max(0, Math.min(24, a + irnd(1, 2))))] };
          }
        }
        events.push(ev);
        sinceBar++;
        // How far right this event's marks reach, so the next one starts clear of them.
        let reach = 0;
        for (const n of ev.notes) reach = Math.max(reach, runWidth(n.toks, fsDigit) / 2 + (n.after ? runWidth(n.after, fsDigit) + letterSpace : 0));
        for (const c of ev.chain || []) reach += runWidth([c.lead, ...c.toks], fsDigit) + 2 * letterSpace + 0.16 * s;
        if (ev.graceOf) reach += runWidth(ev.graceOf.toks, fsDigit) + 0.4 * s;
        const step = rnd(0.85, 2.6) * s * dense;
        x += Math.max(0.7 * s, step, reach + rnd(0.45, 0.9) * s);
      }

      // ---- lay the tokens out: every token becomes a character box on its string.
      const placed = []; // {string, box:[..], cls, ch, fs}
      const baseFor = (k, fs) => { const mm = measure('0', fs); return ys[k - 1] + (mm.asc - mm.desc) / 2 + (chance(0.15) ? rnd(-0.06, 0.06) * s : 0); };
      const placeRun = (k, chars, xLeft, fs, clsFor) => {
        const base = baseFor(k, fs);
        let cx = xLeft;
        const boxes = [];
        for (const ch of chars) {
          const mm = measure(ch, ch === '~' ? fs * 1.1 : fs);
          boxes.push({ ch, x: cx, base, fs: ch === '~' ? fs * 1.1 : fs, adv: mm.adv, box: [cx - mm.l, base - mm.asc, cx + mm.r, base + mm.desc], cls: clsFor(ch), string: k });
          cx += mm.adv + letterSpace * (ch >= '0' && ch <= '9' ? 0.4 : 1);
        }
        return { boxes, x1: cx };
      };
      const lineGaps = [[], [], [], [], [], []];
      const evOut = [];
      for (const ev of events) {
        if (ev.bar) continue;
        const out = { x: ev.x / f, notes: [] };
        let maxX1 = ev.x;
        for (const n of ev.notes) {
          const fs = fsDigit * (n.small || 1);
          const fretW = runWidth(n.toks, fs);
          const before = n.before || [];
          const after = n.after || [];
          const xl = ev.x - fretW / 2 - (before.length ? runWidth(before, fs) + letterSpace : 0);
          const run = placeRun(n.string, [...before, ...n.toks, ...after], xl, fs, classOf);
          placed.push(...run.boxes);
          maxX1 = Math.max(maxX1, run.x1);
          out.notes.push({ string: n.string, fret: n.tech.includes('x') ? null : Number(n.toks.join('')), tech: [...n.tech], bendTo: n.bendTo ?? null });
        }
        if (ev.notes.length) evOut.push(out);
        let cx = maxX1 + letterSpace;
        for (const c of ev.chain || []) {
          const fs = fsDigit;
          const leadFs = /[a-zA-Z]/.test(c.lead) ? fs * rnd(0.8, 1.0) : fs;
          const lr = placeRun(c.string, [c.lead], cx + rnd(0, 0.08) * s, leadFs, classOf);
          placed.push(...lr.boxes);
          const r2 = placeRun(c.string, c.toks, lr.x1 + letterSpace + rnd(0, 0.08) * s, fs, classOf);
          placed.push(...r2.boxes);
          const lead = c.lead.toLowerCase() === 's' ? 's' : c.lead.toLowerCase();
          evOut.push({ x: (r2.boxes[0].box[0] + r2.boxes[r2.boxes.length - 1].box[2]) / 2 / f, notes: [{ string: c.string, fret: Number(c.toks.join('')), tech: [lead], bendTo: null }] });
          cx = r2.x1 + letterSpace;
        }
        if (ev.graceOf) {
          const g = ev.graceOf;
          const r2 = placeRun(g.string, g.toks, cx + rnd(0.15, 0.4) * s, fsDigit, classOf);
          placed.push(...r2.boxes);
          evOut.push({ x: (r2.boxes[0].box[0] + r2.boxes[r2.boxes.length - 1].box[2]) / 2 / f, notes: [{ string: g.string, fret: Number(g.toks.join('')), tech: [], bendTo: null }] });
        }
      }
      truth.push(evOut);

      // ---- string lines, in the page's style
      const gapPad = rnd(0.06, 0.3) * s;
      for (const p of placed) lineGaps[p.string - 1].push([p.box[0] - gapPad, p.box[2] + gapPad]);
      if (style === 'dashes') {
        // Rows of dash characters where there is no mark, on the marks' grid.
        const fsD = fsDigit * rnd(0.9, 1.05);
        const md = measure('-', fsD);
        const dashAdv = mono ? measure('0', fsD).adv : md.adv + rnd(-0.1, 0.25) * md.adv;
        const dashCol = chance(0.6) ? inkCol : lineCol;
        for (let k = 0; k < 6; k++) {
          const base = ys[k] + (md.asc - md.desc) / 2;
          const gaps = lineGaps[k].sort((a, b) => a[0] - b[0]);
          for (let xx = xStart; xx + md.r < xEnd; xx += dashAdv) {
            const a = xx - md.l;
            const b = xx + md.r;
            if (gaps.some((g) => b > g[0] + gapPad * 0.6 && a < g[1] - gapPad * 0.6)) continue;
            ctx.font = fontAt(fsD);
            ctx.fillStyle = dashCol;
            ctx.fillText('-', xx, base);
          }
        }
      } else {
        ctx.strokeStyle = lineCol;
        ctx.lineWidth = lineW;
        for (let k = 0; k < 6; k++) {
          const y = ys[k];
          let segs = [[xStart, xEnd]];
          if (style === 'broken' || style === 'boxed') {
            for (const g of lineGaps[k]) segs = segs.flatMap(([a, b]) => (g[1] <= a || g[0] >= b ? [[a, b]] : [[a, g[0]], [g[1], b]].filter(([p, q]) => q - p > 0.5)));
          }
          for (const [a, b] of segs) {
            if (chance(0.12) && style !== 'through') {
              // Darker and lighter stretches along one line (a cursor's leftovers).
              let xx = a;
              while (xx < b) {
                const len = rnd(1, 6) * s;
                const g = Math.max(0, Math.min(200, lineGray + irnd(-50, 50)));
                ctx.strokeStyle = `rgb(${g},${g},${g})`;
                ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(Math.min(b, xx + len), y); ctx.stroke();
                xx += len;
              }
              ctx.strokeStyle = lineCol;
            } else {
              ctx.beginPath(); ctx.moveTo(a, y); ctx.lineTo(b, y); ctx.stroke();
            }
          }
        }
      }
      // A white box or halo behind each mark, then the marks themselves.
      for (const p of placed) {
        if (style === 'boxed') {
          ctx.fillStyle = '#fff';
          ctx.fillRect(p.box[0] - gapPad * 0.5, ys[p.string - 1] - lineW, p.box[2] - p.box[0] + gapPad, 2 * lineW);
        }
        if (style === 'halo') {
          ctx.font = fontAt(p.fs);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = rnd(1, 3) * f;
          ctx.lineJoin = 'round';
          ctx.strokeText(p.ch, p.x, p.base);
        }
        drawChar(p.ch, p.x, p.base, p.fs, p.cls, p.string);
      }

      // ---- barlines, a start line, a thin+thick end
      const barW = Math.max(0.8 * f, lineW * rnd(0.8, 1.6));
      const vline = (xx, wdt, ya = ys[0], yb = ys[5], col = inkCol) => {
        ctx.fillStyle = col;
        ctx.fillRect(xx - wdt / 2, ya - lineW / 2, wdt, yb - ya + lineW);
        marks.push({ c: '|', b: [xx - wdt / 2 - 1, ya - lineW / 2 - 1, xx + wdt / 2 + 1, yb + lineW / 2 + 1], s: 0 });
      };
      const barCol = chance(0.5) ? inkCol : lineCol;
      for (const ev of events) if (ev.bar) vline(ev.x, barW, ys[0], ys[5], barCol);
      if (style !== 'dashes' && chance(0.5)) vline(xStart + barW / 2, barW, ys[0], ys[5], barCol);
      if (style !== 'dashes' && chance(0.4)) {
        vline(xEnd - barW * 4, barW, ys[0], ys[5], barCol);
        vline(xEnd - barW * 1.5, barW * 3, ys[0], ys[5], barCol);
      }
      if (style === 'dashes' && chance(0.4)) {
        // "|" characters opening each string row.
        for (let k = 0; k < 6; k++) {
          const mm = measure('|', fsDigit);
          drawChar('|', xStart - mm.adv, ys[k] + (mm.asc - mm.desc) / 2, fsDigit, '|', k + 1);
        }
      }

      // ---- the TAB clef and a time signature
      if (clef) {
        const { fsC, cx, clefFam } = clef;
        const letters = ['T', 'A', 'B'];
        const cy = [0, 1, 2].map((i) => (ys[0] + ys[5]) / 2 + (i - 1) * rnd(1.35, 1.7) * s);
        for (let i = 0; i < 3; i++) {
          const mm = measure(letters[i], fsC, clefFam, 'bold');
          drawChar(letters[i], cx, cy[i] + (mm.asc - mm.desc) / 2, fsC, 'other', 0, inkCol, clefFam, 'bold');
        }
        if (clef.ts) {
          const { ts, fsT, tx } = clef;
          const midY = (ys[0] + ys[5]) / 2;
          const mm = measure('4', fsT, family, 'bold');
          drawChar(ts[0], tx, midY - 0.05 * s, fsT, 'other', 0, inkCol, family, 'bold');
          drawChar(ts[1], tx, midY + mm.asc + 0.05 * s, fsT, 'other', 0, inkCol, family, 'bold');
        }
      }

      // ---- stems and beams
      if (stems) {
        const stemW = Math.max(0.7 * f, lineW * rnd(0.7, 1.3));
        const evx = events.filter((e) => !e.bar && e.notes.length);
        const tip = stems === 'below' ? ys[5] + rnd(1, 3) * s : ys[0] - rnd(1, 3) * s;
        let prev = null;
        for (const ev of evx) {
          if (ev.x > xEnd) break;
          const strs = ev.notes.map((n) => n.string);
          const from = stems === 'below' ? ys[Math.max(...strs) - 1] + digitH * rnd(0.5, 0.75) : ys[Math.min(...strs) - 1] - digitH * rnd(0.5, 0.75);
          ctx.fillStyle = inkCol;
          ctx.fillRect(ev.x - stemW / 2, Math.min(from, tip), stemW, Math.abs(tip - from));
          other([ev.x - stemW / 2 - 1, Math.min(from, tip) - 1, ev.x + stemW / 2 + 1, Math.max(from, tip) + 1], 'stem');
          if (prev && chance(0.5) && ev.x - prev.x < 3 * s) {
            const bh = rnd(0.12, 0.25) * s;
            ctx.fillRect(prev.x, stems === 'below' ? tip - bh : tip, ev.x - prev.x, bh);
            prev = null;
          } else prev = ev;
        }
      }

      // ---- strum arrows between events
      if (chance(0.06)) {
        const evx = events.filter((e) => !e.bar);
        for (let i = 0; i + 1 < evx.length; i++) {
          if (!chance(0.4)) continue;
          const ax = (evx[i].x + evx[i + 1].x) / 2;
          const ya = ys[irnd(0, 1)] - rnd(0, 0.3) * s;
          const yb = ys[irnd(4, 5)] + rnd(0, 0.3) * s;
          const up = chance(0.5);
          const aw = Math.max(0.8 * f, lineW);
          ctx.fillStyle = inkCol;
          ctx.fillRect(ax - aw / 2, ya, aw, yb - ya);
          const hy = up ? ya : yb;
          const hs = rnd(0.25, 0.4) * s;
          ctx.beginPath();
          ctx.moveTo(ax - hs, hy + (up ? hs : -hs)); ctx.lineTo(ax, hy); ctx.lineTo(ax + hs, hy + (up ? hs : -hs));
          ctx.lineWidth = aw; ctx.strokeStyle = inkCol; ctx.stroke();
          other([ax - hs - 1, ya - 1, ax + hs + 1, yb + 1], 'arrow');
        }
      }

      // ---- arcs over or under note pairs, H/P letters above some
      if (chance(0.18)) {
        const byString = {};
        for (const p of placed) if (/[0-9]/.test(p.ch)) (byString[p.string] ||= []).push(p);
        for (const [k, ps] of Object.entries(byString)) {
          ps.sort((a, b) => a.box[0] - b.box[0]);
          for (let i = 0; i + 1 < ps.length; i++) {
            const a = ps[i];
            const b = ps[i + 1];
            if (b.box[0] - a.box[2] > 3.5 * s || b.box[0] - a.box[2] < 0.25 * s || !chance(0.35)) continue;
            const above = chance(0.5);
            const xa = (a.box[0] + a.box[2]) / 2;
            const xb = (b.box[0] + b.box[2]) / 2;
            const yb0 = above ? Math.min(a.box[1], b.box[1]) - rnd(0.05, 0.2) * s : Math.max(a.box[3], b.box[3]) + rnd(0.05, 0.2) * s;
            const hh = rnd(0.2, 0.45) * s * (above ? -1 : 1);
            ctx.strokeStyle = pick([inkCol, lineCol]);
            ctx.lineWidth = rnd(0.7, 1.8) * f;
            ctx.beginPath(); ctx.moveTo(xa, yb0); ctx.quadraticCurveTo((xa + xb) / 2, yb0 + 2 * hh, xb, yb0); ctx.stroke();
            other([xa - 2, Math.min(yb0, yb0 + hh) - 2, xb + 2, Math.max(yb0, yb0 + hh) + 2], 'arc');
            if (above && chance(0.6)) {
              const L = pick(['H', 'P', 'h', 'p', 'sl.']);
              const fsL = rnd(0.35, 0.55) * s / capRatio;
              const mm = measure(L, fsL);
              drawChar(L, (xa + xb) / 2 - mm.adv / 2, yb0 + hh - rnd(0.08, 0.25) * s, fsL, 'other', 0);
            }
            i++;
          }
        }
      }

      // ---- rests (grey whole/half-rest blocks, quarter-rest squiggles, dashes on a line)
      if (chance(0.14)) {
        const n = irnd(1, 3);
        for (let i = 0; i < n; i++) {
          const rx = rnd(xNotes, xEnd - s);
          if (placed.some((p) => p.box[2] > rx - 0.5 * s && p.box[0] < rx + 1.2 * s)) continue;
          const col = chance(0.6) ? lineCol : inkCol;
          ctx.fillStyle = col;
          const kind = pick(['block', 'block', 'squiggle', 'dash']);
          if (kind === 'block') {
            const k = irnd(1, 4);
            const bw = rnd(0.4, 0.8) * s;
            const bh = rnd(0.2, 0.4) * s;
            const yy = chance(0.5) ? ys[k] : ys[k] - bh;
            ctx.fillRect(rx, yy, bw, bh);
            other([rx - 1, yy - 1, rx + bw + 1, yy + bh + 1], 'rest');
          } else if (kind === 'dash') {
            const k = irnd(0, 5);
            const bw = rnd(0.4, 0.9) * s;
            const bh = Math.max(lineW * 1.5, rnd(0.08, 0.2) * s);
            ctx.fillRect(rx, ys[k] + rnd(-0.4, 0.4) * s, bw, bh);
            other([rx - 1, ys[k] - 0.4 * s - 1, rx + bw + 1, ys[k] + 0.4 * s + bh + 1], 'rest');
          } else {
            const k = irnd(1, 3);
            const hgt = rnd(1.2, 2) * s;
            ctx.strokeStyle = col;
            ctx.lineWidth = rnd(1, 2.2) * f;
            ctx.beginPath();
            const ya = ys[k] - 0.3 * s;
            ctx.moveTo(rx, ya);
            ctx.lineTo(rx + 0.3 * s, ya + hgt * 0.3);
            ctx.lineTo(rx, ya + hgt * 0.55);
            ctx.lineTo(rx + 0.3 * s, ya + hgt * 0.8);
            ctx.quadraticCurveTo(rx - 0.2 * s, ya + hgt * 0.8, rx + 0.1 * s, ya + hgt);
            ctx.stroke();
            other([rx - 0.3 * s, ya - 2, rx + 0.5 * s, ya + hgt + 2], 'rest');
          }
        }
      }

      // ---- words and watermarks near or between the strings
      if (chance(0.12)) {
        const n = irnd(1, 2);
        for (let i = 0; i < n; i++) {
          const word = pick(WORDS);
          const fsW = rnd(0.35, 0.75) * s / capRatio;
          const fam = chance(0.5) ? family : pick(fonts);
          const k = irnd(0, 5);
          const yy = ys[k] + (chance(0.5) ? rnd(0.2, 0.55) : rnd(-0.1, 0.1)) * s + measure('S', fsW, fam).asc / 2;
          // Somewhere that covers no note: text is written around the tab, not over it.
          const wordW = runWidth([...word], fsW);
          const top = yy - measure('S', fsW, fam).asc - 0.25 * s;
          const bottom = yy + 0.3 * s;
          let xx = null;
          for (let t = 0; t < 25 && xx === null; t++) {
            const x0 = rnd(xStart, Math.max(xStart + 1, xEnd - wordW));
            if (!placed.some((p) => p.box[2] > x0 - 0.3 * s && p.box[0] < x0 + wordW + 0.3 * s && p.box[3] > top && p.box[1] < bottom)) xx = x0;
          }
          if (xx === null) continue;
          const col = chance(0.5) ? inkCol : lineCol;
          for (const ch of word) {
            if (ch === ' ') { xx += measure(' ', fsW, fam).adv; continue; }
            const r = drawChar(ch, xx, yy, fsW, 'other', 0, col, fam, chance(0.2) ? 'bold' : 'normal');
            xx += r.adv;
          }
        }
      }

      // ---- header text: chord names, a section label
      if (chance(0.4)) {
        const fsH = rnd(0.45, 0.8) * s / capRatio;
        const fam = chance(0.5) ? family : pick(fonts);
        const yy = ys[0] - rnd(0.7, 1.6) * s;
        for (const ev of events) {
          if (ev.bar || !ev.notes.length || !chance(0.25)) continue;
          let xx = ev.x - 0.2 * s;
          for (const ch of pick(CHORDS)) xx += drawChar(ch, xx, yy, fsH, 'other', 0, inkCol, fam, chance(0.5) ? 'bold' : 'normal').adv;
        }
        if (chance(0.3)) {
          let xx = rnd(0, 2) * s;
          for (const ch of pick(WORDS)) xx += drawChar(ch, xx, Math.max(fsH, yy - rnd(0.5, 1) * s), fsH, 'other', 0, inkCol, fam, 'bold').adv;
        }
      }

      // ---- specks, dots, video leftovers, a chord-diagram corner
      const nSpeck = chance(0.35) ? irnd(1, 12) : 0;
      for (let i = 0; i < nSpeck; i++) {
        const xx = rnd(0, W);
        const yy = rnd(ys[0] - 0.8 * s, ys[5] + 0.8 * s);
        const rr = rnd(0.03, 0.14) * s;
        ctx.fillStyle = pick([inkCol, lineCol, '#999']);
        ctx.beginPath(); ctx.arc(xx, yy, rr, 0, Math.PI * 2); ctx.fill();
        other([xx - rr - 1, yy - rr - 1, xx + rr + 1, yy + rr + 1], 'speck');
      }
      if (chance(0.1)) {
        const n = irnd(1, 4);
        for (let i = 0; i < n; i++) {
          const xa = rnd(0, W);
          const ya = rnd(ys[0] - 1.5 * s, ys[5] + 1.5 * s);
          const len = rnd(0.5, 4) * s;
          const ang = rnd(-0.6, 0.6);
          const g = irnd(60, 200);
          ctx.strokeStyle = `rgb(${g},${g},${g})`;
          ctx.lineWidth = rnd(0.8, 4) * f;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(xa, ya); ctx.quadraticCurveTo(xa + len / 2, ya + rnd(-0.6, 0.6) * s, xa + len * Math.cos(ang), ya + len * Math.sin(ang)); ctx.stroke();
          ctx.lineCap = 'butt';
          other([xa - 0.7 * s, ya - Math.abs(len) - s, xa + len + 0.7 * s, ya + Math.abs(len) + s], 'leftover');
        }
      }
      if (chance(0.05)) {
        const gx = xEnd - rnd(2, 4) * s;
        const gy = ys[0] + rnd(0, 2) * s;
        const cw = rnd(0.25, 0.4) * s;
        ctx.strokeStyle = inkCol;
        ctx.lineWidth = f;
        for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(gx + i * cw, gy); ctx.lineTo(gx + i * cw, gy + 4 * cw); ctx.stroke(); }
        for (let j = 0; j < 5; j++) { ctx.beginPath(); ctx.moveTo(gx, gy + j * cw); ctx.lineTo(gx + 5 * cw, gy + j * cw); ctx.stroke(); }
        for (let i = 0; i < 3; i++) { ctx.fillStyle = inkCol; ctx.beginPath(); ctx.arc(gx + irnd(0, 5) * cw, gy + (irnd(0, 3) + 0.5) * cw, cw * 0.35, 0, 7); ctx.fill(); }
        other([gx - 2, gy - 2, gx + 5 * cw + 2, gy + 4 * cw + 2], 'diagram');
      }
    }

    // ---- degrade: shrink to the final size (sometimes via a smaller one), blur, JPEG, noise, levels
    const WF = Math.round(W / f);
    const HF = Math.round(H / f);
    const fin = new OffscreenCanvas(WF, HF);
    const fx = fin.getContext('2d');
    fx.imageSmoothingEnabled = true;
    fx.imageSmoothingQuality = 'high';
    fx.fillStyle = '#fff';
    fx.fillRect(0, 0, WF, HF);
    const soft = chance(0.18) ? rnd(0.5, 0.8) : 0;
    if (soft) {
      const w2 = Math.round(WF * soft);
      const h2 = Math.round(HF * soft);
      const c2 = new OffscreenCanvas(w2, h2);
      const x2 = c2.getContext('2d');
      x2.imageSmoothingEnabled = true;
      x2.imageSmoothingQuality = 'high';
      x2.drawImage(cv, 0, 0, w2, h2);
      fx.drawImage(c2, 0, 0, WF, HF);
    } else fx.drawImage(cv, 0, 0, WF, HF);
    const blur = chance(0.3) ? rnd(0.25, 0.8) : 0;
    if (blur) {
      const c3 = new OffscreenCanvas(WF, HF);
      const x3 = c3.getContext('2d');
      x3.fillStyle = '#fff';
      x3.fillRect(0, 0, WF, HF);
      x3.filter = `blur(${blur.toFixed(2)}px)`;
      x3.drawImage(fin, 0, 0);
      fx.drawImage(c3, 0, 0);
    }
    const jpeg = chance(0.35) ? rnd(0.35, 0.9) : 0;
    if (jpeg) {
      const blob = await fin.convertToBlob({ type: 'image/jpeg', quality: jpeg });
      const bmp = await createImageBitmap(blob);
      fx.drawImage(bmp, 0, 0);
    }
    const id = fx.getImageData(0, 0, WF, HF).data;
    const gray = new Uint8Array(WF * HF);
    const noise = chance(0.2) ? rnd(2, 9) : 0;
    const levels = chance(0.5) ? [rnd(0, 60), rnd(190, 255)] : null;
    const gamma = chance(0.3) ? rnd(0.7, 1.4) : 1;
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      let v = (id[i] * 299 + id[i + 1] * 587 + id[i + 2] * 114) / 1000;
      if (noise) { const u = R() + R() + R() - 1.5; v += u * noise * 1.4; }
      if (levels) v = ((v - levels[0]) / (levels[1] - levels[0])) * 255;
      v = Math.max(0, Math.min(255, v));
      if (gamma !== 1) v = 255 * Math.pow(v / 255, gamma);
      gray[p] = v;
    }
    let bin = '';
    for (let i = 0; i < gray.length; i += 32768) bin += String.fromCharCode.apply(null, gray.subarray(i, i + 32768));
    const scaled = marks.map((m) => ({ ...m, b: m.b.map((v) => Math.round((v / f) * 100) / 100) }));
    return {
      w: WF, h: HF, gray: btoa(bin), marks: scaled, systems: systemsOut, truth,
      meta: { seed, style, family, weight, spacing: sF, f, soft, blur, jpeg, noise, levels, gamma, stems },
    };
  };
  return window.synthFonts;
}
/* eslint-enable no-undef */

// ---------------------------------------------------------------- rendering driver

async function render({ pages, seed0, par, dir = PAGES }) {
  fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tabread-synth-'));
  const chrome = spawn(findChrome(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  try {
    let version;
    for (let i = 0; i < 80 && !version; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); }
    }
    if (!version) throw new Error('Chrome did not start');
    const fontData = {
      'JetBrains Mono': fs.readFileSync(path.join(ROOT, 'public/fonts/jetbrains-mono-latin.woff2')).toString('base64'),
      Sora: fs.readFileSync(path.join(ROOT, 'public/fonts/sora-latin.woff2')).toString('base64'),
    };
    const tabs = [];
    for (let t = 0; t < par; t++) {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const c = await connect(target.webSocketDebuggerUrl);
      await c.send('Runtime.enable');
      // The repo's own fonts, from bytes (a file:// page may not load them by URL).
      for (const [fam, b64] of Object.entries(fontData)) {
        await c.evaluate(`(async () => { const b = Uint8Array.from(atob(${JSON.stringify(b64)}), (ch) => ch.charCodeAt(0)); const face = new FontFace(${JSON.stringify(fam)}, b.buffer, { weight: '100 900' }); await face.load(); document.fonts.add(face); return true; })()`);
      }
      const fonts = await c.evaluate(`(${installRenderer.toString()})()`);
      if (t === 0) console.log(`${fonts.length} fonts: ${fonts.join(', ')}`);
      tabs.push(c);
    }
    let next = 0;
    let done = 0;
    const t0 = Date.now();
    await Promise.all(tabs.map(async (c) => {
      for (;;) {
        const n = next++;
        if (n >= pages) return;
        const seed = seed0 + n;
        const r = await c.evaluate(`synthPage(${seed})`);
        const gray = Buffer.from(r.gray, 'base64');
        fs.writeFileSync(path.join(dir, `${seed}.gray.gz`), zlib.gzipSync(gray, { level: 6 }));
        delete r.gray;
        fs.writeFileSync(path.join(dir, `${seed}.json`), JSON.stringify(r));
        if (++done % 100 === 0) console.log(`${done}/${pages} pages (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
    }));
    for (const c of tabs) c.close();
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- pages → labelled glyphs

export function loadSynthPage(seed, dir = PAGES) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${seed}.json`), 'utf8'));
  const gray = zlib.gunzipSync(fs.readFileSync(path.join(dir, `${seed}.gray.gz`)));
  const ink = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) ink[i] = 1 - gray[i] / 255;
  return { meta, img: { width: meta.w, height: meta.h, ink, gray } };
}

export function synthSeeds(dir = PAGES) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => Number(f.replace('.json', ''))).sort((a, b) => a - b);
}

// A glyph's label from the marks it covers. null = ambiguous, left out of
// training (two digits in one glyph, a digit's fragment of middling size).
const BIG = new Set(['other', '|']);
export function labelGlyph(g, marks) {
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const gb = [g.x0 - 0.5, g.y0 - 0.5, g.x1 + 1.5, g.y1 + 1.5];
  const ga = area(gb);
  const hits = [];
  for (const m of marks) {
    const b = [m.b[0] - 0.5, m.b[1] - 0.5, m.b[2] + 0.5, m.b[3] + 0.5];
    const ib = [Math.max(gb[0], b[0]), Math.max(gb[1], b[1]), Math.min(gb[2], b[2]), Math.min(gb[3], b[3])];
    const inter = area(ib);
    if (inter <= 0) continue;
    hits.push({ m, covG: inter / ga, covM: inter / Math.max(1e-6, area(b)) });
  }
  const small = hits.filter((h) => !BIG.has(h.m.c));
  const strong = small.filter((h) => h.covM >= 0.4);
  if (strong.length >= 2) return null;
  if (strong.length === 1) {
    const h = strong[0];
    if (h.covM >= 0.6 && h.covG >= 0.35) return h.m.c;
    // A 1 whose thin flag fell below the ink threshold is still a 1: its stem,
    // full height, inside the mark's box.
    const tall = (Math.min(gb[3], h.m.b[3]) - Math.max(gb[1], h.m.b[1])) / Math.max(1e-6, h.m.b[3] - h.m.b[1]);
    if (h.m.c === '1' && h.covG >= 0.7 && tall >= 0.8) return '1';
    return null;
  }
  const frag = small.filter((h) => h.covG >= 0.5);
  if (frag.length) return frag.every((h) => h.covM < 0.3) ? 'other' : null;
  const big = hits.filter((h) => BIG.has(h.m.c) && h.covG >= 0.5).sort((a, b) => b.covG - a.covG);
  if (big.length) return big[0].m.c;
  return 'other';
}

async function extract() {
  const { segmentPage, CLASSES } = await import('../public/shared/tabread.js');
  const { saveSamples } = await import('./tabread-train.mjs');
  const seeds = synthSeeds();
  const crops = [];
  const feats = [];
  const labels = [];
  const groups = [];
  const counts = {};
  let skipped = 0;
  let pagesFound = 0;
  let lineErr = 0;
  const t0 = Date.now();
  for (const seed of seeds) {
    const { meta, img } = loadSynthPage(seed);
    const seg = segmentPage(img);
    if (!seg.found) continue;
    pagesFound++;
    for (const sys of seg.systems) {
      const truthSys = meta.systems.reduce((best, t) => (Math.abs(t.lines[0] - sys.lines[0]) < Math.abs(best.lines[0] - sys.lines[0]) ? t : best));
      lineErr = Math.max(lineErr, Math.max(...sys.lines.map((y, k) => Math.abs(y - truthSys.lines[k]))) / sys.spacing);
      for (const g of sys.glyphs) {
        const lab = labelGlyph(g, meta.marks);
        if (lab === null) { skipped++; continue; }
        const ci = CLASSES.indexOf(lab);
        if (ci < 0) { skipped++; continue; }
        crops.push(g.crop);
        feats.push(g.feats);
        labels.push(ci);
        groups.push(seed);
        counts[lab] = (counts[lab] || 0) + 1;
      }
    }
  }
  saveSamples(path.join(SYNTH, 'glyphs'), { crops, feats, labels, groups, groupNames: null, source: 'synth' });
  console.log(`${seeds.length} pages, ${pagesFound} with a staff, ${labels.length} glyphs labelled, ${skipped} ambiguous left out, worst line error ${lineErr.toFixed(3)} s (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
}

function show(seed) {
  const { meta, img } = loadSynthPage(seed);
  const out = path.join(SYNTH, `show-${seed}.png`);
  const rgb = Buffer.alloc(img.width * img.height * 3);
  for (let i = 0; i < img.gray.length; i++) rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = img.gray[i];
  const col = { other: [0, 160, 255], '|': [0, 200, 0] };
  for (const m of meta.marks) {
    const c = col[m.c] || [255, 0, 0];
    const [x0, y0, x1, y1] = m.b.map(Math.round);
    for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) if (x >= 0 && y >= 0 && x < img.width && y < img.height) rgb.set(c, 3 * (y * img.width + x));
    for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) if (x >= 0 && y >= 0 && x < img.width && y < img.height) rgb.set(c, 3 * (y * img.width + x));
  }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${img.width}x${img.height}`, '-i', '-', out], { input: rgb });
  console.log(out, JSON.stringify(meta.meta));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (flag('--extract')) await extract();
  else if (flag('--show')) show(Number(arg('--show')));
  else if (flag('--eval')) {
    // A separate set for end-to-end scoring (tabread-eval.mjs --synth).
    await render({ pages: Number(arg('--pages', 200)), seed0: Number(arg('--seed', 900001)), par: Number(arg('--par', 4)), dir: EVAL_PAGES });
  } else {
    await render({ pages: Number(arg('--pages', 2000)), seed0: Number(arg('--seed', 1)), par: Number(arg('--par', 4)) });
    if (!flag('--no-extract')) await extract();
  }
}
