// Runs every pipeline module's built-in self-check (`node pipeline/<mod>.js`).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'pipeline');
const only = process.argv.slice(2);
const mods = [
  ...readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== 'config.js')
    .map((f) => ({ name: f.replace(/\.js$/, ''), file: path.join(dir, f) })),
  // Shared with the browser so it lives outside pipeline/, but it decides what
  // every exported page looks like, so it is checked with everything else.
  { name: 'look', file: path.join(here, '..', 'public', 'shared', 'look.js') },
  // Play-along: the sequence with repeats, the pace, and finding the notes on
  // a page so the sweep crosses them rather than empty staff.
  { name: 'practice', file: path.join(here, '..', 'public', 'shared', 'practice.js') },
  // Follow-along: the staff finder shared with practice, tunings and pitches,
  // page fingerprints, corrections to a reading, and the ground-truth grammar.
  { name: 'staff', file: path.join(here, '..', 'public', 'shared', 'staff.js') },
  { name: 'follow', file: path.join(here, '..', 'public', 'shared', 'follow.js') },
  { name: 'sha1', file: path.join(here, '..', 'public', 'shared', 'sha1.js') },
  { name: 'transcript', file: path.join(here, '..', 'public', 'shared', 'transcript.js') },
  { name: 'tabread', file: path.join(here, '..', 'public', 'shared', 'tabread.js') },
  { name: 'listen', file: path.join(here, '..', 'public', 'shared', 'listen.js') },
  // Timing a page's notes from the video's own recording, and checking the
  // reader's unsure digits against it, on a synthesized string.
  { name: 'timing', file: path.join(here, '..', 'public', 'shared', 'timing.js') },
  { name: 'tabread-truth', file: path.join(here, 'tabread-truth.mjs') },
  // The release page: template, changelog section, planet name.
  { name: 'release-notes', file: path.join(here, 'release-notes.mjs') },
  // Only its pure parts run here — IndexedDB does not exist in Node, and the
  // storage paths are covered by the browser end-to-end test instead.
  { name: 'library', file: path.join(here, '..', 'public', 'lib', 'library.js') },
  // Decides when a looping brand animation may be cut off. Only the pure half
  // runs here; the DOM helpers beside it need a document, and the browser
  // end-to-end test drives those.
  { name: 'motion', file: path.join(here, '..', 'public', 'brand', 'motion.js') },
  // The desktop shell's two pure halves: the songsheet folder, checked against
  // a real temporary directory, and the GitHub release check, against the
  // asset names GitHub actually serves.
  { name: 'library-fs', file: path.join(here, '..', 'electron', 'library-fs.cjs') },
  { name: 'updates', file: path.join(here, '..', 'electron', 'updates.cjs') },
]
  .filter((m) => only.length === 0 || only.includes(m.name))
  .sort((a, b) => a.name.localeCompare(b.name));

let failed = 0;
for (const { name, file } of mods) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { stdio: ['ignore', 'inherit', 'inherit'] });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${path.basename(file).padEnd(16)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
process.exit(failed ? 1 : 0);
