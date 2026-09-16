// How a captured page is coloured, shared by the on-screen preview, the PNG
// export and the PDF export so that what you see is what you get. Pure module:
// no DOM, no Node APIs, so both sides import the same arithmetic instead of
// keeping two copies that drift apart.
//
// The clean render is greyscale — white paper, dark ink — so a look is just a
// two-point map: paper colour where the page is white, ink colour where it is
// black, linear in between. Mapping the whole ramp (rather than thresholding)
// keeps anti-aliased note edges and faint staff lines smooth.

export const LOOKS = [
  {
    id: 'print',
    label: 'Print',
    hint: 'Black on white, for paper',
    ink: [0, 0, 0],
    paper: [255, 255, 255],
  },
  {
    id: 'dark',
    label: 'Dark',
    hint: 'Light ink on near-black, for reading on a screen',
    ink: [235, 235, 238],
    paper: [17, 17, 19],
  },
  {
    id: 'sepia',
    label: 'Sepia',
    hint: 'Warm paper, easier under lamplight',
    ink: [58, 42, 30],
    paper: [246, 236, 218],
  },
  {
    id: 'color',
    label: 'Original',
    hint: 'Colours straight from the video',
    original: true,
  },
];

export function lookById(id) {
  return LOOKS.find((l) => l.id === id) || LOOKS[0];
}

// True when the look shows the video's own colours: it uses the colour capture
// file and must never be recoloured.
export const isOriginal = (look) => Boolean(look && look.original);

// True when the look is exactly the stored greyscale render, so the file on
// disk can be used as-is — no canvas work, no bytes sent to the server.
export const isIdentity = (look) => !look || look.id === 'print';

// Background colour behind a page (canvas fill, preview card, PDF paper).
export function paperRgb(look) {
  if (!look || look.original) return [255, 255, 255];
  return look.paper || [255, 255, 255];
}

export const rgbCss = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

// Ink colour of a look. Original has none of its own — it shows the video's
// colours — so it reports plain black for anything drawn alongside it.
export function inkRgb(look) {
  if (!look || look.original) return [0, 0, 0];
  return look.ink || [0, 0, 0];
}

// Blend two colours: t = 0 gives a, t = 1 gives b. The header's secondary text
// and hairline have to sit between paper and ink in every look, so the blend
// lives here with the rest of the colour maths rather than in the header code.
export const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Recolour RGBA pixels of a clean (greyscale) capture in place.
// Alpha is left untouched; the clean render is fully opaque.
export function applyLook(rgba, look) {
  if (isIdentity(look) || isOriginal(look)) return rgba;
  const [ir, ig, ib] = look.ink;
  const [pr, pg, pb] = look.paper;
  const dr = ir - pr, dg = ig - pg, db = ib - pb;
  for (let i = 0; i < rgba.length; i += 4) {
    // r = g = b in the clean render; read one channel and map the ramp.
    const t = (255 - rgba[i]) / 255; // 0 = paper, 1 = full ink
    rgba[i] = pr + dr * t;
    rgba[i + 1] = pg + dg * t;
    rgba[i + 2] = pb + db * t;
  }
  return rgba;
}

// ---------------------------------------------------------------- self-check

export function selfCheck(assert) {
  const px = (r, g, b) => Uint8ClampedArray.from([r, g, b, 255]);

  // Print leaves the stored render alone, so exports can use the file directly.
  assert.ok(isIdentity(lookById('print')));
  const white = px(255, 255, 255);
  applyLook(white, lookById('print'));
  assert.deepEqual([...white], [255, 255, 255, 255]);

  // Dark inverts the extremes: white paper becomes near-black, black ink light.
  const dark = lookById('dark');
  const paperPx = px(255, 255, 255);
  applyLook(paperPx, dark);
  assert.deepEqual([...paperPx].slice(0, 3), dark.paper);
  const inkPx = px(0, 0, 0);
  applyLook(inkPx, dark);
  assert.deepEqual([...inkPx].slice(0, 3), dark.ink);

  // Mid grey lands mid ramp, so anti-aliased edges stay smooth rather than
  // collapsing to one of the two colours.
  const mid = px(128, 128, 128);
  applyLook(mid, dark);
  const expect = dark.paper.map((p, i) => p + (dark.ink[i] - p) * ((255 - 128) / 255));
  expect.forEach((v, i) => assert.ok(Math.abs(mid[i] - v) <= 1, `mid ramp channel ${i}: ${mid[i]} vs ${v}`));

  // A staff line printed as grey 105 must stay visible against the paper in
  // every look — that was the point of printing it grey rather than black.
  for (const look of LOOKS.filter((l) => !l.original)) {
    const line = px(105, 105, 105);
    applyLook(line, look);
    const paper = paperRgb(look);
    const contrast = Math.abs(line[0] - paper[0]) + Math.abs(line[1] - paper[1]) + Math.abs(line[2] - paper[2]);
    assert.ok(contrast > 60, `${look.id}: staff line too close to the paper (${contrast})`);
  }

  // Original is left to the colour capture and must never be recoloured.
  const colour = px(12, 90, 200);
  applyLook(colour, lookById('color'));
  assert.deepEqual([...colour], [12, 90, 200, 255]);

  // Unknown ids fall back to Print rather than throwing mid-export.
  assert.equal(lookById('nope').id, 'print');

  // Blends land where asked and stay in range.
  assert.deepEqual(mixRgb([0, 0, 0], [200, 100, 50], 0), [0, 0, 0]);
  assert.deepEqual(mixRgb([0, 0, 0], [200, 100, 50], 1), [200, 100, 50]);
  assert.deepEqual(mixRgb([0, 0, 0], [100, 100, 100], 0.5), [50, 50, 50]);

  // The header prints on the same sheet as the pages, so its secondary text has
  // to stay legible against the paper of every look, not just white.
  for (const look of LOOKS.filter((l) => !l.original)) {
    const paper = paperRgb(look);
    const sub = mixRgb(paper, inkRgb(look), 0.55);
    assert.ok(Math.abs(sub[0] - paper[0]) > 40, `${look.id}: secondary header text too close to the paper`);
  }
}

// Run the self-check when executed directly by scripts/test.mjs. Guarded on
// `process` and imported dynamically so the browser, which loads this same
// file, never touches a Node builtin.
if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
}
