// The Electron shell: owns the window, runs the server as a child process, and
// makes sure nothing survives the app being closed.
//
// The server is a child rather than part of this process because the pipeline's
// pixel loops are synchronous — running them here would freeze the window for
// the entire length of a scan.

const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');
const { startServer, killTree } = require('./server-host.cjs');

// Shown while the server boots. Inline rather than a file because it has to be
// on screen before anything is being served.
const STARTING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><meta charset="utf-8"><title>VidToTab</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; height:100vh; display:grid; place-items:center; background:#faf7f2; color:#2b2724;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif }
  @media (prefers-color-scheme: dark) { body { background:#161513; color:#e9e4dc } }
  p { opacity:.75 }
</style>
<p>Starting VidToTab…</p>
`)}`;

let win = null;
let server = null; // { child, port }

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
    backgroundColor: '#faf7f2',
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
  app.whenReady().then(boot);
}

// Closing the window closes the app. Breaking the macOS convention is the
// lesser evil here: an app that looks shut while still holding the work folder
// and a port is worse than one that quits when you close it.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (!server) return;
  killTree(server.child);
  server = null;
});
