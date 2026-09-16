# VidToTab

Turn a guitar-tab video into a clean, printable songsheet. Paste a YouTube link (or drop a video file): VidToTab finds the tab on screen, captures every distinct tab page once, strips out cursors and measure highlights, and exports a PDF or PNG with the song title, link and thumbnail on top. Finished songsheets are kept, so you can come back to them.

It is tuned for the common tab-video styles — vvxoFingerstyleTab-style dark panels (orange cursors, blue measure highlights, notes that turn orange as they're played), tab and chord diagrams overlaid on live video, and white "Tab Sheet Music" pages.

## Install

```sh
brew install yt-dlp ffmpeg
npm install
```

Requires Node 20+. Keep yt-dlp current — YouTube changes often, and the app warns when the installed copy is more than 60 days old.

## Run

```sh
npm start          # http://127.0.0.1:3000  (PORT=xxxx to override)
```

The server listens on loopback only, so nothing on your network can reach it. `HOST=0.0.0.0` opens it up deliberately, for a hosted deployment.

1. **Video** — paste a link (anywhere on the page, not just in the box), drop a link or a video file, or open `…/?url=<video>` from a bookmark. Saved songsheets are listed underneath.
2. **Tab area** — the tab is detected automatically and outlined on the video. Check the box, adjust it if needed (drag the handles), pick where scanning starts, and press **Scan for pages**.
3. **Scan** — pages appear as they're found; cancel any time.
4. **Songsheet** — edit the title, remove pages you don't want (undo supported), click a timestamp to check it against the video, choose a **look** (Print, Dark, Sepia, or the original video colours), pick Letter or A4, and export a PDF or PNG. *Not quite right?* re-scans with fewer or more pages in seconds — frames are cached.

Every finished scan is saved to **your songsheets** on the home screen, because loading another video wipes the working folder. Pages are stored in the browser as images, so a saved songsheet still opens after the video is long gone. Export a PDF to keep a copy anywhere else.

## How it works

Everything runs locally: yt-dlp downloads, ffmpeg decodes, the analysis is plain JavaScript over raw frames (no image libraries).

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
npm run test:server           # server behaviour: upload races, the cross-site guard
npm run e2e                   # drives a real browser through the whole flow over CDP
npm run eval                  # detection + pipeline on the labelled eval set
npm run eval -- --only yT9gKKwBeVw --sens 0.5,0.75,1
npm run eval -- --detect-only
npm run eval -- --label       # frame grids for labelling a new video
npm run eval -- --rescore     # re-score saved captures against current labels
```

`scripts/eval-set.json` holds hand-labelled page sequences (`"t:id"` page starts, repeats reuse the id). The harness downloads videos into `.cache/eval/`, scores recall/precision of page starts, repeat folding, crop IoU and leftover highlight colour, and writes contact sheets to inspect.

Two gates worth knowing about. A fixture may record the score it genuinely reaches as `expect.floor`, with the reason in `expect.notes`; fixtures without a floor must be perfect, and a floor may be raised after a fix but never lowered to make a run green. Fixtures marked `noTab: true` must be *declined* by detection — rejecting videos without tab is half of being accurate, and it is checked rather than assumed.

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

## Known limits

- Horizontally or vertically **scrolling** tabs aren't stitched; the app captures page flips. None of the 19 videos surveyed for this project scroll, so stitching was deliberately not built rather than shipped untested.
- Two pages that differ only by a thin mark (an "x" strum mark, a single changed digit on a small, low-resolution tab) can be merged — use *More pages*.
- Live video directly behind the notation can leave faint marks in the clean print; *Original* shows the video frame as-is.
- Songsheets are stored in the browser. Clearing site data removes them; export a PDF to keep a copy.
- Planned: AI transcription of captures into re-rendered tab (alphaTex / alphaTab).
