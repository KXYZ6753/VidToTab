// Play-along practice: the maths behind the sweep that fills each page.
//
// Every page carries the time it was on screen in the video (tStart–tEnd) and
// the times it came back (alsoAt), so the song's own pacing is already known:
// real speed is the video's timing, a slower or faster speed scales it, and a
// tempo in BPM is the same scale expressed against the song's tempo once that
// is known. Nothing here guesses at bars — most tab styles have no barlines to
// find — so within a page the sweep moves steadily across the notes.
//
// Kept free of the DOM so Node can check it: analysePage() takes anything
// shaped like ImageData, which is what a canvas gives the browser and what a
// raw RGBA decode gives a test.

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 2;
export const BPM_MIN = 20;
export const BPM_MAX = 400;
const MIN_PAGE_SEC = 1; // a page on screen for a blink still gets time to read

export const clampSpeed = (s) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round((Number(s) || 1) * 100) / 100));
export const cleanBpm = (b) => {
  const n = Math.round(Number(b) || 0);
  return n >= BPM_MIN && n <= BPM_MAX ? n : 0;
};

// The order the pages were played in, repeats included: a chorus shown three
// times in the video is three entries here. Gaps between pages (an intro with
// no tab on screen, an instrumental break) are not waited out.
export function buildSequence(items, { repeats = true } = {}) {
  const seq = [];
  items.forEach((it, index) => {
    if (!it || it.deleted) return;
    const dur = Math.max(MIN_PAGE_SEC, (Number(it.tEnd) || 0) - (Number(it.tStart) || 0));
    const starts = [Number(it.tStart) || 0, ...(repeats && Array.isArray(it.alsoAt) ? it.alsoAt : [])];
    for (const [k, start] of starts.entries()) {
      if (Number.isFinite(Number(start))) seq.push({ index, item: it, start: Number(start), dur, repeat: k > 0 });
    }
  });
  // Stable by construction on ties: sort is stable, and earlier items come first.
  return seq.sort((a, b) => a.start - b.start);
}

// Where the notes are on a page, so the sweep crosses the music and not the
// empty staff after the last note. A page is one or more systems: a group of
// evenly spaced horizontal lines (the tab staff, and a notation staff directly
// above it if there is one, which are swept together because they are the
// same moment). Returns systems top to bottom, each with the horizontal span
// its notes occupy, all in image pixels.
export function analysePage(img, { inkBelow = 200 } = {}) {
  const { data, width: W, height: H } = img;
  if (!W || !H) return { systems: [], found: false };
  const ink = new Uint8Array(W * H);
  const rowInk = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Transparent counts as paper; otherwise luma.
      const dark = data[i + 3] > 32 && (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 < inkBelow;
      if (dark) { ink[y * W + x] = 1; n++; }
    }
    rowInk[y] = n;
  }

  // Staff lines: rows inked across most of the width. Dashed lines (the
  // ASCII style) cover about half; solid ones nearly all of it. Runs of such
  // rows are one line drawn a few pixels thick.
  const lines = [];
  for (let y = 0; y < H; y++) {
    if (rowInk[y] < W * 0.3) continue;
    const last = lines[lines.length - 1];
    if (last && y - last.y1 <= 1) last.y1 = y;
    else lines.push({ y0: y, y1: y });
  }
  for (const l of lines) l.y = (l.y0 + l.y1) / 2;

  // Staves: consecutive lines at a steady spacing. Four to eight lines covers
  // guitar, bass, ukulele and a notation staff; anything else is a rule or a
  // border, not a staff.
  const staves = [];
  let run = [];
  const flush = () => {
    if (run.length >= 4 && run.length <= 8) staves.push(run);
    else if (run.length > 8) staves.push(run.slice(0, 8));
    run = [];
  };
  for (const l of lines) {
    if (!run.length) { run.push(l); continue; }
    const gap = l.y - run[run.length - 1].y;
    const prevGap = run.length > 1 ? run[run.length - 1].y - run[run.length - 2].y : gap;
    const steady = gap >= 4 && gap <= H / 3 && Math.abs(gap - prevGap) <= Math.max(2, prevGap * 0.35);
    if (steady) run.push(l);
    else { flush(); run.push(l); }
  }
  flush();

  const lineRows = new Uint8Array(H);
  for (const l of lines) for (let y = Math.max(0, l.y0 - 1); y <= Math.min(H - 1, l.y1 + 1); y++) lineRows[y] = 1;

  const measure = (top, bottom, spacing) => {
    // A column is a note where it has ink that is not a staff line: fret
    // numbers, chord stacks, slides, barlines. Two pixels, or a quarter of a
    // line spacing, keeps specks from stretching the span.
    const need = Math.max(2, Math.round(spacing * 0.25));
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let y = top; y <= bottom; y++) if (!lineRows[y] && ink[y * W + x]) n++;
      if (n >= need) { if (x0 < 0) x0 = x; x1 = x; }
    }
    if (x0 < 0) return { x0: 0, x1: W };
    const pad = Math.round(spacing * 0.6);
    return { x0: Math.max(0, x0 - pad), x1: Math.min(W, x1 + pad) };
  };

  let systems = staves.map((st) => {
    const gaps = st.slice(1).map((l, i) => l.y - st[i].y).sort((a, b) => a - b);
    const spacing = gaps[Math.floor(gaps.length / 2)];
    return {
      top: Math.max(0, Math.floor(st[0].y - spacing * 0.9)),
      bottom: Math.min(H - 1, Math.ceil(st[st.length - 1].y + spacing * 0.9)),
      spacing,
      lines: st.length,
    };
  });
  // A notation staff sitting directly on its tab staff is the same system.
  const merged = [];
  for (const s of systems) {
    const prev = merged[merged.length - 1];
    if (prev && s.top - prev.bottom < 2.5 * Math.max(prev.spacing, s.spacing)) {
      prev.bottom = s.bottom;
      prev.lines += s.lines;
    } else merged.push({ ...s });
  }
  systems = merged.map((s) => ({ ...s, ...measure(s.top, s.bottom, s.spacing) }));

  if (!systems.length) {
    // No staff to be found: sweep the whole picture, across whatever is on it.
    const span = measure(0, H - 1, Math.max(4, H / 12));
    return { systems: [{ top: 0, bottom: H - 1, spacing: 0, lines: 0, ...span }], found: false };
  }
  return { systems, found: true };
}

// Where the sweep is at fraction f (0..1) of the page's time. Each system gets
// a share of the time in proportion to how wide its notes are, so a short last
// line does not crawl.
export function sweepAt(systems, f) {
  const widths = systems.map((s) => Math.max(1, s.x1 - s.x0));
  const total = widths.reduce((a, b) => a + b, 0);
  let at = Math.min(1, Math.max(0, f)) * total;
  for (let i = 0; i < systems.length; i++) {
    if (at <= widths[i] || i === systems.length - 1) {
      return { system: i, x: systems[i].x0 + Math.min(widths[i], at) };
    }
    at -= widths[i];
  }
  return { system: 0, x: systems[0]?.x0 ?? 0 };
}

// ---------------------------------------------------------------- self-check

export function selfCheck(assert) {
  assert.equal(clampSpeed(0.1), SPEED_MIN);
  assert.equal(clampSpeed(3), SPEED_MAX);
  assert.equal(clampSpeed(0.754), 0.75);
  assert.equal(clampSpeed('x'), 1, 'nonsense is real speed');
  assert.equal(cleanBpm(90.4), 90);
  assert.equal(cleanBpm(5), 0, 'out of range is "not set", not clamped');

  // A chorus that came back twice plays three times, in video order.
  const items = [
    { tStart: 0, tEnd: 10, alsoAt: [40, 70] },
    { tStart: 10, tEnd: 20, alsoAt: [] },
    { tStart: 20, tEnd: 20.2, alsoAt: [], deleted: true },
    { tStart: 50, tEnd: 50.3, alsoAt: [] },
  ];
  const seq = buildSequence(items);
  assert.deepEqual(seq.map((s) => s.index), [0, 1, 0, 3, 0]);
  assert.deepEqual(seq.map((s) => s.repeat), [false, false, true, false, true]);
  assert.equal(seq[3].dur, 1, 'a page shown for a blink still gets a second');
  assert.deepEqual(buildSequence(items, { repeats: false }).map((s) => s.index), [0, 1, 3]);

  // A synthetic page: white, six grey staff lines 20px apart from y=40, one
  // dashed; notes between x=100 and x=300; a title above the staff that must
  // not widen the span.
  const W = 600;
  const H = 200;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const px = (x, y, v) => { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; };
  for (let k = 0; k < 6; k++) {
    for (let x = 0; x < W; x++) if (k !== 2 || x % 8 < 5) { px(x, 40 + k * 20, 120); px(x, 41 + k * 20, 120); }
  }
  for (const nx of [100, 180, 300]) for (let y = 55; y < 70; y++) for (let x = nx; x < nx + 8; x++) px(x, y, 0);
  for (let x = 450; x < 590; x++) for (let y = 5; y < 15; y++) px(x, y, 0); // the title
  const page = analysePage({ data, width: W, height: H });
  assert.equal(page.found, true);
  assert.equal(page.systems.length, 1);
  const s = page.systems[0];
  assert.equal(s.lines, 6, 'a dashed line is still a line');
  assert.ok(s.x0 >= 80 && s.x0 <= 100, `span starts at the first note (${s.x0})`);
  assert.ok(s.x1 >= 308 && s.x1 <= 330, `span ends after the last note, not at the edge (${s.x1})`);
  assert.ok(s.top < 40 && s.bottom > 140 && s.top > 15, 'the band covers the staff and not the title');
  assert.equal(sweepAt(page.systems, 0).x, s.x0);
  assert.equal(sweepAt(page.systems, 1).x, s.x1);

  // Two systems share the time by width.
  const two = [{ x0: 0, x1: 300 }, { x0: 0, x1: 100 }];
  assert.deepEqual(sweepAt(two, 0.5), { system: 0, x: 200 });
  assert.deepEqual(sweepAt(two, 0.9), { system: 1, x: 60 });

  // A blank picture has nothing to find and still gets one system.
  const blank = analysePage({ data: new Uint8ClampedArray(40 * 20 * 4).fill(255), width: 40, height: 20 });
  assert.equal(blank.found, false);
  assert.deepEqual([blank.systems[0].x0, blank.systems[0].x1], [0, 40]);
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
  console.log('practice.js self-check passed');
}
