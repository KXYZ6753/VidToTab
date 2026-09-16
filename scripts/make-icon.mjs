// Draws build/icon.png — the app icon, 1024x1024 RGBA.
//
//   npm run icon
//
// Generated rather than committed because build/ is not in git (it is where the
// fetched binaries land), so the icon has to be reproducible from source on any
// machine and in CI. electron-builder derives the .icns and .ico from this one
// file, which is why it is drawn at 1024.
//
// There is no image library here on purpose: adding a dependency to draw eleven
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

// The app's own colours, straight out of the stylesheet.
const PAPER = '#faf7f2';
const ACCENT = '#c93f0c';
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
 */
function roundRect(x, y, w, h, radius, hex) {
  const [cr, cg, cb] = rgb(hex);
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
      const i = (iy * SIZE + ix) * 4;
      const keep = 1 - a;
      px[i] = cr * a + px[i] * keep;
      px[i + 1] = cg * a + px[i + 1] * keep;
      px[i + 2] = cb * a + px[i + 2] * keep;
      px[i + 3] = a + px[i + 3] * keep;
    }
  }
}

// --------------------------------------------------------------- the drawing

// A seven-segment digit. Fret numbers have to be drawn, not typeset — there is
// no font here — and segments stay legible when the whole icon is 32px wide in
// a taskbar, where anything with real letterforms turns to mush.
const SEGMENTS = {
  0: 'abcdef',
  1: 'bc',
  2: 'abged',
  3: 'abgcd',
  4: 'fgbc',
  5: 'afgcd',
  6: 'afgedc',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcdfg',
};

function digit(value, cx, cy, w, h, t, hex) {
  const left = cx - w / 2;
  const right = cx + w / 2;
  const top = cy - h / 2;
  const bottom = cy + h / 2;
  const mid = cy - t / 2;
  const half = h / 2 + t / 2; // verticals run edge to middle, overlapping by t/2
  const r = t * 0.25;
  const box = {
    a: [left, top, w, t],
    b: [right - t, top, t, half],
    c: [right - t, mid, t, half],
    d: [left, bottom - t, w, t],
    e: [left, mid, t, half],
    f: [left, top, t, half],
    g: [left, mid, w, t],
  };
  for (const s of SEGMENTS[value]) roundRect(...box[s], r, hex);
}

// Plate: the whole icon is one rounded square of paper. Inset by 16 so the
// anti-aliased edge has somewhere to land instead of being clipped.
roundRect(16, 16, SIZE - 32, SIZE - 32, 200, PAPER);

// The accent tile the eye actually reads at small sizes.
const TILE = 112;
roundRect(TILE, TILE, SIZE - TILE * 2, SIZE - TILE * 2, 150, ACCENT);

// Six strings. Thick relative to their spacing on purpose: at 32px the pitch is
// under 4px, and thin lines would average away into a flat orange square.
const PAD = 88;
const LINE_X = TILE + PAD;
const LINE_W = SIZE - (TILE + PAD) * 2;
const STROKE = 32;
const PITCH = 116;
const lineY = (i) => SIZE / 2 + (i - 2.5) * PITCH;
for (let i = 0; i < 6; i++) roundRect(LINE_X, lineY(i) - STROKE / 2, LINE_W, STROKE, STROKE / 2, INK);

// Two fret numbers, each sitting in a break in its string — which is how tab is
// actually set, and the cheapest way to keep a light digit legible on top of a
// light line.
const D_W = 84;
const D_H = 132;
const D_T = 24;
const GAP = 22;
for (const [value, cx, line] of [[3, 392, 1], [5, 624, 3]]) {
  const cy = lineY(line);
  roundRect(cx - D_W / 2 - GAP, cy - D_H / 2 - GAP, D_W + GAP * 2, D_H + GAP * 2, 18, ACCENT);
  digit(value, cx, cy, D_W, D_H, D_T, PAPER);
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
