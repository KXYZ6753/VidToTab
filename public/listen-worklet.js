// The microphone's first stop, on the audio thread: mix to mono, cut the
// stream into chunks of exactly `hop` samples for the listening worker, and
// measure the level every ~50 ms so the page can show that it hears something.
//
// Nothing here allocates per sample. Samples collect in one fixed buffer; a
// full chunk is copied out into its own array and transferred (not copied
// again) to the worker, which can hand arrays back to be reused. The audio
// thread is the one place a garbage-collection pause is audible as a dropout.
//
// The worker's end of the channel arrives as a message rather than in
// processorOptions, because a MessagePort cannot travel in those:
//   node.port.postMessage({ type: 'port', port }, [port])
// Out, on that port:
//   { type: 'chunk', frame, samples }      samples: Float32Array(hop), transferred;
//                                          frame: the context frame of samples[0]
//   { type: 'level', frame, rms, peak, clip }   clip: samples with |x| >= 0.985
// In, on that port:
//   { type: 'recycle', samples }           an array to fill again
// In, on node.port:
//   { type: 'port', port }, { type: 'stop' }

const CLIP = 0.985;
const POOL_MAX = 8;

class VttCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const hop = Number(options?.processorOptions?.hop);
    this.hop = Number.isInteger(hop) && hop > 0 ? hop : 512;
    this.acc = new Float32Array(this.hop);
    this.fill = 0;
    this.chunkFrame = 0;
    this.pool = [];
    this.out = null;
    this.alive = true;
    // Level window, in samples.
    this.levelEvery = Math.max(128, Math.round(sampleRate * 0.05));
    this.lvN = 0;
    this.lvSum = 0;
    this.lvPeak = 0;
    this.lvClip = 0;
    this.lvFrame = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m?.type === 'port' && m.port) {
        this.out = m.port;
        this.out.onmessage = (ev) => this.recycle(ev.data);
      } else if (m?.type === 'stop') {
        this.alive = false;
        try { this.out?.close(); } catch { /* already closed */ }
        this.out = null;
      }
    };
  }

  recycle(m) {
    const s = m?.type === 'recycle' ? m.samples : null;
    if (s instanceof Float32Array && s.length === this.hop && this.pool.length < POOL_MAX) this.pool.push(s);
  }

  flushChunk() {
    const buf = this.pool.pop() || new Float32Array(this.hop);
    buf.set(this.acc);
    this.out.postMessage({ type: 'chunk', frame: this.chunkFrame, samples: buf }, [buf.buffer]);
    this.fill = 0;
  }

  flushLevel() {
    const n = this.lvN;
    this.out.postMessage({ type: 'level', frame: this.lvFrame, rms: Math.sqrt(this.lvSum / n), peak: this.lvPeak, clip: this.lvClip });
    this.lvN = 0;
    this.lvSum = 0;
    this.lvPeak = 0;
    this.lvClip = 0;
  }

  process(inputs) {
    if (!this.alive) return false;
    const chans = inputs[0];
    // No worker yet, or no input (the track ended): nothing to do, but stay
    // alive so capture resumes when either arrives.
    if (!this.out || !chans || chans.length === 0) return true;
    const nch = chans.length;
    const len = chans[0].length;
    const inv = 1 / nch;
    const hop = this.hop;
    const acc = this.acc;
    const c0 = chans[0];
    const c1 = nch > 1 ? chans[1] : null;
    for (let i = 0; i < len; i++) {
      let x;
      if (nch === 1) x = c0[i];
      else if (nch === 2) x = (c0[i] + c1[i]) * 0.5;
      else {
        x = 0;
        for (let c = 0; c < nch; c++) x += chans[c][i];
        x *= inv;
      }
      if (this.fill === 0) this.chunkFrame = currentFrame + i;
      acc[this.fill++] = x;
      if (this.fill === hop) this.flushChunk();

      if (this.lvN === 0) this.lvFrame = currentFrame + i;
      const a = x < 0 ? -x : x;
      this.lvSum += x * x;
      if (a > this.lvPeak) this.lvPeak = a;
      if (a >= CLIP) this.lvClip++;
      if (++this.lvN >= this.levelEvery) this.flushLevel();
    }
    return true;
  }
}

registerProcessor('vtt-capture', VttCapture);
