/**
 * All sound is synthesised - no audio files to load, ship, or cache-bust.
 *
 * Browsers refuse to start an AudioContext without a user gesture, which is the
 * real reason the title screen exists: the first key, click, tap or button press
 * both starts the game and unlocks audio in the same gesture, so the wind is
 * already playing by the time the player sees the wasteland.
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 0.7;
    this.nodes = {};
  }

  /** Must be called from inside a real user-gesture handler. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ready;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();

    const master = this.ctx.createGain();
    master.gain.value = this.volume;
    master.connect(this.ctx.destination);
    this.nodes.master = master;

    this.#buildWind();
    this.#buildHeart();
    this.ready = true;
    return true;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.nodes.master) {
      this.nodes.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  /** Looping filtered noise. Cheap, and it hides how quiet the world otherwise is. */
  #buildWind() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // Brown-ish noise: smoother and less hissy than white for wind.
      last = (last + Math.random() * 2 - 1) * 0.5;
      d[i] = last * 0.6;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;

    const gain = ctx.createGain();
    gain.gain.value = 0.18;

    src.connect(filter).connect(gain).connect(this.nodes.master);
    src.start();

    // Slow drift so it never sits perfectly still.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 130;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    this.nodes.wind = gain;
  }

  /** A heartbeat that only exists while something is chasing you. */
  #buildHeart() {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.nodes.master);
    this.nodes.heart = gain;
    this.heartPhase = 0;
    this.heartLevel = 0;
  }

  #thump(when, freq, dur, peak, target) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, when + dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(target);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  /** Call every frame. `threat` is 0..1 from the nearest hunting tubby. */
  update(dt, threat) {
    if (!this.ready) return;
    this.heartLevel += (threat - this.heartLevel) * Math.min(1, dt * 3);
    if (this.heartLevel < 0.04) { this.heartPhase = 0; return; }

    // Faster and louder the closer it gets: 50 bpm at the edge, 130 on top of you.
    const bpm = 50 + this.heartLevel * 80;
    this.heartPhase += dt * (bpm / 60);
    if (this.heartPhase >= 1) {
      this.heartPhase -= 1;
      const t = this.ctx.currentTime;
      const peak = 0.05 + this.heartLevel * 0.5;
      this.#thump(t, 62, 0.16, peak, this.nodes.heart);
      this.#thump(t + 0.17, 52, 0.2, peak * 0.7, this.nodes.heart);
      this.nodes.heart.gain.setTargetAtTime(1, t, 0.1);
    }
  }

  /** Bright two-note rise when a dish is taken. */
  pickup() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.22, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.32);
      osc.connect(g).connect(this.nodes.master);
      osc.start(t + i * 0.09);
      osc.stop(t + i * 0.09 + 0.35);
    }
  }

  land() {
    if (!this.ready) return;
    this.#thump(this.ctx.currentTime, 120, 0.14, 0.25, this.nodes.master);
  }

  /** Long, ugly, and final. */
  caught() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(340, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 1.1);
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    osc.connect(g).connect(this.nodes.master);
    osc.start(t);
    osc.stop(t + 1.35);
  }

  won() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      const at = t + i * 0.13;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.2, at + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      osc.connect(g).connect(this.nodes.master);
      osc.start(at);
      osc.stop(at + 0.55);
    });
  }

  /** Silence everything without tearing the context down. */
  suspend() { if (this.ctx?.state === "running") this.ctx.suspend(); }
  resume() { if (this.ctx?.state === "suspended") this.ctx.resume(); }
}
