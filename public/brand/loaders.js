// The brand loaders as components: build one, show it, hide it.
//
//   import { createLoader } from './loaders.js';
//   const l = createLoader('scan');
//   card.append(l.el);
//   l.show();
//   await l.hide();          // resolves once it is off screen
//
// This file only builds markup and hands the lifecycle to motion.js. Every
// pose, loop and colour lives in loaders.css, because the interesting question
// for all four of these is what the animation does at its seam, and that is a
// question about keyframes.
//
// The one piece of timing that cannot live in the stylesheet is down at the
// bottom: a fret dot's landing has to be keyed to where that dot sits on the
// staff, and only the code drawing the staff knows where that is.

import { enter, exit } from './motion.js';

export const KINDS = ['strings', 'beam', 'pages', 'scan'];

const SVG_NS = 'http://www.w3.org/2000/svg';

function make(ns, tag, attrs = {}, kids = []) {
  const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  node.append(...kids);
  return node;
}

const h = (tag, attrs, kids) => make(null, tag, attrs, kids);
const s = (tag, attrs, kids) => make(SVG_NS, tag, attrs, kids);

const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

/* ---------- strings ---------- */

// Six bars for six strings. Plain elements rather than an SVG: there is no
// geometry here beyond a row of rounded rectangles, and a flex row scales off
// --vtt-size without a viewBox in the way.
const strings = () =>
  h('span', { class: 'vtt-strings', 'aria-hidden': 'true' }, repeat(6, () => h('i')));

/* ---------- beam ---------- */

const beam = () =>
  h('span', { class: 'vtt-beam', 'aria-hidden': 'true' }, [
    s('svg', { viewBox: '0 0 64 36', preserveAspectRatio: 'none' }, [
      // pathLength is the point of the whole element: see the dash comment in
      // the stylesheet. preserveAspectRatio: none lets the frame track the
      // box's aspect ratio instead of letterboxing inside it.
      s('rect', {
        class: 'vtt-beam-frame',
        x: 1, y: 1, width: 62, height: 34, rx: 6, pathLength: 176,
      }),
    ]),
    h('i', { class: 'vtt-beam-bar' }),
  ]);

/* ---------- pages ---------- */

// Four rules per sheet, running the full width. They are what makes the flip
// seamless: a leaf mirrored onto the left page has to be the same picture as
// the left page, and full-width rules are the same picture mirrored.
const sheet = (side, extra = '') =>
  h('span', { class: `vtt-sheet vtt-sheet--${side}${extra}` }, repeat(4, () => h('b')));

const pages = () =>
  h('span', { class: 'vtt-book', 'aria-hidden': 'true' }, [
    sheet('l'),
    sheet('r'),
    sheet('r', ' vtt-leaf'),
    sheet('r', ' vtt-leaf vtt-leaf--b'),
  ]);

/* ---------- scan ---------- */

// One coordinate system for the whole picture, in the stage's own units: the
// waveform across the top, six strings below it, and the playhead crossing
// both. The stylesheet scales it with container queries, so these numbers are
// proportions rather than pixels.
const VB_W = 200;
const VB_H = 100;
const WAVE_Y = 20;          // centre line of the waveform
const WAVE_H = 14;          // its loudest half-height
const WAVE_BARS = 46;
const STRING_TOP = 50;      // first of six strings
const STRING_GAP = 9;
const DOT_R = 4.8;

// The sweep takes 88% of the 4.6s loop to cross the stage; the rest is the
// hold on the finished tab and the fade out. Kept here because the dot timings
// below are derived from it and the two have to agree.
const SWEEP_S = 4.6 * 0.88;

// A fixed shape rather than Math.random(): the same loader drawn twice — two
// stages of one job, or today's screenshot against yesterday's — has to be the
// same picture, or every visual diff is a change.
function amplitude(i) {
  const t = i / WAVE_BARS;
  const envelope = 0.36 + 0.64 * Math.abs(Math.sin(t * Math.PI * 2.7));
  const grain = 0.5 + 0.5 * Math.abs(Math.sin(i * 1.9) * Math.cos(i * 0.77));
  return envelope * grain;
}

function waveform(cls) {
  const step = (VB_W - 8) / WAVE_BARS;
  return repeat(WAVE_BARS, (i) => {
    const a = amplitude(i);
    const height = Math.max(1.6, a * WAVE_H * 2);
    return s('rect', {
      class: cls,
      x: (4 + i * step).toFixed(2),
      y: (WAVE_Y - height / 2).toFixed(2),
      width: Math.min(2.4, step * 0.6).toFixed(2),
      height: height.toFixed(2),
      rx: 1.1,
    });
  });
}

const stringY = (n) => STRING_TOP + (n - 1) * STRING_GAP;

// A plausible phrase rather than a row of the same number: x across the stage,
// which string it sits on, and the fret played.
const FRETS = [
  { x: 28, string: 4, fret: 2 },
  { x: 54, string: 2, fret: 0 },
  { x: 78, string: 5, fret: 3 },
  { x: 102, string: 3, fret: 7 },
  { x: 126, string: 1, fret: 5 },
  { x: 150, string: 4, fret: 9 },
  { x: 176, string: 6, fret: 4 },
];

function fret({ x, string, fret: number }) {
  const y = stringY(string);
  // When the clip edge reaches this dot's leading edge, to the millisecond. The
  // stylesheet turns it into the delay that drops the dot onto its string, so
  // the landing follows the playhead by construction: move a dot and its cue
  // moves with it.
  const at = ((x - DOT_R) / VB_W) * SWEEP_S;
  const g = s('g', { class: 'vtt-fret' }, [
    s('circle', { cx: x, cy: y, r: DOT_R }),
    s('text', { x, y, text: number }),
  ]);
  g.style.setProperty('--vtt-at', `${at.toFixed(3)}s`);
  return g;
}

const scanStage = () =>
  h('div', { class: 'vtt-scan-stage', 'aria-hidden': 'true' }, [
    s('svg', { class: 'vtt-scan-base', viewBox: `0 0 ${VB_W} ${VB_H}`, preserveAspectRatio: 'none' }, [
      ...waveform('vtt-wave-base'),
      s('g', { class: 'vtt-staff' }, repeat(6, (i) =>
        s('line', { x1: 4, x2: VB_W - 4, y1: stringY(i + 1), y2: stringY(i + 1) }))),
    ]),
    s('svg', { class: 'vtt-scan-ink', viewBox: `0 0 ${VB_W} ${VB_H}`, preserveAspectRatio: 'none' }, [
      ...waveform('vtt-wave-ink'),
      s('g', { class: 'vtt-staff-ink' }, repeat(6, (i) =>
        s('line', { x1: 4, x2: VB_W - 4, y1: stringY(i + 1), y2: stringY(i + 1) }))),
      ...FRETS.map(fret),
    ]),
    h('i', { class: 'vtt-scan-head' }),
  ]);

// The app's own icon, drawn from the same path data as the favicon in
// index.html so the thing that breathes here is recognisably the thing in the
// tab strip — in --accent, so it is the right orange in either theme.
const mark = () =>
  s('svg', { class: 'vtt-mark', viewBox: '0 0 32 32', 'aria-hidden': 'true' }, [
    s('rect', { class: 'vtt-mark-bg', width: 32, height: 32, rx: 8 }),
    s('path', { class: 'vtt-mark-line', d: 'M7 9h18M7 13h18M7 17h18M7 21h18' }),
    s('circle', { class: 'vtt-mark-dot', cx: 13, cy: 13, r: 2.6 }),
    s('circle', { class: 'vtt-mark-dot', cx: 20, cy: 19, r: 2.6 }),
  ]);

/* ---------- assembly ---------- */

const GRAPHIC = { strings, beam, pages, scan: scanStage };

// The scan is the only one with a caption of its own, because it is the only
// one that stands alone in the middle of a card with nothing beside it to say
// what is happening.
const DEFAULT_LABEL = { scan: 'transcribing' };

const textNode = (label) => h('span', { class: 'vtt-loader-text', text: label });

/**
 * Build a loader.
 *
 * `kind` is one of KINDS. `label` is optional visible text; the scan says
 * "transcribing" unless told otherwise, the other three say nothing unless
 * given something to say. Pass an empty string to silence the scan.
 *
 * The element comes back hidden and detached — append it, then show().
 * Returns { el, show, hide }; hide() resolves once it is off screen.
 */
export function createLoader(kind, { label } = {}) {
  // Checked against KINDS rather than against GRAPHIC, because a plain object
  // answers to 'constructor' and 'toString' with something truthy and the
  // guard would wave them through to be called as builders.
  if (!KINDS.includes(kind)) {
    throw new Error(`createLoader: unknown kind ${JSON.stringify(kind)}. Expected one of ${KINDS.join(', ')}.`);
  }

  const text = label ?? DEFAULT_LABEL[kind] ?? '';
  const el = h(kind === 'scan' ? 'div' : 'span', { class: `vtt-loader vtt-loader--${kind}` });
  el.append(GRAPHIC[kind]());

  if (text) {
    // A real text node, not a background image or a ::before: it has to be
    // reachable by a screen reader and by whatever translates the rest of the
    // interface.
    el.append(kind === 'scan'
      ? h('span', { class: 'vtt-scan-foot' }, [mark(), textNode(text)])
      : textNode(text));
  }

  // A loader announces itself exactly when it has words of its own. With a
  // label it is the progress message, so it is a live region; without one it is
  // a picture sitting beside a heading that already said "Reading video info",
  // and a second, wordless announcement of the same thing is noise.
  if (text) el.setAttribute('role', 'status');
  else el.setAttribute('aria-hidden', 'true');

  el.hidden = true;

  return {
    el,
    // Everything but the scan joins the phase the previous loaders were
    // keeping. The scan's playhead has to start at the left because its
    // position is the message. motion.js explains the mechanism.
    show: () => enter(el, { phase: kind !== 'scan' }),
    hide: () => exit(el),
  };
}
