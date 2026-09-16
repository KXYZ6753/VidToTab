// Shared constants. Lives here (not server.js) because server.js listens on
// import, and the eval harness needs the exact same download arguments.

// Best <=1080p mp4 video + m4a audio. The sort key matters: without it yt-dlp's
// codec preference picks starved AV1 streams on some videos (measured 634 kbps
// AV1 vs 2302 kbps H.264 for the same upload) — fine print tab needs bitrate.
export const YT_FMT = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]';
export const YT_SORT = 'res:1080,fps,tbr';

// Args for every yt-dlp call, metadata probes included. --ignore-config keeps a
// user's own yt-dlp.conf (an -o template, a -P download path) from sending the
// file somewhere the server will never find it, and the timeouts stop a stalled
// connection from hanging a job indefinitely — `-j` had no timeout at all.
export const YT_BASE_ARGS = [
  '--ignore-config', '--no-playlist',
  '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '3',
];

// Download args shared by server and eval. The single-file fallback can be
// webm; --remux-video guarantees an .mp4 container (output template must end
// in .%(ext)s for that to take effect).
export const YT_DOWNLOAD_ARGS = [
  ...YT_BASE_ARGS, '-f', YT_FMT, '-S', YT_SORT,
  '--merge-output-format', 'mp4', '--remux-video', 'mp4',
];

// Extra yt-dlp args per attempt, tried in order. YouTube intermittently 403s
// media chunks for the default clients (observed Sep 2026: 3 of 5 target videos
// failed on every retry after the first 10 MB chunk); the web_embedded client
// kept serving full 1080p. mweb is a last resort — 360p progressive only.
export const YT_CLIENT_FALLBACKS = [
  { label: 'default', args: [] },
  { label: 'embedded player', args: ['--extractor-args', 'youtube:player_client=web_embedded'] },
  { label: 'mobile web (360p)', args: ['--extractor-args', 'youtube:player_client=mweb'] },
];

// Remember which client actually served the last download and try it first.
// Measured in one sitting: the default client 403'd on 12 of 13 videos while
// the embedded player served every one, so a fixed order burns a failed request
// per download and invites more rate limiting. Reordering the list to match
// today's behaviour would be overfitting — YouTube changes which client works —
// so this adapts instead, and falls back to the full list in the original order.
let lastGoodClient = null;

export function noteClientSuccess(label) {
  lastGoodClient = label;
}

export function orderedClients() {
  if (!lastGoodClient) return YT_CLIENT_FALLBACKS;
  const winner = YT_CLIENT_FALLBACKS.find((c) => c.label === lastGoodClient);
  if (!winner) return YT_CLIENT_FALLBACKS;
  return [winner, ...YT_CLIENT_FALLBACKS.filter((c) => c !== winner)];
}
