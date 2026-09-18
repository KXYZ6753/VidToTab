// Draws build/icon.png — the app icon, 1024x1024 RGBA.
//
//   npm run icon
//
// Generated rather than committed because build/ is not in git (it is where the
// fetched binaries land), so the icon has to be reproducible from source on any
// machine and in CI. electron-builder derives the .icns and .ico from this one
// file, which is why it is drawn at 1024.
//
// There is no image library here on purpose: adding a dependency to draw seven
// rectangles is a poor trade. Shapes are rounded rectangles evaluated as signed
// distance fields, which gives real anti-aliased edges for a few lines of
// arithmetic — a hard-edged icon looks cheap at 32px, and a supersampled one
// costs 16x the work for a worse result. The PNG is written by hand: signature,
// IHDR, one zlib-deflated IDAT of filter-0 scanlines, IEND.

import { deflateSync, inflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'icon.png');
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
const px = new Float64Array(SIZE * SIZE * 4);

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
function roundRect(x, y, w, h, radius, paint) {
  const flat = typeof paint === 'string' ? rgb(paint) : null;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.max(0, Math.min(radius, hw, hh));

  const x0 = Math.max(0, Math.floor(x - 1));
  const x1 = Math.min(SIZE - 1, Math.ceil(x + w + 1));
  const y0 = Math.max(0, Math.floor(y - 1));
  const y1 = Math.min(SIZE - 1, Math.ceil(y + h + 1));

  for (let iy = y0; iy <= y1; iy++) {
    const qy = Math.abs(iy + 0.5 - cy) - (hh - r);
    for (let ix = x0; ix <= x1; ix++) {
      const qx = Math.abs(ix + 0.5 - cx) - (hw - r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const a = Math.min(1, Math.max(0, 0.5 - d));
      if (a <= 0) continue;
      const [cr, cg, cb] = flat || paint(ix + 0.5, iy + 0.5);
      const i = (iy * SIZE + ix) * 4;
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
function roundRectGradient(x, y, w, h, radius, hexA, hexB) {
  const a = (150 * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a); // CSS measures the angle up the page; y grows down here
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const [ar, ag, ab] = rgb(hexA);
  const [br, bg, bb] = rgb(hexB);
  roundRect(x, y, w, h, radius, (sx, sy) => {
    const t = Math.min(1, Math.max(0, ((sx - cx) * dx + (sy - cy) * dy) / len + 0.5));
    return [ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t];
  });
}

// --------------------------------------------------------------- the drawing

// The tile is the whole icon — no plate behind it. Inset by 16 so the
// anti-aliased edge has somewhere to land instead of being clipped.
const INSET = 16;
const TILE = SIZE - INSET * 2;
roundRectGradient(INSET, INSET, TILE, TILE, TILE * 0.268, GRAD_A, GRAD_B);

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

// Those coordinates are cap centres, so the ink reaches half a stroke beyond
// them on every side. Measuring the real extent — rather than trusting the
// 24-unit grid, whose midline the strings hang below — is what lets the mark be
// centred on the tile; an icon off-centre by a percent of its width is obvious
// in a dock, and at 1024 a percent is ten pixels.
const CAP = STROKE / 2;
const inkLeft = Math.min(...STRINGS.map(([from]) => from)) - CAP;
const inkRight = Math.max(...STRINGS.map(([, to]) => to)) + CAP;
const inkTop = Math.min(...STRINGS.map(([, , y]) => y)) - CAP;
const inkBottom = Math.max(...STRINGS.map(([, , y]) => y)) + CAP;

// The brand kit sets the mark's whole 24-unit grid at 0.62 of the tile, not its
// ink: the strings only occupy x 4-21 of that grid, so the ink itself lands at
// about half the tile and the corners keep their margin. Scaling the ink to 0.62
// instead makes the mark a quarter larger than the kit draws it and crowds the
// squircle, which is what it looked like before this line said GRID.
const GRID = 24;
const SCALE = (0.62 * TILE) / GRID;
const ox = INSET + TILE / 2 - ((inkLeft + inkRight) / 2) * SCALE;
const oy = INSET + TILE / 2 - ((inkTop + inkBottom) / 2) * SCALE;

// A rounded rect of height = stroke width with radius = half of it is exactly a
// round-capped line, so the six strings need no new primitive.
for (const [from, to, y] of STRINGS) {
  roundRect(
    ox + (from - CAP) * SCALE,
    oy + (y - CAP) * SCALE,
    (to - from + STROKE) * SCALE,
    STROKE * SCALE,
    (STROKE * SCALE) / 2,
    INK,
  );
}

// ------------------------------------------------------------- the PNG encoder

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

// Straight (un-premultiplied) 8-bit RGBA, each row prefixed with filter type 0.
// Filtering would compress a little better; this image is already ~20KB and the
// simplicity is worth more than the bytes.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  let o = y * (SIZE * 4 + 1);
  raw[o++] = 0;
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const a = px[i + 3];
    const b = (v) => Math.round(Math.min(1, Math.max(0, a > 0 ? v / a : 0)) * 255);
    raw[o++] = b(px[i]);
    raw[o++] = b(px[i + 1]);
    raw[o++] = b(px[i + 2]);
    raw[o++] = Math.round(a * 255);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: truecolour with alpha
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// Cheap proof the file is not merely present: read back what was written, walk
// its chunks, and inflate the image data again. ffprobe is the real check (see
// the README of this script's CI step), but this catches a broken encoder here
// rather than three steps later as "cannot find icon".
function verify(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('bad PNG signature');
  }
  const seen = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    const want = buf.readUInt32BE(o + 8 + len);
    const got = crc32(Buffer.concat([Buffer.from(type, 'ascii'), body]));
    if (got !== want) throw new Error(`${type}: CRC mismatch`);
    seen.push(type);
    if (type === 'IDAT') {
      const pixels = inflateSync(body);
      if (pixels.length !== SIZE * (SIZE * 4 + 1)) throw new Error(`IDAT inflates to ${pixels.length} bytes`);
    }
    o += 12 + len;
  }
  if (o !== buf.length) throw new Error('trailing bytes after IEND');
  if (seen.join(',') !== 'IHDR,IDAT,IEND') throw new Error(`unexpected chunks: ${seen.join(',')}`);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== SIZE || h !== SIZE) throw new Error(`header says ${w}x${h}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
verify(fs.readFileSync(OUT));
console.log(`ok   ${path.relative(ROOT, OUT)} — ${SIZE}x${SIZE} RGBA, ${(png.length / 1024).toFixed(1)}KB`);
