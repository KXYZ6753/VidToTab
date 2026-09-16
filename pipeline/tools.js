// Where the external tools actually live.
//
// A terminal has Homebrew on PATH; an app launched from Finder, the Dock or a
// .desktop file does not. Spawning `ffmpeg` by bare name therefore works all
// through development and fails the first time someone double-clicks the
// packaged build, with an ENOENT that reads like a missing feature. Every
// spawn of ffmpeg/ffprobe/yt-dlp resolves through here instead.
//
// The order is deliberate: an explicit override beats everything, binaries
// shipped inside the app beat ones we downloaded, and PATH is the last resort
// so a plain `npm start` checkout behaves exactly as it did before.
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp'];

const ENV_OVERRIDE = { ffmpeg: 'VIDTOTAB_FFMPEG', ffprobe: 'VIDTOTAB_FFPROBE', 'yt-dlp': 'VIDTOTAB_YTDLP' };

// yt-dlp ships as yt-dlp.exe on Windows; ffmpeg builds follow the same rule.
export const exeName = (name, platform = process.platform) => (platform === 'win32' ? `${name}.exe` : name);

// Pure so the self-check can exercise every platform without touching disk.
export function candidates(name, env = process.env, platform = process.platform) {
  if (!TOOLS.includes(name)) throw new Error(`unknown tool: ${name}`);
  const bin = exeName(name, platform);
  // Join with the target platform's separators rather than the host's. This
  // function takes a platform, so it has to honour it: on Windows, path.join
  // turned every candidate into backslashes, including the POSIX ones, which
  // made it wrong for any platform but the one it happened to run on.
  const P = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  const override = env[ENV_OVERRIDE[name]];
  if (override) out.push(override);
  // Set by the desktop shell: <resources>/bin ships with the app, <data>/bin is
  // where a managed yt-dlp installs and self-updates.
  if (env.VIDTOTAB_RESOURCES_DIR) out.push(P.join(env.VIDTOTAB_RESOURCES_DIR, 'bin', bin));
  if (env.VIDTOTAB_DATA_DIR) out.push(P.join(env.VIDTOTAB_DATA_DIR, 'bin', bin));
  if (platform === 'darwin') {
    out.push(`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`); // Apple silicon, then Intel
  } else if (platform !== 'win32') {
    out.push(`/usr/local/bin/${bin}`, `/usr/bin/${bin}`, `/snap/bin/${bin}`);
  }
  out.push(bin); // PATH lookup — unchanged behaviour for a dev checkout
  return out;
}

const isExecutable = (p) => {
  if (!path.isAbsolute(p)) return false; // bare name: leave it to PATH
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const cache = new Map();

// Absolute path when we can find one, bare name otherwise so spawn's own ENOENT
// still surfaces the familiar "not available on PATH" message.
export function toolPath(name) {
  // Tolerant on purpose: this sits in front of every spawn, so an unrecognised
  // name falls through to PATH exactly as it does today rather than throwing
  // inside a request handler.
  if (!TOOLS.includes(name)) return name;
  const hit = cache.get(name);
  if (hit) return hit;
  const found = candidates(name).find(isExecutable) ?? exeName(name);
  cache.set(name, found);
  return found;
}

export function clearToolCache() {
  cache.clear();
}

export function selfCheck(assert) {
  const linux = { VIDTOTAB_RESOURCES_DIR: '/app/res', VIDTOTAB_DATA_DIR: '/data' };

  // An explicit override wins outright.
  assert.equal(candidates('ffmpeg', { ...linux, VIDTOTAB_FFMPEG: '/custom/ff' }, 'linux')[0], '/custom/ff');

  // Shipped binaries beat downloaded ones, and both beat the system.
  const order = candidates('yt-dlp', linux, 'linux');
  assert.deepEqual(order.slice(0, 2), ['/app/res/bin/yt-dlp', '/data/bin/yt-dlp']);
  assert.ok(order.indexOf('/data/bin/yt-dlp') < order.indexOf('/usr/bin/yt-dlp'));

  // PATH stays last, so a checkout with nothing configured behaves as before.
  assert.equal(candidates('ffprobe', {}, 'linux').at(-1), 'ffprobe');
  assert.deepEqual(candidates('ffprobe', {}, 'darwin'),
    ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe']);

  // Windows needs the extension everywhere, including the fallback.
  const win = candidates('ffmpeg', { VIDTOTAB_DATA_DIR: 'C:\\d' }, 'win32');
  assert.ok(win.every((c) => c.endsWith('ffmpeg.exe')));
  assert.equal(win.at(-1), 'ffmpeg.exe');
  assert.ok(!win.some((c) => c.startsWith('/usr'))); // no POSIX roots on Windows

  // Separators follow the target platform, not whichever machine is running
  // this. That distinction was invisible for a while: asking for Windows
  // candidates on a Mac produced "C:\d/bin/ffmpeg.exe", and an assertion that
  // only checked the suffix was perfectly happy with it. A Windows CI runner
  // caught it instead, which is a test's job, not a runner's.
  assert.ok(win.includes('C:\\d\\bin\\ffmpeg.exe'), `win32 separators: ${win.join(' ')}`);
  assert.ok(order.every((c) => !c.includes('\\')), `posix separators: ${order.join(' ')}`);

  // A bare name is never probed on disk: relative paths must fall through to PATH.
  assert.equal(isExecutable('ffmpeg'), false);

  // Only the three tools we ship resolve; anything else is a programming error.
  assert.throws(() => candidates('curl', {}, 'linux'), /unknown tool/);

  // An unknown name passes through untouched instead of throwing.
  assert.equal(toolPath('curl'), 'curl');

  // The real resolver returns something spawnable for each tool.
  for (const t of TOOLS) assert.ok(toolPath(t).length > 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const assert = (await import('node:assert')).strict;
  selfCheck(assert);
  console.log('tools.js self-check passed');
  for (const t of TOOLS) console.log(`  ${t} -> ${toolPath(t)}`);
}
