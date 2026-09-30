// Fix-by-click: the reading of a page, drawn as boxes over the page itself,
// and every way to correct it — by pointer or entirely by keyboard.
//
// Boxes sit in percentages of the picture, so they follow it at any size.
// Unsure notes are amber with a "?", corrected ones carry a green dot. Every
// change is saved straight away (readings.saveCorrection) and can be undone.

import { FLAG, addNote, confirmNote, deleteNote, joinPrevious, separate, setNote, unsureNotes } from '/shared/transcript.js';

const STRING_NAMES = ['e', 'B', 'G', 'D', 'A', 'E'];
const TECHS = [['h', 'Hammer-on'], ['p', 'Pull-off'], ['/', 'Slide up'], ['\\', 'Slide down'], ['b', 'Bend'], ['~', 'Vibrato'], ['harm', 'Harmonic'], ['ghost', 'Ghost'], ['grace', 'Grace']];

export function createEditor({ el, readings, pageSrc, onClose, onChange }) {
  const root = document.getElementById('tabEdit');
  const img = root.querySelector('.te-page img');
  const layer = root.querySelector('.te-notes');
  const pop = root.querySelector('.te-pop');
  const $q = (sel) => root.querySelector(sel);

  let items = [];
  let index = 0;
  let reading = null;
  let busy = false;
  let sel = null; // { s, e, n }
  let undo = [];
  let redo = [];
  let digitBuf = '';
  let digitTimer = 0;
  let showing = 0; // the newest show(): an older, slower read must not land on another page

  const note = (at) => at && reading?.systems[at.s]?.events[at.e]?.notes[at.n];
  const flat = () => {
    const out = [];
    reading?.systems.forEach((sys, s) => sys.events.forEach((ev, e) => ev.notes.forEach((_, n) => out.push({ s, e, n }))));
    return out;
  };
  const same = (a, b) => a && b && a.s === b.s && a.e === b.e && a.n === b.n;

  async function show(i) {
    index = Math.max(0, Math.min(items.length - 1, i));
    const item = items[index];
    busy = true;
    sel = null;
    undo = [];
    redo = [];
    pop.hidden = true;
    layer.textContent = '';
    $q('#tePos').textContent = `Page ${index + 1} of ${items.length}`;
    $q('#teStatus').textContent = 'Reading…';
    img.src = pageSrc(item);
    const token = ++showing;
    reading = null;
    let got = null;
    try {
      ({ reading: got } = await readings.readingFor(item));
    } catch (err) {
      if (token !== showing) return;
      $q('#teStatus').textContent = err.message;
      busy = false;
      return;
    }
    if (token !== showing) return;
    reading = got;
    busy = false;
    render();
  }

  function render() {
    layer.textContent = '';
    if (!reading) return;
    if (!reading.found) {
      $q('#teStatus').textContent = reading.flags?.includes('notSixLines') ? 'This is not six-string tab.' : 'No tab staff found on this page.';
      return;
    }
    const W = reading.w;
    const H = reading.h;
    const pct = (v, of) => `${(v / of) * 100}%`;
    const labels = $q('#teShowReadings').checked;
    for (const at of flat()) {
      const n = note(at);
      const b = el('button', 'te-note');
      b.type = 'button';
      Object.assign(b.style, { left: pct(n.box.x - 2, W), top: pct(n.box.y - 2, H), width: pct(n.box.w + 4, W), height: pct(n.box.h + 4, H) });
      const unsure = (n.conf ?? 1) < 0.5 && !(n.flags & (FLAG.SET | FLAG.CONFIRMED));
      if (unsure) b.classList.add('unsure');
      if (n.flags & FLAG.SET) b.classList.add('edited');
      if (same(at, sel)) b.classList.add('selected');
      b.dataset.string = String(n.string);
      b.dataset.fret = n.fret === null ? 'x' : String(n.fret);
      b.setAttribute('aria-label', `${STRING_NAMES[n.string - 1]} string, ${n.fret === null ? 'muted' : `fret ${n.fret}`}${unsure ? ', unsure' : ''}`);
      if (labels) b.appendChild(el('span', 'te-label', n.fret === null ? 'x' : String(n.fret)));
      b.addEventListener('click', (ev) => { ev.stopPropagation(); select(at); });
      layer.appendChild(b);
    }
    const left = unsureNotes(reading).length;
    $q('#teStatus').textContent = left ? `${left} to check` : 'Nothing left to check';
    $q('#teStatus').classList.toggle('warn', left > 0);
    $q('#teUndo').disabled = !undo.length;
    $q('#teRedo').disabled = !redo.length;
    renderPop();
  }

  function renderPop() {
    const n = note(sel);
    pop.hidden = !n;
    if (!n) return;
    $q('#tePopTitle').textContent = `${STRING_NAMES[n.string - 1]} string · ${n.fret === null ? 'muted' : `fret ${n.fret}`}`;
    for (const b of pop.querySelectorAll('[data-fret]')) b.setAttribute('aria-pressed', String(String(n.fret ?? 'x') === b.dataset.fret));
    for (const b of pop.querySelectorAll('[data-string]')) b.setAttribute('aria-pressed', String(Number(b.dataset.string) === n.string));
    for (const b of pop.querySelectorAll('[data-tech]')) b.setAttribute('aria-pressed', String(n.tech.includes(b.dataset.tech)));
    // Beside the note, inside the stage.
    // The stage scrolls, and the popover scrolls with it: positions are in
    // the stage's content, not the window.
    const box = layer.querySelector('.te-note.selected');
    const st = $q('.te-stage');
    const stage = st.getBoundingClientRect();
    if (box) {
      const r = box.getBoundingClientRect();
      const below = r.bottom - stage.top + 8;
      const above = r.top - stage.top - pop.offsetHeight - 8;
      const fitsBelow = below + pop.offsetHeight <= st.clientHeight || above < 0;
      pop.style.left = `${st.scrollLeft + Math.max(8, Math.min(st.clientWidth - pop.offsetWidth - 8, r.left - stage.left - 20))}px`;
      pop.style.top = `${st.scrollTop + (fitsBelow ? below : above)}px`;
    }
  }

  function select(at) {
    sel = at;
    digitBuf = '';
    render();
  }

  // The note in system s drawn at box (x, w) on that string, wherever the
  // edit has moved it in the lists: edits re-sort chords and split or merge
  // events, so an index would land on a neighbour.
  function locate(s, box, string) {
    const evs = reading?.systems[s]?.events || [];
    for (let e = 0; e < evs.length; e++) {
      const n = evs[e].notes.findIndex((m) => m.string === string && m.box.x === box.x && m.box.w === box.w);
      if (n >= 0) return { s, e, n };
    }
    return null;
  }

  // Every edit: remember the old reading, apply, save, redraw. The selection
  // stays on the edited note (on its new string, if that is what changed),
  // and goes away with a deleted one.
  function apply(fn, { string, drop = false } = {}) {
    if (!reading || busy) return;
    let next;
    try { next = fn(reading); } catch (err) { $q('#teStatus').textContent = err.message; return; }
    const was = note(sel);
    const at = sel;
    undo.push(reading);
    if (undo.length > 100) undo.shift();
    redo = [];
    reading = next;
    sel = drop || !was ? null : locate(at.s, was.box, string ?? was.string);
    readings.saveCorrection(items[index], reading).then(() => onChange?.(items[index])).catch(() => { /* kept on screen */ });
    render();
  }

  function stepUndo(from, to) {
    if (!from.length) return;
    to.push(reading);
    reading = from.pop();
    if (sel && !note(sel)) sel = null;
    readings.saveCorrection(items[index], reading).then(() => onChange?.(items[index])).catch(() => {});
    render();
  }

  const setFret = (fret) => sel && apply((r) => setNote(r, sel, { fret }));
  const toggleTech = (t) => {
    const n = note(sel);
    if (!n) return;
    const tech = n.tech.includes(t) ? n.tech.filter((x) => x !== t) : [...n.tech, t];
    apply((r) => setNote(r, sel, { tech }));
  };
  const moveString = (d) => {
    const n = note(sel);
    if (!n) return;
    const s = n.string + d;
    if (s >= 1 && s <= 6) apply((r) => setNote(r, sel, { string: s }), { string: s });
  };
  const nextNote = (d) => {
    const all = flat();
    if (!all.length) return;
    const i = all.findIndex((a) => same(a, sel));
    select(i < 0 ? all[d > 0 ? 0 : all.length - 1] : all[(i + d + all.length) % all.length]);
  };
  const nextUnsure = () => {
    const list = unsureNotes(reading || { systems: [] });
    if (list.length) { select(list[0]); return; }
    if (index < items.length - 1) show(index + 1);
  };

  // Adding: a click on empty staff near a string line puts a note there.
  $q('.te-page').addEventListener('click', (ev) => {
    if (!reading?.found || ev.target.closest('.te-note')) return;
    const r = img.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * reading.w;
    const y = ((ev.clientY - r.top) / r.height) * reading.h;
    let best = null;
    reading.systems.forEach((sys, s) => sys.lines.forEach((ly, k) => {
      const d = Math.abs(ly - y);
      if (d <= 0.35 * (sys.spacing || 20) && (!best || d < best.d)) best = { s, string: k + 1, d };
    }));
    if (!best) { select(null); return; }
    apply((rd) => addNote(rd, best.s, { string: best.string, fret: 0, x }));
    // Select the note just added, so typing its fret is the next thing.
    const added = flat().find((a) => { const n = note(a); return n.string === best.string && Math.abs(n.box.x + n.box.w / 2 - x) < 1; });
    if (added) select(added);
  });

  // The popover: fret keypad, strings, techniques, chord and removal.
  const keypad = $q('#teFrets');
  for (const f of ['x', ...Array.from({ length: 25 }, (_, i) => String(i))]) {
    const b = el('button', 'te-key', f);
    b.type = 'button';
    b.dataset.fret = f;
    b.addEventListener('click', () => setFret(f === 'x' ? null : Number(f)));
    keypad.appendChild(b);
  }
  const strings = $q('#teStrings');
  STRING_NAMES.forEach((name, i) => {
    const b = el('button', 'te-key', name);
    b.type = 'button';
    b.dataset.string = String(i + 1);
    b.title = `String ${i + 1}`;
    b.addEventListener('click', () => sel && apply((r) => setNote(r, sel, { string: i + 1 }), { string: i + 1 }));
    strings.appendChild(b);
  });
  const techs = $q('#teTechs');
  for (const [t, label] of TECHS) {
    const b = el('button', 'te-key wide', label);
    b.type = 'button';
    b.dataset.tech = t;
    b.addEventListener('click', () => toggleTech(t));
    techs.appendChild(b);
  }
  $q('#teConfirm').addEventListener('click', () => sel && apply((r) => confirmNote(r, sel)));
  $q('#teDelete').addEventListener('click', () => sel && apply((r) => deleteNote(r, sel), { drop: true }));
  $q('#teSeparate').addEventListener('click', () => sel && apply((r) => separate(r, sel)));
  $q('#teJoin').addEventListener('click', () => sel && apply((r) => joinPrevious(r, sel)));
  $q('#teUndo').addEventListener('click', () => stepUndo(undo, redo));
  $q('#teRedo').addEventListener('click', () => stepUndo(redo, undo));
  $q('#teNextUnsure').addEventListener('click', nextUnsure);
  $q('#tePrevPage').addEventListener('click', () => show(index - 1));
  $q('#teNextPage').addEventListener('click', () => show(index + 1));
  $q('#teShowReadings').addEventListener('change', render);
  $q('#teClose').addEventListener('click', close);

  // Keys, taken in the capture phase while open, so nothing behind the
  // editor (the songsheet's own shortcuts) sees them — Cmd/Ctrl+Z included.
  function keys(e) {
    if (root.hidden) return;
    const k = e.key;
    // Enter and Space on a focused button press that button.
    if ((k === 'Enter' || k === ' ') && e.target instanceof Element && e.target.closest('button, input, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    let handled = true;
    if (mod && k.toLowerCase() === 'z') { if (e.shiftKey) stepUndo(redo, undo); else stepUndo(undo, redo); }
    else if (mod) handled = false;
    else if (k === 'Escape') { if (sel) select(null); else close(); }
    else if (/^[0-9]$/.test(k) && sel) {
      clearTimeout(digitTimer);
      digitBuf += k;
      const v = Number(digitBuf);
      if (digitBuf.length === 2 || v > 2) { if (v <= 24) setFret(v); digitBuf = ''; }
      else { setFret(v); digitTimer = setTimeout(() => { digitBuf = ''; }, 600); }
    }
    else if (k === 'x' && sel) setFret(null);
    else if (['h', 'p', 'b', 'r', 's', '/', '\\', '~'].includes(k) && sel) toggleTech(k);
    else if (k === '<' && sel) toggleTech('harm');
    else if (k === '(' && sel) toggleTech('ghost');
    else if (k === 'g' && sel) toggleTech('grace');
    else if (k === 'ArrowUp' && sel) moveString(-1);
    else if (k === 'ArrowDown' && sel) moveString(1);
    else if (k === 'ArrowRight') nextNote(1);
    else if (k === 'ArrowLeft') nextNote(-1);
    else if (k === '|' && sel) apply((r) => separate(r, sel));
    else if (k === '+' && sel) apply((r) => joinPrevious(r, sel));
    else if (k === 'Enter' && sel) { apply((r) => confirmNote(r, sel)); nextUnsure(); }
    else if ((k === 'Delete' || k === 'Backspace') && sel) apply((r) => deleteNote(r, sel), { drop: true });
    else if (k === 'u') stepUndo(undo, redo);
    else if (k === 'n') nextUnsure();
    else if (k === 'PageDown' || k === ']') show(index + 1);
    else if (k === 'PageUp' || k === '[') show(index - 1);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  window.addEventListener('keydown', keys, true);
  window.addEventListener('resize', () => { if (!root.hidden) renderPop(); });

  function close() {
    root.hidden = true;
    sel = null;
    onClose?.();
  }

  return {
    // items: the songsheet's pages; start: which; focus: a note to select
    // (as a box position, from the listener's "may be misread").
    async open(list, start = 0, focus = null) {
      items = list;
      root.hidden = false;
      $q('#teClose').focus();
      await show(start);
      if (focus && reading) {
        // The note on that string nearest the place asked for.
        let at = null;
        let best = Infinity;
        for (const a of flat()) {
          const n = note(a);
          const d = Math.abs(n.box.x - focus.x);
          if (n.string === focus.string && (focus.s === undefined || a.s === focus.s) && d < best) { best = d; at = a; }
        }
        if (at) select(at);
      } else if (reading) {
        const u = unsureNotes(reading);
        if (u.length) select(u[0]);
      }
    },
    close,
    get isOpen() { return !root.hidden; },
  };
}
