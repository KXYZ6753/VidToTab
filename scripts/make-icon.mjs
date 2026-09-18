// Draws the app icon — build/icon.png, plus the real multi-resolution
// containers that ship to each platform.
//
//   npm run icon
//
//   build/icon.png            1024, the six-string mark (other things read it)
//   build/icon.icns           macOS, 11 slots from 16 to 1024
//   build/icon.ico            Windows, 16/32/48/64/128/256
//   build/icons/<n>x<n>.png   Linux; electron-builder takes the directory
//
// Generated rather than committed because build/ is not in git (it is where the
// fetched binaries land), so the icons have to be reproducible from source on
// any machine and in CI.
//
// Every size is drawn at its own resolution. Handing electron-builder one 1024
// png and letting it downscale was the bug this replaced: the mark is six
// strings on a 24-unit grid with a 3.5-unit pitch and a 2.1 stroke, so by 16px
// the gaps between strings are under a pixel and the whole icon averages into a
// flat orange square. Measured on the real output: crisp at 128 and up, still
// reads at 32, mush at 16. The brand kit anticipated exactly that and specifies
// a three-string variant — short, long, short — which keeps the play-triangle
// taper that is the entire idea of the mark at the one size where six lines
// cannot. public/index.html has been using it for the favicon since the kit
// landed, and the geometry below is copied from that <link rel="icon">.
//
// There is no image library here on purpose: adding a dependency to draw seven
// rectangles is a poor trade. Shapes are rounded rectangles evaluated as signed
// distance fields, which gives real anti-aliased edges for a few lines of
// arithmetic — a hard-edged icon looks cheap at 32px, and a supersampled one
// costs 16x the work for a worse result. The PNG is written by hand: signature,
// IHDR, one zlib-deflated IDAT of filter-0 scanlines, IEND.
//
// The containers are hand-written for the same reason plus one more: `npm run
// pack` and `npm run dist` both run this script first, on all three runners, so
// anything it shells out to has to exist on all three. iconutil and sips are
// macOS-only and ImageMagick is on none of them by default. ICNS and ICO are
// each a header, a table and a run of PNG payloads; a hundred lines of Buffer
// writes buys independence from all of that.

import { deflateSync, inflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(BUILD, 'icon.png');
const OUT_ICNS = path.join(BUILD, 'icon.icns');
const OUT_ICO = path.join(BUILD, 'icon.ico');
const OUT_ICONS = path.join(BUILD, 'icons');
const SIZE = 1024;

// The brand mark's own colours, straight out of the brand kit.
const GRAD_A = '#FFAF66';
const GRAD_B = '#EF6A14';
const INK = '#ffffff';

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

// ---------------------------------------------------------------- the canvas

// Premultiplied RGBA, 0..1. Premultiplied because source-over then costs one
// multiply-add per channel with no division and no special case for a == 0.
// Carried around as a value rather than kept in a module-level `px` so that the
// same drawing code can run at 16 and at 1024 in one process.
const canvas = (size) => ({ size, px: new Float64Array(size * size * 4) });

/**
 * Fill a rounded rectangle, anti-aliased.
 *
 * The distance from a point to a rounded box has a closed form, so coverage is
 * `0.5 - d` clamped to 0..1: a pixel whose centre sits half a pixel inside the
 * edge is fully covered, one half a pixel outside is empty, and the ones in
 * between get the fraction. Only the shape's own bounding box is visited.
 *
 * `paint` is a hex colour, or a function of the pixel centre returning one, so
 * that a gradient is a different argument rather than a second copy of this
 * loop. It is only consulted for pixels the shape actually covers.
 */
function roundRect(c, x, y, w, h, radius, paint) {
  const { size, px } = c;
  const flat = typeof paint === 'string' ? rgb(paint) : null;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.max(0, Math.min(radius, hw, hh));

  const x0 = Math.max(0, Math.floor(x - 1));
  const x1 = Math.min(size - 1, Math.ceil(x + w + 1));
  const y0 = Math.max(0, Math.floor(y - 1));
  const y1 = Math.min(size - 1, Math.ceil(y + h + 1));

  for (let iy = y0; iy <= y1; iy++) {
    const qy = Math.abs(iy + 0.5 - cy) - (hh - r);
    for (let ix = x0; ix <= x1; ix++) {
      const qx = Math.abs(ix + 0.5 - cx) - (hw - r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const a = Math.min(1, Math.max(0, 0.5 - d));
      if (a <= 0) continue;
      const [cr, cg, cb] = flat || paint(ix + 0.5, iy + 0.5);
      const i = (iy * size + ix) * 4;
      const keep = 1 - a;
      px[i] = cr * a + px[i] * keep;
      px[i + 1] = cg * a + px[i + 1] * keep;
      px[i + 2] = cb * a + px[i + 2] * keep;
      px[i + 3] = a + px[i + 3] * keep;
    }
  }
}

/**
 * Fill a rounded rectangle with the brand's linear gradient.
 *
 * The axis is CSS's `150deg`: measured clockwise from "up", so it points right
 * and down, which is why hexA lands in the top-left corner and hexB in the
 * bottom-right. CSS also scales the axis so the two corners it points at sit
 * exactly on the end colours — that length is |w·sin a| + |h·cos a| — and
 * reproducing it is what keeps the icon the same orange as the tile in the web
 * app rather than a washed-out approximation of it.
 */
function roundRectGradient(c, x, y, w, h, radius, hexA, hexB) {
  const a = (150 * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a); // CSS measures the angle up the page; y grows down here
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const [ar, ag, ab] = rgb(hexA);
  const [br, bg, bb] = rgb(hexB);
  roundRect(c, x, y, w, h, radius, (sx, sy) => {
    const t = Math.min(1, Math.max(0, ((sx - cx) * dx + (sy - cy) * dy) / len + 0.5));
    return [ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t];
  });
}

// --------------------------------------------------------------- the drawing

// The mark, in the brand kit's 24x24 grid: six strings, all starting flush at
// the left, whose right-hand ends step out and back in again so that the ragged
// edge they leave reads as a play triangle. Six strings and a play button in one
// shape is the whole idea, so the tapered lengths are the part to preserve if
// anything here is ever retuned.
const STROKE = 2.1;
const STRINGS = [
  [4, 12, 4.2],
  [4, 17, 7.7],
  [4, 21, 11.2],
  [4, 21, 14.7],
  [4, 17, 18.2],
  [4, 12, 21.7],
];

/** The full mark: gradient tile, six tapered strings. Used at 48px and up. */
function drawMark(size) {
  const c = canvas(size);

  // The tile is the whole icon — no plate behind it. Inset by a 64th so the
  // anti-aliased edge has somewhere to land instead of being clipped; that is
  // the 16 this was written with at 1024, kept as a ratio so the tile is the
  // same shape at every size rather than losing a fixed 32px at 48.
  const INSET = size / 64;
  const TILE = size - INSET * 2;
  roundRectGradient(c, INSET, INSET, TILE, TILE, TILE * 0.268, GRAD_A, GRAD_B);

  // Those coordinates are cap centres, so the ink reaches half a stroke beyond
  // them on every side. Measuring the real extent — rather than trusting the
  // 24-unit grid, whose midline the strings hang below — is what lets the mark
  // be centred on the tile; an icon off-centre by a percent of its width is
  // obvious in a dock, and at 1024 a percent is ten pixels.
  const CAP = STROKE / 2;
  const inkLeft = Math.min(...STRINGS.map(([from]) => from)) - CAP;
  const inkRight = Math.max(...STRINGS.map(([, to]) => to)) + CAP;
  const inkTop = Math.min(...STRINGS.map(([, , y]) => y)) - CAP;
  const inkBottom = Math.max(...STRINGS.map(([, , y]) => y)) + CAP;

  // The brand kit sets the mark's whole 24-unit grid at 0.62 of the tile, not
  // its ink: the strings only occupy x 4-21 of that grid, so the ink itself
  // lands at about half the tile and the corners keep their margin. Scaling the
  // ink to 0.62 instead makes the mark a quarter larger than the kit draws it
  // and crowds the squircle, which is what it looked like before this line said
  // GRID.
  const GRID = 24;
  const SCALE = (0.62 * TILE) / GRID;
  const ox = INSET + TILE / 2 - ((inkLeft + inkRight) / 2) * SCALE;
  const oy = INSET + TILE / 2 - ((inkTop + inkBottom) / 2) * SCALE;

  // Below a certain size the honest geometry stops being the legible one. The
  // gap between two strings is (3.5 - 2.1) grid units; once that lands under
  // three device pixels, every string straddles rows at partial coverage and
  // the two long middle strings in particular bleed into each other — measured
  // at 48px, where the gap is 1.7px, the pair reads as one thick bar. Snapping
  // the strings to whole pixels there costs about a fifth of a stroke's weight
  // and buys a gap that is actually orange. At 128 the gap is 4.6px, the
  // anti-aliased edges have room, and the kit's coordinates are drawn as given.
  const stroke = STROKE * SCALE;
  const pitch = (STRINGS[1][2] - STRINGS[0][2]) * SCALE;
  if (pitch - stroke < 3) {
    const h = Math.max(1, Math.floor(stroke));
    const step = Math.max(h + 1, Math.round(pitch)); // never let the gap close
    const top = Math.round(size / 2 - ((STRINGS.length - 1) * step + h) / 2);
    STRINGS.forEach(([from, to], i) => {
      const x0 = Math.round(ox + (from - CAP) * SCALE);
      const x1 = Math.round(ox + (to + CAP) * SCALE);
      // Square ends for the same reason as the small variant: a round cap on a
      // 2px bar is a 1px radius, which spends the end of the string on half-lit
      // pixels and blunts the taper instead of shaping it.
      roundRect(c, x0, top + i * step, x1 - x0, h, 0, INK);
    });
    return c;
  }

  // A rounded rect of height = stroke width with radius = half of it is exactly
  // a round-capped line, so the six strings need no new primitive.
  for (const [from, to, y] of STRINGS) {
    roundRect(
      c,
      ox + (from - CAP) * SCALE,
      oy + (y - CAP) * SCALE,
      (to - from + STROKE) * SCALE,
      stroke,
      stroke / 2,
      INK,
    );
  }
  return c;
}

// The small variant, on the kit's 32x32 grid, lifted verbatim from the favicon
// in public/index.html — that <link> is the authority for this geometry and the
// two must not drift. Short, long, short: three strings still taper to the
// right, so the mark is recognisably the same mark, but at three times the
// pitch. The tile is flat rather than the gradient for the reason the favicon
// gives — sixteen pixels cannot show a gradient — and for one the favicon does
// not have to care about: white on the gradient's light end (#FFAF66) is a
// 1.8:1 contrast ratio against 3.1:1 on the flat orange, so at these sizes the
// gradient would cost the topmost string most of its edge.
const SMALL_STROKE = 3.1;
const SMALL_PITCH = 5.5; // 10.5 -> 16 -> 21.5
const SMALL_LINES = [
  [9.6, 16], // M9.6 10.5 h6.4
  [9.6, 22.4], // M9.6 16   h12.8
  [9.6, 16], // M9.6 21.5 h6.4
];

/** The three-string variant, snapped to the pixel grid. Used at 16 and 32px. */
function drawSmall(size) {
  const c = canvas(size);
  const s = size / 32;
  roundRect(c, 0, 0, size, size, 10 * s, GRAD_B);

  // Everything below is rounded to whole pixels, which is the one place this
  // script departs from drawing the kit's coordinates as given. At 16px the
  // scaled stroke is 1.55px and the scaled pitch 2.75px: drawn honestly, every
  // string straddles two rows at ~0.8 coverage each and the icon goes soft
  // exactly where it can least afford to. Snapped, they are 2px bars separated
  // by a clean 1px of orange. Anti-aliasing is worth having on curves and
  // useless on an axis-aligned bar whose edges can simply be put on a pixel
  // boundary.
  const h = Math.max(1, Math.round(SMALL_STROKE * s));
  const pitch = Math.max(h + 1, Math.round(SMALL_PITCH * s)); // never let the gap close
  const top = Math.round((size - (2 * pitch + h)) / 2);

  SMALL_LINES.forEach(([from, to], i) => {
    // Cap centres again, so the ink runs half a stroke past each end.
    const x0 = Math.round((from - SMALL_STROKE / 2) * s);
    const x1 = Math.round((to + SMALL_STROKE / 2) * s);
    // Square ends, deliberately. The kit's caps are round, but a cap on a 2px
    // bar is a 1px radius: it buys no shape and spends a third of the bar's
    // length on half-lit pixels, which reads as a smudge rather than a cap.
    roundRect(c, x0, top + i * pitch, x1 - x0, h, 0, INK);
  });
  return c;
}

// ------------------------------------------------------------- the PNG encoder

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0); // CRC covers type + data
  return Buffer.concat([head, data, tail]);
}

function encodePng(c) {
  const { size, px } = c;

  // Straight (un-premultiplied) 8-bit RGBA, each row prefixed with filter type
  // 0. Filtering would compress a little better; the 1024 is already ~40KB and
  // the simplicity is worth more than the bytes.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    let o = y * (size * 4 + 1);
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = px[i + 3];
      const b = (v) => Math.round(Math.min(1, Math.max(0, a > 0 ? v / a : 0)) * 255);
      raw[o++] = b(px[i]);
      raw[o++] = b(px[i + 1]);
      raw[o++] = b(px[i + 2]);
      raw[o++] = Math.round(a * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Where the kit swaps one drawing for the other, said once so the .ico, the
// Linux set and the ICNS table cannot drift apart: anything with 32 device
// pixels or fewer gets the three-string variant. (The ICNS table below names a
// variant per slot anyway, because a macOS slot's pixel count is not the size
// it is displayed at and that argument has to be made per slot.)
const variantFor = (size) => (size <= 32 ? 'small' : 'mark');

// Draw-once cache. icp5 and ic11 are both a 32px slot, icp6 and ic12 are both
// 64, and every ICNS size below 256 also appears in the .ico and in icons/ —
// eleven ICNS slots plus six ICO entries plus seven Linux files is 24 requests
// for nine distinct images, and the 1024 alone is a second of arithmetic.
const cache = new Map();
function png(size, variant) {
  const key = `${variant}@${size}`;
  if (!cache.has(key)) cache.set(key, encodePng(variant === 'small' ? drawSmall(size) : drawMark(size)));
  return cache.get(key);
}

// --------------------------------------------------------------- the containers

// Which art goes in which macOS slot. ic11 is the interesting one: it holds a
// 32px image, but it is 16pt@2x — the retina half of the same 16-point slot as
// icp4, and on a retina Mac it is what the Finder sidebar, the list view and
// Spotlight actually show. Sizing its art by pixel count and giving it the six
// strings would buy 1px strings with 2px gaps, which is half a point of ink at
// the size it is displayed at, and would also mean the icon changed shape when
// a window moved to a non-retina screen. So the whole 16pt family gets the
// three-string variant, and so does icp5, the 32pt 1x slot the kit already
// draws small. From ic12 (64px, 32pt@2x) up there is room for the real mark.
//
// That does leave 32pt drawn small at 1x and full at 2x, the one seam in the
// scheme. It is the right way round: the 2x slot has the pixels, and the only
// way to see both is to drag the window between two displays.
//
// The type names are Apple's: ic11..ic14 are the @2x retina slots added in
// 10.8, icp4..icp6 and ic07..ic10 the plain ones. All of them accept a PNG
// payload, which is why there is no icon mask or RLE encoder in this file.
const ICNS_SLOTS = [
  ['icp4', 16, 'small'], //  16pt @1x
  ['ic11', 32, 'small'], //  16pt @2x
  ['icp5', 32, 'small'], //  32pt @1x
  ['ic12', 64, 'mark'], //   32pt @2x
  ['icp6', 64, 'mark'], //   64px, no point size of its own
  ['ic07', 128, 'mark'], // 128pt @1x
  ['ic13', 256, 'mark'], // 128pt @2x
  ['ic08', 256, 'mark'], // 256pt @1x
  ['ic14', 512, 'mark'], // 256pt @2x
  ['ic09', 512, 'mark'], // 512pt @1x
  ['ic10', 1024, 'mark'], // 512pt @2x
];

// 'icns', the total file length, then chunks of OSType + length + payload. The
// length in both places counts its own 8-byte header, which is the detail that
// makes a hand-written icns either work or be rejected whole.
function buildIcns(slots) {
  const chunks = slots.map(([type, size, variant]) => {
    const payload = png(size, variant);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(8 + payload.length, 4);
    return Buffer.concat([head, payload]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

// Windows asks for 256 in Explorer's extra-large view and 16 in the title bar,
// and NSIS picks whichever entry it likes for the installer, so the .ico has to
// carry the lot.
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

// 6-byte header, then a 16-byte directory entry per image, then the payloads.
// Everything is little-endian here, unlike PNG and ICNS. A 256px image writes
// its dimension as 0, because the field is one byte and 256 does not fit — an
// entry that says 256 literally is the classic way to produce an .ico Explorer
// silently ignores. PNG payloads (rather than the older BMP+mask) are valid
// from Vista on and are what electron-builder itself emits.
function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, payload: png(size, variantFor(size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon, 2 = cursor
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, payload }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; // width
    dir[o + 1] = size >= 256 ? 0 : size; // height
    dir[o + 2] = 0; // colours in palette; 0 for truecolour
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(payload.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += payload.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.payload)]);
}

// electron-builder takes a directory for linux.icon and reads the size out of
// each filename, so these have to be named <n>x<n>.png exactly.
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512];

// ------------------------------------------------------------- the verifiers

// Cheap proof the files are not merely present: read back what was written and
// walk it. For the containers this is not optional politeness — a structurally
// wrong .icns or .ico fails deep inside electron-builder (or, worse, inside
// Finder) with a message that says nothing about which offset was wrong, so the
// check for "every declared offset and length lands inside the file" belongs
// here where it can name the slot.

/** Walk a PNG's chunks, check every CRC, and confirm it really is w x h. */
function verify(buf, size, what = 'icon.png') {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`${what}: bad PNG signature`);
  const seen = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    const want = buf.readUInt32BE(o + 8 + len);
    const got = crc32(Buffer.concat([Buffer.from(type, 'ascii'), body]));
    if (got !== want) throw new Error(`${what}: ${type}: CRC mismatch`);
    seen.push(type);
    if (type === 'IDAT') {
      const pixels = inflateSync(body);
      if (pixels.length !== size * (size * 4 + 1)) {
        throw new Error(`${what}: IDAT inflates to ${pixels.length} bytes, not ${size}x${size}`);
      }
    }
    o += 12 + len;
  }
  if (o !== buf.length) throw new Error(`${what}: trailing bytes after IEND`);
  if (seen.join(',') !== 'IHDR,IDAT,IEND') throw new Error(`${what}: unexpected chunks: ${seen.join(',')}`);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== size || h !== size) throw new Error(`${what}: header says ${w}x${h}, expected ${size}`);
}

/**
 * Walk an .icns the way Finder does: magic, declared total length, then chunk
 * after chunk, each of which must declare a length that keeps it inside the
 * file and must contain a PNG of exactly the size its OSType promises.
 */
function verifyIcns(buf, slots) {
  if (buf.toString('ascii', 0, 4) !== 'icns') throw new Error('icns: bad magic');
  const declared = buf.readUInt32BE(4);
  if (declared !== buf.length) throw new Error(`icns: header says ${declared} bytes, file is ${buf.length}`);

  const want = new Map(slots.map(([type, size, variant]) => [type, { size, variant }]));
  const seen = [];
  let o = 8;
  while (o < buf.length) {
    if (o + 8 > buf.length) throw new Error(`icns: chunk header at ${o} runs past the end`);
    const type = buf.toString('ascii', o, o + 4);
    const len = buf.readUInt32BE(o + 4);
    if (len < 8) throw new Error(`icns: ${type} declares ${len} bytes, less than its own header`);
    if (o + len > buf.length) throw new Error(`icns: ${type} runs ${o + len - buf.length} bytes past the end`);
    const payload = buf.subarray(o + 8, o + len);
    const slot = want.get(type);
    if (!slot) throw new Error(`icns: unexpected chunk ${type}`);
    verify(payload, slot.size, `icns ${type}`);
    seen.push(type);
    o += len;
  }
  if (o !== buf.length) throw new Error('icns: trailing bytes');
  const missing = slots.map(([t]) => t).filter((t) => !seen.includes(t));
  if (missing.length) throw new Error(`icns: missing ${missing.join(', ')}`);
  return seen;
}

/**
 * Same walk for the .ico: the directory is the only thing pointing at the
 * payloads, so every offset and length is checked against the real file length
 * and every payload against the dimensions its own entry claims.
 */
function verifyIco(buf, sizes) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('ico: bad header');
  const count = buf.readUInt16LE(4);
  if (count !== sizes.length) throw new Error(`ico: header says ${count} images, expected ${sizes.length}`);

  const found = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const declared = buf[o] === 0 ? 256 : buf[o];
    const height = buf[o + 1] === 0 ? 256 : buf[o + 1];
    if (declared !== height) throw new Error(`ico: entry ${i} is ${declared}x${height}, not square`);
    if (buf.readUInt16LE(o + 4) !== 1) throw new Error(`ico: entry ${i} does not declare 1 colour plane`);
    if (buf.readUInt16LE(o + 6) !== 32) throw new Error(`ico: entry ${i} does not declare 32bpp`);
    const len = buf.readUInt32LE(o + 8);
    const at = buf.readUInt32LE(o + 12);
    if (at < 6 + count * 16) throw new Error(`ico: entry ${i} points into the directory itself`);
    if (at + len > buf.length) throw new Error(`ico: entry ${i} runs ${at + len - buf.length} bytes past the end`);
    verify(buf.subarray(at, at + len), declared, `ico ${declared}px`);
    found.push(declared);
  }
  if (found.join(',') !== sizes.join(',')) throw new Error(`ico: holds ${found.join(',')}, expected ${sizes.join(',')}`);
  return found;
}

// --------------------------------------------------------------------- output

fs.mkdirSync(OUT_ICONS, { recursive: true });

// build/icon.png stays what it always was — the 1024 six-string mark — because
// it is referenced on its own elsewhere and is the source of truth for anything
// that wants one file.
const icon = png(SIZE, 'mark');
fs.writeFileSync(OUT, icon);
verify(fs.readFileSync(OUT), SIZE);
console.log(`ok   ${path.relative(ROOT, OUT)} — ${SIZE}x${SIZE} RGBA, ${(icon.length / 1024).toFixed(1)}KB`);

const icns = buildIcns(ICNS_SLOTS);
fs.writeFileSync(OUT_ICNS, icns);
const icnsTypes = verifyIcns(fs.readFileSync(OUT_ICNS), ICNS_SLOTS);
console.log(
  `ok   ${path.relative(ROOT, OUT_ICNS)} — ${icnsTypes.length} slots ${icnsTypes.join(' ')}, ${(icns.length / 1024).toFixed(1)}KB`,
);

const ico = buildIco(ICO_SIZES);
fs.writeFileSync(OUT_ICO, ico);
const icoSizes = verifyIco(fs.readFileSync(OUT_ICO), ICO_SIZES);
console.log(
  `ok   ${path.relative(ROOT, OUT_ICO)} — ${icoSizes.length} images ${icoSizes.join(' ')}, ${(ico.length / 1024).toFixed(1)}KB`,
);

let linuxBytes = 0;
for (const size of LINUX_SIZES) {
  const file = path.join(OUT_ICONS, `${size}x${size}.png`);
  const buf = png(size, variantFor(size));
  fs.writeFileSync(file, buf);
  verify(fs.readFileSync(file), size, `icons/${size}x${size}.png`);
  linuxBytes += buf.length;
}
console.log(
  `ok   ${path.relative(ROOT, OUT_ICONS)}/ — ${LINUX_SIZES.length} files ${LINUX_SIZES.join(' ')}, ${(linuxBytes / 1024).toFixed(1)}KB`,
);
