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

/**
 * How a sound with a place in the world falls off with distance.
 *
 * Inverse rather than linear, because linear is a straight fade to nothing at a
 * fixed radius and everything inside it is nearly as loud as everything else -
 * which tells you a thing is near without telling you HOW near, and the whole
 * point of putting the monster's feet in the world is that you can tell.
 *
 * ref is the distance at which a sound plays at full strength, so it is roughly
 * "how big is this thing": a footfall is a point and gets 3 m, and past that it
 * halves every time the distance doubles. max is where it stops getting quieter,
 * kept a little beyond the fog so nothing audible is also invisible.
 */
const SPATIAL = { ref: 3, max: 55, rolloff: 1.15 };

/**
 * The two things that hum continuously, and how far away they start to.
 *
 * Both are loops rather than one-shots, so both get a panner they keep and move
 * rather than one per sound - and both follow the NEAREST of their kind, the
 * same trick World plays with the custard light. Ten dishes humming at once is
 * a chord, not a clue.
 */
const HUM = {
  // A dish, for the player who is looking for it. Reaches a little past the
  // torch so the ear finds one just outside what the eye can.
  dish: { from: 26, gain: 0.085, hz: 132 },
  // The set in the CHASER's belly. Only inside the range the heartbeat lives
  // in, so it arrives at the same moment the dread does and says which
  // direction it is coming from, which the heartbeat cannot.
  belly: { from: 20, gain: 0.16, hz: 1750, q: 0.55 },
  // And in everybody else's. Quieter and shorter-ranged than the thing hunting
  // you, deliberately: four tellies at chaser strength would drown the one that
  // matters, and the whole value of that sound is that hearing it means
  // something. A team-mate at arm's length is still under half the chaser at
  // twenty metres.
  friend: { from: 11, gain: 0.055 },
};

/**
 * A belly's own voice, from whatever names it.
 *
 * Every set is tuned slightly differently - a real room of them would be - and
 * doing it from a hash of the player's id rather than at random means yours
 * sounds the same to everybody, stays the same all round, and needs nothing
 * sent to agree on. Two people can be told apart by ear before they are told
 * apart by eye, which in fog is most of the time.
 */
function bellyVoice(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Avalanche, or short similar keys stay short similar hashes. "p1", "p2" and
  // "p3" differ in one character and came out at 1789, 1787 and 1786 Hz - three
  // sets tuned to the same station. Two rounds of xor-shift and multiply spread
  // a one-bit change across the whole word, which is the entire point of the
  // step and the reason it is not optional here.
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  const a = (h >>> 8 & 1023) / 1023;
  const b = (h >>> 20 & 255) / 255;
  // And deliberately BELOW the chaser's band rather than around it. A friend
  // and the thing hunting you should not be the same sound at two volumes: its
  // set sits at 1750 and theirs run 820 to 1480, so a room of them is a chord
  // the monster is not part of.
  return { hz: 820 + a * 660, q: 0.5 + b * 0.55 };
}

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
    this.fading = null;
    this.musicName = null;
    this.gritBuf = null;
    // key -> a looping, panned television. See #belly.
    this.bellies = new Map();
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
  async playSample(name, gain = 1, at = null) {
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
    this.#buildRain();
    this.#buildHeart();
    this.#buildHum();
    this.ready = true;
    return true;
  }

  /**
   * The dish, humming to itself.
   *
   * Heard by the player and nobody else - it feeds no noise into the AI and is
   * not sent to anyone. It is a cue, not an event: a dish is 30 cm across in
   * fog that stops at 46 m, and now that its halo has been pulled back to
   * almost nothing at range this is what is left to find one by.
   *
   * Two detuned triangles rather than one, because a single tone at a fixed
   * pitch is a test signal and two a few cents apart beat slowly against each
   * other, which is the difference between an alarm and something alive.
   */
  #buildHum() {
    const panner = this.#emitter();
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(panner);
    for (const detune of [-7, 6]) {
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = HUM.dish.hz;
      osc.detune.value = detune;
      const g = this.ctx.createGain();
      g.gain.value = 0.5;
      osc.connect(g).connect(gain);
      osc.start();
    }
    this.nodes.dishHum = gain;
    this.nodes.dishAt = panner;
  }

  /**
   * A belly, built on demand and kept.
   *
   * Looped noise through a narrow band, which is what a detuned CRT actually
   * sounds like through a wall: no top end, no bottom, all hiss in the middle.
   * Panned, so it tells you which way the thing is - the heartbeat tells you it
   * is close and nothing more, and knowing a thing is close without knowing
   * where is a worse kind of useless than not knowing at all.
   *
   * One of these per body rather than one shared, because in a lobby there are
   * four of them and they are in four places. They are made when a body first
   * needs one and dropped when it leaves; the chaser's is simply the one keyed
   * "chaser".
   *
   * Your own is never made. In first person you are not somewhere over there,
   * and a television you cannot get away from is a different game.
   */
  #belly(key, voice) {
    let b = this.bellies.get(key);
    if (b) return b;
    const panner = this.#emitter();
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const band = this.ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = voice.hz;
    band.Q.value = voice.q;
    const cut = this.ctx.createBiquadFilter();
    cut.type = "lowpass";
    cut.frequency.value = 3400;
    const src = this.ctx.createBufferSource();
    src.buffer = this.#grit();
    src.loop = true;
    // Each starts at its own point in the noise, or four of them line up and
    // stop being four.
    src.loopStart = 0;
    src.connect(band).connect(cut).connect(gain).connect(panner);
    src.start(this.ctx.currentTime, Math.random() * 0.35);
    b = { panner, gain, src };
    this.bellies.set(key, b);
    return b;
  }

  /** A panner that stays put in the graph and gets moved, for the loops. */
  #emitter() {
    const p = this.ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = SPATIAL.ref;
    p.maxDistance = SPATIAL.max;
    p.rolloffFactor = SPATIAL.rolloff;
    p.connect(this.nodes.master);
    return p;
  }

  /** Move one of the kept panners, in whichever API this browser has. */
  #moveTo(p, at) {
    const t = this.ctx.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(at.x, t);
      p.positionY.setValueAtTime(at.y ?? 0, t);
      p.positionZ.setValueAtTime(at.z, t);
    } else {
      p.setPosition(at.x, at.y ?? 0, at.z);
    }
  }

  /**
   * Point the dish hum at the nearest untaken dish, or fade it out.
   *
   * @param at   where it is, or null for none left
   * @param dist how far away, in metres
   */
  hummingDish(at, dist) {
    if (!this.ready) return;
    if (this.muffled) return;       // see muffle - a dish is not a warning
    const g = this.nodes.dishHum.gain;
    if (!at) { g.setTargetAtTime(0, this.ctx.currentTime, 0.2); return; }
    this.#moveTo(this.nodes.dishAt, at);
    const k = Math.max(0, 1 - dist / HUM.dish.from);
    g.setTargetAtTime(HUM.dish.gain * k * k, this.ctx.currentTime, 0.15);
  }

  /**
   * Point one belly at a body, or quieten it.
   *
   * Squared falloff on top of the panner's own, so it is genuinely absent until
   * the thing is near rather than a hiss that is always faintly there. The
   * chaser's keeps playing through the jumpscare on purpose: the scream goes
   * over the top of it and the static is what is left underneath.
   *
   * @param key   "chaser", or a player's id
   * @param at    where it is, or null to fade this one out
   * @param dist  how far, in metres
   * @param kind  which set of numbers - the thing hunting you, or a friend
   */
  bellyStatic(key, at, dist, kind = "belly") {
    if (!this.ready) return;
    // A paused player still hears the thing hunting them, and nothing else -
    // see muffle. Its television is one of the three sounds that gets through.
    if (this.muffled && key !== "chaser") return;
    const spec = HUM[kind] ?? HUM.belly;
    const voice = kind === "friend" ? bellyVoice(key) : { hz: spec.hz, q: spec.q };
    const b = this.#belly(key, voice);
    const t = this.ctx.currentTime;
    if (!at) { b.gain.gain.setTargetAtTime(0, t, 0.3); return; }
    this.#moveTo(b.panner, at);
    const k = Math.max(0, 1 - dist / spec.from);
    b.gain.gain.setTargetAtTime(spec.gain * k * k, t, 0.12);
  }

  /**
   * The pause mix: a room with the music on and the door shut.
   *
   * The world does not stop while the menu is open - the hour turns, the thing
   * keeps walking - and it would be easy to let the whole soundtrack of that
   * carry on underneath the settings, which is honest and completely wrong. A
   * paused player is not in the wood any more, they are looking at a panel with
   * the theme playing, and a panel is a safe place. That safety has to be a lie.
   *
   * So the rain goes, the wind goes, the dish stops humming, and the party
   * stops making any noise at all. What is left is the theme, the buttons, and
   * the exactly three things that mean something is coming for you: the
   * heartbeat, the television in its belly, and its feet. You hear it arrive
   * over the music, in a silence built to make you think there was nothing to
   * hear - and then it takes you off the pause screen.
   *
   * Nothing here stops the CLOCK. Every ducked sound is still being computed and
   * still being positioned; it is only the level that goes.
   */
  muffle(on) {
    if (!this.ready) return;
    this.muffled = !!on;
    const t = this.ctx.currentTime;
    // Half a second either way. A hard cut announces itself as a mute, and the
    // point is a room going quiet rather than a switch being thrown.
    if (this.nodes.wind) {
      this.nodes.wind.gain.setTargetAtTime(on ? 0 : 0.18, t, 0.5);
    }
    if (on) {
      this.nodes.dishHum.gain.setTargetAtTime(0, t, 0.4);
      if (this.nodes.rain) {
        for (const g of ["patterGain", "bodyGain", "canopyGain"]) {
          this.nodes.rain[g].gain.setTargetAtTime(0, t, 0.5);
        }
      }
      // Everybody's set but the one that matters.
      for (const [key, b] of this.bellies) {
        if (key !== "chaser") b.gain.gain.setTargetAtTime(0, t, 0.4);
      }
    }
    // Coming back needs no restore: every one of those is written every frame
    // by the thing that owns it, so they climb back on their own the moment
    // this stops forcing them down.
  }

  /**
   * Everything the world is humming, off.
   *
   * The dish hum and the bellies are loops whose level is only revised while a
   * round is being played, so when one ends they hold whatever they were last
   * set to and follow you into the menus - which is how the last dish taken
   * ended up humming over the end card. Ending a round has to say so.
   */
  hushWorld() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.nodes.dishHum.gain.setTargetAtTime(0, t, 0.18);
    // There is no weather on the front screens either.
    if (this.nodes.rain) {
      this.rainLevel = 0;
      this.squall = 0;
      this.squallFor = 0;
      this.shelter = 0;
      this.nodes.rain.patterGain.gain.setTargetAtTime(0, t, 0.5);
      this.nodes.rain.bodyGain.gain.setTargetAtTime(0, t, 0.5);
      this.nodes.rain.canopyGain.gain.setTargetAtTime(0, t, 0.5);
    }
    for (const b of this.bellies.values()) b.gain.gain.setTargetAtTime(0, t, 0.18);
  }

  /** A body that has left the lobby takes its television with it. */
  dropBelly(key) {
    const b = this.bellies.get(key);
    if (!b) return;
    this.bellies.delete(key);
    try { b.src.stop(this.ctx.currentTime + 0.3); } catch { /* already gone */ }
    setTimeout(() => { try { b.panner.disconnect(); } catch { /* gone */ } }, 500);
  }

  /**
   * Where the ears are, and which way they face.
   *
   * Called every frame from the camera. Without it every panner in the graph
   * places its sound relative to an origin nobody is standing at, which is worse
   * than no panning at all: sounds would swap sides as you walked past a fixed
   * point in the world rather than as you turned your head.
   *
   * The positionX/orientationX properties are the current API and the
   * setPosition/setOrientation pair is the deprecated one, but Safari only grew
   * the first relatively recently and this is a game people open on phones, so
   * it uses whichever it finds.
   */
  listenAt(pos, forward) {
    if (!this.ready) return;
    const L = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setValueAtTime(pos.x, t);
      L.positionY.setValueAtTime(pos.y, t);
      L.positionZ.setValueAtTime(pos.z, t);
      L.forwardX.setValueAtTime(forward.x, t);
      L.forwardY.setValueAtTime(forward.y, t);
      L.forwardZ.setValueAtTime(forward.z, t);
      L.upX.setValueAtTime(0, t);
      L.upY.setValueAtTime(1, t);
      L.upZ.setValueAtTime(0, t);
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  /**
   * Where a sound comes from, or the master bus if it comes from you.
   *
   * Everything the player does themselves stays unpanned on purpose. Your own
   * feet are not somewhere over to your left; they are you, and pushing them
   * through a panner at head position produces a subtle wrongness that is very
   * hard to name and impossible to stop hearing once named.
   *
   * The node is thrown away after the sound is done. These are one-shots and a
   * panner left connected is a live node in the graph forever, which for a
   * monster walking around for ten minutes is thousands of them.
   */
  #place(at, life = 1.5) {
    if (!at) return this.nodes.master;
    const p = this.ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = SPATIAL.ref;
    p.maxDistance = SPATIAL.max;
    p.rolloffFactor = SPATIAL.rolloff;
    const t = this.ctx.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(at.x, t);
      p.positionY.setValueAtTime(at.y ?? 0, t);
      p.positionZ.setValueAtTime(at.z, t);
    } else {
      p.setPosition(at.x, at.y ?? 0, at.z);
    }
    p.connect(this.nodes.master);
    setTimeout(() => { try { p.disconnect(); } catch { /* already gone */ } },
               (life + 0.4) * 1000);
    return p;
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

  /**
   * Rain, out of two layers of the same noise.
   *
   * A downpour is not one sound. There is the patter - thousands of separate
   * impacts, bright and grainy, which is what tells you it is rain and not
   * wind - and underneath it the roar, the sum of all the ones too far away to
   * hear individually. Splitting the same loop through a highpass and a lowpass
   * and moving the two against each other is what lets a shower become a
   * downpour: the body comes up faster than the patter, so heavy rain gets
   * closer to a roar without ever losing the grain on top.
   *
   * One buffer, one source, two filters. A rainstorm that costs four nodes.
   */
  #buildRain() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 5;         // long enough not to hear it loop
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        // A touch of brown mixed into the white. Pure white noise is a hiss and
        // reads as static; the low end under it is what makes it weather.
        last = (last + white * 0.35) * 0.86;
        d[i] = white * 0.55 + last * 0.9;
      }
    }
    // Two channels of independently generated noise, so it arrives wide rather
    // than as a point between your ears. Rain has no direction.
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const patter = ctx.createBiquadFilter();
    patter.type = "highpass";
    patter.frequency.value = 1900;
    patter.Q.value = 0.5;

    const body = ctx.createBiquadFilter();
    body.type = "lowpass";
    body.frequency.value = 760;

    // And the third layer: rain hitting things rather than falling through air.
    //
    // A shower on open ground is mostly hiss. Get under a spruce and the sound
    // changes completely - the hiss drops away, because none of it is reaching
    // you any more, and what is left is heavier and slower and coming from
    // directly overhead: thousands of drops breaking on needles and running off
    // them. A midrange band with a bit of Q on it is that sound, and swapping it
    // against the patter as you walk under cover is the only way the ear is ever
    // told you have found shelter.
    const canopy = ctx.createBiquadFilter();
    canopy.type = "bandpass";
    canopy.frequency.value = 900;
    canopy.Q.value = 0.8;

    const patterGain = ctx.createGain();
    const bodyGain = ctx.createGain();
    const canopyGain = ctx.createGain();
    patterGain.gain.value = 0;
    bodyGain.gain.value = 0;
    canopyGain.gain.value = 0;

    const bed = ctx.createGain();
    bed.gain.value = 1;

    src.connect(patter).connect(patterGain).connect(bed);
    src.connect(body).connect(bodyGain).connect(bed);
    src.connect(canopy).connect(canopyGain).connect(bed);
    bed.connect(this.nodes.master);
    src.start();

    this.nodes.rain = { bed, patter, body, canopy, patterGain, bodyGain, canopyGain };
    this.shelter = 0;
    // How hard it is coming down right now, and the squall riding on top of it.
    this.rainLevel = 0;
    this.squall = 0;
    this.squallLeft = 14 + Math.random() * 26;
    this.squallFor = 0;
  }

  /**
   * Drive the rain from the sky, once a frame.
   *
   * `amount` is the sky's own rainfall, 0 to 1, and everything here follows it -
   * which is the whole contract: when the rain thins out on screen it thins out
   * in the ears, and when it stops the sound has already been on its way down
   * for several seconds. There is no separate audio state that can be left
   * playing over a clear sky.
   *
   * On top of that it gusts. Real rain is not a constant: it comes on harder
   * for twenty or thirty seconds and eases off again, and a bed that never
   * changes stops being heard within a minute. The squall is a slow envelope
   * that occasionally rises and always comes back down, and it is scaled BY the
   * rainfall rather than added to it, so a squall can never outlive the shower
   * it belongs to.
   */
  rain(dt, amount, cover = 0) {
    if (!this.ready || !this.nodes.rain) return;
    // muffle() has already taken these to zero and would only be fought here.
    // The shelter and squall state still runs, so stepping back into a round
    // under a tree in a downpour sounds like the tree you are under.
    if (this.muffled) { amount = 0; }
    const t = this.ctx.currentTime;
    // Eased, so walking under a tree is a second of the sound changing round
    // you rather than a switch. Slightly slower coming out than going in, which
    // is what stepping back into the open actually sounds like.
    const cov = Math.max(0, Math.min(1, cover));
    this.shelter += (cov - this.shelter) * Math.min(1, dt * (cov > this.shelter ? 2.2 : 1.4));

    // Gusts, but only while there is rain for them to happen to.
    if (amount > 0.2) {
      this.squallLeft -= dt;
      if (this.squallFor > 0) {
        this.squallFor -= dt;
        if (this.squallFor <= 0) this.squallLeft = 20 + Math.random() * 40;
      } else if (this.squallLeft <= 0) {
        this.squallFor = 8 + Math.random() * 14;
      }
    } else {
      this.squallFor = 0;
    }
    const want = this.squallFor > 0 ? 1 : 0;
    // Up over about four seconds, down over about eight: weather arrives faster
    // than it leaves.
    this.squall += (want - this.squall) * Math.min(1, dt / (want ? 4 : 8));

    const wet = Math.max(0, Math.min(1, amount)) * (1 + this.squall * 0.45);
    this.rainLevel += (wet - this.rainLevel) * Math.min(1, dt * 0.9);
    const r = this.rainLevel;
    if (r < 0.002 && this.nodes.rain.patterGain.gain.value < 0.0005
        && this.nodes.rain.canopyGain.gain.value < 0.0005) return;

    // The patter is most of a shower; the roar only really arrives in a
    // downpour, which is why it is squared. Under cover the patter is what goes
    // - it is the sound of rain reaching you - and the canopy layer comes up in
    // its place, so the total barely changes while the character of it changes
    // completely.
    const sh = this.shelter;
    const open = 1 - sh * 0.8;
    this.nodes.rain.patterGain.gain.setTargetAtTime(r * 0.058 * open, t, 0.35);
    this.nodes.rain.bodyGain.gain.setTargetAtTime(r * r * 0.065 * (1 - sh * 0.35), t, 0.5);
    this.nodes.rain.canopyGain.gain.setTargetAtTime(r * 0.075 * sh, t, 0.4);
    // And it gets brighter as it gets heavier - harder drops, closer to you.
    this.nodes.rain.patter.frequency.setTargetAtTime(1500 + r * 900, t, 0.6);
    this.nodes.rain.body.frequency.setTargetAtTime(620 + r * 420, t, 0.6);
    // Heavier rain on a canopy is a lower, fuller roll off the branches.
    this.nodes.rain.canopy.frequency.setTargetAtTime(980 - r * 220, t, 0.6);
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
  pickup(at = null) {
    // Silent behind a pause screen - see muffle. Somebody else's footstep is
    // not a warning, and the whole point is that only warnings get through.
    if (this.muffled) return;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const to = this.#place(at, 0.6);
    for (const [i, f] of [880, 1320].entries()) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.22, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.32);
      osc.connect(g).connect(to);
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
  #scuff(when, { peak = 0.1, dur = 0.09, hz = 1600, q = 0.7, target = null } = {}) {
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
    src.connect(f).connect(g).connect(target ?? this.nodes.master);
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
  step(power = 0.5, at = null) {
    // Silent behind a pause screen - see muffle. Somebody else's footstep is
    // not a warning, and the whole point is that only warnings get through.
    if (this.muffled) return;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const p = Math.max(0, Math.min(1, power));
    const to = this.#place(at, 0.4);
    this.#thump(t, 96 + p * 26, 0.07 + p * 0.05, 0.045 + p * 0.165, to);
    this.#scuff(t, { peak: 0.03 + p * 0.09, dur: 0.05 + p * 0.06,
                     hz: 1500 + p * 900, target: to });
  }

  /**
   * The push-off.
   *
   * A step, not a grunt - it is a foot leaving the ground, and the character
   * makes no other vocal sound in the game, so one here would be a voice
   * arriving from nowhere. Pitched above a walking step and shorter, so a jump
   * and its landing read as two ends of one movement.
   *
   * The quieter end of it. A foot pushing off is a scuff; the arrival is the
   * event. The three loud things you can do are now in the same order to the ear
   * as they are to the monster - 0.13 here, 0.21 for a sprinting step, 0.32 for
   * the landing, against hearing radii of 14, 21.6 and 34 m.
   */
  jumpStep(at = null) {
    // Silent behind a pause screen - see muffle. Somebody else's footstep is
    // not a warning, and the whole point is that only warnings get through.
    if (this.muffled) return;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const to = this.#place(at, 0.5);
    this.#thump(t, 142, 0.09, 0.13, to);
    this.#scuff(t, { peak: 0.07, dur: 0.11, hz: 2100, target: to });
  }

  /**
   * Catching a foot.
   *
   * Two scuffs and a thump, in that order: the drag comes before the weight
   * lands on it. Deliberately not the landing sound - a landing is one clean
   * event and this is a mess, so the parts are the same and the timing is not,
   * which is how you tell them apart without being told.
   *
   * And bigger than the landing, at 0.40 against 0.32, because it is bigger to
   * everything hunting you too: 40 m of hearing radius against 34. It is the
   * loudest thing in the game and the only one you did not press a key for.
   */
  stumble(at = null) {
    // Silent behind a pause screen - see muffle. Somebody else's footstep is
    // not a warning, and the whole point is that only warnings get through.
    if (this.muffled) return;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const to = this.#place(at, 0.8);
    this.#scuff(t, { peak: 0.22, dur: 0.20, hz: 820, q: 0.5, target: to });
    this.#scuff(t + 0.075, { peak: 0.15, dur: 0.13, hz: 1500, target: to });
    this.#thump(t + 0.11, 84, 0.17, 0.40, to);
  }

  /** The loudest one-shot in the game, and the bill for the hop. */
  land(at = null) {
    // Silent behind a pause screen - see muffle. Somebody else's footstep is
    // not a warning, and the whole point is that only warnings get through.
    if (this.muffled) return;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const to = this.#place(at, 0.6);
    this.#thump(t, 118, 0.16, 0.32, to);
    this.#scuff(t, { peak: 0.17, dur: 0.15, hz: 1300, target: to });
  }

  /**
   * The monster's feet, from wherever it is standing.
   *
   * Heavier and duller than yours - lower, longer, with the scuff pushed down
   * where dead grass is rather than up where gravel is - and a quarter louder
   * than the same speed would be under you, because being able to count its
   * pace through the trees is the entire reason it makes a sound at all. The
   * distance falloff does the rest; nothing has to tell you it is close.
   *
   * @param power 0 at a prowl, 1 at a full chase.
   */
  monsterStep(power = 0.5, at = null) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const p = Math.max(0, Math.min(1, power));
    const to = this.#place(at, 0.5);
    this.#thump(t, 74 + p * 20, 0.10 + p * 0.06, (0.055 + p * 0.205) * 1.25, to);
    this.#scuff(t, { peak: (0.035 + p * 0.10) * 1.25, dur: 0.07 + p * 0.07,
                     hz: 900 + p * 500, q: 0.5, target: to });
  }

  /**
   * The noise a person makes on seeing that thing for the first time.
   *
   * Not a scream and not a word - a body doing something it did not ask to do.
   * A short breathy parp with the pitch falling out of it, which is funny for
   * about as long as it takes to remember what caused it. That is the joke the
   * whole game is built on.
   *
   * Once per player per round, so it marks the moment rather than becoming a
   * noise the monster is accompanied by. Other people hear yours from where you
   * are standing, which is usually the first they know you have seen it.
   */
  fright(at = null) {
    // A team-mate's gasp is the party, not the thing - see muffle.
    if (this.muffled) return;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const to = this.#place(at, 0.7);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(196, t);
    osc.frequency.exponentialRampToValueAtTime(88, t + 0.34);
    // A wobble on top so it flutters rather than sliding cleanly, which is the
    // difference between a raspberry and a sad kazoo.
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.value = 24;
    lfoGain.gain.value = 22;
    lfo.connect(lfoGain).connect(osc.frequency);
    f.type = "lowpass";
    f.frequency.value = 900;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    osc.connect(f).connect(g).connect(to);
    osc.start(t); lfo.start(t);
    osc.stop(t + 0.4); lfo.stop(t + 0.4);
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
  torchClick(kind = "handheld", at = null) {
    // Silent behind a pause screen - see muffle. Somebody else's footstep is
    // not a warning, and the whole point is that only warnings get through.
    if (this.muffled) return;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const to = this.#place(at, 0.4);
    if (kind === "searchlight") {
      this.#scuff(t, { peak: 0.30, dur: 0.035, hz: 900, q: 1.4, target: to });
      this.#thump(t, 190, 0.05, 0.13, to);
      this.#scuff(t + 0.05, { peak: 0.17, dur: 0.03, hz: 620, q: 1.6, target: to });
    } else {
      this.#scuff(t, { peak: 0.22, dur: 0.02, hz: 3200, q: 1.1, target: to });
      this.#scuff(t + 0.02, { peak: 0.10, dur: 0.02, hz: 2300, q: 1.3, target: to });
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
      // Held while it fades, so that a screen coming straight back can cut it
      // rather than start a second copy over the top of it - see below.
      this.fading = live;
      const t = this.ctx.currentTime;
      live.gain.gain.cancelScheduledValues(t);
      live.gain.gain.setValueAtTime(live.gain.gain.value, t);
      live.gain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
      try { live.src.stop(t + 0.7); } catch { /* already stopped */ }
      setTimeout(() => { if (this.fading === live) this.fading = null; }, 750);
      return;
    }
    if (this.musicName === name) return;
    this.musicName = name;
    // Whatever was on the way out goes now rather than over the next six
    // hundred milliseconds. Pausing, resuming and pausing again inside that
    // window used to leave two copies of the theme running against each other,
    // slightly out of step, which is the worst possible way for a loop to be
    // wrong - it sounds like the file is broken rather than the code.
    if (this.fading) {
      try { this.fading.src.stop(); } catch { /* already stopped */ }
      this.fading = null;
    }
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
