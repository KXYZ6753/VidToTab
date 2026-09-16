// Eval harness for the target videos in scripts/eval-set.json.
//
//   npm run eval                          detection + pipeline on every video
//   npm run eval -- --only a,b            subset of ids
//   npm run eval -- --detect-only         region detection only
//   npm run eval -- --label               frame grid + 1-fps strips for hand labeling
//   npm run eval -- --sens 0.25,0.5,0.75  sensitivities (default 0.5)
//   npm run eval -- --crop detected       feed the detected crop to the pipeline
//                                         (default: the hand-labeled crop)
//   npm run eval -- --tag baseline        name for this run's outputs
//   npm run eval -- --no-download         skip videos that aren't cached
//
// Scoring. Labels are "t:id" page starts. A capture is correct when its tStart
// is within `tolerance` of a start whose screen has no capture yet; landing on
// a repeat of an already-captured screen is an escaped duplicate; landing on
// nothing (intro, outro, mid-page split) is spurious. Recall = screens with at
// least one capture. Repeats should be folded into alsoAt; a *different*
// screen folded into alsoAt is a wrong merge (its notes are lost).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YT_DOWNLOAD_ARGS, noteClientSuccess, orderedClients } from '../pipeline/config.js';
import { probeVideo, rawFrames } from '../pipeline/ffmpeg.js';
import { detectRegion } from '../pipeline/detect.js';
import { runPipeline } from '../pipeline/index.js';
import { toolPath } from '../pipeline/tools.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'eval');
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'eval-set.json'), 'utf8'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const only = opt('only', '') ? opt('only').split(',') : null;
const sensList = opt('sens', '0.5').split(',').map(Number);
const cropSource = opt('crop', 'expected');
const tag = opt('tag', 'run');
const log = (...a) => console.log(...a);
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;

function sh(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const ffmpeg = (args) => sh(toolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

// ------------------------------------------------------------ video cache

async function ensureVideo(v, dir) {
  const file = v.file ? path.resolve(ROOT, v.file) : path.join(dir, 'video.mp4');
  if (fs.existsSync(file)) return file;
  if (!v.url || flag('no-download')) return null;
  fs.mkdirSync(dir, { recursive: true });
  // Same adaptation as the server: whichever client last worked is tried first,
  // so fetching a set of videos does not repeat a doomed attempt every time.
  for (const client of orderedClients()) {
    for (const f of fs.readdirSync(dir)) if (f.startsWith('video.')) fs.rmSync(path.join(dir, f), { force: true });
    log(`  downloading via ${client.label}…`);
    const r = await sh(toolPath('yt-dlp'), ['-q', '--no-warnings', ...YT_DOWNLOAD_ARGS, ...client.args,
      '-o', path.join(dir, 'video.%(ext)s'), '--', v.url]);
    if (r.code === 0 && fs.existsSync(file)) { noteClientSuccess(client.label); return file; }
    log(`  failed: ${r.err.trim().split('\n').pop()}`);
  }
  return null;
}

// ------------------------------------------------------------ labeling aids

async function label(v, dir, video, info) {
  const out = path.join(dir, 'label');
  fs.mkdirSync(out, { recursive: true });
  for (const f of [0.3, 0.55]) {
    await ffmpeg(['-ss', String(round(info.duration * f)), '-i', video, '-frames:v', '1', '-vf',
      'drawgrid=w=50:h=50:t=1:c=cyan@0.5,drawgrid=w=250:h=250:t=3:c=red@0.9,scale=1280:-2',
      path.join(out, `frame-grid-${f}.png`)]);
  }
  const c = v.expect?.crop;
  if (!c) return log(`  wrote ${out}/frame-grid-*.png (add expect.crop, then re-run --label for strips)`);
  for (const f of fs.readdirSync(out)) if (f.startsWith('strip-')) fs.rmSync(path.join(out, f));
  const sw = Math.min(495, Math.round(c.w * 0.4)) & ~1;
  // 4 x 12 tiles at 1 fps: sheet s (1-based), row r, col c -> t = 48(s-1) + 4r + c
  await ffmpeg(['-i', video, '-an', '-vf',
    `fps=1,crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${sw}:-2:flags=area,tile=4x12:padding=6:margin=6:color=white`,
    '-fps_mode', 'passthrough', path.join(out, 'strip-%02d.png')]);
  log(`  wrote ${out}/strip-*.png (t = 48*(sheet-1) + 4*row + col)`);
}

// ------------------------------------------------------------ metrics

export function iou(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function parseSequence(s) {
  if (!s) return [];
  return s.trim().split(/\s+/).map((tok) => {
    const [t, id] = tok.split(':');
    return { t: Number(t), id };
  }).sort((a, b) => a.t - b.t);
}

export function scoreCaptures(captures, expect, tol) {
  const seq = parseSequence(expect?.sequence);
  if (seq.length === 0) return null;
  const canon = new Map();
  for (const group of expect.equiv || []) for (const id of group) canon.set(id, group[0]);
  const groupOf = (id) => canon.get(id) ?? id;
  const optional = new Set((expect.optional || []).map(groupOf));
  const nearest = (t) => {
    let best = null;
    for (const s of seq) {
      const d = Math.abs(s.t - t);
      if (d <= tol && (best === null || d < best.d)) best = { ...s, d };
    }
    return best;
  };
  const covered = new Map();
  const dups = [], spurious = [], wrongMerges = [];
  let correct = 0, repeatsFound = 0;
  const sorted = [...captures].sort((a, b) => a.tStart - b.tStart);
  for (const c of sorted) {
    const m = nearest(c.tStart);
    if (m === null) {
      spurious.push(round(c.tStart, 1));
      continue;
    }
    const g = groupOf(m.id);
    const seen = covered.get(g);
    if (!seen) {
      covered.set(g, new Set([m.id]));
      correct++;
    } else if (!seen.has(m.id)) {
      seen.add(m.id); // an equivalent variant (extra section label) — fine either way
      correct++;
    } else {
      dups.push(`${m.id}@${round(c.tStart, 1)}`);
    }
    for (const a of c.alsoAt || []) {
      const n = nearest(a);
      if (n !== null && groupOf(n.id) === g) repeatsFound++;
      else if (n !== null) wrongMerges.push(`${n.id}@${round(a, 1)}→${m.id}`);
    }
  }
  const firstSeen = new Set();
  let repeats = 0;
  for (const s of seq) {
    const g = groupOf(s.id);
    if (firstSeen.has(g)) repeats++;
    firstSeen.add(g);
  }
  const required = [...firstSeen].filter((g) => !optional.has(g));
  const missing = required.filter((g) => !covered.has(g))
    .map((g) => `${g}@${seq.find((s) => groupOf(s.id) === g).t}`);
  return {
    screens: required.length,
    captures: sorted.length,
    recall: round((required.length - missing.length) / required.length, 3),
    precision: sorted.length ? round(correct / sorted.length, 3) : 0,
    missing, dups, spurious, wrongMerges,
    repeats, repeatsFound,
  };
}

async function decodePng(file, pixFmt, bytesPerPx) {
  const info = await probeVideo(file);
  if (!info) return null;
  for await (const f of rawFrames(file, { vf: `format=${pixFmt}`, frameBytes: info.width * info.height * bytesPerPx })) {
    return { data: f, w: info.width, h: info.height };
  }
  return null;
}

// Share of strongly saturated pixels in color captures (leftover highlights and
// cursors), and share of dark pixels in clean captures (a surviving dark block).
async function imageStats(workDir, captures) {
  let sat = 0, satN = 0, ink = 0, inkN = 0;
  for (const c of captures) {
    const colorFile = c.pngColor ?? (c.png && !c.clean ? c.png : null);
    if (colorFile) {
      const img = await decodePng(path.join(workDir, colorFile), 'rgb24', 3);
      if (img) {
        for (let j = 0; j < img.data.length; j += 3) {
          const r = img.data[j], g = img.data[j + 1], b = img.data[j + 2];
          if (Math.max(r, g, b) - Math.min(r, g, b) > 60) sat++;
        }
        satN += img.data.length / 3;
      }
    }
    if (c.pngColor) {
      const img = await decodePng(path.join(workDir, c.png), 'gray', 1);
      if (img) {
        for (const v of img.data) if (v < 128) ink++;
        inkN += img.data.length;
      }
    }
  }
  return { saturated: satN ? round(sat / satN, 4) : null, cleanInk: inkN ? round(ink / inkN, 4) : null };
}

async function contactSheets(workDir, captures, key, outPrefix) {
  const files = captures.map((c) => c[key]).filter(Boolean).map((f) => path.join(workDir, f));
  const per = 12;
  const sheets = [];
  for (let s = 0; s * per < files.length; s++) {
    const list = path.join(workDir, `.sheet-${key}-${s}.txt`);
    fs.writeFileSync(list, files.slice(s * per, (s + 1) * per).map((f) => `file '${f}'\nduration 1\n`).join(''));
    const out = `${outPrefix}-${String(s + 1).padStart(2, '0')}.png`;
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf',
      'scale=900:-2:flags=area,format=rgb24,pad=iw+12:ih+12:6:6:color=white,tile=2x6:color=white',
      '-frames:v', '1', out]);
    fs.rmSync(list, { force: true });
    sheets.push(out);
  }
  return sheets;
}

async function drawDetect(video, t, detected, expected, out) {
  const boxes = [];
  if (expected) boxes.push(`drawbox=x=${expected.x}:y=${expected.y}:w=${expected.w}:h=${expected.h}:color=red@0.9:t=5`);
  if (detected) boxes.push(`drawbox=x=${detected.x}:y=${detected.y}:w=${detected.w}:h=${detected.h}:color=lime@0.9:t=3`);
  await ffmpeg(['-ss', String(round(t)), '-i', video, '-frames:v', '1', '-vf', [...boxes, 'scale=1280:-2'].join(','), out]);
}

// ------------------------------------------------------------ main

const rows = [];
let failed = false;

// Gate. A fixture may record the score it is known to reach as expect.floor, with
// the reason written in expect.notes; anything below that floor is a regression.
// Fixtures without a floor must be perfect. Never lower a floor to make a run
// green — fix the pipeline, or write down why the labels changed.
const DEFAULT_FLOOR = { recall: 1, precision: 0.9 };
function gateFail(v, score) {
  if (!score) return false;
  const f = { ...DEFAULT_FLOOR, ...(v.expect?.floor || {}) };
  if (score.recall < f.recall - 1e-9 || score.precision < f.precision - 1e-9) {
    log(`  GATE FAIL: recall ${score.recall} (floor ${f.recall}), precision ${score.precision} (floor ${f.precision})`);
    return true;
  }
  // Only worth saying for a fixture that records its own floor: a default-floor
  // fixture scoring 1.0 is the normal case, not news.
  if (v.expect?.floor && (score.recall > f.recall + 0.02 || score.precision > f.precision + 0.02)) {
    log(`  note: beats its recorded floor (recall ${score.recall} vs ${f.recall}, precision ${score.precision} vs ${f.precision}) — raise expect.floor once it holds`);
  }
  return false;
}

for (const v of SET.videos) {
  if (only && !only.includes(v.id)) continue;
  const dir = path.join(CACHE, v.id);
  log(`\n== ${v.id}  ${v.title}`);
  const video = await ensureVideo(v, dir);
  if (!video) {
    log('  (no video — skipped)');
    rows.push({ id: v.id, status: 'no video' });
    continue;
  }
  const info = await probeVideo(video);
  if (flag('label')) {
    await label(v, dir, video, info);
    continue;
  }
  const outDir = path.join(dir, `out-${tag}`);
  if (flag('rescore')) {
    // Re-score a previous run's saved captures against the current labels.
    for (const sensitivity of sensList) {
      const file = path.join(outDir, `captures-${sensitivity}.json`);
      if (!fs.existsSync(file)) {
        log(`  no saved captures for sens ${sensitivity} in ${outDir}`);
        continue;
      }
      const captures = JSON.parse(fs.readFileSync(file, 'utf8'));
      const score = scoreCaptures(captures, v.expect, SET.tolerance);
      rows.push({ id: v.id, sensitivity, captures: captures.length, ...(score || {}) });
      log(`  sens ${sensitivity}: ${captures.length} captures` + (score
        ? ` | recall ${score.recall} precision ${score.precision} | missing [${score.missing.join(' ')}]`
          + ` dups [${score.dups.join(' ')}] spurious [${score.spurious.join(' ')}]`
          + ` wrongMerges [${score.wrongMerges.join(' ')}] repeats ${score.repeatsFound}/${score.repeats}`
        : ''));
      if (gateFail(v, score)) failed = true;
    }
    continue;
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  const det = await detectRegion(video, info);
  const detectS = round((Date.now() - t0) / 1000, 1);
  const expected = v.expect?.crop ?? null;
  const detIou = expected && det?.crop ? round(iou(det.crop, expected), 3) : null;
  const midT = det?.tabRange ? (det.tabRange[0] + det.tabRange[1]) / 2 : info.duration * 0.4;
  await drawDetect(video, midT, det?.crop, expected, path.join(outDir, 'detect.png'));
  log(`  detect: ${JSON.stringify(det?.crop)} conf=${det?.confidence} pol=${det?.polarity} iou=${detIou} (${detectS}s)`);
  const base = { id: v.id, detectIou: detIou, detectConf: det?.confidence ?? null, detectS };
  if (expected && detIou !== null && detIou < 0.7) failed = true;

  // Videos with no tab on screen must be declined, not boxed. That is the other
  // half of accuracy and it was only ever checked by eye: a change that starts
  // finding "tabs" in piano videos should fail here, not in someone's export.
  // Running the pipeline on them would only measure how convincing the junk is.
  if (v.noTab) {
    const declined = !det?.crop;
    Object.assign(base, { noTab: true, declined });
    log(`  negative: ${declined
      ? 'declined, as it should be'
      : `DETECTED A BOX ${JSON.stringify(det.crop)} conf=${det.confidence} — regression`}`);
    if (!declined) failed = true;
    rows.push(base);
    continue;
  }
  if (flag('detect-only')) {
    rows.push(base);
    continue;
  }

  const crop = cropSource === 'detected' ? det?.crop : expected ?? det?.crop;
  if (!crop) {
    log('  no crop available — skipped pipeline');
    rows.push({ ...base, status: 'no crop' });
    continue;
  }
  for (const sensitivity of sensList) {
    const workDir = path.join(outDir, `work-${sensitivity}`);
    const warnings = [];
    const t1 = Date.now();
    let captures;
    try {
      captures = await runPipeline(video, {
        crop, startTime: 0, sensitivity, workDir, polarity: det?.polarity ?? null,
      }, (ev) => { if (ev.phase === 'warning') warnings.push(ev.msg); });
    } catch (e) {
      log(`  pipeline error: ${e.userMsg || e.message}`);
      rows.push({ ...base, sensitivity, status: 'error' });
      failed = true;
      continue;
    }
    const seconds = round((Date.now() - t1) / 1000, 1);
    const score = scoreCaptures(captures, v.expect, SET.tolerance);
    const stats = await imageStats(workDir, captures);
    const sheetsClean = await contactSheets(workDir, captures, 'png', path.join(outDir, `contact-${sensitivity}-png`));
    if (captures.some((c) => c.pngColor)) {
      await contactSheets(workDir, captures, 'pngColor', path.join(outDir, `contact-${sensitivity}-color`));
    }
    const row = { ...base, sensitivity, captures: captures.length, seconds, ...stats, warnings };
    if (score) Object.assign(row, score);
    rows.push(row);
    fs.writeFileSync(path.join(outDir, `captures-${sensitivity}.json`), JSON.stringify(captures, null, 2));
    log(`  sens ${sensitivity}: ${captures.length} captures in ${seconds}s` + (score
      ? ` | recall ${score.recall} precision ${score.precision} | missing [${score.missing.join(' ')}]`
        + ` dups [${score.dups.join(' ')}] spurious [${score.spurious.join(' ')}]`
        + ` wrongMerges [${score.wrongMerges.join(' ')}] repeats ${score.repeatsFound}/${score.repeats}`
      : '') + ` | sat ${stats.saturated} cleanInk ${stats.cleanInk} | sheets ${sheetsClean.length}`);
    if (warnings.length) log(`  warnings: ${warnings.join(' / ')}`);
    if (gateFail(v, score)) failed = true;
  }
}

fs.mkdirSync(CACHE, { recursive: true });
fs.writeFileSync(path.join(CACHE, `summary-${tag}.json`), JSON.stringify(rows, null, 2));
log('\nid            sens  caps  recall  prec   dups spur  iou    conf  time');
for (const r of rows) {
  log([
    r.id.padEnd(13), String(r.sensitivity ?? '-').padEnd(5), String(r.captures ?? '-').padEnd(5),
    String(r.recall ?? '-').padEnd(7), String(r.precision ?? '-').padEnd(6),
    String(r.dups?.length ?? '-').padEnd(4), String(r.spurious?.length ?? '-').padEnd(5),
    String(r.detectIou ?? '-').padEnd(6), String(r.detectConf ?? '-').padEnd(5), String(r.seconds ?? r.status ?? '-'),
  ].join(' '));
}
log(`\nsummary: ${path.join(CACHE, `summary-${tag}.json`)}`);
process.exit(failed ? 1 : 0);
