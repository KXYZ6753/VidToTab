// Runs every pipeline module's built-in self-check (`node pipeline/<mod>.js`).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pipeline');
const only = process.argv.slice(2);
const mods = readdirSync(dir)
  .filter((f) => f.endsWith('.js') && f !== 'config.js')
  .filter((f) => only.length === 0 || only.includes(f.replace(/\.js$/, '')))
  .sort();

let failed = 0;
for (const f of mods) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: ['ignore', 'inherit', 'inherit'] });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.padEnd(14)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
process.exit(failed ? 1 : 0);
