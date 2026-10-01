// The release page: .github/release-template.md filled in for one version,
// with that version's section of CHANGELOG.md as its "What's new".
//
//   node scripts/release-notes.mjs v0.4.0 [previous tag]   the notes (markdown)
//   node scripts/release-notes.mjs --title v0.4.0          VidToTab 0.4.0 · Mercury
//   node scripts/release-notes.mjs                         self-check
//
// The release job in .github/workflows/ci.yml runs the first two. A version
// with no section in CHANGELOG.md still gets released, with its commit list
// as "What's new" and a warning on the run, rather than failing after every
// installer is already built.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.GITHUB_REPOSITORY || 'KXYZ6753/VidToTab';

// Each major version is a planet, outward from the sun: 0.x (beta) and 1.x
// are Mercury, 2.x Venus, 3.x Earth, and so on. Past Neptune it stays there.
const PLANETS = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
export const planetOf = (version) => {
  const major = parseInt(String(version).replace(/^v/, ''), 10) || 0;
  return PLANETS[Math.min(PLANETS.length - 1, Math.max(0, major - 1))];
};
export const titleOf = (version) => `VidToTab ${version} · ${planetOf(version)}`;

// A Windows checkout gives these files CRLF line endings; the page uses LF.
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

// The lines under "## <version>" up to the next "## " heading, or null.
export function sectionOf(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, next < 0 ? lines.length : next).join('\n').trim() || null;
}

export const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));

export function notesFor(tag, prev) {
  const version = tag.replace(/^v/, '');
  const template = read('.github', 'release-template.md');
  let whatsNew = sectionOf(read('CHANGELOG.md'), version);
  if (!whatsNew) {
    console.error(`::warning::CHANGELOG.md has no "## ${version}" section — the release lists its commits instead.`);
    whatsNew = prev
      ? `${execFileSync('git', ['log', '--no-merges', '--pretty=- %s', `${prev}..${tag}`], { cwd: ROOT, encoding: 'utf8' }).trim()}\n\n[Everything that changed](https://github.com/${REPO}/compare/${prev}...${tag})`
      : '- First release.';
  }
  return fill(template, { version, whats_new: whatsNew, repo: REPO, download: `https://github.com/${REPO}/releases/download/${tag}` });
}

function selfCheck(assert) {
  assert.equal(planetOf('0.4.0'), 'Mercury', 'betas are Mercury');
  assert.equal(planetOf('v1.9.2'), 'Mercury', 'and so is 1.x');
  assert.equal(planetOf('2.0.0'), 'Venus');
  assert.equal(planetOf('3.1.0-beta.1'), 'Earth');
  assert.equal(planetOf('12.0.0'), 'Neptune', 'past Neptune it stays there');
  assert.equal(titleOf('0.4.0'), 'VidToTab 0.4.0 · Mercury');
  const log = '# Changelog\n\n## 0.5.0\n\nNew.\n- a\n\n## 0.4.0\n\nOld.\n';
  assert.equal(sectionOf(log, '0.5.0'), 'New.\n- a', 'one section, not the next');
  assert.equal(sectionOf(log, '0.4.0'), 'Old.');
  assert.equal(sectionOf(log, '0.4'), null, 'a version is matched whole');
  assert.equal(sectionOf(log.replace(/\n/g, '\r\n'), '0.5.0'), 'New.\n- a', 'a Windows checkout reads the same');
  assert.equal(fill('{{a}} {{b}} {{c}}', { a: 1, b: '' }), '1  {{c}}');
  // The real files: every placeholder filled, and this release's section found.
  const notes = notesFor('v0.4.0', null);
  assert.ok(!/\{\{/.test(notes), 'no placeholder left in the notes');
  assert.ok(notes.includes('## What\'s new in 0.4.0\n\n**Listen.**'), 'the 0.4.0 section is the What\'s new');
  assert.ok(notes.includes('releases/download/v0.4.0/VidToTab-0.4.0-arm64.dmg'), 'download links point at this tag');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) {
    selfCheck((await import('node:assert/strict')).default);
    console.log('release-notes.mjs self-check passed');
  } else if (args[0] === '--title') {
    console.log(titleOf(args[1].replace(/^v/, '')));
  } else {
    process.stdout.write(`${notesFor(args[0], args[1] || null)}\n`);
  }
}
