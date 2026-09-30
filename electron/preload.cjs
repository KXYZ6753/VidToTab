// What the page is allowed to ask of the desktop shell, and nothing more.
//
// The hosted web build simply will not have this object, so the interface can
// state which features are available on this platform instead of guessing from
// the user agent — and can say so plainly when one is not. Every call is a
// named request the main process checks; the page never gets a path to open,
// a URL to fetch or a file to run of its own choosing.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('vidtotab', Object.freeze({
  shell: 'desktop',
  platform: process.platform,

  updates: Object.freeze({
    // manual: a check someone asked for, which runs even with automatic
    // checks switched off.
    check: (manual = false) => call('updates:check', { manual: Boolean(manual) }),
    getAuto: () => call('updates:get-auto'),
    setAuto: (on) => call('updates:set-auto', Boolean(on)),
    download: () => call('updates:download'),
    cancel: () => call('updates:cancel'),
    open: () => call('updates:open'),
    reveal: () => call('updates:reveal'),
    openPage: (which) => call('updates:open-page', which === 'release' ? 'release' : 'releases'),
    quit: () => call('app:quit'),
    // Progress, verification and the finished file arrive as events.
    onEvent: (fn) => {
      const h = (_e, ev) => fn(ev);
      ipcRenderer.on('updates:event', h);
      return () => ipcRenderer.removeListener('updates:event', h);
    },
  }),

  // The songsheet library as a folder on disk (electron/library-fs.cjs).
  // Page images travel as bytes; public/lib/library.js turns them into Blobs.
  library: Object.freeze({
    info: () => call('library:info'),
    list: () => call('library:list'),
    get: (id) => call('library:get', String(id)),
    save: (meta, pages, thumb) => call('library:save', { meta, pages, thumb }),
    update: (id, patch) => call('library:update', { id: String(id), patch }),
    remove: (ids) => call('library:remove', Array.from(ids, String)),
    reveal: (id) => call('library:reveal', String(id)),
    openFolder: () => call('library:open-folder'),
    chooseFolder: () => call('library:choose-folder'),
  }),
}));
