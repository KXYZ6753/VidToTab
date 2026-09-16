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
]
  .filter((m) => only.length === 0 || only.includes(m.name))
  .sort((a, b) => a.name.localeCompare(b.name));

let failed = 0;
for (const { name, file } of mods) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { stdio: ['ignore', 'inherit', 'inherit'] });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${`${name}.js`.padEnd(14)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
process.exit(failed ? 1 : 0);
