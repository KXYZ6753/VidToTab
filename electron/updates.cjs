// Is there a newer VidToTab than this one? Asks GitHub, and only GitHub.
//
// The desktop app is downloaded from this repository's releases and nowhere
// else, so the releases feed is the single source of truth: /releases/latest
// already leaves out drafts and pre-releases, which is exactly the set someone
// on a stable build should be offered.
//
// This is a notice, not an auto-updater. Replacing a running macOS app in place
// needs a Developer ID signature — Squirrel checks the new bundle's designated
// requirement against the old one, and an ad-hoc signature has none that
// survives a rebuild — so every platform gets the same honest thing: "there is
// a new version, here it is". The app then downloads the right installer for
// this machine, checks it against the SHA-256 GitHub publishes for it, and
// opens it.
//
// Nothing in here imports Electron, so it can be exercised with plain node.

const REPO = 'KXYZ6753/VidToTab';
const FEED = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const TIMEOUT_MS = 10000;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

// Semver precedence: -1, 0 or 1. Anything unparseable compares equal, so a
// malformed tag can never be offered as an "update".
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  // A release outranks its own pre-releases: 1.0.0-beta.2 < 1.0.0.
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (+p !== +q) return +p < +q ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

// Which file on the release is the installer for this machine. Names are the
// ones GitHub serves, which are not quite what electron-builder wrote: spaces
// become dots ("VidToTab.Setup.0.2.0.exe") and the .deb is lower-case. x64
// builds carry no arch in their name, so "not arm64" is how they are told
// apart. No match means no button — the releases page is always offered.
function pickAsset(assets, { platform, arch, appImage = false } = {}) {
  const list = (Array.isArray(assets) ? assets : [])
    .filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string');
  const find = (re) => list.find((a) => re.test(a.name)) || null;
  const arm = arch === 'arm64';
  if (platform === 'darwin') return arm ? find(/-arm64\.dmg$/i) : find(/^(?!.*arm64).*\.dmg$/i);
  // An x64 installer still runs on Windows on ARM, under emulation.
  if (platform === 'win32') return (arm && find(/arm64.*\.exe$/i)) || find(/^(?!.*arm64).*\.exe$/i);
  if (platform === 'linux') {
    // An AppImage replaces itself; a .deb goes through the package manager.
    // Offering the other kind would install a second copy beside the first.
    if (appImage) return arm ? find(/arm64\.AppImage$/i) : find(/^(?!.*arm64).*\.AppImage$/i);
    return find(arm ? /_arm64\.deb$/i : /_amd64\.deb$/i);
  }
  return null;
}

const httpsUrl = (u, fallback) => (typeof u === 'string' && /^https:\/\/github\.com\//.test(u) ? u : fallback);

// What the interface needs to know, and nothing it could be tricked by: every
// link is checked to be a github.com page before it is handed over.
function summarise(release, { current, platform, arch, appImage = false } = {}) {
  if (!release || typeof release.tag_name !== 'string') {
    throw new Error('Unexpected reply from GitHub.');
  }
  const latest = release.tag_name.replace(/^v/, '');
  const stable = !release.draft && !release.prerelease;
  const a = pickAsset(release.assets, { platform, arch, appImage });
  const digest = a && typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest)
    ? a.digest.toLowerCase() : null;
  return {
    available: stable && compareVersions(latest, current) > 0,
    current: String(current || ''),
    latest,
    name: String(release.name || `VidToTab ${release.tag_name}`).slice(0, 200),
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    notes: String(release.body || '').slice(0, 6000),
    pageUrl: httpsUrl(release.html_url, RELEASES_PAGE),
    releasesUrl: RELEASES_PAGE,
    asset: a ? {
      name: String(a.name),
      url: String(a.browser_download_url),
      size: Number(a.size) || 0,
      digest,
    } : null,
  };
}

async function fetchLatest({ fetchImpl = globalThis.fetch, feed = FEED, userAgent = 'VidToTab', timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(feed, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': userAgent,
      },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null; // nothing published yet
    // Unauthenticated calls get 60 an hour per address — plenty for one check
    // a launch, but a shared network can use them up.
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting update checks. Try again later.');
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`);
    return await res.json();
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('GitHub didn’t answer in time. Check your connection.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Only this repository's release files are ever downloaded. A test feed
// (VIDTOTAB_UPDATE_FEED) may also serve its own files, from its own origin.
function isAllowedDownload(url, feed = FEED) {
  if (typeof url !== 'string') return false;
  if (url.startsWith(DOWNLOAD_PREFIX)) return true;
  if (feed === FEED) return false;
  try {
    return new URL(url).origin === new URL(feed).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- self-check

async function selfCheck() {
  const assert = require('node:assert/strict');

  assert.equal(compareVersions('0.3.0', '0.2.0'), 1);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0, 'a leading v is not a different version');
  assert.equal(compareVersions('0.2.1', '0.10.0'), -1, 'numbers, not strings: 10 > 2');
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1, 'a release outranks its pre-releases');
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1, 'alphanumeric beats numeric');
  assert.equal(compareVersions('nonsense', '0.2.0'), 0, 'unparseable is never newer');

  // The real v0.2.0 asset list, exactly as GitHub serves it.
  const assets = [
    'VidToTab-0.2.0-arm64-mac.zip', 'VidToTab-0.2.0-arm64.dmg', 'VidToTab-0.2.0.AppImage',
    'VidToTab.Setup.0.2.0.exe', 'vidtotab_0.2.0_amd64.deb', 'vidtotab_0.2.0_arm64.deb',
  ].map((name) => ({ name, browser_download_url: `${DOWNLOAD_PREFIX}v0.2.0/${name}`, size: 1 }));
  const pick = (o) => pickAsset(assets, o)?.name ?? null;
  assert.equal(pick({ platform: 'darwin', arch: 'arm64' }), 'VidToTab-0.2.0-arm64.dmg', 'the dmg, not the zip');
  assert.equal(pick({ platform: 'darwin', arch: 'x64' }), null, 'no Intel build: no button, not the arm64 one');
  assert.equal(pick({ platform: 'win32', arch: 'x64' }), 'VidToTab.Setup.0.2.0.exe');
  assert.equal(pick({ platform: 'win32', arch: 'arm64' }), 'VidToTab.Setup.0.2.0.exe', 'x64 runs under emulation');
  assert.equal(pick({ platform: 'linux', arch: 'x64' }), 'vidtotab_0.2.0_amd64.deb');
  assert.equal(pick({ platform: 'linux', arch: 'arm64' }), 'vidtotab_0.2.0_arm64.deb');
  assert.equal(pick({ platform: 'linux', arch: 'x64', appImage: true }), 'VidToTab-0.2.0.AppImage');
  assert.equal(pick({ platform: 'linux', arch: 'arm64', appImage: true }), null);
  assert.equal(pick({ platform: 'freebsd', arch: 'x64' }), null);

  const release = {
    tag_name: 'v0.3.0', name: 'VidToTab v0.3.0', html_url: 'https://github.com/KXYZ6753/VidToTab/releases/tag/v0.3.0',
    body: 'notes', published_at: '2026-10-01T00:00:00Z',
    assets: [{ ...assets[1], name: 'VidToTab-0.3.0-arm64.dmg', digest: 'sha256:' + 'AB'.repeat(32) }],
  };
  const s = summarise(release, { current: '0.2.0', platform: 'darwin', arch: 'arm64' });
  assert.equal(s.available, true);
  assert.equal(s.latest, '0.3.0');
  assert.equal(s.asset.name, 'VidToTab-0.3.0-arm64.dmg');
  assert.equal(s.asset.digest, 'sha256:' + 'ab'.repeat(32), 'digest is normalised to lower case');
  assert.equal(summarise(release, { current: '0.3.0', platform: 'darwin', arch: 'arm64' }).available, false, 'same version: nothing to offer');
  assert.equal(summarise(release, { current: '0.4.0', platform: 'darwin', arch: 'arm64' }).available, false, 'never offer a downgrade');
  assert.equal(summarise({ ...release, prerelease: true }, { current: '0.2.0' }).available, false);
  assert.equal(summarise({ ...release, html_url: 'https://evil.test/x' }, { current: '0.2.0' }).pageUrl, RELEASES_PAGE,
    'a link that is not a github.com page is replaced, not passed on');
  assert.equal(summarise({ ...release, assets: [{ ...release.assets[0], digest: 'md5:x' }] },
    { current: '0.2.0', platform: 'darwin', arch: 'arm64' }).asset.digest, null);
  assert.throws(() => summarise({}, { current: '0.2.0' }));

  assert.ok(isAllowedDownload(`${DOWNLOAD_PREFIX}v0.3.0/x.dmg`));
  assert.ok(!isAllowedDownload('https://github.com/someone-else/VidToTab/releases/download/v1/x.dmg'));
  assert.ok(!isAllowedDownload('http://127.0.0.1:9/x.dmg'), 'a local file is refused against the real feed');
  assert.ok(isAllowedDownload('http://127.0.0.1:9/x.dmg', 'http://127.0.0.1:9/latest'), '…and allowed from a test feed on the same origin');

  const fake = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  assert.equal(await fetchLatest({ fetchImpl: fake(404) }), null, 'no release yet is not an error');
  assert.equal((await fetchLatest({ fetchImpl: fake(200, release) })).tag_name, 'v0.3.0');
  await assert.rejects(fetchLatest({ fetchImpl: fake(403) }), /limiting/);
  await assert.rejects(fetchLatest({ fetchImpl: fake(500) }), /HTTP 500/);
  const hang = (_u, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
  }));
  await assert.rejects(fetchLatest({ fetchImpl: hang, timeoutMs: 20 }), /in time/);

  console.log('updates.cjs self-check passed');
}

if (require.main === module) {
  selfCheck().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  FEED, RELEASES_PAGE, DOWNLOAD_PREFIX, parseVersion, compareVersions, pickAsset, summarise, fetchLatest, isAllowedDownload,
};
