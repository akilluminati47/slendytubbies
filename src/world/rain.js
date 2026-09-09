import * as THREE from "three";

/**
 * Rain.
 *
 * A fixed box of streaks that scrolls under the camera as you move, which is
 * the only sensible way to do weather in an open world: rain is everywhere, so
 * there is nothing to be gained by simulating the half of the map you cannot
 * see. The box is small enough that every drop in it is close enough to read as
 * a drop rather than as noise.
 *
 * Each drop is stored as a single random point in world space. The vertex
 * shader folds that point into the box around the eye — the same modulo-vs-eye
 * trick the splashes use — so the streaks scroll past you when you run: a drop
 * a metre from your face goes by in a rush, a distant one crawls, instead of
 * the whole shower being dragged along on a leash behind the camera.
 *
 * Nothing moves on the CPU. Each drop knows where it started and the vertex
 * shader works out where it has fallen to from the clock, so a downpour costs
 * one uniform write a frame rather than four thousand position updates. The
 * fall wraps with a modulo, so drops leave the bottom of the box and reappear
 * at the top for as long as it rains.
 */

const DROPS = 2200;
/**
 * The box, and why it is this tall.
 *
 * It was 18 m, which put a hard ceiling nine metres over your head: look up in
 * a downpour and the rain stopped at a flat lid with clear sky above it, and a
 * lid does not move, so the whole shower read as a static slab of streaks
 * hanging there rather than as weather falling out of a cloud. Thirty metres
 * puts the ceiling far enough up to be past the tree line, and the top third
 * fades out (see the shader) so there is no edge to find at all - drops appear
 * out of nothing high up and are at full strength by the time they matter.
 */
const BOX = new THREE.Vector3(26, 30, 26);   // metres, centred on the camera
const LEN = 0.42;                            // how long a streak is drawn

/**
 * How many splashes are alive at once, and how big each one is.
 *
 * Rain that stops existing a metre above the floor is the thing everybody
 * notices and nobody can name. A drop has to land, and where it lands is what
 * tells you what you are standing under: bare ground, and the floor is boiling;
 * under a spruce, and the floor is dry and it is the canopy over your head that
 * is being hit instead.
 */
const SPLASHES = 1800;
const TICK = 0.13;                           // metres a splash kicks back up
/**
 * The splashes get their own, much smaller box than the drops.
 *
 * A drop is legible thirteen metres away; the tick it makes on landing is not,
 * and spending particles out there buys nothing but a faint speckle at the edge
 * of the fog. Packed into seventeen metres instead, the same budget is six
 * splashes a square metre where you can actually see them, which is the
 * difference between a shower and a wet floor.
 */
const SPLASH_BOX = 17;

/** What the rain turns into for a spectator who gets unlucky. See setColor. */
const OMEN = new THREE.Color(0x8c1620);

/**
 * The canopies the shader is told about, at most.
 *
 * Only the ones inside the box can occlude anything in it, and the box is 26
 * metres across, so this is a generous ceiling on how many trees can be
 * standing in a square that size. Overflowing it drops the furthest, which are
 * the ones at the edge of the fade anyway.
 */
const CANOPIES = 14;

/**
 * The terrain, in GLSL, exactly as world.js has it in JS.
 *
 * Duplicated on purpose and it must stay in step: this is the only way for the
 * splash to know where the floor is without a readback per drop. It is three
 * sine waves - if the JS ever grows a fourth, this needs it too.
 */
const GROUND_GLSL = `
  float groundAt(vec2 p) {
    return sin(p.x * 0.031) * 1.6
         + cos(p.y * 0.027) * 1.4
         + sin((p.x + p.y) * 0.013) * 2.2;
  }`;

/**
 * Whatever is over this point, and how far up it is - the canopy test both the
 * drops and the splashes run.
 *
 * Returns the height of the lowest thing above the point, or a long way below
 * the world if there is nothing. Discs, not geometry: a spruce crown is a cone
 * and testing against the cone would put rain through the gap between the
 * whorls, which is not how standing under a tree works.
 */
const COVER_GLSL = `
  uniform vec4 uCanopy[${CANOPIES}];   // xz centre, radius, underside height
  uniform int uCanopies;

  float coverAt(vec2 p) {
    float top = -1000.0;
    for (int i = 0; i < ${CANOPIES}; i++) {
      if (i >= uCanopies) break;
      vec4 c = uCanopy[i];
      if (c.z <= 0.0) continue;
      float d = length(p - c.xy);
      if (d < c.z) top = max(top, c.w);
    }
    return top;
  }`;

export class Rain {
  constructor(scene) {
    const pos = new Float32Array(DROPS * 2 * 3);
    const tip = new Float32Array(DROPS * 2);
    const life = new Float32Array(DROPS * 2);

    for (let i = 0; i < DROPS; i++) {
      // A random point in ONE cell of world space. The shader folds this cell
      // onto the box around the eye every frame, so as the eye moves the drops
      // that happen to be ahead of you stay ahead and the ones behind you stay
      // behind — the shower is steady in the world and you walk through it.
      const x = (Math.random() - 0.5) * BOX.x;
      const y = (Math.random() - 0.5) * BOX.y;
      const z = (Math.random() - 0.5) * BOX.z;
      // Two vertices per drop: the head, and the tail it is smeared into.
      for (let v = 0; v < 2; v++) {
        const k = (i * 2 + v) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
        tip[i * 2 + v] = v;
        // Staggered speeds. Rain falling at one rate reads as a curtain being
        // dragged past you rather than as weather.
        life[i * 2 + v] = 0.75 + Math.random() * 0.5;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aTip", new THREE.BufferAttribute(tip, 1));
    geo.setAttribute("aRate", new THREE.BufferAttribute(life, 1));
    // The box moves with the camera, so there is no meaningful bounding volume
    // to cull against and three would throw the whole thing away on a glance.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.uniforms = {
      uTime: { value: 0 },
      uFall: { value: 17 },                       // metres per second
      uWind: { value: new THREE.Vector2(1.6, 0.5) },
      uAmount: { value: 0 },                      // 0..1, how hard it is coming
      uColor: { value: new THREE.Color(0x9fb2c6) },
      // How bright the streak is drawn. Daylight rain is a visible thing you
      // look through; at night it is a suggestion picked out by whatever light
      // is falling on it, and drawing it at noon strength after dark turns the
      // whole screen into television static. See setLight.
      uLit: { value: 1 },
      uEye: { value: new THREE.Vector3() },
      uCanopy: { value: Array.from({ length: CANOPIES }, () => new THREE.Vector4()) },
      uCanopies: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      // No fog. It is handled here instead, as a fade out of the box, because
      // scene fog would erase the far drops and leave a hard-edged column of
      // rain following the player about.
      fog: false,
      vertexShader: `
        attribute float aTip;
        attribute float aRate;
        uniform float uTime, uFall, uAmount, uLit;
        uniform vec2 uWind;
        uniform vec3 uEye;
        varying float vFade;
        ${COVER_GLSL}

        void main() {
          // The drop lives at a fixed point in the world, stored as one cell of
          // it. Fold that point into the box around the eye, exactly like the
          // splashes fold their x/z. This is the whole trick: the eye moves,
          // the fold moves with it, so a drop that is ahead of you stays ahead
          // of you and a drop behind you stays behind - the shower is steady
          // and you walk through it, with a drop a metre from your face rushing
          // past while a distant one crawls.
          vec3 p = position;
          p.x = mod( p.x - uEye.x + ${(BOX.x / 2).toFixed(1)}, ${BOX.x.toFixed(1)} ) - ${(BOX.x / 2).toFixed(1)};
          p.z = mod( p.z - uEye.z + ${(BOX.z / 2).toFixed(1)}, ${BOX.z.toFixed(1)} ) - ${(BOX.z / 2).toFixed(1)};
          p.y = mod( p.y - uEye.y + ${(BOX.y / 2).toFixed(1)}, ${BOX.y.toFixed(1)} ) - ${(BOX.y / 2).toFixed(1)};
          // Wrapped, so a drop leaving the bottom is the same drop arriving at
          // the top. The box is ${BOX.y} m tall and centred on the eye.
          float fall = uTime * uFall * aRate;
          p.y = mod( p.y - fall, ${BOX.y.toFixed(1)} ) - ${(BOX.y / 2).toFixed(1)};
          // Slanted by the wind, by how far it has already fallen.
          //
          // This is what makes it read as being blown rather than dropped, so
          // it is worth more than the token amount it used to get: a drop that
          // has fallen the height of the box is now carried a couple of metres
          // sideways, and because the wind turns and gusts (see update) the
          // whole shower leans and straightens as you watch it.
          p.xz += uWind * ( ${(BOX.y / 2).toFixed(1)} - p.y ) * 0.11;
          // Wrap the slant back into the box too, or the whole shower drifts
          // out of it and the near air goes empty.
          p.x = mod( p.x + ${(BOX.x / 2).toFixed(1)}, ${BOX.x.toFixed(1)} ) - ${(BOX.x / 2).toFixed(1)};
          p.z = mod( p.z + ${(BOX.z / 2).toFixed(1)}, ${BOX.z.toFixed(1)} ) - ${(BOX.z / 2).toFixed(1)};
          // The tail sits above the head, along the direction of travel.
          p.y += aTip * ${LEN.toFixed(2)};
          p.xz -= uWind * aTip * ${(LEN * 0.06).toFixed(4)};

          // Faded at the walls of the box, so it has no edges.
          float r = length( p.xz );
          vFade = ( 1.0 - smoothstep( ${(BOX.x * 0.22).toFixed(1)}, ${(BOX.x * 0.5).toFixed(1)}, r ) )
                  * uAmount * uLit;

          // And faded out of the ceiling, which is the whole reason the box is
          // thirty metres tall. Look up: the top of the shower has to dissolve
          // into the cloud it is coming out of, or you find the lid and the rain
          // stops being weather and becomes a texture hanging over your head.
          float lid = ( p.y + ${(BOX.y / 2).toFixed(1)} ) / ${BOX.y.toFixed(1)};
          vFade *= 1.0 - smoothstep( 0.55, 0.98, lid );

          // And stopped by whatever is over it.
          //
          // Everything here is measured from the eye, canopies included, so this
          // is one comparison: a drop below the underside of the tree it is
          // falling through never existed. Standing under a spruce in a downpour
          // you are in a dry cylinder with the rain coming down all round it,
          // which is the entire point of standing under a spruce.
          float roof = coverAt( p.xz );
          if ( p.y < roof ) vFade = 0.0;

          gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          if ( vFade <= 0.001 ) discard;
          gl_FragColor = vec4( uColor, vFade * 0.42 );
        }`,
    });

    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.#buildSplashes(scene);
  }

  /**
   * Where the rain arrives.
   *
   * Same trick as the drops and the same box: a fixed set of ticks that travels
   * with the camera, each one popping on its own cycle at whatever surface is
   * under it. The surface is the whole feature - the terrain if there is sky
   * overhead, and the canopy if there is not, so a stand of spruce reads as a
   * roof being rained on with dry ground beneath it rather than as rain politely
   * disappearing. Nothing is simulated: a splash is a phase, a place, and the
   * height of the first thing above the floor there.
   */
  #buildSplashes(scene) {
    // Four vertices a splash: two segments from one point on the ground,
    // splaying apart. A drop that hits does not go one way - it breaks, and
    // what you see is the two halves of it thrown out either side. One segment
    // per splash was a slash, and eighteen hundred slashes all leaning off at
    // their own angle read as debris rather than as water.
    const VERTS = 4;
    const pos = new Float32Array(SPLASHES * VERTS * 3);
    const tip = new Float32Array(SPLASHES * VERTS);
    const side = new Float32Array(SPLASHES * VERTS);
    const seed = new Float32Array(SPLASHES * VERTS * 3);

    for (let i = 0; i < SPLASHES; i++) {
      const x = (Math.random() - 0.5) * SPLASH_BOX;
      const z = (Math.random() - 0.5) * SPLASH_BOX;
      // Phase, lean and rate: three numbers that stop eighteen hundred identical
      // ticks landing on the same beat in the same shape. `lean` is now which
      // way the V opens rather than which way a single tick falls.
      const phase = Math.random();
      const lean = Math.random() * Math.PI * 2;
      const rate = 1.6 + Math.random() * 1.4;
      for (let v = 0; v < VERTS; v++) {
        const k = (i * VERTS + v) * 3;
        pos[k] = x; pos[k + 1] = 0; pos[k + 2] = z;
        seed[k] = phase; seed[k + 1] = lean; seed[k + 2] = rate;
        // (base, tip) twice: one arm each way.
        tip[i * VERTS + v] = v % 2;
        side[i * VERTS + v] = v < 2 ? -1 : 1;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aTip", new THREE.BufferAttribute(tip, 1));
    geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
      vertexShader: `
        attribute float aTip;
        attribute float aSide;
        attribute vec3 aSeed;
        uniform float uTime, uAmount, uLit;
        uniform vec3 uEye;
        varying float vFade;
        ${GROUND_GLSL}
        ${COVER_GLSL}

        void main() {
          // Wrapped onto the camera exactly like the drops, so the ground you
          // are walking over is always the ground being rained on.
          vec3 p = position;
          p.x = mod( p.x - uEye.x + ${(SPLASH_BOX / 2).toFixed(1)}, ${SPLASH_BOX.toFixed(1)} ) - ${(SPLASH_BOX / 2).toFixed(1)};
          p.z = mod( p.z - uEye.z + ${(SPLASH_BOX / 2).toFixed(1)}, ${SPLASH_BOX.toFixed(1)} ) - ${(SPLASH_BOX / 2).toFixed(1)};

          // The floor here, and then whatever is above it. All relative to the
          // eye, the same frame the drops fall in.
          vec2 world = uEye.xz + p.xz;
          float surface = groundAt( world ) - uEye.y;
          float roof = coverAt( p.xz );
          // A canopy catches it instead - and a hair below the underside, so
          // the tick sits ON the branches rather than hanging under them.
          if ( roof > surface ) surface = roof - 0.06;

          // One pop per cycle, and most of the cycle is nothing: a splash is
          // brief and the gap between them is what makes it read as a rate.
          float age = fract( uTime * aSeed.z + aSeed.x );
          float life = smoothstep( 0.0, 0.06, age ) * ( 1.0 - smoothstep( 0.06, 0.34, age ) );

          // The kick: two arms out of one point, opening away from each other.
          // The arms are shorter than they are wide, so it reads as a splash
          // opening out rather than as a pair of antennae.
          float up = ${TICK.toFixed(2)} * ( 0.5 + aSeed.z * 0.35 ) * aTip * life;
          p.y = surface + up;
          vec2 open = vec2( cos( aSeed.y ), sin( aSeed.y ) ) * aSide;
          p.xz += open * aTip * life * ${(TICK * 0.85).toFixed(3)};

          float r = length( p.xz );
          vFade = ( 1.0 - smoothstep( ${(SPLASH_BOX * 0.30).toFixed(1)}, ${(SPLASH_BOX * 0.5).toFixed(1)}, r ) )
                  * uAmount * uAmount * uLit * life;

          gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          if ( vFade <= 0.002 ) discard;
          // Brighter than the falling streak: a splash catches light from every
          // direction at once and it is the part the eye actually reads.
          gl_FragColor = vec4( uColor, vFade * 0.55 );
        }`,
    });

    // Scratch for #gatherCanopy: how far outside each kept canopy's drip line
    // the camera is, so the furthest can be found and replaced without sorting.
    this.near = new Float32Array(CANOPIES);

    this.splash = new THREE.LineSegments(geo, mat);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 4;
    this.splash.visible = false;
    scene.add(this.splash);
  }

  /**
   * @param eye    where the camera is; the box is hung on it
   * @param amount 0..1, how hard it is raining
   */
  update(dt, eye, amount, canopy = null) {
    this.uniforms.uAmount.value = amount;
    this.#blow(dt, amount);
    // Eased here rather than in setColor, which is called before this and has
    // no idea how much time has gone by.
    this.omenNow = (this.omenNow ?? 0)
      + ((this.omen ?? 0) - (this.omenNow ?? 0)) * Math.min(1, dt * 0.35);
    // Skipped entirely when it is dry. A shower nobody can see is still two and
    // a half thousand transparent primitives being sorted and drawn - and now
    // eleven hundred more of them landing.
    const on = amount > 0.01;
    this.mesh.visible = on;
    this.splash.visible = on;
    if (!on) { this.cover = 0; return; }
    this.uniforms.uTime.value += dt;
    if (eye) {
      this.mesh.position.copy(eye);
      this.splash.position.copy(eye);
      this.uniforms.uEye.value.copy(eye);
      this.#gatherCanopy(eye, canopy);
    }
  }

  /**
   * The wind, turning and gusting.
   *
   * It was a constant - one direction, one strength, for the whole game - and
   * a constant slant is the thing that makes a shower look like a wallpaper of
   * diagonal lines rather than like rain. Two slow sines out of phase turn it
   * through most of a circle over a couple of minutes, and the gust rides on
   * top: heavier rain is pushed harder, so a downpour visibly drives across you
   * and eases off again while it does.
   *
   * Nothing here is random. Two sines against the clock give a wind that always
   * changes and never jumps, which is the only quality that matters when the
   * thing being driven is four thousand streaks that must all agree.
   */
  #blow(dt, amount) {
    this.blown = (this.blown ?? 0) + dt;
    const t = this.blown;
    const turn = Math.sin(t * 0.041) * 1.7 + Math.sin(t * 0.0173 + 2.1) * 1.1;
    // 0.55 in a drizzle, up towards 2.2 in a driven downpour, breathing on its
    // own slow cycle so it is never at one strength for long.
    const push = (0.55 + amount * 1.15) * (1 + Math.sin(t * 0.083 + 0.7) * 0.42);
    this.uniforms.uWind.value.set(Math.cos(turn) * push, Math.sin(turn) * push);
  }

  /**
   * Which canopies are close enough to matter, in the eye's own frame.
   *
   * Rebuilt every frame from whatever the world hands over, because it is
   * fourteen slots and a linear scan of a few hundred trees - cheaper than any
   * structure that would avoid it, and it cannot go stale. Everything is stored
   * RELATIVE to the eye so both shaders can compare against a drop's own
   * position without a second frame of reference.
   */
  #gatherCanopy(eye, canopy) {
    const slots = this.uniforms.uCanopy.value;
    const near = this.near;
    let n = 0;
    this.cover = 0;
    if (canopy) {
      const reach = BOX.x * 0.5;
      for (const c of canopy) {
        const dx = c.x - eye.x, dz = c.z - eye.z;
        if (Math.abs(dx) > reach + c.r || Math.abs(dz) > reach + c.r) continue;
        // How much of a roof YOU are under, for the sound of it - see World.
        // Nearest-edge rather than centre, so standing just inside the drip line
        // already counts as sheltered.
        const d = Math.hypot(dx, dz);
        if (d < c.r) this.cover = Math.max(this.cover, 1 - (d / c.r) * 0.45);

        // Keep the closest fourteen, not the first fourteen.
        //
        // In a stand of spruce there are routinely more than fourteen crowns
        // inside the box, and taking them in list order meant a tree forty
        // metres of forest away could hold the slot that belonged to the one
        // directly over your head - so the ground under you got rained on while
        // something at the edge of the fog was sheltering nothing. Fourteen is
        // small enough that a linear insert beats sorting, every frame.
        const edge = d - c.r;                  // how far outside its drip line
        if (n < CANOPIES) {
          near[n] = edge;
          slots[n].set(dx, dz, c.r, c.y - eye.y);
          n++;
        } else {
          let worst = 0;
          for (let i = 1; i < CANOPIES; i++) if (near[i] > near[worst]) worst = i;
          if (edge < near[worst]) {
            near[worst] = edge;
            slots[worst].set(dx, dz, c.r, c.y - eye.y);
          }
        }
      }
    }
    this.uniforms.uCanopies.value = n;
  }

  /**
   * The colour of the light it is falling through - and, very occasionally,
   * something else.
   *
   * `omen` is an easter egg and it has exactly one rule: the living never see
   * it. Rain runs red for a spectator now and then, one round in twenty-five,
   * and there is nobody left alive to tell about it. Anyone you describe it to
   * is watching clear rain, which is the entire joke. It eases in over a few
   * seconds rather than switching, so it reads as something you noticed rather
   * than as a bug you caught.
   */
  setColor(c) {
    const u = this.uniforms.uColor.value;
    u.copy(c);
    this.omenNow = (this.omenNow ?? 0);
    if (this.omenNow > 0.002) u.lerp(OMEN, this.omenNow);
  }

  /** Roll the egg, or put it away. Called when a round starts and when you die. */
  setOmen(on) { this.omen = on ? 1 : 0; }

  /**
   * How brightly to draw it, from how much light there is to draw it in.
   *
   * A streak of rain is not a thing that emits - it is a short length of water
   * with the sky in it, so at noon it is a pale hard line and at midnight it is
   * barely there at all. Drawn at one strength around the clock it was a wash of
   * white grit over a night scene, brighter than the trees behind it.
   *
   * @param day 0 at the dead of night, 1 in full daylight
   */
  setLight(day) {
    // Never quite nothing: a torch beam swept through rain has to catch
    // something, and the floor of this is what it catches.
    this.uniforms.uLit.value = 0.34 + 0.66 * Math.max(0, Math.min(1, day));
  }

  dispose(scene) {
    for (const m of [this.mesh, this.splash]) {
      if (!m) continue;
      scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}
