// Installs and updates yt-dlp into the app's data folder.
//
// yt-dlp is the one tool that cannot be bundled and forgotten. YouTube changes
// something every few weeks and a build more than a month or two old starts
// failing in ways that look, to the person using the app, like broken links.
// So it is fetched at runtime into <data>/bin — which pipeline/tools.js already
// searches ahead of the system — and can be replaced in place later without
// shipping a new build of the app.
//
// The standalone builds are used rather than the 3 MB script, because that one
// needs a python3 on the machine and modern macOS does not ship one.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LATEST = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

// Which release asset belongs to this machine. Pure, so the self-check can
// cover every platform without downloading anything.
export function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos'; // universal binary
  if (platform === 'linux') return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  throw new Error(`no yt-dlp build for ${platform}/${arch}`);
}

export const binaryName = (platform = process.platform) => (platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// "<sha256>  <name>" per line, which is what SHA2-256SUMS contains.
export function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)\s*$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Does the installed copy work, and what version is it?
export function installedVersion(binPath) {
  try {
    const r = spawnSync(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    if (r.status !== 0) return null;
    return String(r.stdout).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

// yt-dlp's version is a date, so staleness is readable straight off it.
export function ageDays(version, now = Date.now()) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version || '');
  if (!m) return null;
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.max(0, Math.round((now - released) / 86400000));
}

/**
 * Make sure a working yt-dlp exists in binDir, downloading it if not.
 *
 * The checksum comes from the same release as the binary, so it guards against
 * a corrupted or truncated download rather than against a compromised
 * publisher — which is the usual trade-off for a tool that must track upstream
 * continuously and cannot be pinned to a hash baked in at build time.
 */
export async function ensureYtDlp({
  binDir,
  force = false,
  onLog = () => {},
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!binDir) throw new Error('ensureYtDlp needs binDir');
  const dest = path.join(binDir, binaryName(platform));

  if (!force) {
    const have = installedVersion(dest);
    if (have) return { path: dest, version: have, installed: false };
  }

  const asset = assetFor(platform, arch);
  onLog(`downloading yt-dlp (${asset})`);

  const [binRes, sumRes] = await Promise.all([
    fetchImpl(`${LATEST}/${asset}`, { redirect: 'follow' }),
    fetchImpl(`${LATEST}/SHA2-256SUMS`, { redirect: 'follow' }),
  ]);
  if (!binRes.ok) throw new Error(`yt-dlp download failed: ${binRes.status} ${binRes.statusText}`);
  if (!sumRes.ok) throw new Error(`yt-dlp checksum list failed: ${sumRes.status} ${sumRes.statusText}`);

  const buf = Buffer.from(await binRes.arrayBuffer());
  const sums = parseSums(await sumRes.text());
  const want = sums.get(asset);
  if (!want) throw new Error(`no checksum published for ${asset}`);
  const got = sha256(buf);
  if (got !== want) throw new Error(`yt-dlp checksum mismatch\n  expected ${want}\n  got      ${got}`);

  fs.mkdirSync(binDir, { recursive: true });
  // Write beside the target and rename, so a half-written file can never be
  // left behind as a "working" install if this is interrupted.
  const tmp = `${dest}.partial`;
  fs.writeFileSync(tmp, buf);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);

  const version = installedVersion(dest);
  if (!version) throw new Error('yt-dlp was downloaded but does not run');
  onLog(`yt-dlp ${version} installed`);
  return { path: dest, version, installed: true };
}

export function selfCheck(assert) {
  assert.equal(assetFor('win32', 'x64'), 'yt-dlp.exe');
  assert.equal(assetFor('darwin', 'arm64'), 'yt-dlp_macos');
  assert.equal(assetFor('darwin', 'x64'), 'yt-dlp_macos'); // one universal build
  assert.equal(assetFor('linux', 'x64'), 'yt-dlp_linux');
  assert.equal(assetFor('linux', 'arm64'), 'yt-dlp_linux_aarch64');
  assert.throws(() => assetFor('aix', 'ppc'), /no yt-dlp build/);

  assert.equal(binaryName('win32'), 'yt-dlp.exe');
  assert.equal(binaryName('linux'), 'yt-dlp');

  const sums = parseSums([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp',
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  yt-dlp_macos',
    '',
    'not a checksum line',
  ].join('\n'));
  assert.equal(sums.get('yt-dlp'), 'a'.repeat(64));
  assert.equal(sums.get('yt-dlp_macos'), 'b'.repeat(64)); // normalised to lower case
  assert.equal(sums.size, 2); // the junk lines are ignored, not guessed at

  assert.equal(ageDays('2026.07.04', Date.UTC(2026, 6, 14)), 10);
  assert.equal(ageDays('not-a-version'), null);
  assert.equal(ageDays('2026.07.04', Date.UTC(2026, 6, 1)), 0); // never negative

  // A mismatched checksum must fail rather than install something unexpected.
  const fakeFetch = async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode('definitely not yt-dlp').buffer,
    text: async () => `${'c'.repeat(64)}  yt-dlp_macos\n`,
  });
  return ensureYtDlp({ binDir: '/nonexistent-on-purpose', fetchImpl: fakeFetch, platform: 'darwin', arch: 'arm64' })
    .then(() => { throw new Error('expected a checksum mismatch'); })
    .catch((e) => assert.match(e.message, /checksum mismatch/));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const assert = (await import('node:assert')).strict;
  await selfCheck(assert);
  console.log('ytdlp.js self-check passed');
}
