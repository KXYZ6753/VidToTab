// SHA-1 of a page's bytes: the key a corrected reading is stored under, so it
// follows the page through re-saves and is dropped by a new scan.
//
// crypto.subtle does it natively, but only in a secure context — the app's
// own http://127.0.0.1 page is one, a hosted instance reached over plain HTTP
// on a LAN is not. The small pure version below covers that case; its
// self-check compares it with node:crypto.

function sha1Js(bytes) {
  const ml = bytes.length;
  const withPad = ((ml + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(withPad);
  m.set(bytes);
  m[ml] = 0x80;
  const bits = ml * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(withPad - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(withPad - 4, bits >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

// bytes: Uint8Array, ArrayBuffer or Blob. Resolves to 40 lower-case hex digits.
export async function sha1(bytes) {
  let buf = bytes;
  if (typeof Blob !== 'undefined' && buf instanceof Blob) buf = new Uint8Array(await buf.arrayBuffer());
  if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
  const subtle = globalThis.crypto?.subtle;
  if (subtle && (typeof isSecureContext === 'undefined' || isSecureContext)) {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-1', buf));
      return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
    } catch { /* fall through to the pure version */ }
  }
  return sha1Js(buf);
}

export async function selfCheck(assert) {
  const { createHash } = await import('node:crypto');
  for (const text of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000)]) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(sha1Js(bytes), createHash('sha1').update(bytes).digest('hex'), `pure SHA-1 of ${text.length} bytes`);
  }
  const random = new Uint8Array(4096).map((_, i) => (i * 131 + 7) & 255);
  assert.equal(await sha1(random), createHash('sha1').update(random).digest('hex'));
}

if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  await selfCheck(assert);
  console.log('sha1.js self-check passed');
}
