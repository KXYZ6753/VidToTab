// ffmpeg spawn helpers: raw-frame async generator, keyframe grabs, PNG encode via
// stdin, probing. All children are tracked so cancelPipeline() can kill them.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { toolPath } from './tools.js';

const children = new Set();

export function killAllChildren() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

function track(bin, args, stdio) {
  const child = spawn(toolPath(bin), args, { stdio });
  children.add(child);
  child.once('close', () => children.delete(child));
  child.once('error', () => children.delete(child));
  return child;
}

// Async generator of raw frames (Buffer of exactly frameBytes each) from ffmpeg stdout.
// opts: { ss?, to?, t?, vf?, frameBytes, maxFrames?, keyOnly?, passthrough? }
// ss/to are input options, t is output -t. keyOnly decodes keyframes only and
// snaps ss to the keyframe at/before it: one decoded frame per grab.
// passthrough keeps select-filtered frames from being duplicated by the muxer.
export async function* rawFrames(input, { ss, to, t, vf, frameBytes, maxFrames, keyOnly = false, passthrough = false }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (keyOnly) args.push('-noaccurate_seek', '-skip_frame', 'nokey');
  if (ss != null) args.push('-ss', String(ss));
  if (to != null) args.push('-to', String(to));
  args.push('-i', input, '-an', '-sn', '-dn');
  if (t != null) args.push('-t', String(t));
  if (vf) args.push('-vf', vf);
  if (passthrough) args.push('-fps_mode', 'passthrough');
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

// One frame per timestamp, returned in input order; a failed grab is null.
// keyOnly (default) makes each grab decode a single keyframe — ideal for
// sampling a whole video quickly (detection, calibration).
export async function grabFramesAt(input, times, { vf, frameBytes, keyOnly = true, concurrency = 4 } = {}) {
  const out = new Array(times.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < times.length) {
      const i = next++;
      try {
        for await (const f of rawFrames(input, { ss: times[i], vf, frameBytes, maxFrames: 1, keyOnly })) out[i] = f;
      } catch { /* leave null; callers tolerate missing samples */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, times.length) }, worker));
  return out;
}

// Encode one raw buffer (rgb24 or gray) to a PNG file via ffmpeg stdin.
export function encodePng(buf, w, h, outPath, pixFmt = 'rgb24') {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', `${w}x${h}`, '-i', 'pipe:0',
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
    child.stdin.end(buf);
  });
}

// {codec, width, height, fps, duration} of the first video stream, or null.
export function probeVideo(input) {
  return new Promise((resolve) => {
    const child = track('ffprobe',
      ['-v', 'error', '-select_streams', 'v:0',
        // stream_side_data carries the display matrix; without asking for it
        // ffprobe emits an empty side_data_list and rotation looks absent.
        '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:format=duration',
        '-of', 'json', input],
      ['ignore', 'pipe', 'ignore']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.once('error', () => resolve(null));
    child.once('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const j = JSON.parse(out);
        const s = j.streams?.[0];
        if (!s) return resolve(null);
        const d = parseFloat(j.format?.duration);
        // Displayed size, not stored size: ffmpeg applies the display matrix
        // when it decodes, so a portrait phone video stored 1920x1080 yields
        // 1080x1920 frames. Reporting the stored size puts every crop, scale
        // and detection box in the wrong coordinate space.
        const rotation = Math.abs(Number(
          (s.side_data_list || []).find((x) => x.rotation != null)?.rotation ?? 0,
        ) % 180);
        const swap = rotation === 90;
        resolve({
          codec: s.codec_name || '',
          width: (swap ? s.height : s.width) || 0,
          height: (swap ? s.width : s.height) || 0,
          rotation,
          fps: parseRate(s.avg_frame_rate) || parseRate(s.r_frame_rate),
          duration: Number.isFinite(d) ? d : null,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

export function parseRate(r) {
  const [a, b] = String(r || '').split('/').map(Number);
  return a > 0 && b > 0 ? a / b : 0;
}

// Duration in seconds, or null on any failure (callers treat as unknown).
export async function probeDuration(input) {
  return (await probeVideo(input))?.duration ?? null;
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

    // gray PNGs (clean print output) round-trip too
    const gray = Buffer.from(Array.from({ length: w * h }, (_, i) => (i * 11) & 0xff));
    const gpng = path.join(dir, 'g.png');
    await encodePng(gray, w, h, gpng, 'gray');
    const g = [];
    for await (const f of rawFrames(gpng, { vf: 'format=gray', frameBytes: w * h })) g.push(f);
    assert.deepEqual(Buffer.from(g[0]), gray);

    // keyframe grabs from a tiny lossless video: 3 grabs, in order, right size
    //
    // Frames are piped in as rawvideo rather than conjured with `-f lavfi`. The
    // LGPL ffmpeg this app ships is built --disable-avdevice, so the lavfi
    // input device is not in it at all — testsrc is a filter, but reaching it
    // needs that device. Piping works on every build.
    const vid = path.join(dir, 'v.mkv');
    await new Promise((resolve, reject) => {
      const c = spawn(toolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '64x48', '-r', '10', '-i', 'pipe:0',
        '-c:v', 'ffv1', '-g', '5', vid], { stdio: ['pipe', 'ignore', 'inherit'] });
      c.once('error', reject);
      c.once('close', (code) => (code === 0 ? resolve() : reject(new Error('test clip encode failed'))));
      // 30 frames at 10 fps = 3 s, each a different shade so the grabs differ.
      for (let i = 0; i < 30; i++) c.stdin.write(Buffer.alloc(64 * 48 * 3, (i * 8) & 0xff));
      c.stdin.end();
    });
    const grabs = await grabFramesAt(vid, [0.2, 1.4, 2.6], { vf: 'format=gray', frameBytes: 64 * 48 });
    assert.equal(grabs.length, 3);
    assert.ok(grabs.every((f) => f && f.length === 64 * 48));
    const info = await probeVideo(vid);
    assert.equal(info.width, 64);
    assert.equal(info.fps, 10);
    assert.ok(Math.abs(info.duration - 3) < 0.2);
    assert.equal(await probeVideo(path.join(dir, 'missing.mp4')), null);

    // Rotated video: ffmpeg applies the display matrix on decode, so probeVideo
    // has to report the displayed size or every crop lands in the wrong space.
    // Skipped when the local ffmpeg cannot write a display matrix, so this
    // never fails over an unrelated build difference.
    const flat = path.join(dir, 'flat.mp4');
    const rot = path.join(dir, 'rot.mp4');
    const ff = (args) => new Promise((resolve) => {
      const c = spawn(toolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'ignore' });
      c.once('error', () => resolve(false));
      c.once('close', (code) => resolve(code === 0));
    });
    // Re-encodes the clip made above rather than generating one, for the same
    // reason: no lavfi in the shipped build.
    const madeFlat = await ff(['-i', vid, '-t', '1', '-c:v', 'mpeg4', flat]);
    const madeRot = madeFlat && await ff(['-display_rotation', '90', '-i', flat, '-c', 'copy', rot]);
    if (madeRot) {
      const r = await probeVideo(rot);
      if (r?.rotation === 90) {
        assert.equal(r.width, 48, 'rotated video reports the displayed width');
        assert.equal(r.height, 64, 'rotated video reports the displayed height');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfCheck();
}
