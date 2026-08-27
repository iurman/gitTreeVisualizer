/* -------------------------------------------------------------------------- */
/* Sound                                                                       */
/*                                                                            */
/* The growth animation is a sonification of the repository's history, not a   */
/* garnish on it. Dense commit periods produce dense sound, quiet years are    */
/* near-silent, and a merge is an event you hear. Everything is synthesized    */
/* from oscillators, filtered noise and envelopes: no audio files, so there is */
/* no asset weight and no loading delay before the moment the product exists   */
/* for, and every event can be parameterized by real commit data instead of    */
/* picking from a handful of fixed clips.                                      */
/*                                                                            */
/* Three things stop generative audio sounding like noise, and all three are   */
/* non-negotiable here: every pitch is quantized to one scale, voices are      */
/* pooled and throttled with bursts aggregated rather than dropped, and the    */
/* master bus is compressed and limited.                                       */
/* -------------------------------------------------------------------------- */

/** Minor pentatonic on D. Forgiving: no interval in it can clash with another. */
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 146.83; // D3

const MAX_VOICES = 8;
const MAX_TRIGGERS_PER_SECOND = 12;

export type VoiceKind =
  | 'leaf'
  | 'limb'
  | 'merge'
  | 'ring'
  | 'ringMajor'
  | 'granularity'
  | 'hover'
  | 'click'
  | 'mode'
  | 'fall';

export type LeafEvent = {
  /** 0..1, commit size. Drives pitch and brightness. */
  size: number;
  /** Limb depth. Deeper branches are higher. */
  depth: number;
  isMerge: boolean;
};

function quantize(semitoneish: number): number {
  // Snap to the nearest scale degree, then to an octave. Overlapping events can
  // then never sound wrong no matter how many fire at once.
  const octave = Math.floor(semitoneish / 12);
  const within = semitoneish - octave * 12;
  let best = SCALE[0];
  let bestD = 99;
  for (const s of SCALE) {
    const d = Math.abs(s - within);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return ROOT * Math.pow(2, (octave * 12 + best) / 12);
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ambient: { osc: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;

  private active = 0;
  private windowStart = 0;
  private windowCount = 0;
  /** Events swallowed by the throttle inside the current window. Density stays audible. */
  private aggregated = 0;
  private aggregatedSize = 0;

  private _muted = false;
  private _volume = 0.7;
  private hidden = false;

  get muted(): boolean {
    return this._muted;
  }

  get volume(): number {
    return this._volume;
  }

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Must be called from inside a user gesture handler. Browsers will not start
   * an AudioContext otherwise, and a deep link that auto-grew the tree would
   * play the whole sequence silently — the worst possible outcome for the one
   * moment this is built around. Deep links show a seed and wait for the click
   * instead, which also makes starting feel chosen rather than missed.
   */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    // Master bus: compressor then limiter. Overlapping envelopes clip badly
    // without one, and master gain sits well below unity.
    const bus = ctx.createDynamicsCompressor();
    bus.threshold.value = -22;
    bus.knee.value = 12;
    bus.ratio.value = 4;
    bus.attack.value = 0.004;
    bus.release.value = 0.18;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.06;

    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : this._volume * 0.34;

    bus.connect(limiter);
    limiter.connect(master);
    master.connect(ctx.destination);

    this.bus = bus;
    this.limiter = limiter;
    this.master = master;

    // One second of white noise, reused by every noise voice.
    const len = Math.floor(ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    void ctx.resume();
    this.startAmbient();
  }

  setMuted(v: boolean): void {
    this._muted = v;
    this.applyGain();
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    this.applyGain();
  }

  /** Mute while the tab is hidden. A tree growing in a background tab is nobody's soundtrack. */
  setHidden(v: boolean): void {
    this.hidden = v;
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.master || !this.ctx) return;
    const g = this._muted || this.hidden ? 0 : this._volume * 0.34;
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05);
  }

  /* ---------------------------------------------------------------------- */
  /* Voices                                                                 */
  /* ---------------------------------------------------------------------- */

  private canTrigger(now: number): boolean {
    if (now - this.windowStart > 1) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.active >= MAX_VOICES) return false;
    if (this.windowCount >= MAX_TRIGGERS_PER_SECOND) return false;
    this.windowCount++;
    return true;
  }

  private noise(duration: number, freq: number, q: number, gain: number, sweep = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer || !this.bus) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    if (sweep !== 0) filter.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t + duration);
    src.connect(filter).connect(g).connect(this.bus);
    src.start(t);
    src.stop(t + duration + 0.02);
    this.active++;
    src.onended = () => {
      this.active--;
      src.disconnect();
      filter.disconnect();
      g.disconnect();
    };
  }

  private tone(
    freq: number,
    duration: number,
    gain: number,
    type: OscillatorType = 'triangle',
    attack = 0.02,
    detune = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + duration + 0.02);
    this.active++;
    osc.onended = () => {
      this.active--;
      osc.disconnect();
      g.disconnect();
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * A commit appearing. Over a 20-second growth of a 5000-commit repo this is
   * asked to fire 250 times a second; what does not fit the throttle is
   * aggregated into one louder, brighter tick rather than dropped, so a burst
   * still sounds like a burst.
   */
  leaf(ev: LeafEvent): void {
    if (!this.ctx || this._muted) return;
    const now = this.ctx.currentTime;
    if (!this.canTrigger(now)) {
      this.aggregated++;
      this.aggregatedSize = Math.max(this.aggregatedSize, ev.size);
      return;
    }
    const burst = this.aggregated;
    const size = Math.max(ev.size, this.aggregatedSize);
    this.aggregated = 0;
    this.aggregatedSize = 0;

    if (ev.isMerge) {
      this.merge(ev.depth);
      return;
    }
    // Bigger commits are lower and darker; small ones are high and dry.
    const freq = 1500 + (1 - size) * 2600 + ev.depth * 260;
    const gain = Math.min(0.5, 0.055 + size * 0.075 + Math.min(burst, 20) * 0.012);
    this.noise(0.045 + size * 0.05, freq, 3 + size * 5, gain, 0.55);
  }

  /** A branch leaving its parent. Pitched by depth, so deeper branches are higher. */
  limb(depth: number): void {
    if (!this.ctx || this._muted || !this.canTrigger(this.ctx.currentTime)) return;
    this.tone(quantize(12 + depth * 7), 0.5, 0.075, 'triangle', 0.05);
  }

  /** Two tones converging to a unison. */
  merge(depth: number): void {
    if (!this.ctx || this._muted) return;
    const ctx = this.ctx;
    if (!this.bus) return;
    const target = quantize(12 + depth * 5);
    const t = ctx.currentTime;
    for (const sign of [-1, 1]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(target * Math.pow(2, (sign * 3.5) / 12), t);
      osc.frequency.exponentialRampToValueAtTime(target, t + 0.34);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      osc.connect(g).connect(this.bus);
      osc.start(t);
      osc.stop(t + 0.6);
      this.active++;
      osc.onended = () => {
        this.active--;
        osc.disconnect();
        g.disconnect();
      };
    }
  }

  /**
   * A ring boundary crossing. This is what gives a chosen timescale an audible
   * pulse. Minor rings are suppressed when they are dense, or it turns into a
   * drum roll.
   */
  ring(major: boolean, dense: boolean): void {
    if (!this.ctx || this._muted) return;
    if (!major && dense) return;
    if (!this.canTrigger(this.ctx.currentTime)) return;
    this.tone(major ? ROOT / 2 : ROOT, major ? 0.85 : 0.3, major ? 0.09 : 0.035, 'sine', 0.01);
  }

  /** Up for finer, down for coarser. */
  granularity(finer: boolean): void {
    if (!this.ctx || this._muted || !this.bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const a = quantize(finer ? 0 : 24);
    const b = quantize(finer ? 24 : 0);
    osc.frequency.setValueAtTime(a, t);
    osc.frequency.exponentialRampToValueAtTime(b, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    osc.connect(g).connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.3);
    this.active++;
    osc.onended = () => {
      this.active--;
      osc.disconnect();
      g.disconnect();
    };
  }

  hover(): void {
    if (!this.ctx || this._muted || !this.canTrigger(this.ctx.currentTime)) return;
    this.noise(0.03, 5200, 8, 0.022, 1);
  }

  /** Two notes; the second is pitched by which view was entered, so each has an identity. */
  modeChange(index: number): void {
    if (!this.ctx || this._muted) return;
    this.tone(quantize(12), 0.16, 0.06, 'triangle', 0.008);
    window.setTimeout(() => this.tone(quantize(12 + 3 + index * 4), 0.32, 0.06, 'triangle', 0.01), 110);
  }

  click(): void {
    if (!this.ctx || this._muted || !this.canTrigger(this.ctx.currentTime)) return;
    this.noise(0.05, 2400, 4, 0.05, 0.6);
  }

  fall(): void {
    if (!this.ctx || this._muted || !this.canTrigger(this.ctx.currentTime)) return;
    this.noise(0.6, 1800, 2.5, 0.03, 0.16);
  }

  /* ---------------------------------------------------------------------- */
  /* Ambient bed                                                            */
  /* ---------------------------------------------------------------------- */

  private startAmbient(): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = ROOT / 4;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 180;
    filter.Q.value = 1.4;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    osc.connect(filter).connect(gain).connect(this.bus);
    osc.start();
    gain.gain.setTargetAtTime(0.05, ctx.currentTime, 2);
    this.ambient = { osc, filter, gain };
  }

  /** Filter cutoff tracks camera height, so orbiting has a sense of space. */
  setCameraHeight(h: number): void {
    if (!this.ambient || !this.ctx) return;
    this.ambient.filter.frequency.setTargetAtTime(140 + h * 620, this.ctx.currentTime, 0.3);
  }

  dispose(): void {
    this.ambient?.osc.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Growth scheduler                                                            */
/*                                                                            */
/* Growth drives the sound, not the other way round: the scheduler watches the */
/* same normalized-time cursor the vertex shader gates leaves against, so what */
/* you hear and what you see are the same number.                              */
/* -------------------------------------------------------------------------- */

export type GrowthEvent =
  | { kind: 'leaf'; leaf: LeafEvent }
  | { kind: 'limb'; depth: number }
  | { kind: 'ring'; major: boolean };

export class GrowthSonifier {
  private cursor = 0;
  private events: { h: number; ev: GrowthEvent }[] = [];
  private index = 0;
  private denseRings = false;

  load(events: { h: number; ev: GrowthEvent }[], denseRings: boolean): void {
    this.events = [...events].sort((a, b) => a.h - b.h);
    this.index = 0;
    this.cursor = 0;
    this.denseRings = denseRings;
  }

  reset(to = 0): void {
    this.cursor = to;
    this.index = 0;
    while (this.index < this.events.length && this.events[this.index].h <= to) this.index++;
  }

  /** Fire everything the growth cursor has passed since the last frame. */
  advance(to: number, sound: SoundEngine): void {
    if (to < this.cursor) {
      this.reset(to);
      return;
    }
    this.cursor = to;
    let guard = 0;
    while (this.index < this.events.length && this.events[this.index].h <= to && guard++ < 4000) {
      const { ev } = this.events[this.index++];
      if (ev.kind === 'leaf') sound.leaf(ev.leaf);
      else if (ev.kind === 'limb') sound.limb(ev.depth);
      else sound.ring(ev.major, this.denseRings);
    }
  }
}
