// Downloads the ffmpeg/ffprobe builds that ship inside the app.
//
//   npm run binaries          this platform
//   npm run binaries -- --all every platform (what CI needs)
//
// Why bundle at all: an app launched from Finder or the Dock has no Homebrew on
// its PATH, and a machine that never had ffmpeg has nothing to find. Without
// these, a packaged download greets a non-developer with "missing tools —
// brew install ffmpeg", which is the whole problem the app exists to avoid.
//
// Licensing is the reason these particular builds were chosen. Both publishers
// ship LGPL builds with no GPL components (no libx264/libx265), and both
// publish the corresponding sources next to the binaries, which is what makes
// redistributing them inside a download lawful. A popular macOS arm64 build was
// rejected during this work: it is a GPL build and its site adds an
// "educational purposes only" restriction, which cannot be squared with
// shipping it to users.
//
// Every archive is pinned by SHA-256, taken from the publisher's own checksum
// file rather than computed here, so a tampered or swapped upload fails loudly.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'bin');

const NS = 'https://github.com/Nothing-Software/FFmpeg-Builds/releases/download/9.0.1-ntr1';
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-15-13-18';

// Pinned deliberately to dated releases. BtbN's `latest` tag is rolling — its
// assets are replaced in place, so a checksum pinned against it would break the
// first time they rebuild.
const TARGETS = {
  'darwin-arm64': {
    url: `${NS}/ffmpeg-9.0.1-ntr1-macos-arm64.zip`,
    sha256: '5a3744024f1982be7bfafcfddb3d577204f3dc4a68248b57624c283bacfbf0c7',
    kind: 'zip',
    sources: `${NS}`,
  },
  'win32-x64': {
    url: `${NS}/ffmpeg-9.0.1-ntr1-windows-x86_64.zip`,
    sha256: 'f99fa9991657e6ebd5735606d662c84fc71799f5766d0d7fcc94b0a69ff6986d',
    kind: 'zip',
    sources: `${NS}`,
  },
  'linux-x64': {
    url: `${BTBN}/ffmpeg-n9.0.1-30-g9258bacca5-linux64-lgpl-9.0.tar.xz`,
    sha256: 'ed619a525ed4059f9fccdaef92bcc8af8c4ba882ba5a19317d37c494939f2291',
    kind: 'tar.xz',
    sources: 'https://github.com/BtbN/FFmpeg-Builds',
  },
  'linux-arm64': {
    url: `${BTBN}/ffmpeg-n9.0.1-31-g3a7c002718-linuxarm64-lgpl-9.0.tar.xz`,
    sha256: '4f2c3fd0a0a7ef63f0d4f7ac32d50059f7a53ca14ea079438fecbec07b4546ef',
    kind: 'tar.xz',
    sources: 'https://github.com/BtbN/FFmpeg-Builds',
  },
};

const NEEDED = ['ffmpeg', 'ffprobe'];
const exeFor = (target, name) => (target.startsWith('win32') ? `${name}.exe` : name);

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${String(r.stderr).slice(-400)}`);
  return r;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// The archives disagree about layout. The macOS build is a flat folder holding
// the executables *and* their dylibs — its rpath is @executable_path, so those
// have to stay side by side — while BtbN nests static binaries in a versioned
// bin/. Copying the whole folder the executables live in handles both, and
// carries the LICENSE files along, which LGPL redistribution needs anyway.
function binaryDir(dir, target) {
  const wanted = new Set(NEEDED.map((n) => exeFor(target, n)));
  let hit = null;
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    if (!hit && entries.some((e) => e.isFile() && wanted.has(e.name))) hit = d;
    for (const e of entries) if (e.isDirectory()) walk(path.join(d, e.name));
  };
  walk(dir);
  return hit;
}

const isNative = (target) => target === `${process.platform}-${process.arch}`;

// Running the thing is the only check that catches a shared build whose
// libraries were left behind. The first version of this script copied just the
// two executables and produced an ffmpeg that died on a missing dylib, which a
// size or permission check happily called fine.
function runs(destDir, target) {
  if (!isNative(target)) return true; // cannot execute another platform's build
  const r = spawnSync(path.join(destDir, exeFor(target, 'ffmpeg')), ['-version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0;
}

function alreadyGood(destDir, target) {
  const present = NEEDED.every((n) => {
    try {
      fs.accessSync(path.join(destDir, exeFor(target, n)), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  return present && runs(destDir, target);
}

async function fetchTarget(target) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`no pinned build for ${target}`);
  const destDir = path.join(OUT, target);

  if (alreadyGood(destDir, target)) {
    console.log(`ok    ${target} — already present`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-ff-'));
  const archive = path.join(tmp, path.basename(spec.url));

  console.log(`      ${target} — downloading ${path.basename(spec.url)}`);
  await download(spec.url, archive);

  const got = sha256(archive);
  if (got !== spec.sha256) {
    throw new Error(`checksum mismatch for ${target}\n  expected ${spec.sha256}\n  got      ${got}`);
  }

  const unpack = path.join(tmp, 'x');
  fs.mkdirSync(unpack);
  if (spec.kind === 'zip') run('unzip', ['-q', archive, '-d', unpack]);
  else run('tar', ['-xJf', archive, '-C', unpack]);

  const srcDir = binaryDir(unpack, target);
  if (!srcDir) throw new Error(`${target}: archive contained no ${NEEDED.join(' or ')}`);

  let bytes = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const dest = path.join(destDir, entry.name);
    fs.copyFileSync(path.join(srcDir, entry.name), dest);
    bytes += fs.statSync(dest).size;
  }
  for (const n of NEEDED) fs.chmodSync(path.join(destDir, exeFor(target, n)), 0o755);

  if (!runs(destDir, target)) {
    const r = spawnSync(path.join(destDir, exeFor(target, 'ffmpeg')), ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error(`${target}: the copied ffmpeg does not run — ${String(r.stderr).trim().slice(0, 300)}`);
  }
  console.log(`ok    ${target} — ${(bytes / 1e6).toFixed(1)}MB, ffmpeg runs`);
  fs.writeFileSync(path.join(destDir, 'SOURCE.txt'),
    `${spec.url}\nsha256 ${spec.sha256}\nsources: ${spec.sources}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const all = process.argv.includes('--all');
const targets = all ? Object.keys(TARGETS) : [`${process.platform}-${process.arch}`];

let failed = 0;
for (const t of targets) {
  try {
    await fetchTarget(t);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${t}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
