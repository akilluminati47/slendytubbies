/**
 * Nearly all sound is synthesised - no audio files to load, ship, or cache-bust.
 * The one exception is the jumpscare, which is a recording and could not be
 * anything else; see preload() and playSample().
 *
 * Browsers refuse to start an AudioContext without a user gesture, which is the
 * real reason the title screen exists: the first key, click, tap or button press
 * both starts the game and unlocks audio in the same gesture, so the wind is
 * already playing by the time the player sees the wasteland.
 */
/** How loud the theme sits under everything else. */
const MUSIC_GAIN = 0.42;

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 0.7;
    this.nodes = {};
    // name -> ArrayBuffer while we are waiting for a gesture, then AudioBuffer.
    this.samples = new Map();
    this.pending = new Map();
    // The looping music, and which sample it is - see music().
    this.playing = null;
    this.musicName = null;
    this.gritBuf = null;
  }

  /**
   * Fetch a sound file now and decode it later.
   *
   * Decoding needs an AudioContext and there is no context until the player
   * touches something, but the download can happen immediately, so the bytes are
   * on hand the moment the context exists. A jumpscare that arrives a beat late
   * is not a jumpscare.
   */
  preload(name, url) {
    this.pending.set(name, fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .catch((err) => {
        console.warn(`[audio] ${url} did not load:`, err.message);
        return null;
      }));
    return this.pending.get(name);
  }

  async #decode(name) {
    if (this.samples.has(name)) return this.samples.get(name);
    const bytes = await this.pending.get(name);
    if (!bytes || !this.ctx) return null;
    try {
      // decodeAudioData detaches the buffer, so hand it a copy - a second
      // playthrough would otherwise find an empty ArrayBuffer.
      const buf = await this.ctx.decodeAudioData(bytes.slice(0));
      this.samples.set(name, buf);
      return buf;
    } catch (err) {
      console.warn(`[audio] could not decode ${name}:`, err.message);
      return null;
    }
  }

  /**
   * Play a preloaded file. Returns its length in seconds, or 0 if it is not
   * available, so a caller timing something against it has a number either way.
   */
  async playSample(name, gain = 1) {
    if (!this.ready) return 0;
    const buf = await this.#decode(name);
    if (!buf) return 0;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(g).connect(this.nodes.master);
    src.start(this.ctx.currentTime);
    return buf.duration;
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

  /* ------------------------------------------------------------ footfall -- */

  /**
   * White noise, made once and shared.
   *
   * Every impact in the game is a pitched thump with a scatter of grit on top;
   * the thump says how heavy it was and the grit says what it hit. One buffer
   * serves all of them - the variation comes from where in it each burst starts
   * and how it is filtered, which is free.
   */
  #grit() {
    if (this.gritBuf) return this.gritBuf;
    const len = Math.floor(this.ctx.sampleRate * 0.4);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.gritBuf = buf;
    return buf;
  }

  /** A burst of filtered noise: the scuff on top of a footfall, or a switch. */
  #scuff(when, { peak = 0.1, dur = 0.09, hz = 1600, q = 0.7 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.#grit();
    // Two steps in a row should not be the same step.
    src.playbackRate.value = 0.82 + Math.random() * 0.36;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = hz;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(f).connect(g).connect(this.nodes.master);
    src.start(when, Math.random() * 0.2);
    src.stop(when + dur + 0.02);
  }

  /**
   * One footfall.
   *
   * The same two parts as the landing, scaled - because they are the same event
   * at different speeds, and a sprint that sounded like a different instrument
   * from the landing you finish it with would come apart. A full run lands just
   * under the jump, which is what makes running the loud way to travel.
   *
   * @param power 0 at a crawl, 1 at a full sprint.
   */
  step(power = 0.5) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const p = Math.max(0, Math.min(1, power));
    this.#thump(t, 96 + p * 26, 0.07 + p * 0.05, 0.045 + p * 0.165, this.nodes.master);
    this.#scuff(t, { peak: 0.03 + p * 0.09, dur: 0.05 + p * 0.06, hz: 1500 + p * 900 });
  }

  /**
   * The push-off.
   *
   * A step, not a grunt - it is a foot leaving the ground, and the character
   * makes no other vocal sound in the game, so one here would be a voice
   * arriving from nowhere. Pitched above a walking step and shorter, so a jump
   * and its landing read as two ends of one movement.
   */
  jumpStep() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.#thump(t, 142, 0.09, 0.19, this.nodes.master);
    this.#scuff(t, { peak: 0.10, dur: 0.11, hz: 2100 });
  }

  land() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.#thump(t, 120, 0.14, 0.25, this.nodes.master);
    this.#scuff(t, { peak: 0.13, dur: 0.14, hz: 1300 });
  }

  /**
   * The switch.
   *
   * Two of them, because there are two torches and they are not the same
   * object. The slim black one is a plastic thumb-switch: one bright tick with
   * a smaller one behind it. The Guardian's lamp is a lever on a metal housing,
   * so it is lower, heavier, and takes two beats to finish - the same
   * information the size of the thing already gives you, arriving through the
   * other ear.
   */
  torchClick(kind = "handheld") {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (kind === "searchlight") {
      this.#scuff(t, { peak: 0.30, dur: 0.035, hz: 900, q: 1.4 });
      this.#thump(t, 190, 0.05, 0.13, this.nodes.master);
      this.#scuff(t + 0.05, { peak: 0.17, dur: 0.03, hz: 620, q: 1.6 });
    } else {
      this.#scuff(t, { peak: 0.22, dur: 0.02, hz: 3200, q: 1.1 });
      this.#scuff(t + 0.02, { peak: 0.10, dur: 0.02, hz: 2300, q: 1.3 });
    }
  }

  /* ---------------------------------------------------------------- menu -- */

  /**
   * The cursor moved.
   *
   * Deliberately tiny. This is the sound you will hear more than any other in
   * the game - every hover, every stick flick down a settings list - so it has
   * to survive being heard fifty times in ten seconds, which rules out anything
   * with a tail on it.
   */
  blip() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(740, t);
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(g).connect(this.nodes.master);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  /**
   * Chosen.
   *
   * Also what the title screen says when it lets you in - the first press and
   * every press after it are the same act, so they are the same sound, and it
   * doubles as proof the audio context actually started.
   */
  select() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    [560, 840].forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      const at = t + i * 0.055;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.15, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(g).connect(this.nodes.master);
      osc.start(at);
      osc.stop(at + 0.2);
    });
  }

  /* --------------------------------------------------------------- music -- */

  /**
   * The theme, looping, faded in and out.
   *
   * Called every frame with whether it should be playing, rather than started
   * and stopped from half a dozen places - the screens it belongs to are the
   * screens the parade is on, and that is already one question with one answer,
   * so asking it repeatedly is cheaper than keeping two things in step.
   *
   * The name is claimed before the decode is awaited, so a screen that comes
   * and goes faster than an mp3 decodes cannot leave a second copy playing.
   */
  async music(name, on) {
    if (!this.ready) return;
    if (!on) {
      this.musicName = null;
      const live = this.playing;
      if (!live) return;
      this.playing = null;
      const t = this.ctx.currentTime;
      live.gain.gain.cancelScheduledValues(t);
      live.gain.gain.setValueAtTime(live.gain.gain.value, t);
      live.gain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
      try { live.src.stop(t + 0.7); } catch { /* already stopped */ }
      return;
    }
    if (this.musicName === name) return;
    this.musicName = name;
    const buf = await this.#decode(name);
    if (!buf || this.musicName !== name || this.playing) return;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buf;
    src.loop = true;
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(MUSIC_GAIN, t + 1.4);
    src.connect(gain).connect(this.nodes.master);
    src.start(t);
    this.playing = { src, gain };
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
