# VidToTab

Turn a guitar-tab video into a clean, printable songsheet. Paste a YouTube link (or drop a video file): VidToTab finds the tab on screen, captures every distinct tab page once, strips out cursors and measure highlights, and exports a PDF or PNG with the song title, link and thumbnail on top. Finished songsheets are kept, so you can come back to them.

It is tuned for the common tab-video styles — vvxoFingerstyleTab-style dark panels (orange cursors, blue measure highlights, notes that turn orange as they're played), tab and chord diagrams overlaid on live video, and white "Tab Sheet Music" pages.

It runs as a desktop app on macOS, Windows and Linux, as a local server, or hosted for other people to use — the same code behind all three.

## Three ways to run it

One codebase behind all of them.

| | Desktop app | Local server | Hosted |
|---|---|---|---|
| For | anyone, no terminal | developers | you, and whoever you share the address with |
| ffmpeg | bundled | install it yourself | in the image |
| yt-dlp | fetched on first run, kept current | install it yourself | in the image |
| Limits | none | none | off by default, on with `VIDTOTAB_PUBLIC=1` |
| Songsheets | a folder of files, `Documents/VidToTab` | kept in the browser | kept in each visitor's browser |
| Updates | tells you, and downloads the installer | `git pull` | redeploy |

### Desktop app — macOS, Windows, Linux

Installers for all three platforms are published to [Releases](https://github.com/KXYZ6753/VidToTab/releases) by tagging a version — see [Releasing](#releasing). To build your own:

```sh
npm install
npm run pack            # unpacked build in dist/ — quickest way to try it
npm run dist            # installers for this platform
```

It carries its own ffmpeg (LGPL, pinned by checksum) and fetches yt-dlp into its data folder on first run, so it works on a machine that has neither — an app opened from Finder, the Dock or a .desktop file has no Homebrew on its PATH, which is the whole reason it brings its own.

The macOS app is ad-hoc signed, which is what stops macOS calling it damaged, but it is not notarised: the first launch of a downloaded copy is stopped, and since macOS 15 the way through is **System Settings → Privacy & Security → Open Anyway** (right-click → Open no longer is). Windows SmartScreen wants **More info → Run anyway**. [Releasing](#releasing) explains what it would take to remove both.

**Songsheets are files.** Each one is a folder in `Documents/VidToTab` — `sheet.json`, one `page-NNN.png` per page (and `page-NNN-original.png` where the video's own colours differ), and the video's thumbnail. The folder follows the songsheet's title, so it can be found in Finder or Explorer, copied to another machine, or backed up with everything else; the app goes by the id inside `sheet.json`, so renaming or moving a folder by hand loses nothing. Only files the app wrote are ever changed. A songsheet saved by 0.2, which kept them in the app's browser storage, is copied into the folder once on the first launch of a newer version, and the original is left where it was.

The **Library** in the sidebar is the full view of that folder: search across titles, artists, channels and notes; sort by when a songsheet was added or edited, by title, artist or page count; select several and move them to the Trash (or Recycle Bin) together. Selecting one shows its details — edit the title, artist and notes in place, see its pages, open it, practise from it, or show its folder. *Change…* points the library at another folder and offers to move the songsheets there. On a Mac the first save to Documents asks for permission once; if it was refused, allow it under System Settings → Privacy & Security → Files and Folders, or choose another folder.

**Updates.** On launch, and whenever you click the version in the top bar, the app asks GitHub which release is the newest. The request carries this app's version and platform and nothing else — no identifier, nothing about your songsheets. If there is a newer one, a banner offers **Download**, **What's new** and **See releases**. Download fetches the installer for this machine (the `.dmg`, the Windows installer, or the `.deb` or AppImage matching how it was installed), checks it against the SHA-256 GitHub publishes for it, and opens it: on a Mac, quit VidToTab and drag the new one into Applications; on Windows the installer takes over and the app closes. It is a notice and a download rather than a silent auto-update, because replacing a running macOS app in place needs a Developer ID signature this app does not have yet. The check can be turned off in the same dialog.

The desktop app has no landing page. That view exists to explain the thing and offer the download, and inside the download both halves are pointless, so it opens straight into the working layout and the home toggle is not there — a preference remembered from a browser on the same machine does not follow it in.

### Local server

```sh
brew install yt-dlp ffmpeg     # or your platform's equivalent
npm install
npm start                      # http://127.0.0.1:3000  (PORT=xxxx to override)
```

Node 26. The server listens on loopback only, so nothing on your network can reach it. `HOST=0.0.0.0` opens it up deliberately, for a hosted deployment. Keep yt-dlp current — YouTube changes often, and the app warns when the installed copy is more than 60 days old.

### Hosted

```sh
docker build -t vidtotab .
docker run -p 3000:3000 -v vidtotab-data:/data -e VIDTOTAB_PUBLIC=1 vidtotab
```

`VIDTOTAB_PUBLIC=1` switches the limits on. Without it a hosted instance behaves exactly like a local one and has none — that split is deliberate: your own machine is unlimited, a public address is not.

| | Default | |
|---|---|---|
| `VIDTOTAB_MAX_UPLOAD_MB` | 512 | refused with the cap named |
| `VIDTOTAB_MAX_MINUTES` | 20 | checked before the download starts |
| `VIDTOTAB_RATE_LIMIT` / `VIDTOTAB_RATE_WINDOW_SEC` | 20 / 60 | per IP, 429 with `Retry-After` |
| `VIDTOTAB_MAX_JOBS` | 1 | 503 with `Retry-After` |
| `VIDTOTAB_TRUST_PROXY` | off | only then is `X-Forwarded-For` believed |

`GET /api/health` answers `{ok, mode, public, version, uptimeSec}` for whatever is watching it.

**A public instance serves one person at a time, and that is its shape rather than a setting.** The server holds a single job, so a second visitor starting a video would end the first one's scan. While someone is using it others are asked to wait; their video and pages are theirs alone — nobody else can read or cancel them — and the instance frees itself when they leave or their scan fails. Raising `VIDTOTAB_MAX_JOBS` buys no concurrency, it only lets visitors delete each other's work, and the server says so on startup if you set it.

## Using it

1. **Video** — paste a link (anywhere on the page, not just in the box), drop a link or a video file, or open `…/?url=<video>` from a bookmark. Saved songsheets are listed underneath.
2. **Tab area** — the tab is detected automatically and outlined on the video. Check the box, adjust it if needed (drag the handles), pick where scanning starts, and press **Scan for pages**.
3. **Scan** — pages appear as they're found; cancel any time.
4. **Songsheet** — edit the title, remove pages you don't want (undo supported), click a timestamp to check it against the video, choose a **look** (Print, Dark, Sepia, or the original video colours), pick Letter or A4, and export a PDF or PNG. *Not quite right?* re-scans with fewer or more pages in seconds — frames are cached.

**Practice** is for playing along, full screen. Press **Play** (or K) and each page, shown as a card like on the songsheet step, fills from left to right over the time it lasts, with a countdown to the next page — then the next one comes up. It is a timer for when the page turns, not a claim to follow the notes, which are not evenly spaced in time. The pace is the video's own timing by default (every page knows how long it was on screen), and **−** / **+** (or [ and ]) slow it down or speed it up; click the speed to go back to real speed. Enter the song's tempo in Settings and the pace is shown and set in BPM instead. Pages the video repeats are played again where it repeats them, and there is a short count-in before the first page. *Scroll* shows the next pages coming up below the one being played; *One page* shows one at a time. The pace is saved with the songsheet; the layout and count-in are remembered.

Arrow keys, space or PageUp/PageDown still turn the page by hand, playing or not — the last pair is what most Bluetooth page-turner pedals send, so a pedal works without any setup. On a phone or tablet, tap the left or right edge in *One page*. The screen is kept awake while you read, playback pauses if the app is hidden, and Esc leaves. Settings also has an experimental playhead over the notes, off by default.

Every finished scan is saved to **your songsheets** on the home screen, because loading another video wipes the working folder, and changes made on the songsheet step — the title, a removed page, the look, the paper — are saved back as you make them. In a browser the pages are stored as images in the browser itself, so a saved songsheet still opens after the video is long gone; export a PDF to keep a copy anywhere else. The desktop app keeps them as files instead (above).

There is a **home page** and an **app view**, swapped by the button in the bar. The home page is the front door; the app view drops the pitch and puts a sidebar beside the workspace with new scan, every saved songsheet and practice — so a songsheet is one click away instead of four steps back. The desktop build opens straight into the app view, since a downloaded app has no business showing a landing page every launch.

## How it works

Everything runs locally: yt-dlp downloads, ffmpeg decodes, the analysis is plain JavaScript over raw frames (no image libraries).

- **Finding the tools** (`pipeline/tools.js`) resolves ffmpeg, ffprobe and yt-dlp to absolute paths — what the app ships with, then what it downloaded, then the usual install roots, then PATH. Spawning them by bare name works all through development and fails the moment someone double-clicks a built app.

- **Tab detection** (`pipeline/detect.js`) samples keyframes across the video and looks for the one thing every tab style shares: six thin, evenly spaced horizontal lines that stay put while everything around them changes. Guitar strings fail (slanted, moving); panel borders and live video stop the box from growing past the tab.
- **Calibration** measures the crop's polarity (light notes on dark or dark on light), staff-line spacing and ink contrast. Every later threshold is expressed in those units, so results don't depend on resolution or on how loosely the box was drawn. If it can't find the six lines, it says so instead of producing pages that look plausible.
- **Ink planes** (`pipeline/ink.js`): luma, polarity-normalized, then a morphological top-hat that deletes anything wider than a few line spacings (translucent measure highlights, guitar bodies) while keeping digits, lines and symbols. Cursor bars are removed by shape and colour.
- **Pass 1** (`pipeline/analyze.js`) runs over a half-resolution cache at 4 fps: a 7-frame temporal majority filter erases moving cursors and playheads, static chrome and flickering video are excluded, and a new page starts where the ink changes by a lot overall or by a glyph-sized cluster anywhere.
- **Assembly** (`pipeline/assemble.js`) merges runs of the same screen, folds repeats into "repeats at …", and drops intro/outro screens that don't show the staff.
- **Pass 2** (`pipeline/composite.js`) decodes up to 11 frames per page once, and renders a *clean* print (percentile-ranked ink, black on white) and an *original-colour* version that per-pixel rejects tinted samples.
- **Looks** (`public/shared/look.js`) map that clean greyscale render onto any paper and ink colour. The same module drives the preview, the PNG and the PDF, so what you see is what you export.
- **Export** builds the PDF server-side (pdf-lib); the header is rendered in the browser so titles in any script (「勇者」, 최애의 아이) print correctly.

## Development

```sh
npm test                      # pipeline self-checks + the browser-shared modules
npm run test:server           # server behaviour: upload races, the guard, public limits, job ownership
npm run test:app              # launches the desktop shell: library folders, the Library screen, the
                              # update check against a fake GitHub, and that it leaves nothing running
npm run test:app:packaged     # the same against a built app
npm run binaries              # fetch the pinned ffmpeg/ffprobe for this platform
npm run icon                  # redraw build/icon.png from source
npm run e2e                   # drives a real browser through the whole flow over CDP
npm run eval                  # detection + pipeline on the labelled eval set
npm run eval -- --only yT9gKKwBeVw --sens 0.5,0.75,1
npm run eval -- --detect-only
npm run eval -- --label       # frame grids for labelling a new video
npm run eval -- --rescore     # re-score saved captures against current labels
```

`scripts/eval-set.json` holds hand-labelled page sequences (`"t:id"` page starts, repeats reuse the id). The harness downloads videos into `.cache/eval/`, scores recall/precision of page starts, repeat folding, crop IoU and leftover highlight colour, and writes contact sheets to inspect.

Two gates worth knowing about. A fixture may record the score it genuinely reaches as `expect.floor`, with the reason in `expect.notes`; fixtures without a floor must be perfect, and a floor may be raised after a fix but never lowered to make a run green. Fixtures marked `noTab: true` must be *declined* by detection — rejecting videos without tab is half of being accurate, and it is checked rather than assumed.

### Brand and motion

The mark, the loading animations and the opening sequence live in `public/brand/`; the two typefaces in `public/fonts/`, served from there rather than from a CDN because the desktop build is expected to work with no network.

| File | What it holds |
|---|---|
| `brand/motion.js` | The lifecycle every looping animation shares — how it arrives, how it stays in step with the others, and an exit that waits for the loop's own seam before fading. Self-checked by `npm test`. |
| `brand/loaders.{css,js}` | The four loaders: `strings` (reading video info), `beam` (detecting the tab area), `pages` (rendering pages), `scan` (the scan step). `createLoader(kind)` returns `{ el, show, hide }`. |
| `brand/splash.{css,js}` | The opening animation, played once at launch. |
| `brand/preview.html`, `brand/splash-preview.html` | Every loader at several sizes in both themes, and the opening sequence with a replay button. Open them at `/brand/preview.html` and `/brand/splash-preview.html`. |

Three things hold this together, and all three are easy to undo by accident.

**Colour comes from the tokens in `index.html`, never from a hex code.** The brand orange is `#ff8a3d` only in dark mode; the light theme deliberately darkens it to `#c93f0c` so that white on accent clears WCAG AA. Writing the kit's orange into a component would quietly undo that.

**Every loop returns to the pose it started in, and leaves at that seam** rather than wherever it had reached. A loader runs for as long as the work does, so its seam is seen far more often than its beginning; `motion.js` explains the mechanism and the cap on how long it will wait before fading from where it is.

**Nothing moves under `prefers-reduced-motion`,** and nothing goes blank either: each loader has a resting pose that still says "working". The step transitions are named there explicitly — they are more specific than the `.step` rule that block already covered, so leaving them out would have quietly exempted them.

Steps arrive from the side they came from: forward from the right, back from the left, decided in `showStep()` before the section is unhidden, since what restarts the animation is the section leaving `display: none`. Only the incoming step moves — animating both would mean taking them out of the flow and paying for it with a layout jump at the end of every transition.

`npm run icon` draws the app icon from the same mark, so the icon and the interface cannot drift apart.
### Releasing

Two commands. `npm version` bumps `package.json`, commits that, and makes the matching tag; pushing the tag is what starts a release.

```sh
npm version patch          # or minor, or major
git push --follow-tags
```

The tag runs the same matrix as any other push — module self-checks, server checks, a real build, and the packaged app started and shut down again on macOS, Windows and Linux — and then, only if all of that is green, builds the installers and publishes a GitHub release with them attached:

| Platform | What lands on the release |
|---|---|
| macOS, Apple Silicon | `.dmg`, plus a `.zip` of the same app |
| Windows, x64 | `VidToTab.Setup.<version>.exe` |
| Linux, x64 and arm64 | `.deb` |
| Linux, x64 | `.AppImage` |

The tag has to match `package.json`, and the workflow stops if it does not — installers are named from `package.json`, so a tag made by hand that disagrees with it produces downloads whose names are a lie. `npm version` moves both together, which is why it is the way to make the tag.

A tag with a suffix, `v0.2.0-beta.1`, is published as a pre-release, so "Latest release" on the repo page goes on pointing at the last stable one. Re-running a release that failed part way through is safe: it replaces the files on the existing release rather than refusing because it already exists, and publishes it if it had been left a draft — which is what GitHub does to a release whose tag was deleted and pushed again.

The macOS app is ad-hoc signed (`mac.identity: '-'`), and that is not cosmetic. Every Mach-O binary on Apple Silicon must carry a signature to run at all, and an unsigned one is reported as *"VidToTab is damaged and can't be opened"* — an error with no right-click-Open escape. What arrives from electron-builder without an explicit identity is the linker's own signature on the Electron binary, which `codesign --verify` rejects; the ad-hoc pass re-seals the bundle under `com.vidtotab.app`. The hardened runtime stays on with `electron/entitlements.mac.plist`, so notarising later is a credential change rather than a packaging one.

It is still not notarised, so Gatekeeper stops the first launch of a downloaded copy and says Apple cannot check it for malicious software. Since macOS 15 the only way past it is **System Settings → Privacy & Security → Open Anyway** (or `xattr -dr com.apple.quarantine`), and the generated release notes say so. Apple's own `syspolicy_check` calls ad-hoc signing a warning and the missing notary ticket fatal, which is the honest summary: this is fine for people who trust the source and wrong for strangers.

Removing that warning needs a **Developer ID Application** certificate — not the Apple Development or Apple Distribution certificates, which are for Xcode and the App Store — exported as a .p12 into `CSC_LINK` / `CSC_KEY_PASSWORD` repository secrets, App Store Connect API credentials for the notary service, `CSC_IDENTITY_AUTO_DISCOVERY` turned back on and `mac.identity` removed so the real certificate is found. Windows has the same shape of problem and the same shape of answer: SmartScreen warns until the installer is signed.

## Results

**Tuned videos** — hand-labelled sequences, scored at the default setting. *Recall* = distinct tab screens captured (a page whose notes are lost counts as missed); *precision* = captures that are a new screen (duplicates and intro/outro frames count against it). "Detected box" is the real flow.

| Video | Style | Pages | Detected box | Hand-drawn box |
|---|---|---|---|---|
| Crossing Field (yT9gKKwBeVw) | dark strip, blue measure highlight | 15 | 1.00 / 0.94 | 1.00 / 1.00 |
| Tabibito no Uta (Fv3pCR1Btjk) | dark panel, notes turn orange when played | 16 | 1.00 / 1.00 | 1.00 / 1.00 |
| Yuusha (MENRbBUBYd4) | dark panel, orange cursor bar | 20 | 1.00 / 1.00 | 1.00 / 1.00 |
| Unravel (0YXjZDR5V-4) | dark strip, wide blue highlight | 15 | 1.00 / 1.00 | 1.00 / 1.00 |
| Mephisto (73HxHE5e2yY) | tab + chords over live video, 2-bar screens | 31 | 0.97 / 0.68 | 0.97 / 0.67 |

**Held-out videos** — nine more from the same playlist, never tuned on, measured before any change was made to fit them. Five genuinely show tab on screen, and detection found the tab area in **all five**; their pages were checked by eye (chord names, time signatures, slides, ties and technique marks all survive the clean print). They carry no hand-labelled sequences, so they have no recall/precision score — a count is not an accuracy claim.

The other four turned out to have **no tab on screen at all**: channels put "TAB" in the title because tabs are sold or linked, not shown. Together with a piano video, a fingerstyle cover and piano sheet music, that makes **eight videos that must be declined — and all eight are**, including the sheet music, whose five-line staves are not mistaken for six-line tab.

One held-out video shows the limits honestly: YouTube refused every stream for the default player client, the fallback offered only 360p, and at that size the tab band is 48 pixels tall and calibration cannot lock onto the staff. The app now says so — on the source card and in the scan — rather than reporting two pages as though it had worked.

## Troubleshooting

- **"YouTube is rate-limiting downloads"** — a temporary bot check, not a permanent block. Wait a few minutes, or download the video yourself and drop the file in. The app already retries through other YouTube player clients and remembers which one worked.
- **"Only 360p came through"** — YouTube gave the fallback route a low-quality stream. Small tab text may not survive the scan; trying again later often gets the better one.
- **"Couldn't lock onto the six tab lines"** — the box probably isn't on the tab, or the video is too low quality to read.
- **The box is wrong or missing** — pause on a frame where the tab is visible, press *Adjust box*/*Draw box*, and drag. *Detect again* re-samples the video.
- **Duplicates or a missing page** — *Not quite right? → Fewer pages / More pages*.

**Test against the ffmpeg the app ships, not the one on your machine.** The bundled builds are LGPL: no libx264, and compiled `--disable-avdevice`, so `-f lavfi` does not exist in them. A Homebrew copy has both, which hides a whole class of failure until it reaches a user.

```sh
npm run binaries
VIDTOTAB_FFMPEG=$PWD/build/bin/$(node -p "process.platform+'-'+process.arch")/ffmpeg \
VIDTOTAB_FFPROBE=$PWD/build/bin/$(node -p "process.platform+'-'+process.arch")/ffprobe \
  npm run test:server
```

## Known limits

- Horizontally or vertically **scrolling** tabs aren't stitched; the app captures page flips. None of the 19 videos surveyed for this project scroll, so stitching was deliberately not built rather than shipped untested.
- Two pages that differ only by a thin mark (an "x" strum mark, a single changed digit on a small, low-resolution tab) can be merged — use *More pages*.
- Live video directly behind the notation can leave faint marks in the clean print; *Original* shows the video frame as-is.
- In a browser, songsheets are stored in the browser. Clearing site data removes them; export a PDF to keep a copy. (The desktop app keeps them as files.)
- A **hosted instance is one person at a time** — see [Hosted](#hosted). The limits keep visitors from disturbing each other; they do not make it multi-user.
- **The downloads are not signed by a known developer.** macOS wants *Open Anyway* in Privacy & Security on first launch and Windows SmartScreen wants *Run anyway* — see [Releasing](#releasing) for what removing both would take.
- Planned: AI transcription of captures into re-rendered tab (alphaTex / alphaTab).
