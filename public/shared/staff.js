// Where the tab staves are on a page: the six string lines of every system,
// found from the page's own pixels.
//
// Shared by the practice view (which only needs each system's band and the
// span of its notes) and the tab reader (which needs every string line exactly,
// to put each fret number on the right string).
//
// A staff line is a row inked across much of the page. Dashed ASCII lines ink
// about half of it, solid ones nearly all, and lines broken around every digit
// somewhere in between — all well above the 30 % taken here. Six lines at a
// steady spacing are a tab staff. Pages add their own lines, though: a header
// rule above the staff, a panel frame below it. Those used to be taken as a
// seventh and eighth string, because each gap is judged only against the one
// before it. So a run of more than six is cut back to the six consecutive
// lines whose gaps are the most even, and a run of four or five — notation, a
// bass or ukulele tab — is reported separately rather than read as guitar.

const LINE_COVER = 0.3;   // share of the width a row needs to be a staff line
const STEADY = 0.35;      // a gap may differ this much from the previous one and still continue a run
const EVEN = 0.12;        // six chosen lines: every gap within this of their median gap

// Ink per pixel, 0..1 (1 = black), from anything shaped like ImageData.
// Transparent counts as paper.
export function inkPlane({ data, width: W, height: H }) {
  const ink = new Float32Array(W * H);
  for (let i = 0, p = 0; p < W * H; p++, i += 4) {
    if (data[i + 3] <= 32) continue;
    const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    ink[p] = 1 - luma / 255;
  }
  return ink;
}

// Candidate staff lines: runs of rows inked across much of the width.
function lineRows(ink, W, H, dark) {
  const lines = [];
  for (let y = 0; y < H; y++) {
    let n = 0;
    const row = y * W;
    for (let x = 0; x < W; x++) if (ink[row + x] >= dark) n++;
    if (n < W * LINE_COVER) continue;
    const last = lines[lines.length - 1];
    if (last && y - last.y1 <= 1) {
      last.y1 = y;
      last.sum += y * n;
      last.weight += n;
      last.cover = Math.max(last.cover, n / W);
    } else {
      lines.push({ y0: y, y1: y, sum: y * n, weight: n, cover: n / W });
    }
  }
  return lines.map((l) => ({ y: l.sum / l.weight, y0: l.y0, y1: l.y1, thick: l.y1 - l.y0 + 1, cover: l.cover }));
}

// Runs of lines at a steady spacing.
function runsOf(lines, H) {
  const runs = [];
  let run = [];
  for (const l of lines) {
    if (!run.length) { run.push(l); continue; }
    const gap = l.y - run[run.length - 1].y;
    const prev = run.length > 1 ? run[run.length - 1].y - run[run.length - 2].y : gap;
    if (gap >= 4 && gap <= H / 3 && Math.abs(gap - prev) <= Math.max(2, prev * STEADY)) run.push(l);
    else { runs.push(run); run = [l]; }
  }
  if (run.length) runs.push(run);
  return runs;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// The six consecutive lines in a run whose gaps are the most even, or null.
export function bestSix(run) {
  let best = null;
  for (let i = 0; i + 6 <= run.length; i++) {
    const six = run.slice(i, i + 6);
    const gaps = six.slice(1).map((l, k) => l.y - six[k].y);
    const m = median(gaps);
    const worst = Math.max(...gaps.map((g) => Math.abs(g - m) / m));
    if (worst > EVEN) continue;
    const cover = six.reduce((a, l) => a + l.cover, 0);
    if (!best || worst < best.worst - 0.02 || (Math.abs(worst - best.worst) <= 0.02 && cover > best.cover)) {
      best = { six, worst, cover, spacing: m };
    }
  }
  return best;
}

// Where along the staff the lines really run: the columns where at least four
// of the six lines have ink. The page may start before the staff (a clef, a
// string-name column) or the staff may stop short of the page edge.
function staffSpan(ink, W, six, dark) {
  const hit = new Uint8Array(W);
  for (const l of six) {
    const y0 = Math.max(0, Math.floor(l.y) - 1);
    const y1 = Math.floor(l.y) + 1;
    for (let x = 0; x < W; x++) {
      for (let y = y0; y <= y1; y++) {
        if (ink[y * W + x] >= dark) { hit[x]++; break; }
      }
    }
  }
  let x0 = 0;
  let x1 = W - 1;
  while (x0 < W && hit[x0] < 4) x0++;
  while (x1 > x0 && hit[x1] < 4) x1--;
  return x0 < W ? { xStart: x0, xEnd: x1 + 1 } : { xStart: 0, xEnd: W };
}

// Every six-line staff on the page, top to bottom, plus any other staff (four
// or five lines) that is not a guitar tab.
export function findStaves(img, { dark = 0.22 } = {}) {
  const { width: W, height: H } = img;
  if (!W || !H) return { systems: [], other: [], ink: null };
  const ink = img.ink || inkPlane(img);
  const lines = lineRows(ink, W, H, dark);
  const systems = [];
  const other = [];
  for (const run of runsOf(lines, H)) {
    if (run.length < 4) continue;
    const pick = run.length >= 6 ? bestSix(run) : null;
    if (!pick) {
      if (run.length <= 5) {
        const gaps = run.slice(1).map((l, k) => l.y - run[k].y);
        other.push({ lines: run.map((l) => l.y), spacing: median(gaps) });
      }
      continue;
    }
    const s = pick.spacing;
    const ys = pick.six.map((l) => l.y);
    systems.push({
      lines: ys,
      thick: pick.six.map((l) => l.thick),
      spacing: s,
      top: Math.max(0, Math.floor(ys[0] - s * 0.9)),
      bottom: Math.min(H - 1, Math.ceil(ys[5] + s * 0.9)),
      ...staffSpan(ink, W, pick.six, dark),
      evenness: pick.worst,
    });
  }
  return { systems, other, ink, lines };
}

// ---------------------------------------------------------------- self-check

// A white page with lines drawn at the given ys, optionally dashed.
export function drawPage(W, H, ys, { dashed = [], gray = 120, thick = 2 } = {}) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const px = (x, y, v) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; };
  ys.forEach((y, k) => {
    for (let x = 0; x < W; x++) {
      if (dashed.includes(k) && x % 8 >= 5) continue;
      for (let t = 0; t < thick; t++) px(x, Math.round(y) + t, gray);
    }
  });
  return { data, width: W, height: H, px };
}

export function selfCheck(assert) {
  // Six evenly spaced lines, one dashed.
  const six = [40, 60, 80, 100, 120, 140];
  let r = findStaves(drawPage(600, 200, six, { dashed: [2] }));
  assert.equal(r.systems.length, 1);
  assert.deepEqual(r.systems[0].lines.map(Math.round), six.map((y) => y + 1), 'line centres, a 2-px line centred half a pixel down');
  assert.ok(Math.abs(r.systems[0].spacing - 20) < 0.01);

  // A header rule above and a frame line below at almost the staff's spacing:
  // eight lines in one run, and the six strings are the evenly spaced middle.
  r = findStaves(drawPage(600, 260, [18, 40, 60, 80, 100, 120, 140, 157]));
  assert.equal(r.systems.length, 1, 'one staff, not an eight-string one');
  assert.deepEqual(r.systems[0].lines.map(Math.round), six.map((y) => y + 1));

  // Two systems on one page.
  r = findStaves(drawPage(600, 420, [...six, ...six.map((y) => y + 220)]));
  assert.equal(r.systems.length, 2);
  assert.ok(r.systems[1].lines[0] > r.systems[0].lines[5]);

  // A five-line staff is somebody else's music.
  r = findStaves(drawPage(600, 200, [40, 60, 80, 100, 120]));
  assert.equal(r.systems.length, 0);
  assert.equal(r.other.length, 1);

  // Lines that start after a clef: the span follows the lines, not the page.
  const page = drawPage(600, 200, []);
  for (const y of six) for (let x = 90; x < 560; x++) for (let t = 0; t < 2; t++) page.px(x, y + t, 30);
  r = findStaves(page);
  assert.equal(r.systems[0].xStart, 90);
  assert.equal(r.systems[0].xEnd, 560);

  // Uneven gaps are not a staff.
  assert.equal(bestSix([10, 30, 50, 90, 110, 130].map((y) => ({ y, cover: 1 }))), null);
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
  console.log('staff.js self-check passed');
}
