# VidToTab

Turn a guitar-tab video into a clean, printable songsheet. Paste a YouTube link (or drop a video file): VidToTab finds the tab on screen, captures every distinct tab page once, strips out cursors and measure highlights, and exports a PDF or PNG with the song title, link and thumbnail on top.

It is tuned for the common tab-video styles — vvxoFingerstyleTab-style dark panels (orange cursors, blue measure highlights, notes that turn orange as they're played), Haruguitar-style tab overlaid on live video, and white "Tab Sheet Music" pages.

## Install

```sh
brew install yt-dlp ffmpeg
npm install
```

Requires Node 20+. Keep yt-dlp current (`brew upgrade yt-dlp`) — YouTube changes often.

## Run

```sh
npm start          # http://localhost:3000  (PORT=xxxx to override)
```

1. **Video** — paste a link or drop a file.
2. **Tab area** — the tab is detected automatically and outlined on the video. Check the box, adjust it if needed (drag the handles), pick where scanning starts, and press **Scan for pages**.
3. **Scan** — pages appear as they're found; cancel any time.
4. **Songsheet** — edit the title, remove pages you don't want (undo supported), click a timestamp to check it against the video, switch between **Clean** (black ink on white, the default) and **Original** colors, pick Letter or A4, and export a PDF or PNG. *Not quite right?* re-scans with fewer or more pages in seconds — frames are cached.

## How it works

Everything runs locally: yt-dlp downloads, ffmpeg decodes, the analysis is plain JavaScript over raw frames (no image libraries).

- **Tab detection** (`pipeline/detect.js`) samples keyframes across the video and looks for the one thing every tab style shares: six thin, evenly spaced horizontal lines that stay put while everything around them changes. Guitar strings fail (slanted, moving); panel borders and live video stop the box from growing past the tab.
- **Calibration** measures the crop's polarity (light notes on dark or dark on light), staff-line spacing and ink contrast. Every later threshold is expressed in those units, so results don't depend on resolution or on how loosely the box was drawn.
- **Ink planes** (`pipeline/ink.js`): luma, polarity-normalized, then a morphological top-hat that deletes anything wider than a few line spacings (translucent measure highlights, guitar bodies) while keeping digits, lines and symbols. Cursor bars are removed by shape and color.
- **Pass 1** (`pipeline/analyze.js`) runs over a half-resolution cache at 4 fps: a 7-frame temporal majority filter erases moving cursors and playheads, static chrome and flickering video are excluded, and a new page starts where the ink changes by a lot overall or by a glyph-sized cluster anywhere.
- **Assembly** (`pipeline/assemble.js`) merges runs of the same screen, folds repeats into "repeats at …", and drops intro/outro screens that don't show the staff.
- **Pass 2** (`pipeline/composite.js`) decodes up to 11 frames per page once, and renders a *clean* print (percentile-ranked ink, black on white) and an *original-color* version that per-pixel rejects tinted samples.
- **Export** builds the PDF server-side (pdf-lib); the header is rendered in the browser so titles in any script (「勇者」, 최애의 아이) print correctly.

## Development

```sh
npm test                      # every pipeline module's self-check
npm run eval                  # detection + pipeline on the labeled eval set
npm run eval -- --only yT9gKKwBeVw --sens 0.25,0.5,0.75
npm run eval -- --detect-only
npm run eval -- --label       # frame grids + 1-fps strips for labeling a new video
```

`scripts/eval-set.json` holds hand-labeled page sequences (`"t:id"` page starts, repeats reuse the id) for the target videos. The harness downloads them into `.cache/eval/`, scores recall/precision of page starts, repeat folding, crop IoU and leftover highlight color, and writes contact sheets to inspect.

## Results on the target videos

Hand-labeled page sequences in `scripts/eval-set.json`, scored at the default setting. *Recall* = distinct tab screens captured (a page whose notes are lost counts as missed); *precision* = captures that are a new screen (duplicates and intro/outro frames count against it). "Detected box" is the real flow — the pipeline runs on the automatically detected tab area.

| Video | Style | Pages | Detected box: recall / precision | Hand-drawn box: recall / precision |
|---|---|---|---|---|
| Crossing Field (yT9gKKwBeVw) | dark strip, blue measure highlight | 15 | 1.00 / 0.94 | 1.00 / 1.00 |
| Tabibito no Uta (Fv3pCR1Btjk) | dark panel, notes turn orange when played | 16 | 1.00 / 1.00 | 1.00 / 1.00 |
| Yuusha (MENRbBUBYd4) | dark panel, orange cursor bar | 21 | 1.00 / 1.00 | 1.00 / 1.00 |
| Unravel (0YXjZDR5V-4) | dark strip, wide blue highlight | 15 | 1.00 / 1.00 | 1.00 / 1.00 |
| Mephisto (73HxHE5e2yY) | tab + chords over live video, 2-bar screens | 31 | 0.97 / 0.68 | 0.97 / 0.67 |

Before the remaster, on the two videos labeled at the time: Crossing Field 0.87 / 0.38 (with blue highlights baked into the captures, 6 min to process) and Mephisto 0.68 / 0.56. Mephisto's remaining misses are screens that differ only by thin "x" strum marks; its duplicates are repeats of those look-alike screens — remove them in review or use *Fewer pages*.

## Troubleshooting

- **"YouTube blocked the download"** — the app already retries through other YouTube player clients. If it still fails, update yt-dlp, wait a minute, or download the video yourself and drop the file in.
- **The box is wrong or missing** — pause on a frame where the tab is visible, press *Adjust box*/*Draw box*, and drag. *Detect again* re-samples the video.
- **Duplicates or a missing page** — *Not quite right? → Fewer pages / More pages*.

## Known limits

- Horizontally or vertically **scrolling** tabs aren't stitched; the app captures page flips.
- Two pages that differ only by a thin mark (an "x" strum mark, a single changed digit on a small, low-resolution tab) can be merged — use *More pages*.
- Live video directly behind the notation can leave faint marks in the clean print; *Original* shows the video frame as-is.
- Planned: AI transcription of captures into re-rendered tab (alphaTex / alphaTab).
