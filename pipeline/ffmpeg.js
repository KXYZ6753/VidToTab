// ffmpeg spawn helpers: raw-frame async generator, PNG encode via stdin, duration probe.
// All children are tracked so cancelPipeline() can kill them.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const children = new Set();

export function killAllChildren() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

function track(bin, args, stdio) {
  const child = spawn(bin, args, { stdio });
  children.add(child);
  child.once('close', () => children.delete(child));
  child.once('error', () => children.delete(child));
  return child;
}

// Async generator of raw frames (Buffer of exactly frameBytes each) from ffmpeg stdout.
// opts: { ss?, to?, t?, vf?, frameBytes, maxFrames? }  (ss/to are input options, t is output -t)
export async function* rawFrames(input, { ss, to, t, vf, frameBytes, maxFrames }) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (ss != null) args.push('-ss', String(ss));
  if (to != null) args.push('-to', String(to));
  args.push('-i', input);
  if (t != null) args.push('-t', String(t));
  if (vf) args.push('-vf', vf);
  if (maxFrames != null) args.push('-frames:v', String(maxFrames));
  args.push('-f', 'rawvideo', 'pipe:1');

  const child = track('ffmpeg', args, ['ignore', 'pipe', 'pipe']);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const done = new Promise((resolve, reject) => {
    child.once('close', (code, sig) => resolve({ code, sig }));
    child.once('error', (e) => { e.userMsg = 'ffmpeg is not available on PATH'; reject(e); });
  });
  done.catch(() => {}); // settled below; avoid unhandled rejection if we throw first

  let yielded = 0;
  let gotEnough = false;
  try {
    let chunks = [];
    let len = 0;
    for await (const chunk of child.stdout) {
      chunks.push(chunk);
      len += chunk.length;
      if (len < frameBytes) continue;
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, len);
      let off = 0;
      while (len - off >= frameBytes) {
        const frame = Buffer.allocUnsafe(frameBytes);
        all.copy(frame, 0, off, off + frameBytes);
        off += frameBytes;
        yield frame;
        yielded++;
        if (maxFrames != null && yielded >= maxFrames) {
          gotEnough = true;
          child.kill('SIGKILL');
          return;
        }
      }
      chunks = off < len ? [all.subarray(off)] : [];
      len -= off;
    }
    const { code, sig } = await done;
    if (code !== 0 && !(gotEnough || (maxFrames != null && yielded >= maxFrames))) {
      const err = new Error(`ffmpeg exited with ${sig ?? code}`);
      err.userMsg = `ffmpeg failed: ${stderr.trim().split('\n').pop() || 'unknown error'}`;
      err.stderr = stderr;
      throw err;
    }
  } finally {
    children.delete(child);
    if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
  }
}

// Encode one rgb24 buffer to a PNG file via ffmpeg stdin.
export function encodePng(rgb, w, h, outPath) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', 'pipe:0',
      '-frames:v', '1', outPath];
    const child = track('ffmpeg', args, ['pipe', 'ignore', 'pipe']);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.once('error', (e) => { e.userMsg = 'ffmpeg is not available on PATH'; reject(e); });
    child.once('close', (code, sig) => {
      if (code === 0) return resolve();
      const err = new Error(`ffmpeg png encode exited with ${sig ?? code}`);
      err.userMsg = 'PNG encoding failed';
      err.stderr = stderr;
      reject(err);
    });
    child.stdin.on('error', () => {}); // EPIPE if child died early; close handler reports
    child.stdin.end(rgb);
  });
}

// Duration in seconds via ffprobe, or null on any failure (callers treat as unknown).
export function probeDuration(input) {
  return new Promise((resolve) => {
    const child = track('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
      ['ignore', 'pipe', 'ignore']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.once('error', () => resolve(null));
    child.once('close', (code) => {
      const n = parseFloat(out);
      resolve(code === 0 && Number.isFinite(n) ? n : null);
    });
  });
}

async function selfCheck() {
  const { strict: assert } = await import('node:assert');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vidtotab-ffmpeg-'));
  try {
    const w = 32, h = 16;
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[3 * i] = (i * 7) & 0xff;
      rgb[3 * i + 1] = (i * 13) & 0xff;
      rgb[3 * i + 2] = (i * 29) & 0xff;
    }
    const png = path.join(dir, 'rt.png');
    await encodePng(rgb, w, h, png);
    const frames = [];
    for await (const f of rawFrames(png, { vf: 'format=rgb24', frameBytes: w * h * 3 })) frames.push(f);
    assert.equal(frames.length, 1);
    assert.deepEqual(Buffer.from(frames[0]), rgb); // PNG round-trip is lossless
    const d = await probeDuration(png);
    assert.ok(d === null || Number.isFinite(d)); // probe must not throw on stills
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
