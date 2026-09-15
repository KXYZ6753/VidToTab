# VidToTab

Extract guitar tablature from videos. Give it a YouTube link (or a local video file), drag a box around the on-screen tab, and it captures every distinct tab screen — erasing the moving playhead bar and skipping transition animations — then exports a songsheet PDF or PNG with the video's title, link, and thumbnail on top.

## Install

```sh
brew install yt-dlp ffmpeg
npm install
```

## Run

```sh
npm start          # http://localhost:3000  (PORT=xxxx to override)
```

1. **Source** — paste a YouTube link or drop a video file.
2. **Region** — seek past the intro, pause on a frame where the tab is visible, drag a box around the notation (exclude webcam/fretboard/titles). The live preview strip shows exactly what will be analyzed.
3. **Processing** — captures appear live as they're found; cancel any time.
4. **Review** — delete bad captures (undo supported), click a timestamp to verify against the video, or re-run detection with more/fewer captures (fast — frames are cached). Then **Export PDF / PNG**.

## How it works

Two-pass analysis over ffmpeg rawvideo pipes (no image libraries): pass 1 streams cropped grayscale frames at 4 fps and segments the video into "stable runs" separated by content transitions — a sweeping playhead changes few, narrow pixel columns; a page flip changes wide ones. Pass 2 takes K frames spread across each run and computes a per-pixel temporal median, which erases the playhead, cursors, and measure highlights. Consecutive composites are then collapsed when they're the same screen (changed-pixel-fraction below a threshold) and a fresh page is emitted whenever the notes change; exact repeats are deduplicated.

## Known v1 limits

- **Scrolling tabs are not supported.** This build only captures on change (page flips) — it does not align or stitch scrolling content. A continuously scrolling tab produces no stable runs and falls back to fixed-interval captures with a warning.
- Planned v2: AI transcription of captures into re-rendered clean tabs (Claude vision → alphaTex → alphaTab).
