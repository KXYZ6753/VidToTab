// Starts the VidToTab server as a child process and reports the port it bound.
//
// The server deliberately does not run inside Electron's main process: the
// pipeline's pixel loops are synchronous and would freeze the window for the
// whole length of a scan. ELECTRON_RUN_AS_NODE makes the Electron binary behave
// as plain Node, so the packaged app ships one runtime instead of two.
//
// Nothing in here imports Electron, so it can be exercised with plain node.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LISTENING = /VIDTOTAB_LISTENING (\d+)/;
const START_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 3000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {}; // missing or corrupt settings are not worth failing a launch over
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch {
    /* settings are a convenience, never a requirement */
  }
}

// SIGKILL does not reach grandchildren, and the server spawns yt-dlp, which in
// turn spawns ffmpeg for merges. Children are started in their own process
// group so the whole tree can be signalled at once; Windows has no process
// groups worth relying on, so taskkill /T does the same job there.
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* already gone */ }
    return;
  }
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig); // negative pid: the whole group
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  signal('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) signal('SIGKILL');
  }, KILL_GRACE_MS).unref();
}

// One launch attempt on one port. Resolves as soon as the server announces the
// port it actually bound, which is not necessarily the one we asked for.
function attempt({ execPath, serverPath, port, env, onLog }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(execPath, [serverPath], {
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      reject(e);
      return;
    }

    let settled = false;
    let buffered = '';
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, new Error(`server did not report a port within ${START_TIMEOUT_MS / 1000}s`));
    }, START_TIMEOUT_MS);

    const watch = (chunk) => {
      const text = String(chunk);
      buffered += text;
      if (onLog) for (const l of text.split('\n')) if (l.trim()) onLog(l.trim());
      const m = LISTENING.exec(buffered);
      if (m) finish(resolve, { child, port: Number(m[1]) });
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);

    child.once('error', (e) => finish(reject, e));
    child.once('exit', (code, signal) => {
      const err = new Error(`server exited with ${signal || code} before it started listening`);
      err.exitCode = code;
      err.output = buffered.trim();
      finish(reject, err);
    });
  });
}

// Start the server, preferring the port used last time.
//
// The songsheet library lives in IndexedDB, which is keyed to the origin — so a
// port that changed on every launch would look to the user as though every
// saved songsheet had vanished. The remembered port is tried first and only
// falls back to an OS-assigned one when it is taken, which is also why the
// server has to honour PORT=0 rather than collapsing it to the default.
async function startServer({
  execPath = process.execPath,
  serverPath,
  dataDir,
  resourcesDir,
  settingsFile,
  defaultPort = 3000,
  onLog = () => {},
} = {}) {
  if (!serverPath) throw new Error('startServer needs serverPath');

  const settings = settingsFile ? readJson(settingsFile) : {};
  const remembered = Number.isInteger(settings.port) && settings.port > 0 ? settings.port : defaultPort;

  const env = {};
  if (dataDir) env.VIDTOTAB_DATA_DIR = dataDir;
  if (resourcesDir) env.VIDTOTAB_RESOURCES_DIR = resourcesDir;

  let lastError;
  for (const port of [remembered, 0]) {
    try {
      const started = await attempt({ execPath, serverPath, port, env, onLog });
      if (settingsFile && started.port !== settings.port) {
        writeJson(settingsFile, { ...settings, port: started.port });
      }
      return started;
    } catch (e) {
      lastError = e;
      if (port === 0) break;
      onLog(`port ${port} is not available (${e.exitCode != null ? `exit ${e.exitCode}` : e.message}) — asking the OS for a free one`);
    }
  }
  throw lastError;
}

module.exports = { startServer, killTree, attempt, readJson, writeJson, LISTENING };
