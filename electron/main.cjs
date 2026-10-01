// The Electron shell: owns the window, runs the server as a child process, and
// makes sure nothing survives the app being closed.
//
// The server is a child rather than part of this process because the pipeline's
// pixel loops are synchronous — running them here would freeze the window for
// the entire length of a scan.

const { app, BrowserWindow, dialog, ipcMain, net, session, shell, systemPreferences } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, killTree, readJson, writeJson } = require('./server-host.cjs');
const library = require('./library-fs.cjs');
const updates = require('./updates.cjs');

// For tests and nothing else: a profile of their own, so a test run neither
// touches the real app's songsheets and settings nor collides with a copy of
// the app that is already open (the single-instance lock lives in userData),
// and a debugging port so the test can drive the window. Both must be set
// before the app is ready, which is why they are up here.
if (process.env.VIDTOTAB_USER_DATA) app.setPath('userData', path.resolve(process.env.VIDTOTAB_USER_DATA));
const cdpPort = Number(process.env.VIDTOTAB_CDP_PORT);
if (Number.isInteger(cdpPort) && cdpPort > 0) app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
// A microphone that plays a WAV file, so the test can listen without a real
// one. Only the capture device is faked: there is deliberately no
// use-fake-ui-for-media-stream, so the permission handler below still decides
// whether the page gets it. The audio service reads the file itself, and on
// macOS and Windows it is sandboxed away from the disk unless told otherwise.
const fakeMic = process.env.VIDTOTAB_FAKE_MIC ? path.resolve(process.env.VIDTOTAB_FAKE_MIC) : null;
if (fakeMic) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${fakeMic}%noloop`);
  if (process.platform !== 'linux') app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
}

// Shown while the server boots. Inline rather than a file because it has to be
// on screen before anything is being served.
const STARTING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><meta charset="utf-8"><title>VidToTab</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; height:100vh; display:grid; place-items:center; background:#f6f3ee; color:#1d1b18;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif }
  @media (prefers-color-scheme: dark) { body { background:#121315; color:#eeebe6 } }
  p { opacity:.75 }
</style>
<p>Starting VidToTab…</p>
`)}`;

let win = null;
let server = null; // { child, port }

// An edit is saved a moment after the last keystroke, so quitting straight
// after one would lose it. Before the window or the app goes — whichever comes
// first: closing the window starts with the window, while Quit, a logout and a
// SIGTERM start with the app and kill the server before any window hears of it
// — the page is asked to write what it has, and the library's writes are
// waited for. A few seconds at most; a page that does not answer is not a
// reason to refuse to quit.
let pageFlushed = false;
function flushPage() {
  if (pageFlushed || !win || win.isDestroyed()) return Promise.resolve();
  pageFlushed = true;
  const page = win.webContents.executeJavaScript('window.vidtotabFlush ? window.vidtotabFlush() : null', true).catch(() => {});
  return Promise.race([page.then(() => libraryQueue), new Promise((r) => setTimeout(r, 4000))]);
}

// Packaged, the server lives in resources/app (extraResources) rather than
// inside app.asar, because it spawns child processes and reads its own files.
function serverPaths() {
  if (app.isPackaged) {
    return { serverPath: path.join(process.resourcesPath, 'app', 'server.js'), resourcesDir: process.resourcesPath };
  }
  const root = path.join(__dirname, '..');
  return { serverPath: path.join(root, 'server.js'), resourcesDir: root };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 640,
    minHeight: 560,
    // The dark field the opening animation paints on, not the app's paper.
    // This colour is only ever seen before the renderer's first paint, and on a
    // desktop launch what paints first is always the splash — unconditionally
    // dark, in either theme. Leaving it light put a white flash in front of it
    // every single launch. The trade is a brief dark edge if a light-theme
    // window is resized faster than it can repaint, which is rarer and quieter
    // than a flash on every start.
    backgroundColor: '#0a0b0c',
    show: false,
    title: 'VidToTab',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());

  // A window with no address bar is the wrong place for YouTube: anything that
  // is not our own origin opens in the real browser.
  const ours = (url) => server && url.startsWith(`http://127.0.0.1:${server.port}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('data:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('data:') || ours(url)) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  // Closing the window is one of the two ways out; see flushPage().
  win.on('close', (e) => {
    if (pageFlushed || !server) return;
    e.preventDefault();
    flushPage().finally(() => { if (win && !win.isDestroyed()) win.close(); });
  });

  win.on('closed', () => { win = null; });
  return win;
}

async function boot() {
  createWindow();
  win.loadURL(STARTING_PAGE);

  const { serverPath, resourcesDir } = serverPaths();
  const dataDir = app.getPath('userData');
  try {
    server = await startServer({
      execPath: process.execPath, // Electron itself, via ELECTRON_RUN_AS_NODE
      serverPath,
      dataDir,
      resourcesDir,
      settingsFile: path.join(dataDir, 'settings.json'),
      onLog: (l) => console.log('[server]', l),
    });
  } catch (e) {
    dialog.showErrorBox(
      'VidToTab could not start',
      `The background service did not start.\n\n${e.message}\n\n${String(e.output || '').slice(-1200)}`,
    );
    app.quit();
    return;
  }

  if (!win) return; // window was closed while the server was starting
  win.loadURL(`http://127.0.0.1:${server.port}/`);
}

// ---------------------------------------------------------------- settings

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const getSettings = () => readJson(settingsFile());
// Read-modify-write, never a cached copy: the server host writes the port into
// the same file.
function setSettings(patch) {
  const next = { ...readJson(settingsFile()), ...patch };
  writeJson(settingsFile(), next);
  return next;
}

// Only our own page may call in. The window never navigates anywhere else
// (will-navigate above), but a handler that trusts that is one bug away from
// giving a web page the library folder.
function assertOurs(e) {
  const url = e?.senderFrame?.url || '';
  if (!server || !url.startsWith(`http://127.0.0.1:${server.port}/`)) throw new Error('Not allowed from this page.');
}
const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
  assertOurs(e);
  return fn(e, ...args);
});

// ---------------------------------------------------------------- permissions

// With no handler Electron grants every web permission to every page. The page
// leans on some of them (clipboard, the screen wake lock while playing along,
// persistent storage), so our own origin keeps them all; nothing else — the
// "Starting…" page, anything that ever slipped past will-navigate — gets any.
// The microphone is the one with a second gate: it goes only to our origin,
// never together with the camera, and on macOS only once the system has said
// yes too.
const isOurs = (url) => {
  if (!server || !url) return false;
  try { return new URL(url).origin === `http://127.0.0.1:${server.port}`; } catch { return false; }
};

// macOS keeps its own answer per app. Asking while it is undecided shows the
// system prompt (in the words of NSMicrophoneUsageDescription); asking after a
// no shows nothing, so a no is final here and the page points at Settings
// instead. Under the fake test microphone the system is not consulted at all:
// a test must never sit waiting on a prompt nobody will answer.
const micBlockedBySystem = () => process.platform === 'darwin' && !fakeMic
  && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('microphone'));
async function systemAllowsMic() {
  if (process.platform !== 'darwin' || fakeMic) return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone').catch(() => false);
  return status === 'granted';
}

function guardPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
    if (!isOurs(details.requestingUrl || wc?.getURL())) return callback(false);
    if (permission !== 'media') return callback(true);
    if (details.securityOrigin && !isOurs(details.securityOrigin)) return callback(false);
    if ((details.mediaTypes || []).includes('video')) return callback(false);
    systemAllowsMic().then((ok) => callback(Boolean(ok)), () => callback(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details = {}) => {
    if (!isOurs(origin || details.requestingUrl)) return false;
    if (permission !== 'media') return true;
    if (details.securityOrigin && !isOurs(details.securityOrigin)) return false;
    return details.mediaType !== 'video' && !micBlockedBySystem();
  });
}

// ---------------------------------------------------------------- microphone

// What the system thinks of this app using the microphone, so the page can
// tell "you said no in VidToTab" from "macOS or Windows is blocking it".
// Linux has no such switch.
handle('mic:status', () => (process.platform === 'darwin' || process.platform === 'win32'
  ? systemPreferences.getMediaAccessStatus('microphone')
  : 'granted'));
// Fixed addresses, one per platform — never one from the page.
const MIC_SETTINGS = {
  darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  win32: 'ms-settings:privacy-microphone',
};
handle('mic:open-settings', async () => {
  const url = MIC_SETTINGS[process.platform];
  if (!url) return false;
  await shell.openExternal(url);
  return true;
});

// ---------------------------------------------------------------- library

// Documents/VidToTab by default, because a songsheet is a document: that is
// where people look for one, and where their backups already reach. On a Mac
// the first save there asks for permission to use Documents, once.
const libraryDir = () => path.resolve(process.env.VIDTOTAB_LIBRARY_DIR
  || getSettings().libraryDir
  || path.join(app.getPath('documents'), 'VidToTab'));

// Saves arrive one per edit and each rewrites sheet.json; two in flight for the
// same songsheet would race over it. One queue for every write is simplest and
// costs nothing at the rate people edit.
let libraryQueue = Promise.resolve();
const serial = (fn) => {
  const run = libraryQueue.then(fn, fn);
  libraryQueue = run.catch(() => {});
  return run;
};

async function confirmBox(opts) {
  const { response } = await dialog.showMessageBox(win, { type: 'question', noLink: true, ...opts });
  return response;
}

handle('library:info', () => {
  const dir = libraryDir();
  return { dir, exists: fs.existsSync(dir), home: app.getPath('home'), platform: process.platform };
});
// Songsheets moved to the Trash this session. A save already on its way when
// its songsheet was trashed — reading pages, or queued behind the removal —
// would otherwise land afterwards and quietly make the folder again.
const trashed = new Set();

handle('library:list', () => library.list(libraryDir()));
// Queued with the writes, so a read never lands half way through a save or a
// rename and reports pages as missing that are only moving.
handle('library:get', (_e, id) => serial(() => library.get(libraryDir(), id)));
handle('library:save', (_e, { meta, pages, thumb } = {}) => serial(() => (
  trashed.has(String(meta?.id)) ? null : library.save(libraryDir(), meta, pages, thumb))));
handle('library:update', (_e, { id, patch } = {}) => serial(() => library.update(libraryDir(), id, patch)));
handle('library:remove', async (_e, ids) => {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const n = ids.length;
  const trashName = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
  const choice = await confirmBox({
    message: n === 1 ? `Move this songsheet to the ${trashName}?` : `Move ${n} songsheets to the ${trashName}?`,
    detail: `${n === 1 ? 'Its folder' : 'Their folders'} in ${libraryDir()} ${n === 1 ? 'goes' : 'go'} to the ${trashName}, so ${n === 1 ? 'it' : 'they'} can still be put back from there.`,
    buttons: [`Move to ${trashName}`, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return 0;
  for (const id of ids) trashed.add(String(id));
  return serial(() => library.remove(libraryDir(), ids, (dir) => shell.trashItem(dir)));
});
handle('library:reveal', async (_e, id) => {
  const dir = await library.locate(libraryDir(), id);
  if (!dir) throw new Error('That songsheet is no longer in the library folder.');
  shell.showItemInFolder(dir);
  return true;
});
handle('library:open-folder', async () => {
  const dir = libraryDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return true;
});
handle('library:choose-folder', async () => {
  const from = libraryDir();
  const picked = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for your songsheets',
    defaultPath: from,
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths?.[0]) return null;
  const to = path.resolve(picked.filePaths[0]);
  if (to === from) return { dir: to, moved: 0 };
  // A songsheet folder, or anywhere inside one, cannot hold the library: the
  // move would try to put a folder inside itself.
  for (let d = to; ; d = path.dirname(d)) {
    if (await library.isSheetFolder(d)) {
      throw new Error('That folder is part of a songsheet. Choose the folder that should hold your songsheets instead.');
    }
    if (path.dirname(d) === d) break;
  }
  const count = (await library.list(from)).length;
  let moved = 0;
  if (count) {
    const choice = await confirmBox({
      message: `Move your ${count === 1 ? 'songsheet' : `${count} songsheets`} to the new folder?`,
      detail: `From ${from}\nto ${to}\n\nIf you leave them, the library shows only what is in the new folder, and switching back shows them again.`,
      buttons: ['Move them', 'Leave them where they are', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 2) return null;
    if (choice === 0) moved = await serial(() => library.move(from, to));
  }
  setSettings({ libraryDir: to });
  return { dir: to, moved };
});

// ---------------------------------------------------------------- updates

const updateFeed = process.env.VIDTOTAB_UPDATE_FEED || updates.FEED;
const downloadsDir = () => path.resolve(process.env.VIDTOTAB_DOWNLOAD_DIR || app.getPath('downloads'));
let lastCheck = null; // the summary the buttons act on — never a URL from the page
let checking = null;
let download = null; // { url, name, digest, file, item, state }

const emit = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('updates:event', ev); };

async function checkNow() {
  const release = await updates.fetchLatest({
    feed: updateFeed,
    fetchImpl: (u, o) => net.fetch(u, o),
    userAgent: `VidToTab/${app.getVersion()} (${process.platform}; ${process.arch})`,
  });
  setSettings({ lastUpdateCheck: Date.now() });
  if (!release) {
    lastCheck = { available: false, current: app.getVersion(), latest: null, asset: null, releasesUrl: updates.RELEASES_PAGE, pageUrl: updates.RELEASES_PAGE };
    return lastCheck;
  }
  lastCheck = updates.summarise(release, {
    current: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    appImage: Boolean(process.env.APPIMAGE),
  });
  return lastCheck;
}

handle('updates:check', async (_e, { manual = false } = {}) => {
  // Automatic checks can be switched off, and are off under test; a check the
  // person asked for always goes ahead.
  if (!manual && (process.env.VIDTOTAB_NO_UPDATE_CHECK === '1' || getSettings().checkUpdates === false)) {
    return { skipped: true };
  }
  if (!manual && lastCheck) return lastCheck;
  if (!checking) checking = checkNow().finally(() => { checking = null; });
  return checking;
});
handle('updates:get-auto', () => getSettings().checkUpdates !== false);
handle('updates:set-auto', (_e, on) => setSettings({ checkUpdates: Boolean(on) }).checkUpdates);
handle('updates:open-page', (_e, which) => {
  const url = which === 'release' && lastCheck?.pageUrl ? lastCheck.pageUrl : updates.RELEASES_PAGE;
  shell.openExternal(url);
  return true;
});

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(`sha256:${h.digest('hex')}`));
  });
}

// Resolves to whether the file was checked: GitHub publishes a SHA-256 for
// every release file now, but one without it is downloaded unverified and the
// interface says so rather than implying otherwise.
async function finishDownload(file, digest) {
  if (digest) {
    emit({ type: 'verifying' });
    const got = await sha256(file);
    if (got !== digest) {
      await fs.promises.rm(file, { force: true });
      throw new Error('The download did not match the checksum GitHub published for it, so it was deleted. Try again, or download it from the releases page.');
    }
  }
  // An AppImage is the program itself, and a download is never executable.
  if (file.endsWith('.AppImage')) await fs.promises.chmod(file, 0o755);
  return Boolean(digest);
}

handle('updates:download', async () => {
  const asset = lastCheck?.available && lastCheck.asset;
  if (!asset) throw new Error('There is no download for this computer on that release.');
  if (!updates.isAllowedDownload(asset.url, updateFeed)) throw new Error('That download is not from the VidToTab releases.');
  if (download && download.state === 'progressing') return { started: false };
  const dir = downloadsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(asset.name));
  // Downloaded already, and intact: nothing to fetch twice.
  if (asset.digest && fs.existsSync(file) && (await sha256(file).catch(() => null)) === asset.digest) {
    download = { ...asset, file, state: 'completed' };
    emit({ type: 'done', file, name: asset.name, verified: true });
    return { started: false };
  }
  const mine = { ...asset, file, state: 'progressing', item: null };
  download = mine;
  session.defaultSession.downloadURL(asset.url);
  // A request that fails before any response never reaches will-download, and
  // would otherwise leave the button waiting on a download that is not coming.
  setTimeout(() => {
    if (download !== mine || mine.item || mine.state !== 'progressing') return;
    mine.state = 'failed';
    emit({ type: 'error', message: 'The download did not start. Check your connection and try again.' });
  }, 30000).unref();
  return { started: true };
});

handle('updates:cancel', () => {
  if (!download || download.state !== 'progressing') return true;
  if (download.item) {
    download.item.cancel();
  } else {
    // Asked before the response arrived: will-download sees the state and
    // cancels it there.
    download.state = 'cancelled';
    emit({ type: 'cancelled' });
  }
  return true;
});

handle('updates:open', async () => {
  if (!download || download.state !== 'completed') throw new Error('The download has not finished.');
  const file = download.file;
  if (file.endsWith('.AppImage')) {
    shell.showItemInFolder(file);
    return { opened: 'folder' };
  }
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  // The Windows installer replaces the app in place and asks for it to be
  // closed first; getting out of its way is the helpful thing to do.
  if (process.platform === 'win32') setTimeout(() => app.quit(), 1500);
  return { opened: 'installer' };
});

handle('updates:reveal', () => {
  if (download?.file && fs.existsSync(download.file)) shell.showItemInFolder(download.file);
  return true;
});

handle('app:quit', () => { setTimeout(() => app.quit(), 100); return true; });

// Every download the window makes comes through here. Only the update this
// shell asked for is taken over; anything else — an exported PDF, a PNG — is
// left to Electron's usual save dialog.
function watchDownloads() {
  session.defaultSession.on('will-download', (_e, item) => {
    if (!download || download.item || item.getURLChain()[0] !== download.url) return;
    // Cancelled, or given up on, before it got here: it must not fall through
    // to Electron's own save dialog for an installer nobody is waiting for.
    if (download.state !== 'progressing') { item.cancel(); return; }
    const mine = download;
    mine.item = item;
    item.setSavePath(mine.file);
    let lastSent = 0;
    item.on('updated', (_ev, state) => {
      if (state !== 'progressing' || Date.now() - lastSent < 200) return;
      lastSent = Date.now();
      emit({ type: 'progress', received: item.getReceivedBytes(), total: item.getTotalBytes() || mine.size || 0 });
    });
    item.once('done', async (_ev, state) => {
      if (state === 'cancelled') { mine.state = 'cancelled'; emit({ type: 'cancelled' }); return; }
      if (state !== 'completed') {
        mine.state = 'failed';
        emit({ type: 'error', message: 'The download was interrupted. Check your connection and try again.' });
        return;
      }
      try {
        const verified = await finishDownload(mine.file, mine.digest);
        mine.state = 'completed';
        emit({ type: 'done', file: mine.file, name: mine.name, verified });
      } catch (e) {
        mine.state = 'failed';
        emit({ type: 'error', message: e.message });
      }
    });
  });
}

// A second launch focuses the existing window rather than starting a second
// server against the same work folder.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    guardPermissions();
    watchDownloads();
    return boot();
  });
}

// Closing the window closes the app. Breaking the macOS convention is the
// lesser evil here: an app that looks shut while still holding the work folder
// and a port is worse than one that quits when you close it.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
  if (!pageFlushed && server && win && !win.isDestroyed()) {
    e.preventDefault();
    flushPage().finally(() => app.quit());
    return;
  }
  if (!server) return;
  killTree(server.child);
  server = null;
});
