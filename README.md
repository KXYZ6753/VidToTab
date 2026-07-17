# VidToTab

Extract guitar tablature from videos. Give it a YouTube link (or a local video file), drag a box around the on-screen tab, and it captures every distinct tab screen — erasing the moving playhead bar, stitching scrolling tabs, skipping transition animations — then exports a songsheet PDF or PNG with the video's title, link, and thumbnail on top.

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
4. **Review** — delete bad captures (undo supported), click a timestamp to verify against the video, unstitch a bad scroll-merge, or re-run detection with more/fewer captures (fast — frames are cached). Then **Export PDF / PNG**.

## How it works

Two-pass analysis over ffmpeg rawvideo pipes (no image libraries): pass 1 streams cropped grayscale frames at 4 fps and segments the video into "stable runs" separated by content transitions — a sweeping playhead changes few, narrow pixel columns; a page flip or scroll changes wide ones. Pass 2 takes K frames spread across each run and computes a per-pixel temporal median, which erases the playhead, cursors, and measure highlights. Consecutive composites are then classified as duplicate / vertical scroll / page flip (gradient-profile correlation + changed-pixel-fraction verification); scrolls are stitched into continuous strips, repeats deduplicated.

## Known v1 limits

- **Horizontally scrolling tabs** produce readable but overlapping captures (each capture shares a measure or two with the next); vertical scrolls stitch properly. Horizontal stitching is a v1.1 candidate.
- Continuously moving (never-resting) tabs fall back to fixed-interval captures with a warning.
- Planned v2: AI transcription of captures into re-rendered clean tabs (Claude vision → alphaTex → alphaTab).
