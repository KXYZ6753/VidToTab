// A small, read-only hint that the page is running inside the desktop app.
//
// The hosted web build simply will not have this object, so the interface can
// state which features are available on this platform instead of guessing from
// the user agent — and can say so plainly when one is not.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('vidtotab', Object.freeze({
  shell: 'desktop',
  platform: process.platform,
}));
