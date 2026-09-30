// Listen mode in the practice view: the microphone, the setup sheet, and the
// notes lighting up on the page as they are heard.
//
// Wait mode (the default) sits on the next note or chord until it is heard,
// then moves on; a page turns 300 ms after its last event. The listening
// itself is the engine's (shared/listen.js, in a worker); this module decides
// what it should listen for next and shows what it found. The practice view
// (app.js) owns the cards, the sequence of pages and the page turns, and
// hands them over through `ctx`.

import { openMic, micPermissionState } from '/listen-audio.js';
import { TUNINGS, buildEvents, noteName, normaliseListen, playTimes } from '/shared/follow.js';

const HELP = {
  insecure: 'The microphone is only offered on a secure page. Open VidToTab from this computer (http://127.0.0.1) or over https.',
  unsupported: 'This browser cannot listen to a microphone. A current Chrome, Edge, Firefox or Safari can.',
  nodevice: 'No microphone was found. Plug one in, or check it is switched on, then try again.',
  busy: 'The microphone is there but could not be started — another app may be using it. Close that app and try again.',
  failed: 'The microphone could not be opened.',
};

export function createListen(ctx) {
  const { $, el } = ctx;
  const ls = {
    active: false,
    mic: null,
    opening: null,
    engine: false,
    flat: [],        // every event of the song, in order: { entry, event, targetIndex }
    byEntry: [],     // per sequence entry: { first, count, reading, error }
    cur: 0,
    status: new Map(), // flat index → 'heard' | 'skipped' | 'missed'
    partial: new Map(), // flat index → Set of midi heard so far
    wrongCount: new Map(),
    lastWrong: 0,
    closing: false,
    paused: false,   // K in Wait mode
    held: false,     // the note editor is open over practice
    turnTimer: 0,
    building: 0,
    mode: 'wait',
    times: new Map(), // Play mode: entry → when each of its events is due, in its own seconds
  };

  // ---------------------------------------------------------------- setup

  function message(text, { actions = [] } = {}) {
    const box = $('listenMsg');
    box.textContent = '';
    if (!text) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('span', null, text));
    for (const [label, fn] of actions) {
      const b = el('button', 'ls-act', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      box.appendChild(b);
    }
  }

  function renderSetup() {
    const s = ctx.settings();
    $('lsTuning').value = s.tuningId;
    $('lsCustom').hidden = s.tuningId !== 'custom';
    for (const [i, inp] of [...document.querySelectorAll('#lsCustom input')].entries()) inp.value = String(s.tuning[i]);
    $('lsCapo').value = String(s.capo);
    $('lsStrict').value = s.strictness;
    for (const b of document.querySelectorAll('#lsModeSeg [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === ls.mode));
    $('lsMicState').textContent = ls.mic
      ? `Listening with ${ls.mic.label || 'the microphone'}${ls.engine ? '' : ' — the listener did not start'}`
      : 'The microphone is off.';
    $('lsAllow').hidden = Boolean(ls.mic);
    $('lsLive').hidden = !ls.mic;
  }

  const idle = () => ls.paused || ls.held;

  function toggleSetup(open) {
    if (open) ctx.closeSettings();
    $('listenSetup').hidden = !open;
    $('lsSetupBtn').setAttribute('aria-expanded', String(open));
    if (open) {
      renderSetup();
      if (ls.mic) { ls.mic.call('setMode', 'tuner'); refreshDevices(); }
    } else if (ls.mic && ls.active) {
      ls.mic.call('setMode', idle() || !ls.flat.length ? 'idle' : ls.mode);
      armCurrent();
    }
  }

  async function refreshDevices() {
    if (!ls.mic) return;
    const sel = $('lsDevice');
    const devices = await ls.mic.listDevices().catch(() => []);
    sel.textContent = '';
    for (const d of devices) {
      const o = el('option', null, d.label || 'Microphone');
      o.value = d.deviceId;
      o.selected = d.current;
      sel.appendChild(o);
    }
  }

  // One microphone at a time: a second call while one is opening waits for it.
  function startMic(deviceId) {
    if (!ls.opening) ls.opening = openMicNow(deviceId).finally(() => { ls.opening = null; });
    return ls.opening;
  }

  async function openMicNow(deviceId) {
    message('');
    if (ls.mic) { const old = ls.mic; ls.mic = null; await old.close(); }
    let mic;
    try {
      try {
        mic = await openMic({ deviceId });
      } catch (err) {
        // The microphone picked last time is gone (unplugged, renamed):
        // the system's own, rather than an error every time.
        if (!deviceId || ['denied', 'insecure', 'unsupported'].includes(err.code)) throw err;
        ctx.saveDevice('');
        mic = await openMic({});
      }
    } catch (err) {
      if (!ls.active) return null;
      let text = HELP[err.code] || err.message;
      const actions = [];
      if (err.code === 'denied') {
        const desktop = ctx.desktopMic();
        text = desktop
          ? 'VidToTab is not allowed to use the microphone. Allow it in System Settings, then come back.'
          : 'The browser is not letting this page use the microphone. Allow it in the site settings (the icon in the address bar), then try again.';
        if (desktop) actions.push(['Open System Settings', () => desktop.openSettings()]);
      }
      actions.push(['Try again', () => startMic(deviceId)]);
      message(text, { actions });
      toggleSetup(true);
      $('lsMicState').textContent = text;
      return null;
    }
    // Practice was closed while the microphone was opening: it goes again.
    if (!ls.active && ls.closing) { await mic.close(); return null; }
    ls.mic = mic;
    mic.on('level', onLevel);
    mic.on('tuner', onTuner);
    mic.on('accept', onAccept);
    mic.on('heard', onHeard);
    mic.on('wrong', onWrong);
    mic.on('drift', (m) => { $('lsDrift').textContent = Math.abs(m.cents) >= 30 ? `The guitar reads ${m.cents > 0 ? 'sharp' : 'flat'} by about ${Math.abs(Math.round(m.cents))} cents — worth retuning.` : ''; });
    mic.on('calib', () => { $('lsQuiet').disabled = false; $('lsQuiet').textContent = 'Stay quiet 3 s'; $('lsQuietDone').hidden = false; });
    mic.on('ended', () => { if (ls.mic === mic && ls.active) message('The microphone stopped — it may have been unplugged.', { actions: [['Reconnect', () => startMic()]] }); });
    mic.on('error', (m) => { if (ls.mic === mic && ls.active) message(`Listening failed: ${m.message}`); });
    const ready = await mic.ready;
    if (ls.mic !== mic) return null;
    ls.engine = Boolean(ready?.engine);
    if (!ls.active) { mic.call('setMode', 'idle'); return mic; }
    for (const w of mic.warnings) message(w);
    await sendTargets();
    renderSetup();
    refreshDevices();
    return mic;
  }

  function onLevel({ rms, peak, clip }) {
    const v = Math.min(1, Math.sqrt(rms) * 2.2);
    $('lsPillMeter').style.width = `${v * 100}%`;
    $('lsMeterFill').style.width = `${v * 100}%`;
    $('lsClip').hidden = !clip;
    if (clip && !$('listenSetup').hidden) $('lsClip').textContent = 'Too loud — move back a little';
  }

  function onTuner({ midi, cents, hz, clarity }) {
    if ($('listenSetup').hidden) return;
    if (!midi || clarity < 0.8) { $('lsTunerNote').textContent = '–'; $('lsTunerCents').textContent = 'Play one open string'; $('lsNeedle').style.left = '50%'; return; }
    $('lsTunerNote').textContent = noteName(midi);
    const c = Math.max(-50, Math.min(50, cents));
    $('lsTunerCents').textContent = `${c > 0 ? '+' : ''}${Math.round(c)} cents · ${hz.toFixed(1)} Hz`;
    $('lsNeedle').style.left = `${50 + c}%`;
    $('lsNeedle').classList.toggle('in', Math.abs(c) <= 5);
  }

  // ---------------------------------------------------------------- events

  // Read every page in the sequence (once per page image) and build the
  // song's events in order. Pages the reader could not make out get none;
  // they are turned by hand.
  async function build() {
    const token = ++ls.building;
    const seq = ctx.getSeq();
    const s = ctx.settings();
    // Nothing from the last build is valid while this one reads: the pages
    // may be another songsheet's, or shifted.
    ls.flat = [];
    ls.byEntry = [];
    ls.cur = 0;
    message(`Reading the tab… 0 of ${seq.length} pages`);
    const flat = [];
    const byEntry = [];
    for (let k = 0; k < seq.length; k++) {
      let reading = null;
      let error = null;
      try { ({ reading } = await ctx.readings.readingFor(seq[k].item)); } catch (err) { error = err.message; }
      if (token !== ls.building) return;
      const events = reading ? buildEvents(reading, s, { page: k }) : [];
      byEntry.push({ first: flat.length, count: events.length, reading, error, events });
      for (let i = 0; i < events.length; i++) flat.push({ entry: k, event: i, ev: events[i] });
      message(`Reading the tab… ${k + 1} of ${seq.length} pages`);
    }
    ls.flat = flat;
    ls.byEntry = byEntry;
    ls.times.clear();
    ls.status = new Map();
    ls.partial = new Map();
    ls.wrongCount = new Map();
    const unread = byEntry.filter((b) => !b.count).length;
    message(unread ? `${unread} page${unread === 1 ? '' : 's'} could not be read — turn ${unread === 1 ? 'it' : 'them'} by hand, or fix the notes (E).` : '');
    ls.cur = firstOf(ctx.current());
    await sendTargets();
    drawAll();
  }

  const firstOf = (entry) => {
    const b = ls.byEntry[entry];
    if (b && b.count) return b.first;
    // A page with nothing to hear: the next page that has something.
    for (let k = entry + 1; k < ls.byEntry.length; k++) if (ls.byEntry[k].count) return ls.byEntry[k].first;
    return ls.flat.length;
  };

  async function sendTargets() {
    const mic = ls.mic;
    if (!mic) return;
    await mic.call('setStrictness', ctx.settings().strictness);
    // No events (nothing could be read): the old ones must not stay armed.
    await mic.call('setTargets', ls.flat.map(({ ev }) => ({
      id: ev.id,
      pitchless: ev.pitchless,
      notes: ev.notes.map((n) => ({ midi: n.midi, string: n.string, required: n.required, tech: n.tech, bendTo: n.bendTo })),
    })));
    if (ls.mic !== mic) return;
    await mic.call('setMode', !ls.flat.length || idle() ? 'idle' : $('listenSetup').hidden ? ls.mode : 'tuner');
    armCurrent();
  }

  function armCurrent() {
    if (!ls.mic || idle() || ls.cur >= ls.flat.length) return;
    ls.mic.call('arm', ls.cur);
  }

  function onAccept({ index }) {
    if (!ls.active || idle() || index !== ls.cur) return;
    ls.status.set(index, 'heard');
    ls.partial.delete(index);
    advance();
  }

  function onHeard({ index, midi }) {
    if (!ls.active || index !== ls.cur) return;
    ls.partial.set(index, new Set(midi));
    drawEntry(ls.flat[index]?.entry);
  }

  function onWrong({ index, heard, expected }) {
    if (!ls.active || idle() || index !== ls.cur || !heard?.length) return;
    const now = performance.now();
    if (now - ls.lastWrong < 900) return;
    ls.lastWrong = now;
    const n = (ls.wrongCount.get(index) || 0) + 1;
    ls.wrongCount.set(index, n);
    const said = `Heard ${heard.map(noteName).join(' ')}${expected?.length ? `, expected ${expected.map(noteName).join(' ')}` : ''}`;
    if (n >= 3) {
      message(`${said}. The tab may be misread here.`, { actions: [['Skip note (N)', skip], ['Fix it (E)', fixCurrent]] });
    } else {
      message(said);
    }
    const note = document.querySelector('#practice .pr-card[data-current] .ls-note.current');
    note?.classList.remove('wrong');
    void note?.offsetWidth;
    note?.classList.add('wrong');
  }

  // Last event of a page heard: a moment to see it light up, then the next
  // page in order — one that could not be read included, to turn by hand.
  // Going back a note in that moment cancels it.
  function turnTo(k) {
    clearTimeout(ls.turnTimer);
    const at = ls.cur;
    ls.turnTimer = setTimeout(() => {
      if (ls.active && ls.cur === at && ctx.current() < k && k < ctx.getSeq().length) ctx.showEntry(k);
    }, 300);
  }

  function advance() {
    const was = ls.flat[ls.cur];
    if (!was) return;
    ls.cur++;
    message('');
    const next = ls.flat[ls.cur];
    drawEntry(was.entry);
    armCurrent();
    // In Play mode the clock turns pages and reports the end.
    if (ls.mode !== 'wait') { if (next) drawEntry(next.entry); return; }
    if (!next) {
      ctx.fill(was.entry, 1, 'the end');
      turnTo(was.entry + 1);
      finished();
    } else if (next.entry !== was.entry) {
      turnTo(was.entry + 1);
    } else {
      drawEntry(next.entry);
    }
  }

  function skip() {
    if (ls.cur >= ls.flat.length) return;
    ls.status.set(ls.cur, 'skipped');
    advance();
  }

  function back() {
    clearTimeout(ls.turnTimer);
    if (ls.cur === 0) return;
    ls.cur--;
    ls.status.delete(ls.cur);
    ls.partial.delete(ls.cur);
    const e = ls.flat[ls.cur];
    if (e.entry !== ctx.current()) ctx.showEntry(e.entry);
    else drawEntry(e.entry);
    armCurrent();
  }

  // Play mode: the clock says an event's time has passed without it.
  function miss() {
    const was = ls.flat[ls.cur];
    ls.status.set(ls.cur, 'missed');
    ls.partial.delete(ls.cur);
    ls.cur++;
    armCurrent();
    drawEntry(was.entry);
    const next = ls.flat[ls.cur];
    if (next && next.entry !== was.entry) drawEntry(next.entry);
  }

  // Called on every tick of the practice clock: t seconds into entry k (video
  // time). An event is due at its place along the page (playTimes) and is
  // missed once it is later than that by the gap to the next one, or half a
  // second of real time, whichever is more. Tab spacing is not rhythm, so the
  // window is wide; being early is never a miss.
  function onClock(k, t, dur, speed) {
    if (!ls.active || ls.mode !== 'play' || idle()) return;
    const b = ls.byEntry[k];
    if (!b) return;
    while (ls.cur < Math.min(b.first, ls.flat.length)) miss();
    if (!b.count) return;
    if (!ls.times.has(k)) ls.times.set(k, playTimes(b.events, dur));
    const times = ls.times.get(k);
    while (ls.cur >= b.first && ls.cur < b.first + b.count) {
      const i = ls.cur - b.first;
      const gap = (i + 1 < times.length ? times[i + 1] : dur) - times[i];
      if (t <= times[i] + Math.max(0.5 * speed, gap)) break;
      miss();
    }
  }

  // The clock reached the end of the song.
  function onEnd() {
    if (!ls.active || ls.mode !== 'play') return;
    while (ls.cur < ls.flat.length) miss();
    const total = ls.flat.length;
    if (!total) return;
    const heard = [...ls.status.values()].filter((v) => v === 'heard').length;
    const missedNotes = new Map();
    for (const [i, st] of ls.status) {
      if (st !== 'missed') continue;
      for (const n of ls.flat[i].ev.notes) if (n.midi !== null) missedNotes.set(n.midi, (missedNotes.get(n.midi) || 0) + 1);
    }
    const worst = [...missedNotes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, c]) => `${noteName(m)} ×${c}`);
    message(`${heard} of ${total} heard — ${Math.round((heard / total) * 100)}%.${worst.length ? ` Most missed: ${worst.join(', ')}.` : ''}`, { actions: [['Again', () => ctx.restart()]] });
  }

  function fixCurrent() {
    const e = ls.flat[ls.cur];
    if (!e) return;
    const n = e.ev.notes[0];
    const src = n && ls.byEntry[e.entry].reading.systems[e.ev.system]?.events[e.ev.index]?.notes.find((m) => m.string === n.string);
    ctx.openEditor(e.entry, n ? { s: e.ev.system, string: n.string, x: src?.box?.x ?? e.ev.x0 } : null);
  }

  function finished() {
    const total = ls.flat.length;
    const heard = [...ls.status.values()].filter((v) => v === 'heard').length;
    const skipped = [...ls.status.values()].filter((v) => v === 'skipped').length;
    const unread = ls.byEntry.filter((b) => !b.count).length;
    message(`Played through — ${heard} of ${total} heard${skipped ? `, ${skipped} skipped` : ''}${unread ? `; ${unread} page${unread === 1 ? '' : 's'} could not be read` : ''}.`, { actions: [['From the top', fromTop]] });
  }

  function fromTop() {
    clearTimeout(ls.turnTimer);
    ls.status.clear();
    ls.partial.clear();
    ls.wrongCount.clear();
    ls.cur = firstOf(0);
    message('');
    ctx.showEntry(0);
    drawAll();
    armCurrent();
  }

  // ---------------------------------------------------------------- drawing

  function drawAll() {
    for (let k = 0; k < ls.byEntry.length; k++) drawEntry(k);
  }

  function drawEntry(k) {
    if (k === undefined || k === null) return;
    const card = ctx.cardFor(k);
    const b = ls.byEntry[k];
    if (!card || !b) return;
    const paper = card.querySelector('.pr-paper');
    let layer = paper.querySelector('.ls-layer');
    if (!layer) { layer = el('div', 'ls-layer'); paper.appendChild(layer); }
    layer.textContent = '';
    card.querySelector('.ls-chip')?.remove();
    if (!ls.active) return;
    if (!b.count) {
      const chip = el('span', 'pr-chip ls-chip', b.error ? 'not read' : 'no notes read');
      card.querySelector('.pr-card-head')?.insertBefore(chip, card.querySelector('.pr-card-head .spacer'));
      ctx.fill(k, 0, 'turn by hand');
      return;
    }
    const { w, h } = b.reading;
    const pct = (v, of) => `${(v / of) * 100}%`;
    let done = 0;
    for (let i = 0; i < b.count; i++) {
      const idx = b.first + i;
      const st = ls.status.get(idx) || (idx === ls.cur ? 'current' : idx < ls.cur ? 'missed' : 'todo');
      if (st === 'heard' || st === 'skipped') done++;
      const ev = b.events[i];
      const partial = ls.partial.get(idx);
      for (const n of ev.notes) {
        const src = b.reading.systems[ev.system]?.events[ev.index]?.notes.find((m) => m.string === n.string);
        if (!src?.box) continue;
        const d = el('div', `ls-note ${st}`);
        if (st === 'current' && partial && n.midi !== null && partial.has(n.midi)) d.classList.add('got');
        if (!n.required) d.classList.add('optional');
        if ((src.conf ?? 1) < 0.5) d.classList.add('uncertain');
        Object.assign(d.style, { left: pct(src.box.x - 3, w), top: pct(src.box.y - 3, h), width: pct(src.box.w + 6, w), height: pct(src.box.h + 6, h) });
        d.dataset.midi = n.midi === null ? '' : String(n.midi);
        d.dataset.string = String(n.string);
        d.dataset.fret = n.fret === null ? 'x' : String(n.fret);
        d.dataset.state = st;
        layer.appendChild(d);
      }
    }
    if (ls.mode === 'wait') {
      ctx.fill(k, done / b.count, `${done} of ${b.count} notes`);
    } else {
      let heard = 0;
      let resolved = 0;
      for (let i = b.first; i < b.first + b.count; i++) {
        if (ls.status.has(i)) resolved++;
        if (ls.status.get(i) === 'heard') heard++;
      }
      if (resolved) {
        const chip = el('span', 'pr-chip ls-chip', `${heard}/${b.count} heard`);
        card.querySelector('.pr-card-head')?.insertBefore(chip, card.querySelector('.pr-card-head .spacer'));
      }
    }
  }

  // ---------------------------------------------------------------- test clips

  // What the microphone hears from the current note on, and the notes it
  // should have matched, as two files: scripts/eval-clips.mjs replays them
  // through the engine, so a clip recorded here becomes a regression test.
  let rec = null;
  function toggleRecord() {
    if (rec) { rec.stop(); return; }
    if (!ls.mic) { message('Allow the microphone first.'); return; }
    if (typeof MediaRecorder === 'undefined') { message('This browser cannot record.'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(ls.mic.stream, type ? { mimeType: type, audioBitsPerSecond: 256000 } : {});
    const chunks = [];
    const from = ls.cur;
    const mic = { label: ls.mic.label, sampleRate: ls.mic.sampleRate };
    // ponytail: capped at 90 s; longer clips only make slower tests.
    const limit = setTimeout(() => { if (r.state !== 'inactive') r.stop(); }, 90000);
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      clearTimeout(limit);
      rec = null;
      $('lsRecord').textContent = 'Record a test clip';
      const ext = /ogg/.test(r.mimeType) ? 'ogg' : /mp4/.test(r.mimeType) ? 'm4a' : 'webm';
      const name = `vidtotab-clip-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
      const events = ls.flat.slice(from, from + 200).map(({ ev }) => ({
        pitchless: ev.pitchless,
        notes: ev.notes.map((n) => ({ string: n.string, fret: n.fret, midi: n.midi, required: n.required, tech: n.tech, bendTo: n.bendTo })),
      }));
      ctx.download(new Blob(chunks, { type: r.mimeType }), `${name}.${ext}`);
      ctx.download(new Blob([JSON.stringify({ v: 1, audio: `${name}.${ext}`, settings: ctx.settings(), mic, events }, null, 2)], { type: 'application/json' }), `${name}.json`);
      message(`Saved ${name}.${ext} and its notes. Put both in scripts/listen-clips/ to replay them as a test.`);
    };
    r.start(1000);
    rec = r;
    $('lsRecord').textContent = 'Stop recording';
    message('Recording — play from the highlighted note, then stop.');
  }

  // ---------------------------------------------------------------- mode

  function setMode(mode) {
    ls.mode = mode === 'play' ? 'play' : 'wait';
    ctx.saveSettings({ mode: ls.mode });
    if (ls.active) document.getElementById('practice').dataset.listen = ls.mode;
    // Wait mode has no clock; Play mode starts from Play (K), with a count-in.
    ctx.stopClock();
    ls.paused = false;
    ls.status.clear();
    ls.partial.clear();
    ls.cur = firstOf(ctx.current());
    armCurrent();
    drawAll();
    message(ls.mode === 'play' ? 'Play (K) starts the clock — notes are scored as they come.' : '');
    for (const b of document.querySelectorAll('#lsModeSeg [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === ls.mode));
    if (ls.mic) ls.mic.call('setMode', ls.mode);
  }

  // ---------------------------------------------------------------- wiring

  // Allowed from the panel: the point was to play, so it steps aside once the
  // microphone is live (T brings it and the tuner back).
  $('lsAllow').addEventListener('click', async () => {
    if (await startMic(ctx.savedDevice())) toggleSetup(false);
  });
  $('lsSetupBtn').addEventListener('click', () => toggleSetup($('listenSetup').hidden));
  $('lsSkip').addEventListener('click', skip);
  $('lsRecord').addEventListener('click', toggleRecord);
  $('lsDevice').addEventListener('change', () => { ctx.saveDevice($('lsDevice').value); startMic($('lsDevice').value); });
  $('lsQuiet').addEventListener('click', () => {
    if (!ls.mic) return;
    $('lsQuiet').disabled = true;
    $('lsQuiet').textContent = 'Listening to the room…';
    $('lsQuietDone').hidden = true;
    ls.mic.call('calibrateNoise', 3);
  });
  for (const t of TUNINGS) {
    const o = el('option', null, t.label);
    o.value = t.id;
    $('lsTuning').appendChild(o);
  }
  for (let c = 0; c <= 12; c++) {
    const o = el('option', null, c ? `Capo ${c}` : 'No capo');
    o.value = String(c);
    $('lsCapo').appendChild(o);
  }
  const resettle = () => { renderSetup(); if (ls.active) build(); };
  $('lsTuning').addEventListener('change', () => { ctx.saveSettings({ tuningId: $('lsTuning').value }); resettle(); });
  for (const inp of document.querySelectorAll('#lsCustom input')) {
    inp.addEventListener('change', () => {
      const inputs = [...document.querySelectorAll('#lsCustom input')];
      const tuning = inputs.map((x) => Number(x.value));
      // One field half-typed or out of range must not reset the other five.
      for (const x of inputs) x.toggleAttribute('aria-invalid', !(Number.isInteger(Number(x.value)) && Number(x.value) >= 28 && Number(x.value) <= 76));
      if (inputs.some((x) => x.hasAttribute('aria-invalid'))) return;
      ctx.saveSettings({ tuningId: 'custom', tuning });
      resettle();
    });
  }
  $('lsCapo').addEventListener('change', () => { ctx.saveSettings({ capo: Number($('lsCapo').value) }); resettle(); });
  $('lsStrict').addEventListener('change', () => { ctx.saveSettings({ strictness: $('lsStrict').value }); if (ls.mic) ls.mic.call('setStrictness', $('lsStrict').value); });
  for (const b of document.querySelectorAll('#lsModeSeg [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));

  return {
    get active() { return ls.active; },
    // The tab is read first, then the microphone opened: what either has to
    // say (pages not read, no microphone) is then said last and stays.
    async enter() {
      ls.active = true;
      ls.paused = false;
      ls.mode = ctx.settings().mode;
      document.getElementById('practice').dataset.listen = ls.mode;
      renderSetup();
      await build();
      if (!ls.active || ls.mic) return;
      if (await micPermissionState() === 'granted') await startMic(ctx.savedDevice());
      else if (ls.active) toggleSetup(true);
    },
    // Back to the timer: the microphone stays open but stops listening, so
    // coming back is instant.
    leave() {
      ls.active = false;
      ls.building++;
      clearTimeout(ls.turnTimer);
      delete document.getElementById('practice').dataset.listen;
      message('');
      toggleSetup(false);
      drawAll();
      if (ls.mic) ls.mic.call('setMode', 'idle');
    },
    // Practice closed: the microphone too, including one still opening.
    async close() {
      if (rec) rec.stop();
      this.leave();
      ls.closing = true;
      try {
        await ls.opening?.catch(() => {});
        if (ls.mic) { const m = ls.mic; ls.mic = null; await m.close(); }
      } finally {
        ls.closing = false;
      }
    },
    // The note editor is open over practice: nothing is heard or scored.
    hold(on) {
      ls.held = on;
      if (!ls.mic || !ls.active) return;
      ls.mic.call('setMode', on || ls.paused ? 'idle' : $('listenSetup').hidden ? ls.mode : 'tuner');
      armCurrent();
    },
    closeSetup() { if (!$('listenSetup').hidden) toggleSetup(false); },
    // The practice view showed another page: by hand (arrows, pedal) or by
    // listening. By hand means "listen for this page's notes now".
    onEntryShown(k) {
      if (!ls.active || !ls.byEntry.length) return;
      const cur = ls.flat[ls.cur];
      if (!cur || cur.entry !== k) {
        const to = firstOf(k);
        if (to < ls.cur) {
          // Back to an earlier page: played again from there.
          for (const i of [...ls.status.keys()]) if (i >= to) ls.status.delete(i);
          ls.partial.clear();
          ls.cur = to;
        } else if (ls.mode === 'play') {
          while (ls.cur < to) miss();
        } else {
          ls.cur = to;
        }
        armCurrent();
        drawAll();
      }
      drawEntry(k);
      if (k + 1 < ls.byEntry.length) drawEntry(k + 1);
    },
    onClock,
    onEnd,
    // A page's notes were corrected in the editor: read it again.
    async refresh() { if (ls.active) await build(); },
    togglePause() {
      ls.paused = !ls.paused;
      message(ls.paused ? 'Paused — press K to listen again.' : '');
      if (ls.mic) ls.mic.call('setMode', idle() ? 'idle' : ls.mode);
      armCurrent();
    },
    keys(e) {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'n') { skip(); return true; }
      if (k === 'b') { back(); return true; }
      if (k === 't') { toggleSetup($('listenSetup').hidden); return true; }
      if (k === 'w') { setMode(ls.mode === 'wait' ? 'play' : 'wait'); return true; }
      if ((k === 'k' || k === 'p') && ls.mode === 'wait') { this.togglePause(); return true; }
      return false;
    },
    get mode() { return ls.mode; },
  };
}

export { normaliseListen };
