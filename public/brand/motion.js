// The lifecycle every looping brand animation shares: how a loader arrives, how
// it stays in step with the ones before it, and — the part that is easy to get
// wrong — how it leaves.
//
// A CSS `animation: … infinite` is trivial to start and awful to stop. Hiding
// the element mid-stride cuts the loop wherever it happened to be: the playhead
// disappears half way across the staff, the page stops mid-flip. The eye reads
// that as a glitch even when the work behind it finished perfectly. So an exit
// here waits for the loop's own seam — the moment the animation comes back to
// the pose it started in — and fades from there, where the last frame and the
// first frame are the same picture and the fade has nothing to cut.
//
// The wait is capped. A 4.6s scan loop that has only just restarted would hold
// a finished stage on screen for four more seconds, which is worse than the cut
// it set out to avoid, so past the cap it fades from wherever it is.
//
// The timing arithmetic is exported on its own, free of the DOM, so that
// scripts/test.mjs can check it in Node where there is nothing to animate.

// A fade long enough to read as a fade and short enough not to delay the next
// screen. Matches the .15s-.25s the rest of the app already uses.
export const FADE_MS = 200;

// Past this, waiting for the seam costs more than the seam is worth.
export const SEAM_CAP_MS = 900;

/**
 * How long to hold before starting the exit, given where the loop currently is.
 *
 * `progress` is the animation's position within its current iteration (0..1) and
 * `period` is how long one iteration lasts. Returns 0 to mean "leave now" —
 * either we are already at the seam or it is too far off to be worth waiting
 * for. Anything under about three frames also counts as now: the eye cannot
 * tell, and a scheduled 12ms wait only adds a timer.
 */
export function seamWait(progress, period, cap = SEAM_CAP_MS) {
  if (!Number.isFinite(progress) || !Number.isFinite(period) || period <= 0) return 0;
  const left = (1 - Math.min(Math.max(progress, 0), 1)) * period;
  if (left <= 40 || left >= period) return 0;
  return left <= cap ? left : 0;
}

// ------------------------------------------------------------------- the DOM

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The animation whose interruption would show most — the longest loop running
 * anywhere inside `el`. A loader is several elements moving at different rates
 * (six strings plucking under one sweeping beam); cutting the fast one is barely
 * visible, cutting the slow one is the glitch.
 */
export function carrier(el) {
  if (!el?.getAnimations) return null;
  let best = null;
  let bestPeriod = 0;
  for (const a of el.getAnimations({ subtree: true })) {
    if (a.playState !== 'running') continue;
    const period = Number(a.effect?.getComputedTiming?.().duration);
    if (!Number.isFinite(period) || period <= 0 || period <= bestPeriod) continue;
    best = a;
    bestPeriod = period;
  }
  return best;
}

// Bumped by both enter() and exit() so a loader that comes back while its own
// exit is still waiting for a seam does not get hidden out from under itself.
const generation = new WeakMap();
const bump = (el) => {
  const n = (generation.get(el) || 0) + 1;
  generation.set(el, n);
  return () => generation.get(el) === n;
};

/**
 * Show a loader.
 *
 * `phase` puts it in step with every other brand loop on the page. Each of them
 * reads `animation-delay: var(--vtt-phase)`, and setting that to minus the time
 * since the page loaded starts the animation that far in — so a loader mounted
 * three seconds late sits at exactly the point in its cycle it would have
 * reached had it been running all along. Handing a wait from one stage to the
 * next then reads as one tempo carried through rather than three restarts.
 *
 * Pass `phase: false` for anything whose beginning is part of what it says. The
 * scan playhead is the case: it means "this is where we are up to", so it has to
 * set off from the left, not from wherever the shared clock happens to be.
 */
export function enter(el, { phase = true } = {}) {
  if (!el) return el;
  bump(el);
  el.hidden = false;
  if (phase) el.style.setProperty('--vtt-phase', `-${Math.round(performance.now())}ms`);
  else el.style.removeProperty('--vtt-phase');
  el.classList.remove('is-leaving');
  el.classList.add('is-entering');
  // Two frames, not one: the browser has to take the starting style before the
  // change can be a transition rather than a jump.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-entering')));
  return el;
}

/**
 * Hide a loader at the next seam in its loop, then fade it.
 *
 * Resolves true once it is hidden, or false if an enter() overtook it — the
 * caller can use that to tell "gone" from "came back".
 */
export async function exit(el, { cap = SEAM_CAP_MS } = {}) {
  if (!el || el.hidden) return false;
  const live = bump(el);
  const quick = reducedMotion();

  if (!quick) {
    const a = carrier(el);
    const timing = a?.effect?.getComputedTiming?.();
    if (timing) await sleep(seamWait(Number(timing.progress), Number(timing.duration), cap));
    if (!live()) return false;
  }

  el.classList.add('is-leaving');
  await sleep(quick ? 0 : FADE_MS);
  if (!live()) return false;
  el.hidden = true;
  el.classList.remove('is-leaving');
  return true;
}

// ------------------------------------------------------------- the self-check

export function selfCheck(assert) {
  // At the seam already — both ends of the iteration are the same pose, so
  // there is nothing to wait for.
  assert.equal(seamWait(0, 1200), 0);
  assert.equal(seamWait(1, 1200), 0);

  // Part way through: wait out the remainder.
  assert.equal(seamWait(0.5, 1200), 600);
  assert.equal(seamWait(0.25, 800), 600);

  // Within three frames of the seam, waiting buys nothing but a timer.
  assert.equal(seamWait(0.99, 1200), 0);

  // Too far off to hold a finished stage on screen for: fade from here instead.
  // This is the long scan loop caught just after it restarted.
  assert.equal(seamWait(0.05, 4600), 0);
  // The same loop near its end is inside the cap, so it is worth the wait.
  assert.ok(seamWait(0.9, 4600) > 0);
  assert.ok(seamWait(0.9, 4600) <= SEAM_CAP_MS);

  // A raised cap takes that same restart-time case, which is the only reason to
  // raise it.
  assert.ok(seamWait(0.05, 4600, 5000) > 4000);

  // Nothing here may throw on the values a stopped or malformed animation hands
  // back; an exit that throws leaves the loader on screen forever.
  for (const bad of [[NaN, 1200], [0.5, NaN], [0.5, 0], [0.5, -10], [null, 1200], [0.5, Infinity]]) {
    assert.equal(seamWait(bad[0], bad[1]), 0, `seamWait(${bad[0]}, ${bad[1]})`);
  }

  // Out-of-range progress is clamped rather than turned into a negative wait,
  // which would resolve the exit before the fade had started.
  assert.equal(seamWait(-3, 1200), 0);
  assert.equal(seamWait(9, 1200), 0);
}

// Run the self-check when executed directly by scripts/test.mjs, guarded on
// `process` so the browser loading this same file never touches a Node builtin.
if (typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { strict: assert } = await import('node:assert');
  selfCheck(assert);
}
