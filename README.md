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
| Songsheets | kept by the app | kept in the browser | kept in each visitor's browser |

### Desktop app — macOS, Windows, Linux

**There are no published downloads yet.** CI builds the app and runs it on all three platforms on every commit, but nothing has been released, so for now you build your own:

```sh
npm install
npm run pack            # unpacked build in dist/ — quickest way to try it
npm run dist            # installers for this platform
```

It carries its own ffmpeg (LGPL, pinned by checksum) and fetches yt-dlp into its data folder on first run, so it works on a machine that has neither — an app opened from Finder, the Dock or a .desktop file has no Homebrew on its PATH, which is the whole reason it brings its own.

A self-built app is unsigned. macOS wants **right-click → Open** the first time; Windows SmartScreen wants **More info → Run anyway**.

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

**Practice** opens one page at a time, full screen, for playing along. Arrow keys, space or PageUp/PageDown turn the page — the last pair is what most Bluetooth page-turner pedals send, so a pedal works without any setup. On a phone or tablet, tap the left or right edge. The screen is kept awake while you read, and Esc leaves.

Every finished scan is saved to **your songsheets** on the home screen, because loading another video wipes the working folder. Pages are stored in the browser as images, so a saved songsheet still opens after the video is long gone. Export a PDF to keep a copy anywhere else.

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
npm run test:app              # launches the desktop shell and checks it leaves nothing running
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

**Nothing moves under `prefers-reduced-motion`,** and nothing goes blank either: each loader has a resting pose that still says "working".

`npm run icon` draws the app icon from the same mark, so the icon and the interface cannot drift apart.

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
- Songsheets are stored in the browser. Clearing site data removes them; export a PDF to keep a copy.
- A **hosted instance is one person at a time** — see [Hosted](#hosted). The limits keep visitors from disturbing each other; they do not make it multi-user.
- **No downloads are published yet.** The desktop apps are built and tested on all three platforms in CI, but releasing them needs signing to avoid the unsigned-app warnings, so for now you build your own.
- Planned: AI transcription of captures into re-rendered tab (alphaTex / alphaTab).
