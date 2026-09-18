// The opening animation, mounted over the app and taken away again.
//
// The animation itself is in splash.css; this file owns only its lifecycle, the
// same division the brand work already uses between look.js (what a thing looks
// like) and motion.js (how it arrives and leaves).
//
// The whole of this module is written around one failure: a splash that gets
// stuck is a bricked app. Everything behind it works — the pipeline is warm, the
// buttons are live — and the user can see none of it, because a decoration threw
// on the way out. So there is no path through here that can leave the overlay
// on screen. The promise never rejects; it only ever resolves, and it resolves
// after the node is gone rather than when the fade was scheduled. A watchdog is
// armed before the first line of work that could fail and tears the overlay down
// whatever state anything else is in. Skip is deliberately generous, because
// someone who has launched this fifty times has earned a click that works.

import { FADE_MS, reducedMotion } from './motion.js';

const SHEET_URL = new URL('./splash.css', import.meta.url).href;

// A stylesheet served off localhost by our own static server answers in single
// figures of milliseconds. Anything past this is not slow, it is broken, and the
// right answer to a broken splash is no splash.
const SHEET_WAIT_MS = 1200;

// Used only if --vtt-splash-run cannot be read back. Kept equal to the value in
// splash.css so the two cannot drift silently into a visible mistake.
const RUN_FALLBACK_MS = 3120;

// A beat on the finished lockup before it goes. Without it the tagline's own
// arrival runs straight into the fade and the last pose is never actually seen,
// which defeats the point of having built up to it.
const SETTLE_MS = 400;

// FADE_MS is tuned for the loaders — a 40px chip swapping out inside a panel.
// This is the entire window dissolving to reveal an app, and at 200ms that read
// as a cut rather than a hand-off. Doubled rather than redeclared, so the two
// still move together if the shared constant is ever retuned.
const CURTAIN_MS = FADE_MS * 2;

// Under reduced motion there is no sequence to watch, just the lockup. Long
// enough to register as a deliberate title card, short enough not to be a wait.
const STILL_HOLD_MS = 520;

// The escape hatch. Comfortably past the longest legitimate run (about 3.9s)
// and well short of anyone's patience. If this is what removes the overlay,
// something above it is broken — but the app is still usable, which is the only
// thing that matters at this point.
const HARD_CAP_MS = 9000;

// ------------------------------------------------------------ the stylesheet

// splash.css is loaded on demand rather than linked from index.html, so the
// splash stays a self-contained component that a caller can import and forget.
// Refcounted because teardown removes the <link> again and two overlapping plays
// must not pull the sheet out from under each other.
let sheet = null;

function acquireSheet() {
  if (!sheet) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = SHEET_URL;
    const ready = new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      link.addEventListener('load', () => done(true), { once: true });
      link.addEventListener('error', () => done(false), { once: true });
      timer = setTimeout(() => done(false), SHEET_WAIT_MS);
    });
    document.head.appendChild(link);
    sheet = { link, ready, users: 0 };
  }
  sheet.users += 1;
  return sheet;
}

function releaseSheet(ref) {
  if (!ref || ref !== sheet) return;
  ref.users -= 1;
  if (ref.users > 0) return;
  ref.link.remove();
  sheet = null;
}

// ------------------------------------------------------------------ the DOM

// The schedule lives in splash.css, next to the keyframes it has to agree with,
// and is read back from here so that retiming the animation does not mean
// editing two files and hoping. Anything unreadable or out of range falls back
// rather than throwing — a splash that has lost its clock should still leave.
function readRunMs(el) {
  try {
    const raw = getComputedStyle(el).getPropertyValue('--vtt-splash-run').trim();
    const m = /^([\d.]+)(ms|s)$/.exec(raw);
    if (!m) return RUN_FALLBACK_MS;
    const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
    return Number.isFinite(ms) && ms >= 0 && ms <= 6000 ? ms : RUN_FALLBACK_MS;
  } catch {
    return RUN_FALLBACK_MS;
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------- the mark

// The six strings of the mark, copied straight off `.brand-mark` in
// index.html, which is the authority: a 32-unit box, stroke 1.75 with round
// caps, every string starting at x=8.92, and the right-hand ends stepping
// 6.66 / 10.83 / 14.16 / 14.16 / 10.83 / 6.66 so they trace a play triangle.
// Only [y, length] is listed because everything else is shared.
const MARK_X = 8.92;
const STRINGS = [
  [8.71, 6.66],
  [11.63, 10.83],
  [14.54, 14.16],
  [17.46, 14.16],
  [20.37, 10.83],
  [23.29, 6.66],
];

// How long each string is drawn before it tapers. 58 units is a staff wide
// enough to read as a staff — a little over four times the mark's longest
// string — and it is the same for all six, because a tab staff is six equal
// lines and only the mark is tapered.
const STAFF_LEN = 58;

// How far apart the strings sit while the staff is open, as a multiple of the
// mark's 2.91-unit spacing. 2.2 is not arbitrary: it spreads the outer strings
// to y=0 and y=32 exactly, so the open staff fills the tile's height.
const FAN = 2.2;

// The fret numbers the kit puts on the open staff: dark ink on accent dots,
// none of which survive into the mark. Taken in order from the kit's own run
// (3 2 0 2 3 3 0 2 ...). [x along the staff, which string, which fret].
const FRETS = [
  [15, 6, 3],
  [22, 5, 2],
  [29, 4, 0],
  [36, 3, 2],
  [43, 2, 3],
  [50, 1, 3],
  [57, 3, 0],
  [63, 5, 2],
];

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function svg(tag, className) {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

// Where a string waits, where it fans out to, and how much of its 58-unit path
// the taper leaves behind. Derived here rather than written into the CSS so the
// only numbers anyone has to keep in step with index.html are the six above.
function stringGeometry(y) {
  return {
    // Collapsed onto the centre line, where the barline has just been drawn.
    ty0: 16 - y,
    // Fanned out: the mark's own offset from centre, multiplied out.
    ty1: (16 + (y - 16) * FAN) - y,
  };
}

function buildArt() {
  const art = svg('svg', 'vtt-splash-art');
  art.setAttribute('viewBox', '0 0 32 32');
  art.setAttribute('fill', 'none');

  const tile = svg('rect', 'vtt-splash-tile');
  tile.setAttribute('width', '32');
  tile.setAttribute('height', '32');
  tile.setAttribute('rx', '9');

  // Tall enough to cover the staff at full spread, which reaches y=0 and y=32,
  // with a unit of overshoot at each end so the barline reads as the taller
  // gesture rather than as a line that stops exactly where the staff starts.
  const bar = svg('path', 'vtt-splash-bar');
  bar.setAttribute('d', 'M16 -1V33');

  const staff = svg('g', 'vtt-splash-staff');
  // The open staff runs from x=8.92 to x=66.92, so its middle sits at 37.92.
  // This is what carries it back to the mark's own centre.
  staff.style.setProperty('--gx', `${(16 - (MARK_X + STAFF_LEN / 2)).toFixed(2)}px`);

  STRINGS.forEach(([y, len], i) => {
    const { ty0, ty1 } = stringGeometry(y);
    const path = svg('path', 'vtt-splash-string');
    path.setAttribute('d', `M${MARK_X} ${y}H${MARK_X + STAFF_LEN}`);
    // Normalised so the dash arithmetic is in the same units as everything
    // else, rather than whatever the renderer measures the path to be.
    path.setAttribute('pathLength', String(STAFF_LEN));
    path.style.setProperty('--ty0', `${ty0.toFixed(2)}px`);
    path.style.setProperty('--ty1', `${ty1.toFixed(2)}px`);
    // What the taper leaves painted: the mark's own length of this string.
    path.style.setProperty('--off', (STAFF_LEN - len).toFixed(2));
    // Top to bottom, so the staff opens as one gesture rather than six.
    path.style.setProperty('--draw', `${360 + i * 55}ms`);
    staff.append(path);
  });

  FRETS.forEach(([x, stringNo, fret], i) => {
    const [y] = STRINGS[stringNo - 1];
    const { ty0, ty1 } = stringGeometry(y);
    // The dot rides its own string, so it is authored at that string's mark
    // position and handed the same two offsets; it is then shed before the
    // string finishes closing up.
    const group = svg('g', 'vtt-splash-fret');
    group.style.setProperty('--ty0', `${ty0.toFixed(2)}px`);
    group.style.setProperty('--ty1', `${ty1.toFixed(2)}px`);

    const pop = svg('g', 'vtt-splash-fret-pop');
    // Left to right, and finished before the fret dots are shed at 1420ms.
    pop.style.setProperty('--land', `${860 + i * 42}ms`);

    const dot = svg('circle');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
    dot.setAttribute('r', '2.5');

    const label = svg('text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(y));
    label.textContent = String(fret);

    pop.append(dot, label);
    group.append(pop);
    staff.append(group);
  });

  art.append(tile, bar, staff);
  return art;
}

function buildOverlay(tagline) {
  const root = el('div', 'vtt-splash');

  // Decoration over a page that is already there: it must not be announced, and
  // it has nothing focusable in it, so there is no focus to trap. `inert` would
  // be the stronger tool but it also stops the element being the target of a
  // pointer event, which would send a click meant to skip straight through to
  // whatever button of the app happens to be underneath.
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('role', 'presentation');

  // Set before splash.css is known to have applied. If the sheet is late, or
  // arrives broken, the worst case is a plain opaque black curtain that still
  // leaves on schedule — never a transparent overlay eating the app's clicks,
  // and never a flash of the app underneath.
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.zIndex = '2147483000';
  root.style.backgroundColor = '#0b0c0e';
  root.style.opacity = '1';

  const glow = el('div', 'vtt-splash-glow');
  const stage = el('div', 'vtt-splash-stage');

  // Built rather than written as markup: the wordmark's accent split has to
  // match `.brand b` in index.html, and the tagline is caller-supplied, so it
  // goes in as text and never as HTML.
  const word = el('p', 'vtt-splash-word');
  word.append('VidTo');
  const tab = el('b');
  tab.textContent = 'Tab';
  word.append(tab);

  const tag = el('p', 'vtt-splash-tag');
  tag.textContent = String(tagline ?? '');

  stage.append(buildArt(), word, tag);
  root.append(glow, stage);
  return root;
}

// ------------------------------------------------------------------ the play

/**
 * Play the opening animation over the page, once.
 *
 * Resolves when the overlay is gone and the element has been removed from the
 * DOM. It never rejects: a caller awaiting this is almost always about to show
 * the app, and there is no failure here worth not showing it for.
 *
 * @param {object}      [options]
 * @param {Element}     [options.host]     where the overlay is mounted
 * @param {string}      [options.tagline]  the line under the wordmark
 * @param {AbortSignal} [options.signal]   dismisses it, exactly as a click does
 * @returns {Promise<void>}
 */
export function playSplash({ host = document.body, tagline = 'video → songsheet', signal } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    let leaving = false;
    let node = null;
    let sheetRef = null;
    const timers = [];

    const at = (ms, fn) => {
      timers.push(setTimeout(fn, ms));
    };

    // Everything unwinds here, and only here. Idempotent, because it is reached
    // from the natural end, from a click, from a keypress, from an abort, from
    // the watchdog and from the catch below — sometimes several of those within
    // a frame of each other.
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      try { window.removeEventListener('keydown', onKey, true); } catch { /* nothing left to remove */ }
      try { signal?.removeEventListener?.('abort', onAbort); } catch { /* not an AbortSignal */ }
      // The pointer listeners live on the node and go with it; the keydown one
      // is on window and is the only one that could outlive the overlay.
      try { node?.remove(); } catch { /* already detached */ }
      node = null;
      try { releaseSheet(sheetRef); } catch { /* sheet already released */ }
      sheetRef = null;
      resolve();
    };

    // Start the fade from wherever the animation currently is. This is the
    // hand-off, and it is a transition rather than a keyframe precisely so that
    // it has no opinion about which pose it starts from.
    const leave = () => {
      if (finished || leaving) return;
      leaving = true;
      try {
        // A skip that arrives in the same tick as the mount — an AbortSignal
        // aborted immediately, most obviously — would otherwise have its start
        // and end opacity collapsed into one style resolution, and cut instead
        // of fading. Reading the computed value forces the starting style to
        // exist before the value that changes it is written.
        getComputedStyle(node).opacity; // eslint-disable-line no-unused-expressions
        // Inline, to beat the inline opacity:1 written at mount. A class that
        // sets opacity in splash.css loses to it and the overlay cuts instead
        // of fading — which is invisible in a screenshot and was only caught by
        // sampling the computed opacity through the hand-off.
        node.style.opacity = '0';
      } catch {
        finish();
        return;
      }
      // Driven by a timer, not transitionend: transitionend does not fire if the
      // transition is interrupted, if the element is hidden part way through, or
      // in a backgrounded window, and every one of those would strand the
      // overlay. The extra frame of slack covers a fade that starts a tick late.
      at(CURTAIN_MS + 60, finish);
    };

    const onKey = (e) => {
      // A bare modifier is someone reaching for a shortcut, not someone asking
      // for this to go away; everything else counts, including Escape.
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      leave();
    };
    const onAbort = () => leave();

    try {
      // Armed first, before the DOM, the stylesheet or the schedule — all of
      // which can fail, and none of which can stop this.
      at(HARD_CAP_MS, finish);

      if (typeof document === 'undefined' || !host || typeof host.appendChild !== 'function') {
        finish();
        return;
      }
      if (signal?.aborted) {
        finish();
        return;
      }

      sheetRef = acquireSheet();
      sheetRef.ready.then((ok) => {
        if (finished) return;
        // No stylesheet, no splash. Showing the lockup unstyled — three lines of
        // raw text on a black rectangle — is worse than launching straight into
        // the app, and this is the only branch where nothing has been mounted
        // yet, so it costs nothing to take.
        if (!ok) {
          finish();
          return;
        }

        node = buildOverlay(tagline);
        const still = reducedMotion();
        if (still) node.classList.add('vtt-splash--still');

        // One number for the CSS transition and the JS timer that waits on it,
        // so they cannot disagree about when the curtain is actually gone.
        const fadeMs = still ? FADE_MS : CURTAIN_MS;
        node.style.setProperty('--vtt-splash-fade', `${fadeMs}ms`);

        // Pointer first: it fires before click and makes the skip feel immediate
        // on a press rather than on a release. `click` stays as the fallback for
        // anything not dispatching pointer events. Both land on the overlay, so
        // the app underneath never sees the skip.
        node.addEventListener('pointerdown', leave);
        node.addEventListener('click', leave);
        window.addEventListener('keydown', onKey, true);
        try { signal?.addEventListener?.('abort', onAbort, { once: true }); } catch { /* not an AbortSignal */ }

        host.appendChild(node);

        // No entrance on the overlay itself. The curtain has to be opaque from
        // the first frame it exists, or launch shows a flash of the app before
        // the splash that was meant to cover it.
        at(still ? STILL_HOLD_MS : readRunMs(node) + SETTLE_MS, leave);
      }, () => finish());
    } catch {
      // Belt to the watchdog's braces: an exception anywhere above resolves now
      // rather than in nine seconds.
      finish();
    }
  });
}
