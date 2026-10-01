// Reading a tab page: every fret number, which string it is on, and which
// numbers are played together.
//
// Pure functions over anything shaped like ImageData, so the browser, the
// worker and the Node evaluation all run the same code. The steps, with every
// threshold a fraction of the string spacing s (or of the page's own digit
// height) so a 358p page and a 1080p page are read the same way:
//
//   1. staff.js finds the six string lines of each system, and where they
//      really start (a column of string names before them is not staff).
//   2. The lines are removed by shape, not colour: in each column, ink whose
//      vertical run through a line stays inside the line's band and is no
//      taller than the line is the line — unless a slanted stroke continues
//      through it (an x's arms, a 2's diagonal). That covers solid lines,
//      ASCII dashes and the styles where the lines run straight through digits.
//   3. Long vertical strokes are barlines (top string to bottom string, no
//      further), note stems (reaching well outside the staff) or strum arrows
//      (with a head); barlines are kept as positions, the rest is erased.
//      Wide flat arcs are set aside too, and an H or P over one is kept.
//   4. What is left is cut into glyphs: connected ink near a string line, the
//      size of a mark, pale smudges trimmed off dark marks. Pieces the line
//      removal cut apart are joined again (above and below a line; side by
//      side where the line breaks around them). Chord digits that touch across
//      strings are cut apart at the lightest row between the strings; a tall
//      shape without such a waist (an arpeggio wave) gives up only what
//      touches it from the side; two digits touching are cut at their joint.
//   5. Each glyph is classified (tabread-model.js), then each string is read
//      left to right: two digits written tight together are one fret, letters
//      mark the note after them, brackets and angle brackets wrap one, runs of
//      letters are words.
//   6. Notes at the same place across strings are one event — a chord.
//   7. adaptSheet() reads a whole songsheet at once: look-alike glyphs across
//      its pages vote, which settles the ones the classifier was unsure of.
//
// Nothing here guesses silently: every note carries a confidence, and pages
// the reader cannot make sense of say so in their flags.

import { findStaves, inkPlane } from './staff.js';

export const CLASSES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'x', 'h', 'p', 'b', 'r', 's', '/', '\\', '~', '(', ')', '<', '>', '|', 'other'];
export const GLYPH_W = 16;
export const GLYPH_H = 24;
export const FEATS = 8;
const DARK = 0.35; // ink level that counts as a mark; gray staff lines (~0.55) included

const isDigit = (c) => c >= '0' && c <= '9';

// ---------------------------------------------------------------- segmentation

// Ink at or above DARK, as a 0/1 mask.
function maskOf(ink) {
  const m = new Uint8Array(ink.length);
  for (let i = 0; i < ink.length; i++) m[i] = ink[i] >= DARK ? 1 : 0;
  return m;
}

// Step 2: take the string lines out of the mask, keeping whatever crosses them.
// A run no taller than the line, and within its band, is line — unless a
// stroke goes on through it:
// ink diagonally above its top and diagonally below its bottom is a slanted
// stroke (the arms of an x, the diagonal of a 2 or a 7) crossing the line,
// which a column-by-column look sees as only a line-high run.
function removeLines(mask, W, sys, x0, x1, orig) {
  const s = sys.spacing;
  const H = mask.length / W;
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && orig[y * W + x] === 1;
  for (let k = 0; k < 6; k++) {
    const yc = sys.lines[k];
    const thick = Math.max(1, sys.thick[k]);
    const limit = thick + Math.max(2, Math.round(0.06 * s));
    const ya = Math.max(0, Math.floor(yc - thick / 2 - 1));
    const yb = Math.min(H - 1, Math.ceil(yc + thick / 2 + 1));
    for (let x = x0; x < x1; x++) {
      // Find ink in the line's band, then measure the vertical run through it.
      let seed = -1;
      for (let y = ya; y <= yb; y++) if (mask[y * W + x]) { seed = y; break; }
      if (seed < 0) continue;
      let top = seed;
      let bot = seed;
      while (top > 0 && mask[(top - 1) * W + x]) top--;
      while (bot < H - 1 && mask[(bot + 1) * W + x]) bot++;
      if (bot - top + 1 > limit) continue;
      // A short run reaching well out of the band is part of a mark that
      // only grazes the line.
      if (top < ya - 1 || bot > yb + 1) continue;
      const above = at(x - 1, top - 1) || at(x + 1, top - 1);
      const below = at(x - 1, bot + 1) || at(x + 1, bot + 1);
      if (above && below) continue;
      for (let y = top; y <= bot; y++) mask[y * W + x] = 0;
    }
  }
}

// Step 3: vertical strokes at least 1.2 s tall and at most 0.2 s wide.
function takeStrokes(mask, W, sys, x0, x1) {
  const s = sys.spacing;
  const H = mask.length / W;
  const top = sys.lines[0];
  const bottom = sys.lines[5];
  const minRun = Math.round(1.2 * s);
  const maxWide = Math.max(2, Math.round(0.2 * s));
  // The longest vertical run in each column, and where it is.
  const runs = [];
  for (let x = x0; x < x1; x++) {
    let best = null;
    let start = -1;
    for (let y = 0; y <= H; y++) {
      const on = y < H && mask[y * W + x];
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        if (!best || y - start > best.len) best = { y0: start, y1: y - 1, len: y - start };
        start = -1;
      }
    }
    runs.push(best && best.len >= minRun ? best : null);
  }
  const barlines = [];
  let i = 0;
  while (i < runs.length) {
    if (!runs[i]) { i++; continue; }
    let j = i;
    while (j + 1 < runs.length && runs[j + 1]) j++;
    const width = j - i + 1;
    if (width <= maxWide) {
      const y0 = Math.min(...runs.slice(i, j + 1).map((r) => r.y0));
      const y1 = Math.max(...runs.slice(i, j + 1).map((r) => r.y1));
      const xa = x0 + i;
      const xb = x0 + j;
      const spansStaff = y0 <= top + 0.2 * s && y1 >= bottom - 0.2 * s;
      const outside = Math.max(top - y0, y1 - bottom);
      // A head: the ink either side of the stroke's ends widens out.
      const headAt = (y) => {
        let w = 0;
        for (let x = Math.max(0, xa - Math.round(0.4 * s)); x <= Math.min(W - 1, xb + Math.round(0.4 * s)); x++) if (mask[y * W + x]) w++;
        return w;
      };
      const head = Math.max(headAt(Math.min(H - 1, y0 + 2)), headAt(Math.max(0, y1 - 2))) >= 0.45 * s;
      let kind = null;
      if (spansStaff && outside < 0.5 * s && !head) kind = 'bar';
      else if (head && y1 - y0 >= 1.5 * s) kind = 'arrow';
      else if (outside > 0.5 * s) kind = 'stem';
      if (kind === 'bar') barlines.push((xa + xb) / 2);
      if (kind) {
        // Erase the stroke; a stem keeps the part inside the staff near where
        // it leaves its digit, so the digit it hangs from survives.
        const keepA = kind === 'stem' ? top - 0.45 * s : Infinity;
        const keepB = kind === 'stem' ? bottom + 0.45 * s : -Infinity;
        const pad = kind === 'arrow' ? Math.round(0.4 * s) : 0;
        for (let x = Math.max(0, xa - pad); x <= Math.min(W - 1, xb + pad); x++) {
          for (let y = y0; y <= y1; y++) {
            if (kind === 'stem' && y >= keepA && y <= keepB) continue;
            mask[y * W + x] = 0;
          }
        }
        if (kind === 'stem') {
          // The stem's last stretch inside the kept band, where the row holds
          // nothing but the stem itself, is still stem — left, it would hang
          // a tail off the digit and stretch its box.
          const onlyStem = (y) => {
            for (let x = Math.max(0, xa - 2); x <= Math.min(W - 1, xb + 2); x++) {
              if ((x < xa || x > xb) && mask[y * W + x]) return false;
            }
            return true;
          };
          for (let y = Math.min(y1, Math.floor(keepB)); y > bottom; y--) {
            if (!onlyStem(y)) break;
            for (let x = xa; x <= xb; x++) mask[y * W + x] = 0;
          }
          for (let y = Math.max(y0, Math.ceil(keepA)); y < top; y++) {
            if (!onlyStem(y)) break;
            for (let x = xa; x <= xb; x++) mask[y * W + x] = 0;
          }
        }
      }
    }
    i = j + 1;
  }
  return barlines;
}

// 8-connected components inside a box, as pixel index lists.
function components(mask, W, xa, ya, xb, yb) {
  const seen = new Uint8Array(mask.length);
  const out = [];
  const stack = [];
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const p = y * W + x;
      if (!mask[p] || seen[p]) continue;
      const px = [];
      seen[p] = 1;
      stack.push(p);
      while (stack.length) {
        const q = stack.pop();
        px.push(q);
        const qx = q % W;
        const qy = (q - qx) / W;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx;
            const ny = qy + dy;
            if (nx < xa || nx > xb || ny < ya || ny > yb) continue;
            const r = ny * W + nx;
            if (mask[r] && !seen[r]) { seen[r] = 1; stack.push(r); }
          }
        }
      }
      out.push(boxOf(px, W));
    }
  }
  return out;
}

function boxOf(px, W) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let sy = 0;
  for (const p of px) {
    const x = p % W;
    const y = (p - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    sy += y;
  }
  return { px, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: sy / px.length };
}

// Nearest string line and the distance to it.
function nearestString(sys, y) {
  let best = 0;
  for (let k = 1; k < 6; k++) if (Math.abs(sys.lines[k] - y) < Math.abs(sys.lines[best] - y)) best = k;
  return { k: best, d: Math.abs(sys.lines[best] - y) };
}

// Step 4a: a component reaching across two strings is two stacked digits
// only if it has a waist — a light row near the midpoint between the strings —
// and both halves sit on a string. Returns the pieces, or null to set it aside.
function splitStack(comp, W, sys) {
  const s = sys.spacing;
  const rows = new Map();
  for (const p of comp.px) {
    const y = Math.floor(p / W);
    rows.set(y, (rows.get(y) || 0) + 1);
  }
  const peak = Math.max(...rows.values());
  const cuts = [];
  for (let k = 0; k < 5; k++) {
    const mid = (sys.lines[k] + sys.lines[k + 1]) / 2;
    if (mid < comp.y0 || mid > comp.y1) continue;
    let bestY = -1;
    let bestN = Infinity;
    for (let y = Math.round(mid - 0.2 * s); y <= Math.round(mid + 0.2 * s); y++) {
      const n = rows.get(y) || 0;
      if (n < bestN) { bestN = n; bestY = y; }
    }
    if (bestY >= 0 && bestN <= 0.3 * peak) cuts.push(bestY);
  }
  if (!cuts.length) return null;
  const bands = [comp.y0 - 1, ...cuts, comp.y1 + 1];
  const pieces = [];
  for (let b = 0; b + 1 < bands.length; b++) {
    const px = comp.px.filter((p) => { const y = Math.floor(p / W); return y > bands[b] && y < bands[b + 1] && y !== cuts[b]; });
    if (!px.length) continue;
    const piece = boxOf(px, W);
    const { d } = nearestString(sys, piece.cy);
    if (piece.h > 1.05 * s || d > 0.35 * s) return null;
    pieces.push(piece);
  }
  return pieces.length >= 2 ? pieces : null;
}

// Connected parts of a set of pixels (8-connected).
function subComponents(px, W) {
  const left = new Set(px);
  const out = [];
  for (const p0 of px) {
    if (!left.has(p0)) continue;
    left.delete(p0);
    const part = [p0];
    for (let i = 0; i < part.length; i++) {
      const q = part[i];
      const qx = q % W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (qx + dx < 0 || qx + dx >= W) continue;
          const r = q + dy * W + dx;
          if (left.has(r)) { left.delete(r); part.push(r); }
        }
      }
    }
    out.push(boxOf(part, W));
  }
  return out;
}

// A dark mark can touch pale ink — a grey leftover of the video, a light
// smudge — and be read as one shape with it. In a component that has black
// in it, pale pixels (under 0.6) away from any dark one are not part of the
// mark; its anti-aliased edge (pale pixels touching dark ones) is.
function trimPale(comp, W, ink) {
  let max = 0;
  for (const p of comp.px) if (ink[p] > max) max = ink[p];
  if (max < 0.8) return [comp];
  const inComp = new Set(comp.px);
  const keep = comp.px.filter((p) => {
    if (ink[p] >= 0.6) return true;
    const x = p % W;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= W) continue;
        const r = p + dy * W + dx;
        if (inComp.has(r) && ink[r] >= 0.6) return true;
      }
    }
    return false;
  });
  if (keep.length === comp.px.length) return [comp];
  return subComponents(keep, W).filter((c) => c.px.length >= 3);
}

// A tall component with no waist between strings can still hold digits: a
// wavy arpeggio line, a bracket or a long stroke that one touches. Within each
// string's band, what runs through from the band's top to its bottom is that
// long shape; cut at the thinnest column, whatever does not run through is
// kept as a piece.
function splitTall(comp, W, ink, sys) {
  const s = sys.spacing;
  const pieces = [];
  for (let k = 0; k < 6; k++) {
    const top = sys.lines[k] - 0.5 * s;
    const bot = sys.lines[k] + 0.5 * s;
    if (comp.y1 < top || comp.y0 > bot) continue;
    const band = comp.px.filter((p) => { const y = Math.floor(p / W); return y >= top && y <= bot; });
    for (const part of subComponents(band, W)) {
      const through = (c) => c.y0 <= top + 1.5 && c.y1 >= bot - 1.5;
      let parts = [part];
      if (through(part) && part.w >= 0.45 * s) {
        // Split at the thinnest column in the middle, then again if needed.
        const cols = new Map();
        for (const p of part.px) { const x = p % W; cols.set(x, (cols.get(x) || 0) + ink[p]); }
        let bestX = -1;
        let bestV = Infinity;
        for (let x = part.x0 + 2; x <= part.x1 - 2; x++) { const v = cols.get(x) || 0; if (v < bestV) { bestV = v; bestX = x; } }
        if (bestX >= 0 && bestV <= 0.35 * Math.max(...cols.values())) {
          parts = subComponents(part.px.filter((p) => p % W !== bestX), W);
        }
      }
      // Only what came apart from the long shape at the cut: the long shape's
      // own ends (a wave's curl) are not marks.
      if (parts.length > 1) for (const c of parts) if (!through(c) && c.h >= 0.3 * s && c.px.length >= 3) pieces.push(c);
    }
  }
  return pieces;
}

// Step 4b: a component much wider than a digit, and about as wide as it is
// tall or wider, is two digits touching — where the columns between them thin
// to a joint. An x, an h or a wide 0 is none of that.
function splitWide(comp, W, ink, medW) {
  const cols = new Map();
  for (const p of comp.px) {
    const x = p % W;
    cols.set(x, (cols.get(x) || 0) + ink[p]);
  }
  let bestX = -1;
  let bestV = Infinity;
  for (let x = comp.x0 + Math.round(comp.w * 0.3); x <= comp.x1 - Math.round(comp.w * 0.3); x++) {
    const v = cols.get(x) || 0;
    if (v < bestV) { bestV = v; bestX = x; }
  }
  if (bestX < 0 || bestV > 0.4 * Math.max(...cols.values())) return [comp];
  const left = comp.px.filter((p) => p % W < bestX);
  const right = comp.px.filter((p) => p % W > bestX);
  if (!left.length || !right.length) return [comp];
  return [boxOf(left, W), boxOf(right, W)].flatMap((c) => (c.w > 1.35 * medW && c.w >= 0.8 * c.h ? splitWide(c, W, ink, medW) : [c]));
}

// Pieces of one mark that line removal split apart where one of its strokes
// crossed the line (the diagonal of a 2 or a 7, the bar of a 4): one above
// the other, overlapping horizontally, with nothing between them but rows of a
// line band — no more of them than line removal can take out. Pieces that
// overlap outright (a letter inside its circle) are one mark too. Judged before
// the pieces' size and place are, as the top half of a digit sitting high on
// its line can be further from it than a whole mark may be.
function mergeHalves(glyphs, W, sys) {
  const bands = sys.lines.map((yc, k) => {
    const t = Math.max(1, sys.thick[k]);
    return { a: yc - t / 2 - 2, b: yc + t / 2 + 2, limit: t + Math.max(2, Math.round(0.06 * sys.spacing)) + 1 };
  });
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < glyphs.length; i++) {
      for (let j = i + 1; j < glyphs.length; j++) {
        const a = glyphs[i];
        const b = glyphs[j];
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
        if (overlap < 0.3 * Math.min(a.w, b.w)) continue;
        const top = a.y0 <= b.y0 ? a : b;
        const bot = top === a ? b : a;
        // Rows between them (or shared by them, as few as a line is thick),
        // at a line band: cut apart by the line.
        const gap = bot.y0 - top.y1 - 1;
        const lo = Math.min(top.y1 + 1, bot.y0 - 1);
        const hi = Math.max(top.y1 + 1, bot.y0 - 1);
        const cut = bands.some((bd) => gap <= bd.limit && gap >= -bd.limit && lo <= bd.b && hi >= bd.a);
        // Or one mostly inside the other (a letter in its circle) — not a
        // smudge that merely reaches into a digit's box.
        const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
        const nested = gap <= 0 && overlap * ih >= 0.6 * Math.min(a.w * a.h, b.w * b.h);
        if (!cut && !nested) continue;
        glyphs[i] = { ...boxOf([...a.px, ...b.px], W), string: a.string };
        glyphs.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return glyphs;
}

// The line band of string k: rows that line removal may have cleared.
function bandOf(sys, k, H) {
  const yc = sys.lines[k];
  const thick = Math.max(1, sys.thick[k]);
  return [Math.max(0, Math.floor(yc - thick / 2 - 1)), Math.min(H - 1, Math.ceil(yc + thick / 2 + 1))];
}

// Is there original line ink in column x of the band?
function bandInk(orig, W, band, x) {
  if (x < 0 || x >= W) return false;
  for (let y = band[0]; y <= band[1]; y++) if (orig[y * W + x]) return true;
  return false;
}

// Where the line breaks around a glyph (white either side of it on the line),
// ink on the line inside the break belongs to the glyph. Removing the line cut
// such a glyph apart wherever one of its own strokes lay along it — the
// shoulder of an h, the bar of a 4, the crossing of an x — leaving pieces side
// by side that mergeHalves (which joins pieces above and below each other)
// does not join. Pieces next to each other on one string, joined by ink on the
// line in the original, with the line broken around the pair and no wider
// together than one character, are one glyph again.
function bridgeMerge(glyphs, W, H, orig, sys) {
  const s = sys.spacing;
  const out = [];
  for (let k = 1; k <= 6; k++) {
    const row = glyphs.filter((g) => g.string === k).sort((a, b) => a.x0 - b.x0);
    const band = bandOf(sys, k - 1, H);
    const broken = (x0, x1) => (x0 <= 1 || !bandInk(orig, W, band, x0 - 2) || !bandInk(orig, W, band, x0 - 3))
      && (x1 >= W - 2 || !bandInk(orig, W, band, x1 + 2) || !bandInk(orig, W, band, x1 + 3));
    for (let i = 0; i < row.length; i++) {
      let a = row[i];
      while (i + 1 < row.length) {
        const b = row[i + 1];
        const gap = b.x0 - a.x1 - 1;
        if (gap > Math.max(3, 0.35 * s)) break;
        const x0 = Math.min(a.x0, b.x0);
        const x1 = Math.max(a.x1, b.x1);
        if (x1 - x0 + 1 > 0.9 * s) break;
        const vo = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
        if (vo < 0.3 * Math.min(a.h, b.h)) break;
        // Both pieces reach the line, and line ink joins them.
        const touches = (g) => g.y0 <= band[1] + 1 && g.y1 >= band[0] - 1;
        if (!touches(a) || !touches(b)) break;
        let joined = true;
        for (let x = a.x1; x <= b.x0 && joined; x++) if (!bandInk(orig, W, band, x)) joined = false;
        if (!joined || !broken(x0, x1)) break;
        a = { ...boxOf([...a.px, ...b.px], W), string: k };
        i++;
      }
      out.push(a);
    }
  }
  return out;
}

// Line removal cannot tell a digit's own stroke lying along the string (the
// middle of a 3, the bar of a 4) from the line itself, and takes both. Where
// the line is broken around the digit — a white gap either side, as nearly
// every style draws it — whatever ink was on the line inside the digit's box
// is the digit's, and goes back. Where the line runs straight through, it
// stays out: that ink is mostly line, and the classifier is trained on glyphs
// cut exactly this way.
function restoreLine(g, orig, W, sys) {
  const k = g.string - 1;
  const yc = sys.lines[k];
  const thick = Math.max(1, sys.thick[k]);
  const ya = Math.floor(yc - thick / 2 - 1);
  const yb = Math.ceil(yc + thick / 2 + 1);
  if (g.y1 < ya || g.y0 > yb) return g;
  const inkAt = (x) => { for (let y = ya; y <= yb; y++) if (x >= 0 && x < W && orig[y * W + x]) return true; return false; };
  const gapLeft = g.x0 <= 1 || !inkAt(g.x0 - 2) || !inkAt(g.x0 - 3);
  const gapRight = g.x1 >= W - 2 || !inkAt(g.x1 + 2) || !inkAt(g.x1 + 3);
  if (!gapLeft || !gapRight) return { ...g, touches: true };
  const have = new Set(g.px);
  const px = [...g.px];
  for (let y = ya; y <= yb; y++) {
    for (let x = g.x0; x <= g.x1; x++) {
      const p = y * W + x;
      if (orig[p] && !have.has(p)) px.push(p);
    }
  }
  return { ...boxOf(px, W), string: g.string, touches: true, restored: true };
}

// The classifier's view of a glyph: its own ink (not its neighbours' in the
// same box), resampled into GLYPH_W×GLYPH_H keeping its proportions — each
// cell the average of a 3×3 grid of bilinear samples, so a small glyph is
// enlarged smoothly and a large one shrunk without aliasing — plus eight
// measurements of shape and place.
function describe(g, W, ink, sys, medH, pageW) {
  const s = sys.spacing;
  const crop = new Float32Array(GLYPH_W * GLYPH_H);
  const pw = g.w;
  const ph = g.h;
  const patch = new Float32Array(pw * ph);
  for (const p of g.px) {
    const x = p % W;
    const y = (p - x) / W;
    patch[(y - g.y0) * pw + (x - g.x0)] = ink[p];
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= pw || y >= ph ? 0 : patch[y * pw + x]);
  const bil = (fx, fy) => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const ay = fy - y0;
    return (1 - ay) * ((1 - ax) * at(x0, y0) + ax * at(x0 + 1, y0)) + ay * ((1 - ax) * at(x0, y0 + 1) + ax * at(x0 + 1, y0 + 1));
  };
  const scale = Math.min(GLYPH_H / ph, GLYPH_W / pw);
  const ox = (GLYPH_W - pw * scale) / 2;
  const oy = (GLYPH_H - ph * scale) / 2;
  for (let cy = 0; cy < GLYPH_H; cy++) {
    for (let cx = 0; cx < GLYPH_W; cx++) {
      let v = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          // Centre of this sub-sample in glyph pixels (pixel centres at +0.5).
          const gx = (cx + (sx + 0.5) / 3 - ox) / scale - 0.5;
          const gy = (cy + (sy + 0.5) / 3 - oy) / scale - 0.5;
          v += bil(gx, gy);
        }
      }
      crop[cy * GLYPH_W + cx] = Math.min(1, v / 9);
    }
  }
  const feats = new Float32Array(FEATS);
  feats[0] = g.h / s;
  feats[1] = g.w / s;
  feats[2] = g.w / g.h;
  feats[3] = (g.cy - sys.lines[g.string - 1]) / s;
  feats[4] = g.px.length / (g.w * g.h);
  feats[5] = holes(g, W) / 2;
  feats[6] = g.x0 <= 1 || g.x1 >= pageW - 2 ? 1 : 0;
  feats[7] = medH ? g.h / medH : 1;
  return { crop, feats };
}

// Enclosed background regions inside the glyph's box: 0 for 1, 1 for 0/6/9, 2 for 8.
function holes(g, W) {
  const w = g.w + 2;
  const h = g.h + 2;
  const on = new Uint8Array(w * h);
  for (const p of g.px) {
    const x = p % W;
    const y = (p - x) / W;
    on[(y - g.y0 + 1) * w + (x - g.x0 + 1)] = 1;
  }
  const seen = new Uint8Array(w * h);
  let regions = 0;
  for (let start = 0; start < w * h; start++) {
    if (on[start] || seen[start]) continue;
    regions++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const q = stack.pop();
      const x = q % w;
      const y = (q - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const r = ny * w + nx;
        if (!on[r] && !seen[r]) { seen[r] = 1; stack.push(r); }
      }
    }
  }
  return Math.max(0, regions - 1); // the outside is one region
}

// Arcs: wide, flat, thin curves (at least 0.8 s wide, at most 0.6 s tall,
// under a quarter of their box inked) bowed up or down. An arc bowed up with a
// letter within 0.8 s above it — H (two legs) or P (a closed bowl) — marks a
// hammer-on or pull-off on the note where it ends; a letter cut by the page
// edge says nothing. Returns the arcs and the components that are not arcs or
// their letters.
function findArcs(comps, sys, W, H) {
  const s = sys.spacing;
  const arcs = [];
  const used = new Set();
  for (const c of comps) {
    if (c.w < 0.8 * s || c.h > 0.6 * s || c.h < 2 || c.px.length > 0.25 * c.w * c.h) continue;
    // Bowed: the ends sit lower (or higher) than the middle.
    const colY = (xa, xb) => {
      let sum = 0;
      let n = 0;
      for (const p of c.px) { const x = p % W; if (x >= xa && x <= xb) { sum += (p - x) / W; n++; } }
      return n ? sum / n : null;
    };
    const e = Math.max(1, Math.round(0.12 * c.w));
    const left = colY(c.x0, c.x0 + e);
    const right = colY(c.x1 - e, c.x1);
    const mid = colY(Math.round(c.cx - e / 2), Math.round(c.cx + e / 2));
    if (left === null || right === null || mid === null) continue;
    const bow = (left + right) / 2 - mid;
    if (Math.abs(bow) < Math.max(1.5, 0.12 * s)) continue;
    const up = bow > 0;
    // Its string: the notes sit below an arc bowed up, above one bowed down.
    let k = -1;
    if (up) { for (let i = 0; i < 6; i++) if (sys.lines[i] > c.y1 - 0.1 * s) { k = i; break; } }
    else { for (let i = 5; i >= 0; i--) if (sys.lines[i] < c.y0 + 0.1 * s) { k = i; break; } }
    if (k < 0 || Math.abs(sys.lines[k] - (up ? c.y1 : c.y0)) > 0.9 * s) continue;
    const arc = { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, up, string: k + 1, letter: null };
    used.add(c);
    if (up) {
      // A letter over the arc's middle.
      const letter = comps.filter((o) => o !== c && !used.has(o) && o.y1 <= c.y0 + 0.15 * s && o.y1 >= c.y0 - 0.8 * s
        && o.cx >= c.x0 && o.cx <= c.x1 && o.h >= 0.2 * s && o.h <= 0.9 * s && o.w <= 0.8 * s);
      if (letter.length === 1) {
        const L = letter[0];
        used.add(L);
        const cut = L.x0 <= 0 || L.x1 >= W - 1 || L.y0 <= 0;
        if (!cut) arc.letter = letterHP(L, W);
      }
    }
    arcs.push(arc);
  }
  return { arcs, rest: comps.filter((c) => !used.has(c)) };
}

// H or P (either case) from shape: a closed bowl is a P; two full-height legs
// with no bowl an H; anything else, unknown.
function letterHP(L, W) {
  const n = holes(L, W);
  if (n >= 1) return 'p';
  const legs = [L.x0, L.x1].map((edge) => {
    let best = 0;
    for (let x = Math.max(L.x0, edge - 1); x <= Math.min(L.x1, edge + 1); x++) {
      let run = 0;
      for (const p of L.px) if (p % W === x) run++;
      best = Math.max(best, run);
    }
    return best;
  });
  if (legs[0] >= 0.5 * L.h && legs[1] >= 0.5 * L.h) return 'h';
  return null;
}

// Steps 1–4: the page's systems, barlines and glyphs, ready to classify.
export function segmentPage(img) {
  const { width: W, height: H } = img;
  const ink = img.ink || inkPlane(img);
  // Named, not spread: a browser ImageData keeps width, height and data on
  // its prototype, so { ...img } would carry none of them.
  const staves = findStaves({ width: W, height: H, data: img.data, ink });
  const flags = [];
  if (!staves.systems.length) {
    flags.push(staves.other.length ? 'notSixLines' : 'noStaff');
    return { found: false, flags, w: W, h: H, systems: [] };
  }
  const mask = maskOf(ink);
  const orig = mask.slice();
  const systems = [];
  for (const st of staves.systems) {
    const s = st.spacing;
    const sys = { ...st, barlines: [], glyphs: [], rejected: 0 };
    const xa = 0;
    const xb = W;
    // Room above the staff for the arcs over string 1 and their letters.
    const ya = Math.max(0, Math.floor(st.lines[0] - 1.6 * s));
    const yb = Math.min(H - 1, Math.ceil(st.lines[5] + 0.75 * s));
    removeLines(mask, W, sys, xa, xb, orig);
    sys.barlines = takeStrokes(mask, W, sys, xa, xb);
    let comps = components(mask, W, xa, ya, W - 1, yb);
    // Slur and tie arcs are not marks; one with an H or P over it says how
    // the note it ends on is played.
    const found = findArcs(comps, sys, W, H);
    sys.arcs = found.arcs;
    comps = found.rest;
    // Stacks across strings first.
    const pieces = [];
    for (const c of comps.flatMap((c0) => (c0.px.length < 3 ? [] : trimPale(c0, W, ink)))) {
      const { d } = nearestString(sys, c.cy);
      const tall = c.h > 1.05 * s;
      if (tall) {
        const split = splitStack(c, W, sys) || splitTall(c, W, ink, sys);
        if (split.length) pieces.push(...split);
        else sys.rejected++;
        continue;
      }
      if (d > 0.6 * s) { sys.rejected++; continue; }
      pieces.push(c);
    }
    // Pieces a line cut apart are joined first; then keep what is the size of
    // a mark and sits on a string.
    let glyphs = mergeHalves(pieces.filter((c) => c.h <= 1.05 * s), W, sys).filter((c) => {
      const { k, d } = nearestString(sys, c.cy);
      c.string = k + 1;
      if (d > 0.35 * s || c.h < 0.2 * s || c.h > 1.05 * s) { sys.rejected++; return false; }
      return true;
    });
    glyphs = bridgeMerge(glyphs, W, H, orig, sys);
    glyphs = glyphs.map((g) => restoreLine(g, orig, W, sys));
    // Does this page break its lines around the marks (then line ink between
    // two digits means two numbers), or run them straight through?
    const onLine = glyphs.filter((g) => g.touches && g.h >= 0.45 * s);
    sys.broken = onLine.length ? onLine.filter((g) => g.restored).length / onLine.length : 1;
    // Touching digits: split what is much wider than the page's typical digit
    // (measured on glyphs that are not narrow like a 1 or a bracket).
    const tallOnes = glyphs.filter((g) => g.h >= 0.45 * s);
    const heights0 = tallOnes.map((g) => g.h).sort((a, b) => a - b);
    const medH0 = heights0.length ? heights0[Math.floor(heights0.length / 2)] : 0.7 * s;
    const digitish = tallOnes.filter((g) => g.w >= 0.4 * g.h).map((g) => g.w).sort((a, b) => a - b);
    const medW = digitish.length ? digitish[Math.floor(digitish.length / 2)] : 0.6 * medH0;
    glyphs = glyphs.flatMap((g) => (g.h >= 0.45 * s && g.w > 1.35 * medW && g.w >= 0.8 * g.h ? splitWide(g, W, ink, medW).map((c) => ({ ...c, string: g.string })) : [g]));
    const heights = glyphs.filter((g) => g.h >= 0.45 * s).map((g) => g.h).sort((a, b) => a - b);
    const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0.7 * s;
    sys.medH = medH;
    sys.medW = medW;
    sys.glyphs = glyphs
      .sort((a, b) => a.string - b.string || a.x0 - b.x0)
      .map((g) => {
        const { crop, feats } = describe(g, W, ink, sys, medH, W);
        const { px, ...box } = g;
        // Before the lines start: a column of string names, or a chord written
        // right at the staff's left edge. Which, the classifier decides (assemble).
        return { ...box, crop, feats, edge: feats[6] === 1, before: g.x1 < st.xStart - 0.3 * s };
      });
    systems.push(sys);
  }
  // Line ink between neighbouring glyphs on a string, in the original image:
  // on pages that break their lines around the marks, a gap with line in it
  // is two numbers, not one.
  for (const sys of systems) {
    for (let i = 0; i + 1 < sys.glyphs.length; i++) {
      const a = sys.glyphs[i];
      const b = sys.glyphs[i + 1];
      if (a.string !== b.string) continue;
      const y = Math.round(sys.lines[a.string - 1]);
      let n = 0;
      let total = 0;
      for (let x = a.x1 + 1; x < b.x0; x++) { total++; if (ink[y * W + x] >= DARK) n++; }
      a.lineAfter = total ? n / total : 0;
    }
  }
  return { found: true, flags, w: W, h: H, systems };
}

// ---------------------------------------------------------------- classifier

const b64bytes = (str) => {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// A classify(glyph, sys) for readPage from a trained model (tabread-model.js):
// an MLP whose int8 weights are stored input-major with one scale per output
// unit, so a mostly empty crop only touches the rows it has ink in.
export function makeClassifier(model) {
  let net = null;
  const init = () => {
    net = model.layers.map((L) => {
      const q = b64bytes(L.w);
      return {
        nin: L.nin, nout: L.nout, relu: L.relu,
        q: new Int8Array(q.buffer, q.byteOffset, q.length),
        scale: new Float32Array(b64bytes(L.scale).buffer),
        bias: new Float32Array(b64bytes(L.bias).buffer),
      };
    });
  };
  const x = new Float32Array(GLYPH_W * GLYPH_H + FEATS);
  return function classify(g) {
    if (!net) init();
    const nc = GLYPH_W * GLYPH_H;
    for (let k = 0; k < nc; k++) x[k] = g.crop[k] < 0.02 ? 0 : g.crop[k];
    for (let k = 0; k < FEATS; k++) x[nc + k] = (Math.min(8, g.feats[k]) - model.norm.mean[k]) / model.norm.std[k];
    let a = x;
    for (const L of net) {
      const acc = new Float32Array(L.nout);
      for (let k = 0; k < L.nin; k++) {
        const v = a[k];
        if (v === 0) continue;
        const row = k * L.nout;
        for (let j = 0; j < L.nout; j++) acc[j] += v * L.q[row + j];
      }
      for (let j = 0; j < L.nout; j++) {
        acc[j] = acc[j] * L.scale[j] + L.bias[j];
        if (L.relu && acc[j] < 0) acc[j] = 0;
      }
      a = acc;
    }
    const T = model.temperature || 1;
    let m = -Infinity;
    for (let j = 0; j < a.length; j++) m = Math.max(m, a[j] / T);
    let sum = 0;
    const probs = new Float32Array(a.length);
    for (let j = 0; j < a.length; j++) { probs[j] = Math.exp(a[j] / T - m); sum += probs[j]; }
    let best = 0;
    for (let j = 0; j < a.length; j++) { probs[j] /= sum; if (probs[j] > probs[best]) best = j; }
    return { label: model.classes[best], conf: probs[best], probs };
  };
}

// ---------------------------------------------------------------- assembly

// Step 5: one string's glyphs, left to right, into notes.
function readString(glyphs, sys) {
  const s = sys.spacing;
  const notes = [];
  // How far apart the digits of one number can be, to tell "12" from "1 2":
  // a third of a digit's height between their ink; or, where a narrow 1 in a
  // font with wide, equal-width figures opens the gap further, centres less
  // than a digit's height (or two thirds of a spacing) apart. Notes written
  // with only a space between them sit half a digit apart or more, centres
  // four fifths of a spacing and more.
  const medH = sys.medH || 0.7 * s;
  const together = (a, b) => {
    const gap = b.x0 - a.x1 - 1;
    const centre = (b.x0 + b.x1) / 2 - (a.x0 + a.x1) / 2;
    return gap <= Math.max(0.1 * s, 0.36 * medH) || (gap <= 0.6 * medH && centre <= Math.max(0.9 * medH, 0.68 * s));
  };
  // Pairs that could go either way make both readings less certain.
  const borderline = (a, b) => {
    const gap = b.x0 - a.x1 - 1;
    return gap > 0.28 * medH && gap <= 0.6 * medH;
  };
  // A shape read as "other" right beside a digit may be a digit the model
  // missed — the note next to it may be short of one.
  const OTHER = CLASSES.indexOf('other');
  const digitish = (g) => g && g.label === 'other' && g.probs && 1 - g.probs[OTHER] >= 0.25;
  // The classifier's runner-up for a number: the likeliest other digit in
  // one of its places (CLASSES starts with the ten digits). Never read as
  // the note — only offered to the recording as a fret worth trying
  // (shared/timing.js) when the reading is unsure.
  const runnerUp = (digits, text) => {
    let best = null;
    digits.forEach((dg, k) => {
      if (!dg.probs) return;
      for (let d = 0; d < 10; d++) {
        if (String(d) === dg.label) continue;
        const s = text.slice(0, k) + d + text.slice(k + 1);
        if ((s.length > 1 && s[0] === '0') || Number(s) > 24) continue;
        if (!best || dg.probs[d] > best.p) best = { fret: Number(s), p: dg.probs[d] };
      }
    });
    return best && best.p >= 0.01 ? best.fret : null;
  };
  let pending = []; // technique marks waiting for the next note
  let i = 0;
  while (i < glyphs.length) {
    const g = glyphs[i];
    const c = g.label;
    if (isDigit(c)) {
      let text = c;
      let conf = g.conf;
      let x1 = g.x1;
      let y0 = g.y0;
      let y1 = g.y1;
      const digits = [g];
      const prevG = glyphs[i - 1];
      const next = glyphs[i + 1];
      if (next && isDigit(next.label) && (c === '1' || (c === '2' && next.label <= '4'))) {
        const lineBetween = (g.lineAfter || 0) > 0.5 && (sys.broken ?? 1) > 0.5;
        if (!lineBetween && borderline(g, next)) conf *= 0.88;
        if (together(g, next) && !lineBetween) {
          text += next.label;
          digits.push(next);
          conf = Math.min(conf, next.conf);
          x1 = next.x1;
          y0 = Math.min(y0, next.y0);
          y1 = Math.max(y1, next.y1);
          i++;
        }
      } else if (prevG && isDigit(prevG.label) && (prevG.label === '1' || prevG.label === '2') && !((prevG.lineAfter || 0) > 0.5 && (sys.broken ?? 1) > 0.5) && borderline(prevG, g)) {
        conf *= 0.88;
      }
      const after = glyphs[i + 1];
      if ((digitish(prevG) && g.x0 - prevG.x1 - 1 <= 0.4 * medH) || (digitish(after) && after.x0 - x1 - 1 <= 0.4 * medH)) conf *= 0.85;
      const tech = [...pending];
      pending = [];
      const grace = sys.medH && (y1 - y0 + 1) < 0.72 * sys.medH;
      if (grace) { tech.push('grace'); conf *= 0.9; }
      else if (sys.medH && (y1 - y0 + 1) > 1.25 * sys.medH) conf *= 0.88;
      const note = { string: g.string, fret: Number(text), tech, conf, box: { x: g.x0, y: y0, w: x1 - g.x0 + 1, h: y1 - y0 + 1 }, edge: g.edge };
      const alt = runnerUp(digits, text);
      if (alt !== null) note.alt = alt;
      notes.push(note);
    } else if (c === 'x') {
      notes.push({ string: g.string, fret: null, tech: ['x', ...pending], conf: g.conf, box: { x: g.x0, y: g.y0, w: g.w, h: g.h }, edge: g.edge });
      pending = [];
    } else if (c === 'h' || c === 'p' || c === 's' || c === '/' || c === '\\') {
      pending.push(c);
    } else if (c === 'b' || c === 'r') {
      // Bend or release: the digits right after it are where the bend goes,
      // not a new note.
      const prev = notes[notes.length - 1];
      const nd = glyphs[i + 1];
      if (prev && nd && isDigit(nd.label)) {
        let text = nd.label;
        if (glyphs[i + 2] && isDigit(glyphs[i + 2].label) && together(nd, glyphs[i + 2])) { text += glyphs[i + 2].label; i++; }
        prev.tech.push(c);
        prev.bendTo = Number(text);
        i++;
      }
    } else if (c === '~') {
      const prev = notes[notes.length - 1];
      if (prev) prev.tech.push('~');
    } else if (c === '(' || c === '<') {
      pending.push(c === '(' ? 'ghost' : 'harm');
    }
    // ')' and '>' close what '(' and '<' opened; 'other' and '|' carry no note.
    i++;
  }
  return notes;
}

// Step 6: notes at the same place across strings are one event.
function groupEvents(notes, sys) {
  const s = sys.spacing;
  const sorted = [...notes].sort((a, b) => (a.box.x + a.box.w / 2) - (b.box.x + b.box.w / 2));
  const events = [];
  for (const n of sorted) {
    const nx0 = n.box.x;
    const nx1 = n.box.x + n.box.w;
    const ncx = (nx0 + nx1) / 2;
    const ev = events[events.length - 1];
    if (ev) {
      const overlap = Math.min(ev.x1, nx1) - Math.max(ev.x0, nx0);
      const same = overlap >= 0.25 * Math.min(ev.x1 - ev.x0, nx1 - nx0)
        || Math.abs(ev.xc - ncx) <= 0.35 * s
        || Math.abs(ev.x0 - nx0) <= 0.25 * s;
      if (same && !ev.notes.some((m) => m.string === n.string)) {
        ev.notes.push(n);
        ev.x0 = Math.min(ev.x0, nx0);
        ev.x1 = Math.max(ev.x1, nx1);
        ev.xc = (ev.x0 + ev.x1) / 2;
        continue;
      }
    }
    events.push({ x0: nx0, x1: nx1, xc: ncx, notes: [n] });
  }
  const bars = [...sys.barlines].sort((a, b) => a - b);
  let bi = 0;
  for (const ev of events) {
    ev.notes.sort((a, b) => a.string - b.string);
    ev.barBefore = false;
    while (bi < bars.length && bars[bi] < ev.x0) { ev.barBefore = true; bi++; }
    ev.conf = Math.min(...ev.notes.map((n) => n.conf));
  }
  return events;
}

// Step 7: what cannot be right lowers confidence rather than being fixed.
function validate(events) {
  for (const ev of events) {
    const fretted = ev.notes.filter((n) => n.fret);
    if (fretted.length >= 2) {
      const frets = fretted.map((n) => n.fret).sort((a, b) => a - b);
      const med = frets[Math.floor(frets.length / 2)];
      if (frets[frets.length - 1] - frets[0] > 5) {
        for (const n of fretted) if (Math.abs(n.fret - med) > 5) n.conf *= 0.6;
      }
    }
  }
  for (let i = 0; i < events.length; i++) {
    const around = events.slice(Math.max(0, i - 3), i + 4).flatMap((e) => e.notes.filter((n) => n.fret)).map((n) => n.fret);
    if (around.length < 3) continue;
    const med = [...around].sort((a, b) => a - b)[Math.floor(around.length / 2)];
    for (const n of events[i].notes) if (n.fret !== null && Math.abs(n.fret - med) > 12) n.conf *= 0.85;
  }
  for (const ev of events) {
    for (const n of ev.notes) n.conf = Math.round(n.conf * 100) / 100;
    ev.conf = Math.min(...ev.notes.map((n) => n.conf));
  }
  return events;
}

// Words are not notes: a tight run of three or more marks on one string, at
// least two of them letters or unknown shapes, is text ("Sheet Music",
// "let ring") — its h, s or 5-shaped S included. Returns the glyphs to read.
function dropWords(glyphs, sys) {
  const s = sys.spacing;
  const medH = sys.medH || 0.7 * s;
  const noteish = (g) => isDigit(g.label) || g.label === 'x' || '()<>/\\~'.includes(g.label);
  // Only marks the height of a character make words; arc pieces and specks
  // between them neither make nor break one.
  const big = glyphs.filter((g) => g.h >= 0.45 * medH);
  const word = new Set();
  let i = 0;
  while (i < big.length) {
    let j = i;
    while (j + 1 < big.length && big[j + 1].x0 - big[j].x1 - 1 <= 0.25 * s) j++;
    const run = big.slice(i, j + 1);
    const letters = run.filter((g) => !noteish(g) && g.label !== '|').length;
    if (run.length >= 3 && letters >= 2 && letters >= run.length / 2) for (const g of run) { g.word = true; word.add(g); }
    i = j + 1;
  }
  return glyphs.filter((g) => !word.has(g));
}

// Steps 5–7 from classified glyphs: strings into notes, notes into events.
function assemble(glyphs, sys) {
  // Marks before the lines start are notes only if they read as notes: a
  // chord at the very edge does, a column of (circled) string names with its
  // arrowheads does not, and is dropped whole.
  const pre = glyphs.filter((g) => g.before && g.h >= 0.45 * (sys.medH || 0.7 * sys.spacing));
  if (pre.length) {
    const notey = pre.filter((g) => (isDigit(g.label) || g.label === 'x') && g.conf >= 0.8).length;
    if (notey < 0.6 * pre.length) glyphs = glyphs.filter((g) => !g.before);
  }
  const notes = [];
  for (let k = 1; k <= 6; k++) {
    const row = glyphs.filter((g) => g.string === k).sort((a, b) => a.x0 - b.x0);
    notes.push(...readString(dropWords(row, sys), sys));
  }
  // An arc with its H or P: the note under the arc's right end.
  const s = sys.spacing;
  for (const arc of sys.arcs || []) {
    if (!arc.letter) continue;
    const cands = notes.filter((n) => n.string === arc.string && n.box.x + n.box.w / 2 > (arc.x0 + arc.x1) / 2
      && Math.abs(n.box.x + n.box.w / 2 - arc.x1) <= 0.7 * s);
    const n = cands.sort((a, b) => Math.abs(a.box.x + a.box.w / 2 - arc.x1) - Math.abs(b.box.x + b.box.w / 2 - arc.x1))[0];
    if (n && !n.tech.includes('h') && !n.tech.includes('p')) n.tech.push(arc.letter);
  }
  return validate(groupEvents(notes, sys));
}

// The whole page. classify(glyph, sys) → { label, conf[, probs] } decides what
// each glyph is; the trained model supplies it (readPageWithModel), tests
// supply a stub. keep: true leaves each system's glyphs (crops included) on
// the result, which adaptSheet needs.
export function readPage(img, { classify, debug = false, keep = false } = {}) {
  const seg = segmentPage(img);
  if (!seg.found) return { found: false, flags: seg.flags, w: seg.w, h: seg.h, systems: [] };
  let unknown = 0;
  let total = 0;
  const systems = seg.systems.map((sys) => {
    for (const g of sys.glyphs) {
      const r = classify(g, sys);
      g.label = r.label;
      g.conf = r.conf;
      if (r.probs) g.probs = r.probs;
      total++;
      if (r.label === 'other') unknown++;
    }
    const out = { lines: sys.lines, spacing: sys.spacing, x0: sys.xStart, x1: sys.xEnd, barlines: sys.barlines, medH: sys.medH, broken: sys.broken, arcs: sys.arcs || [], events: assemble(sys.glyphs, sys) };
    if (debug || keep) out.glyphs = sys.glyphs;
    return out;
  });
  const flags = [...seg.flags];
  if (total && unknown / total > 0.2) flags.push('manyUnknown');
  if (systems.some((s) => s.events.some((e) => e.notes.some((n) => n.edge)))) flags.push('edgeCut');
  return { found: true, flags, w: seg.w, h: seg.h, systems };
}

// readPage with the trained model, loaded the first time it is needed.
let modelPromise = null;
export async function readPageWithModel(img, opts = {}) {
  if (!modelPromise) modelPromise = import('./tabread-model.js');
  const model = await modelPromise;
  return readPage(img, { ...opts, classify: model.classify });
}

// ---------------------------------------------------------------- the whole songsheet

// One songsheet is one engraver's hand: the same digit looks the same on every
// page. Glyphs of the same size whose crops correlate at 0.92 or better are
// grouped across all pages; a group of three or more that agrees (80 % of its
// confidence-weighted vote) relabels its unsure members (confidence 0.95 or
// less) to the group's label, and a confident member that disagrees marks the
// whole group unsure instead. anchors are glyphs a person corrected —
// { page, system, glyph, label } (indices into results) — and count five times.
// Takes readPage results made with keep: true and returns new ones.
export function adaptSheet(results, { anchors = [], minCorr = 0.92, minGroup = 3, agree = 0.8, unsure = 0.95 } = {}) {
  const items = [];
  results.forEach((r, pi) => {
    if (!r || !r.found) return;
    r.systems.forEach((sys, si) => {
      (sys.glyphs || []).forEach((g, gi) => items.push({ g, pi, si, gi, s: sys.spacing }));
    });
  });
  if (!items.length) return results;
  const anchorOf = new Map(anchors.map((a) => [`${a.page}/${a.system}/${a.glyph}`, a.label]));
  const n = GLYPH_W * GLYPH_H;
  // Zero-mean, unit-length crops: a dot product is then a correlation.
  for (const it of items) {
    const c = it.g.crop;
    let m = 0;
    for (let k = 0; k < n; k++) m += c[k];
    m /= n;
    const v = new Float32Array(n);
    let ss = 0;
    for (let k = 0; k < n; k++) { v[k] = c[k] - m; ss += v[k] * v[k]; }
    const inv = ss > 0 ? 1 / Math.sqrt(ss) : 0;
    for (let k = 0; k < n; k++) v[k] *= inv;
    it.v = v;
    it.h = it.g.h / it.s;
    it.w = it.g.w / it.s;
    it.anchor = anchorOf.get(`${it.pi}/${it.si}/${it.gi}`);
    it.weight = it.anchor !== undefined ? 5 : it.g.conf;
    it.label = it.anchor !== undefined ? it.anchor : it.g.label;
  }
  // Greedy grouping around the most certain glyphs first.
  const order = items.map((_, i) => i).sort((a, b) => (items[b].anchor !== undefined) - (items[a].anchor !== undefined) || items[b].weight - items[a].weight);
  const group = new Int32Array(items.length).fill(-1);
  const groups = [];
  for (const i of order) {
    if (group[i] >= 0) continue;
    const seed = items[i];
    const members = [i];
    group[i] = groups.length;
    for (let j = 0; j < items.length; j++) {
      if (group[j] >= 0) continue;
      const o = items[j];
      if (Math.abs(o.h - seed.h) > Math.max(0.04, 0.08 * seed.h) || Math.abs(o.w - seed.w) > Math.max(0.05, 0.12 * seed.w)) continue;
      let dot = 0;
      for (let k = 0; k < n; k++) dot += seed.v[k] * o.v[k];
      if (dot >= minCorr) { members.push(j); group[j] = groups.length; }
    }
    groups.push(members);
  }
  // Copies of the results with their own glyph objects, then the votes.
  const out = results.map((r) => (r && r.found ? { ...r, systems: r.systems.map((sys) => ({ ...sys, glyphs: (sys.glyphs || []).map((g) => ({ ...g })) })) } : r));
  const glyphOf = (it) => out[it.pi].systems[it.si].glyphs[it.gi];
  for (const it of items) if (it.anchor !== undefined) { const g = glyphOf(it); g.label = it.anchor; g.conf = 1; }
  let changed = 0;
  for (const members of groups) {
    if (members.length < minGroup) continue;
    const votes = new Map();
    let total = 0;
    for (const j of members) { const it = items[j]; votes.set(it.label, (votes.get(it.label) || 0) + it.weight); total += it.weight; }
    let best = null;
    for (const [label, v] of votes) if (!best || v > best[1]) best = [label, v];
    const share = best[1] / Math.max(1e-9, total);
    const dissent = members.some((j) => items[j].anchor === undefined && items[j].label !== best[0] && items[j].weight > unsure);
    for (const j of members) {
      const it = items[j];
      if (it.anchor !== undefined) continue;
      const g = glyphOf(it);
      if (dissent || share < agree) {
        // Look-alikes that do not agree: none of them is certain.
        if (it.label !== best[0] || dissent) g.conf = Math.min(g.conf, 0.5);
        continue;
      }
      if (g.label !== best[0] && g.conf <= unsure) { g.label = best[0]; g.conf = Math.min(0.95, share); changed++; }
      else if (g.label === best[0]) g.conf = Math.max(g.conf, Math.min(0.99, share * 0.99));
    }
  }
  for (const r of out) {
    if (!r || !r.found) continue;
    for (const sys of r.systems) if (sys.glyphs) sys.events = assemble(sys.glyphs, sys);
  }
  out.adapted = changed;
  return out;
}

// ---------------------------------------------------------------- self-check

// Pages drawn from strokes, so the logic can be checked without a font or a
// model: digits are drawn as simple seven-segment shapes and the stub
// classifier recognises exactly those shapes.
const SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

export function drawTab({ W = 600, H = 220, ys = [50, 74, 98, 122, 146, 170], line = 'solid', notes = [], bars = [], stems = [], extra = [] } = {}) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const px = (x, y, v = 0) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = Math.min(data[i], v); };
  const s = ys[1] - ys[0];
  const dh = Math.round(0.7 * s);
  const dw = Math.round(0.42 * s);
  const t = 2;
  const boxes = [];
  const digit = (d, x, cy) => {
    const top = Math.round(cy - dh / 2);
    const mid = Math.round(cy);
    const bot = top + dh - 1;
    const seg = SEGMENTS[d];
    const hbar = (y) => { for (let xx = x; xx < x + dw; xx++) for (let k = 0; k < t; k++) px(xx, y + k); };
    const vbar = (xx, y0, y1) => { for (let y = y0; y <= y1; y++) for (let k = 0; k < t; k++) px(xx + k, y); };
    if (seg.includes('a')) hbar(top);
    if (seg.includes('g')) hbar(mid - 1);
    if (seg.includes('d')) hbar(bot - 1);
    if (seg.includes('f')) vbar(x, top, mid);
    if (seg.includes('b')) vbar(x + dw - t, top, mid);
    if (seg.includes('e')) vbar(x, mid, bot);
    if (seg.includes('c')) vbar(x + dw - t, mid, bot);
    return { x0: x, x1: x + dw - 1, y0: top, y1: bot };
  };
  // Lines first, then clear them where a digit goes (broken styles).
  ys.forEach((y) => {
    for (let x = 0; x < W; x++) {
      if (line === 'dashed' && x % 8 >= 5) continue;
      px(x, y, 110);
      px(x, y + 1, 110);
    }
  });
  for (const n of notes) {
    const cy = ys[n.string - 1] + 1;
    let x = n.x;
    for (const d of String(n.fret)) {
      if (line !== 'through') for (let xx = x - 2; xx < x + dw + 2; xx++) for (let k = -2; k < 4; k++) { const i = ((cy + k) * W + xx) * 4; if (xx >= 0 && xx < W) data[i] = data[i + 1] = data[i + 2] = 255; }
      boxes.push({ ...digit(Number(d), x, cy), string: n.string, d });
      x += dw + (n.gap ?? 2);
    }
  }
  for (const bx of bars) for (let y = ys[0]; y <= ys[5] + 1; y++) px(bx, y, 0);
  for (const st of stems) for (let y = ys[st.string - 1] + Math.round(dh / 2); y < st.to; y++) { px(st.x, y); px(st.x + 1, y); }
  for (const e of extra) e(px, { ys, s });
  return { data, width: W, height: H, boxes, dw, dh };
}

// Recognises the drawn seven-segment digits by which segments carry ink.
export function stubClassify(g, sys) {
  const c = g.crop;
  const at = (fx, fy) => {
    let v = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = Math.min(GLYPH_W - 1, Math.max(0, Math.round(fx * (GLYPH_W - 1)) + dx));
      const y = Math.min(GLYPH_H - 1, Math.max(0, Math.round(fy * (GLYPH_H - 1)) + dy));
      v = Math.max(v, c[y * GLYPH_W + x]);
    }
    return v > 0.3;
  };
  if (g.w < 0.25 * sys.spacing) return { label: '1', conf: 0.9 };
  const lit = { a: at(0.5, 0.05), b: at(0.95, 0.25), c: at(0.95, 0.75), d: at(0.5, 0.95), e: at(0.05, 0.75), f: at(0.05, 0.25), g: at(0.5, 0.5) };
  const on = Object.keys(lit).filter((k) => lit[k]).sort().join('');
  for (const [d, segs] of Object.entries(SEGMENTS)) if ([...segs].sort().join('') === on) return { label: d, conf: 0.9 };
  return { label: 'other', conf: 0.3 };
}

export function selfCheck(assert) {
  const read = (page) => readPage(page, { classify: stubClassify });
  const events = (r) => r.systems[0].events.map((e) => e.notes.map((n) => `${n.string}:${n.fret}`).join(' '));

  // A browser ImageData keeps width, height and data on its prototype; a page
  // shaped like that must read exactly like a plain object.
  {
    const page = drawTab({ notes: [{ string: 2, fret: 3, x: 120 }, { string: 5, fret: 7, x: 260 }] });
    const like = Object.create({ get width() { return page.width; }, get height() { return page.height; }, get data() { return page.data; } });
    assert.deepEqual(events(read(like)), events(read(page)), 'an ImageData-shaped page is read the same');
    assert.ok(read(like).found, 'and its staff is found');
  }

  // A chord and single notes, on solid, dashed and through-the-digit lines.
  for (const line of ['solid', 'dashed', 'through']) {
    const page = drawTab({ line, notes: [
      { string: 1, fret: 0, x: 60 }, { string: 2, fret: 1, x: 60 }, { string: 3, fret: 0, x: 60 }, { string: 4, fret: 2, x: 60 }, { string: 5, fret: 3, x: 60 },
      { string: 3, fret: 2, x: 160 }, { string: 1, fret: 3, x: 260 }, { string: 6, fret: 5, x: 360 },
    ] });
    if (line === 'through') {
      // The line takes the digits' middle bars with it here, which the stub
      // cannot read round (the trained model is taught to): check that every
      // digit is found on its string, in its place.
      const glyphs = segmentPage(page).systems[0].glyphs;
      assert.equal(glyphs.length, page.boxes.length, 'through lines: one glyph per digit');
      for (const b of page.boxes) {
        const hit = glyphs.find((g) => g.string === b.string && Math.abs((g.x0 + g.x1) / 2 - (b.x0 + b.x1) / 2) < page.dw);
        assert.ok(hit, `through lines: digit on string ${b.string} at ${b.x0} found`);
      }
      continue;
    }
    const r = read(page);
    assert.equal(r.found, true, line);
    assert.deepEqual(events(r), ['1:0 2:1 3:0 4:2 5:3', '3:2', '1:3', '6:5'], `${line} lines`);
  }

  // "12" is one fret; "1 2" (a gap) is two notes.
  let r = read(drawTab({ notes: [{ string: 2, fret: 12, x: 100, gap: 2 }, { string: 2, fret: 1, x: 300 }, { string: 2, fret: 2, x: 330 }] }));
  assert.deepEqual(events(r), ['2:12', '2:1', '2:2']);

  // A barline is recorded, not read as a note; a stem below the staff does
  // not stop its digit being read.
  r = read(drawTab({ notes: [{ string: 6, fret: 3, x: 100 }, { string: 1, fret: 5, x: 300 }], bars: [200], stems: [{ string: 6, x: 104, to: 215 }] }));
  assert.deepEqual(events(r), ['6:3', '1:5']);
  assert.equal(r.systems[0].barlines.length, 1);
  assert.equal(r.systems[0].events[1].barBefore, true);

  // Header text above the staff and a big time-signature-like glyph spanning
  // strings are not notes.
  r = read(drawTab({ notes: [{ string: 3, fret: 7, x: 300 }], extra: [
    (px) => { for (let x = 20; x < 200; x++) for (let y = 8; y < 16; y++) if (x % 7 < 4) px(x, y); },
    (px, { ys }) => { for (let y = ys[1] - 4; y <= ys[3] + 4; y++) for (let x = 40; x < 54; x++) if (x < 44 || x > 50 || y < ys[1] || y > ys[3]) px(x, y); },
  ] }));
  assert.deepEqual(events(r), ['3:7']);

  // No staff, or a five-line one: not found, and said why.
  const blank = { data: new Uint8ClampedArray(300 * 100 * 4).fill(255), width: 300, height: 100 };
  assert.equal(read(blank).found, false);
  assert.deepEqual(read(blank).flags, ['noStaff']);
  const five = drawTab({ ys: [40, 64, 88, 112, 136] });
  assert.deepEqual(read(five).flags, ['notSixLines']);

  // Chord fret spans that cannot be played lower confidence.
  r = read(drawTab({ notes: [{ string: 1, fret: 1, x: 100 }, { string: 3, fret: 9, x: 100 }, { string: 4, fret: 2, x: 100 }] }));
  const low = r.systems[0].events[0].notes.find((n) => n.fret === 9);
  assert.ok(low.conf < 0.9, 'an outlier fret in a chord is less certain');

  // A digit whose middle bar lies on a broken line comes back whole: the
  // pieces the line removal left side by side are one glyph again.
  r = read(drawTab({ notes: [{ string: 3, fret: 4, x: 200 }, { string: 3, fret: 8, x: 300 }] }));
  assert.deepEqual(events(r), ['3:4', '3:8']);

  // A tie arc over two notes with an H above it: the second is hammered on.
  // A P (a closed bowl) is a pull-off; an arc with no letter says nothing.
  const arcWith = (letter) => (px, { ys }) => {
    for (let x = 105; x <= 190; x++) { const t = (x - 105) / 85; px(x, Math.round(ys[0] - 12 - 10 * 4 * t * (1 - t))); }
    const y0 = ys[0] - 34;
    if (letter === 'H') { for (let y = y0; y < y0 + 10; y++) { px(143, y); px(144, y); px(151, y); px(152, y); } for (let x = 143; x <= 152; x++) px(x, y0 + 5); }
    if (letter === 'P') { for (let y = y0; y < y0 + 10; y++) { px(143, y); px(144, y); } for (let x = 143; x <= 151; x++) { px(x, y0); px(x, y0 + 5); } for (let y = y0; y <= y0 + 5; y++) px(151, y); }
  };
  const tieNotes = [{ string: 1, fret: 5, x: 100 }, { string: 1, fret: 7, x: 185 }];
  const techOf = (r) => r.systems[0].events.map((e) => e.notes[0].tech.join(''));
  assert.deepEqual(techOf(read(drawTab({ notes: tieNotes, extra: [arcWith('H')] }))), ['', 'h']);
  assert.deepEqual(techOf(read(drawTab({ notes: tieNotes, extra: [arcWith('P')] }))), ['', 'p']);
  r = read(drawTab({ notes: tieNotes, extra: [arcWith(null)] }));
  assert.deepEqual(techOf(r), ['', '']);
  assert.deepEqual(events(r), ['1:5', '1:7'], 'the arc itself is no note');

  // An x whose arms cross exactly on a line stays one glyph: the crossing is a
  // stroke going through the line, not line.
  const xmark = (px, { ys }) => { for (let t = -8; t <= 8; t++) for (let w = 0; w < 2; w++) { px(300 + t + w, ys[2] + t); px(300 - t + w, ys[2] + t); } };
  let gl = segmentPage(drawTab({ notes: [{ string: 3, fret: 5, x: 100 }], extra: [xmark] })).systems[0].glyphs.filter((g) => g.x0 > 250);
  assert.equal(gl.length, 1, 'an x on the line is one glyph');
  assert.ok(gl[0].w >= 16 && gl[0].h >= 16, `the whole x (${gl[0].w}×${gl[0].h})`);

  // A pale smudge touching a digit is not part of it.
  const smudge = (px) => { for (let x = 107; x < 135; x++) for (let y = 89; y < 95; y++) px(x, y, 150); };
  gl = segmentPage(drawTab({ notes: [{ string: 3, fret: 8, x: 100 }], extra: [smudge] })).systems[0].glyphs.filter((g) => g.string === 3);
  assert.ok(gl[0].x1 <= 111, `the digit keeps its own box (${gl[0].x0}–${gl[0].x1})`);

  // A wavy arpeggio line down the staff, touching a chord's digit, gives the
  // digit up and is no note itself.
  const wave = (px, { ys }) => { for (let y = ys[0] - 6; y <= ys[5] + 6; y++) { const x = Math.round(88 + 3 * Math.sin(y / 4)); px(x, y); px(x + 1, y); px(x + 2, y); } for (let x = 86; x <= 100; x++) { px(x, ys[2] - 5); px(x, ys[2] - 4); } };
  r = read(drawTab({ notes: [{ string: 3, fret: 7, x: 100 }, { string: 5, fret: 3, x: 100 }], extra: [wave] }));
  assert.deepEqual(events(r), ['3:7 5:3'], 'the wave lets go of the 7');

  // Words on a string are not notes, even where a letter looks like a digit.
  const word = (px, { ys }) => { for (const x0 of [400, 413, 426, 439]) for (let y = ys[4] - 8; y <= ys[4] + 8; y++) for (let x = x0; x < x0 + 9; x++) if (y === ys[4] - 8 || x === x0) px(x, y); };
  r = readPage(drawTab({ notes: [{ string: 5, fret: 7, x: 200 }], extra: [word] }), {
    classify: (g, sys) => (g.x0 >= 395 ? { label: g.x0 === 413 ? '5' : 'other', conf: 0.6 } : stubClassify(g, sys)),
  });
  assert.deepEqual(events(r), ['5:7'], 'a run of letters is text');

  // A number carries the classifier's runner-up as `alt` — a fret for the
  // recording to try when the reading is unsure — in whichever of its places
  // the runner-up is likelier. A classifier without probabilities gives none.
  const withProbs = (second) => (g, sys) => {
    const r = stubClassify(g, sys);
    const probs = new Float32Array(CLASSES.length);
    probs[CLASSES.indexOf(r.label)] = 0.6;
    if (second[r.label] !== undefined) probs[CLASSES.indexOf(second[r.label])] = 0.3;
    return { ...r, probs };
  };
  r = readPage(drawTab({ notes: [{ string: 2, fret: 3, x: 120 }] }), { classify: withProbs({ 3: '8' }) });
  assert.equal(r.systems[0].events[0].notes[0].fret, 3);
  assert.equal(r.systems[0].events[0].notes[0].alt, 8, 'a 3 that might be an 8');
  r = readPage(drawTab({ notes: [{ string: 2, fret: 12, x: 100, gap: 2 }] }), { classify: withProbs({ 2: '7' }) });
  assert.equal(r.systems[0].events[0].notes[0].fret, 12);
  assert.equal(r.systems[0].events[0].notes[0].alt, 17, '12 that might be 17');
  assert.equal(read(drawTab({ notes: [{ string: 2, fret: 3, x: 120 }] })).systems[0].events[0].notes[0].alt, undefined);

  // A trained model plugs in through makeClassifier: here one layer whose
  // biases alone pick "7".
  const b64 = (typed) => { const u = new Uint8Array(typed.buffer); let t = ''; for (const c of u) t += String.fromCharCode(c); return btoa(t); };
  const nin = GLYPH_W * GLYPH_H + FEATS;
  const bias = new Float32Array(CLASSES.length);
  bias[CLASSES.indexOf('7')] = 5;
  const model = { classes: CLASSES, temperature: 1, norm: { mean: new Array(FEATS).fill(0), std: new Array(FEATS).fill(1) },
    layers: [{ nin, nout: CLASSES.length, relu: false, w: b64(new Int8Array(nin * CLASSES.length)), scale: b64(new Float32Array(CLASSES.length).fill(1)), bias: b64(bias) }] };
  const c7 = makeClassifier(model)(segmentPage(drawTab({ notes: [{ string: 1, fret: 2, x: 100 }] })).systems[0].glyphs[0]);
  assert.equal(c7.label, '7');
  assert.ok(c7.conf > 0.5 && c7.probs.length === CLASSES.length);

  // One songsheet, one hand: the same 3 on four pages, read unsure as an 8 on
  // one of them, is put right by the other three; a confident reading stays.
  const pages = [0, 1, 2, 3].map(() => drawTab({ notes: [{ string: 2, fret: 3, x: 120 }, { string: 4, fret: 5, x: 260 }] }));
  const shaky = (i) => (g, sys) => (i === 2 && g.string === 2 ? { label: '8', conf: 0.4 } : stubClassify(g, sys));
  const sheet = pages.map((pg, i) => readPage(pg, { classify: shaky(i), keep: true }));
  assert.deepEqual(events(sheet[2]), ['2:8', '4:5']);
  const fixed = adaptSheet(sheet);
  assert.deepEqual(events(fixed[2]), ['2:3', '4:5'], 'the group outvotes an unsure reading');
  assert.deepEqual(events(fixed[0]), ['2:3', '4:5']);
  // A person's correction is taken as given (and votes five times).
  const corrected = adaptSheet(sheet, { anchors: [{ page: 0, system: 0, glyph: 0, label: '8' }] });
  assert.equal(corrected[0].systems[0].events[0].notes[0].fret, 8, 'an anchor is taken as given');
  // A confident dissenter makes the group unsure instead of being overruled.
  const firm = pages.map((pg, i) => readPage(pg, { classify: i === 2 ? (g, sys) => (g.string === 2 ? { label: '8', conf: 0.99 } : stubClassify(g, sys)) : stubClassify, keep: true }));
  const firmOut = adaptSheet(firm);
  assert.equal(firmOut[2].systems[0].events[0].notes[0].fret, 8);
  assert.ok(firmOut[0].systems[0].events[0].notes[0].conf <= 0.5, 'look-alikes that disagree are all flagged');
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
  console.log('tabread.js self-check passed');
}
