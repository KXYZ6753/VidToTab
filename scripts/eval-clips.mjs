// Replays recorded test clips through the listener:
//
//   node scripts/eval-clips.mjs [folder]      (default scripts/listen-clips)
//
// A clip is what "Record a test clip" in Listen mode saves: the sound and a
// .json with the notes it should match, from the note that was highlighted
// when recording started. Each is fed through the engine in Wait mode, arming
// the events in order, and scored by how far it gets. A clip's json may carry
// `floor` (0..1): below it, this exits non-zero.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../public/shared/listen.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(process.argv[2] || path.join(ROOT, 'scripts', 'listen-clips'));
const FFMPEG = process.env.VIDTOTAB_FFMPEG || 'ffmpeg';
const SR = 48000;

const clips = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];
if (!clips.length) {
  console.log(`No clips in ${path.relative(ROOT, DIR) || DIR}. Record one in Listen mode (the microphone panel, T) and put both files there.`);
  process.exit(0);
}

let failed = 0;
for (const f of clips) {
  const clip = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const audio = path.join(DIR, clip.audio);
  if (!fs.existsSync(audio)) { console.log(`skip ${f}: ${clip.audio} is missing`); continue; }
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', audio, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);

  const eng = createEngine({ sampleRate: SR });
  eng.setMode('wait');
  eng.setStrictness(clip.settings?.strictness || 'lenient');
  eng.setTargets(clip.events.map((e, i) => ({ id: i, pitchless: e.pitchless, notes: e.notes })));
  let cur = 0;
  eng.arm(0);
  for (let off = 0; off < pcm.length && cur < clip.events.length; off += eng.hop) {
    for (const m of eng.push(pcm.subarray(off, Math.min(pcm.length, off + eng.hop))) || []) {
      if (m.type === 'accept' && m.index === cur) {
        if (++cur < clip.events.length) eng.arm(cur);
      }
    }
  }
  // Plain progress: a clip may stop before the song does, so set `floor` to
  // what the clip actually covers.
  const progress = cur / clip.events.length;
  const below = Number.isFinite(clip.floor) && progress < clip.floor;
  if (below) failed++;
  console.log(`${f.padEnd(40)} ${String(cur).padStart(4)}/${clip.events.length}  ${(pcm.length / SR).toFixed(1)} s  ${clip.mic?.label || ''}${below ? `  BELOW FLOOR ${clip.floor}` : ''}`);
}
if (failed) process.exitCode = 1;
