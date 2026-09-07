import * as THREE from "three";
import { CFG } from "../game/config.js";
import { MIST, MIST_COLOR } from "./groundFog.js";

/**
 * A night that moves.
 *
 * A round is a single pass through a compressed day: forty-eight minutes for
 * twenty-four hours, so an in-game hour is two real ones. It always starts in
 * the evening - somewhere between six and two - because the game is about being
 * outside in the dark, and starting at noon would give away an hour of it.
 *
 * The dome is one sphere seen from the inside with everything drawn in its
 * fragment shader: gradient, stars, sun, moon. That is far cheaper than a
 * cubemap per weather state and it can be driven continuously, which is the
 * whole point - the light has to slide rather than switch.
 *
 */

const DAY_MINUTES = 48;                     // real minutes for a full day
const DAY_SECONDS = DAY_MINUTES * 60;
const HOUR = DAY_SECONDS / 24;              // 120s of real time per hour

/** Sunrise and sunset, in hours. Deliberately a long night. */
const DAWN = 6.4;
const DUSK = 19.1;

const WEATHERS = ["clear", "hazy", "overcast", "rain"];

// Scratch. update() runs every frame and these were three allocations a frame
// for numbers that are overwritten immediately.
const _mist = new THREE.Color();
const _mistNight = new THREE.Color(0x2e3644);
const _mistDay = new THREE.Color(0xd6dfe8);
const _zen = new THREE.Color();
const _hor = new THREE.Color();
const _tmp = new THREE.Color();
// Zenith and horizon at midnight and at noon. The old noon zenith was 0x2b4a74,
// which is the colour of a clear sky about forty minutes after sunset - the
// game starts in the evening and the daytime end of the ramp had never been
// looked at, so noon came out as a slightly hopeful dusk.
const NIGHT_ZENITH = new THREE.Color(0x05070f);
// Pitched high on purpose. The dome is drawn straight, with no lighting, and
// then run through ACES, which pulls the top end down hard - a swatch picked to
// look like daylight in a colour picker comes out of the tone mapper as late
// afternoon in a thunderstorm.
const NOON_ZENITH = new THREE.Color(0x74b3ee);
const NIGHT_HORIZON = new THREE.Color(0x131a26);
const NOON_HORIZON = new THREE.Color(0xe4eef7);
const DUSK_HORIZON = new THREE.Color(0xc4713a);
const CLOUD_LIT_DAY = new THREE.Color(0xffffff);
const CLOUD_LIT_NIGHT = new THREE.Color(0x2b3243);
const CLOUD_DARK_DAY = new THREE.Color(0xa8b6c6);
const CLOUD_DARK_NIGHT = new THREE.Color(0x171c2a);

export class Sky {
  /**
   * @param scene  the world to light
   * @param rand   the world's own seeded generator, so a lobby sharing a seed
   *               shares its weather and its start time as well as its terrain
   */
  constructor(scene, rand = Math.random) {
    this.scene = scene;
    this.rand = rand;

    // Somewhere between 18:00 and 02:00.
    this.hour = 18 + rand() * 8;
    this.weather = "clear";
    this.weatherLeft = 40 + rand() * 90;
    this.wet = 0;                     // 0..1, eased, so weather arrives slowly
    this.rainfall = 0;                // 0..1, and only while it is actually raining
    this.elapsed = 0;                 // seconds since the round began, for drift

    // Enough segments that the interpolated direction is smooth. At 32x20 the
    // triangles are wide enough that everything derived from that direction -
    // gradient, glow, star cells - banded visibly along their edges.
    const geo = new THREE.SphereGeometry(1, 96, 64);
    this.uniforms = {
      uZenith: { value: new THREE.Color(0x05070f) },
      uHorizon: { value: new THREE.Color(0x131a26) },
      uSunDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunColor: { value: new THREE.Color(0xffd9a0) },
      uStars: { value: 1 },
      uHaze: { value: 0 },
      uFog: { value: new THREE.Color(0x0a0c0a) },
      uTime: { value: 0 },
      // x how much of the sky is covered, y how dark the undersides are,
      // z how high the sun is - clouds are lit from the same place everything
      // else is.
      uCloud: { value: new THREE.Vector3(0.35, 0.4, 0) },
      uCloudLit: { value: new THREE.Color(0xffffff) },
      uCloudDark: { value: new THREE.Color(0x59606b) },
    };
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          // Sits on the far plane whatever the camera does.
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 uZenith, uHorizon, uSunDir, uSunColor;
        uniform float uStars, uHaze, uTime;
        uniform vec3 uFog, uCloud, uCloudLit, uCloudDark;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }
        // A hash that survives large inputs. The sin() one above starts
        // repeating itself once its argument runs into the thousands, which is
        // exactly where star cells live, and the sky came out empty.
        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        // Value noise and four octaves of it. Clouds are the one thing up there
        // with any structure, and structure is what a single octave cannot do -
        // one gives you a lava lamp, four gives you weather.
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i), b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0)), e = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, amp = 0.5;
          for (int i = 0; i < 4; i++) {
            v += vnoise(p) * amp;
            p = p * 2.03 + 17.3;
            amp *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 d = normalize(vDir);
          float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(up, 0.85));

          // Stars, thinned out by daylight and by cloud.
          //
          // Cells taken off the direction itself, not off d.xz divided by d.y.
          // That division is a projection onto a plane and it tears itself apart
          // as it approaches the horizon, where d.y goes to zero: the field
          // stretched into long smeared streaks all round the edge of the sky.
          // Quantising the unit vector has no such pole.
          if (uStars > 0.01 && d.y > 0.0) {
            // One candidate per cell, drawn as a small round point at its own
            // place inside that cell. Lighting the whole cell instead - which is
            // what testing the hash alone does - gives square stars the size of
            // the grid, and at any useful density that is a field of confetti.
            const float N = 120.0;
            vec3 cell = floor(d * N);
            float h = hash31(cell);
            if (h > 0.982) {
              vec3 at = normalize(cell + vec3(hash31(cell + 1.0),
                                              hash31(cell + 2.0),
                                              hash31(cell + 3.0)));
              float r = length(at - d);
              float point = smoothstep(0.0035, 0.0, r);
              col += vec3(point) * uStars * smoothstep(0.02, 0.30, d.y)
                   * (0.5 + 0.5 * hash31(cell + 4.0));
            }
          }

          // The sun: a disc, and a great deal of glow around it near the horizon.
          float sd = dot(d, normalize(uSunDir));
          col += uSunColor * pow(max(sd, 0.0), 220.0) * 6.0;
          col += uSunColor * pow(max(sd, 0.0), 6.0) * 0.28;

          // --- cloud ----------------------------------------------------------
          // Projected onto a flat deck overhead. Dividing by d.y is a pole at
          // the horizon and it would smear the cloud into infinite streaks
          // there, so the divisor is floored and the whole layer is faded out
          // over the last fifteen degrees - which is also what really happens,
          // cloud running into haze rather than meeting the ground.
          if (d.y > 0.0 && uCloud.x > 0.01) {
            // Softened pole. Dividing by d.y alone is unbounded as the view
            // approaches the horizon, and it smeared the cloud into horizontal
            // streaks all round the edge of the sky - the same failure the star
            // field had. Adding a constant to the divisor caps the projection at
            // about three and a half, so features stay features right down to
            // the treeline and simply crowd together, which is what perspective
            // on a real cloud deck does anyway.
            vec2 deck = d.xz / (d.y + 0.28) * 1.7;
            vec2 drift = vec2(uTime * 0.0042, uTime * 0.0016);
            float f = fbm(deck * 0.42 + drift);
            // Coverage as a threshold on the noise: raising it grows the cloud
            // out of a clear sky instead of fading a grey sheet up over it.
            float edge = mix(0.72, 0.24, uCloud.x);
            float c = smoothstep(edge, edge + 0.22, f);
            // Second, finer layer for the ragged edges.
            c *= mix(1.0, 0.62 + 0.38 * smoothstep(0.28, 0.78, fbm(deck * 1.45 - drift * 2.1)),
                     1.0 - uCloud.x * 0.7);
            // Thicker cloud is darker underneath, and the whole layer dies into
            // the horizon.
            // Faded into the horizon haze, but only over the last few degrees.
            // At a quarter of the dome this was deleting most of the sky a
            // standing player ever looks at, so an overcast sky came out as a
            // few streaks near the zenith.
            c *= smoothstep(0.0, 0.10, d.y);
            vec3 cloudCol = mix(uCloudLit, uCloudDark, uCloud.y * smoothstep(0.35, 0.95, f));
            // Lit from wherever the sun is, so the tops catch it at dawn.
            cloudCol += uSunColor * pow(max(sd, 0.0), 3.0) * 0.35 * max(uCloud.z, 0.0);
            col = mix(col, cloudCol, c * 0.94);
          }

          col = mix(col, uHorizon, uHaze * (1.0 - up) * 0.8);

          // Everything below the skyline is fog and nothing else. The dome is a
          // sphere, so its lower half is behind the world anyway - drawing sky
          // detail down there only ever showed through as banding along the
          // treeline. Fade to the fog's own colour and let it be a gap.
          float below = smoothstep(0.16, -0.04, d.y);
          col = mix(col, uFog, below);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });

    this.dome = new THREE.Mesh(geo, this.material);
    // Just inside the camera's far plane, so the dome is always the furthest
    // thing drawn and never clipped.
    this.dome.scale.setScalar(360);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    scene.add(this.dome);
    scene.background = null;      // the dome is the sky; a clear colour would
                                  // only ever be drawn behind it

    this.hemi = new THREE.HemisphereLight(0x2e3a4e, 0x0d1109, 0.9);
    scene.add(this.hemi);
    // One light for both: it is the sun by day and the moon by night, which
    // saves a shader recompile every dusk.
    this.key = new THREE.DirectionalLight(0x9db4d4, 0.7);
    scene.add(this.key);

    this.update(0);
  }

  /** Is the sun above the horizon? Drives the gauge's glow. */
  get daylight() { return this.hour > DAWN && this.hour < DUSK; }

  /** 0 at the top of the hour, 1 at the end of it. */
  get hourFraction() { return this.hour % 1; }

  get clock() {
    const h = Math.floor(this.hour) % 24;
    const m = Math.floor((this.hour % 1) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  #rollWeather() {
    // Rain follows cloud rather than arriving out of a clear sky.
    const next = this.weather === "overcast"
      ? (this.rand() < 0.55 ? "rain" : "hazy")
      : this.weather === "rain"
        ? "overcast"
        : WEATHERS[Math.floor(this.rand() * 3)];
    this.weather = next;
    this.weatherLeft = 45 + this.rand() * 120;
  }

  update(dt) {
    this.hour = (this.hour + dt / HOUR) % 24;
    this.elapsed += dt;

    this.weatherLeft -= dt;
    if (this.weatherLeft <= 0) this.#rollWeather();
    const wetTarget = { clear: 0, hazy: 0.35, overcast: 0.7, rain: 1 }[this.weather];
    this.wet += (wetTarget - this.wet) * Math.min(1, dt * 0.25);
    // Separate from `wet`, which is really cloud: overcast is as grey as rain
    // and nothing falls out of it. This is the one that decides whether there
    // is water in the air, and it comes on faster than the cloud does because
    // rain starts rather than arrives.
    this.rainfall += ((this.weather === "rain" ? 1 : 0) - this.rainfall)
      * Math.min(1, dt * 0.6);

    // One body on one arc, up between six and eighteen.
    const sunAngle = (this.hour - 6) * Math.PI / 12;
    const arc = (a) => new THREE.Vector3(-Math.cos(a), Math.sin(a), 0.3).normalize();
    const sun = arc(sunAngle);
    this.uniforms.uSunDir.value.copy(sun);


    // How far up the sun is, which is what actually decides the light.
    const day = THREE.MathUtils.clamp(sun.y * 3.0 + 0.15, 0, 1);
    const dusk = THREE.MathUtils.clamp(1 - Math.abs(sun.y) * 6, 0, 1);
    const cloud = this.wet;

    // Cloud pulls the blue out of the sky rather than turning the lights off:
    // an overcast noon is bright, just colourless. Darkening it the way the old
    // multiplier did made every cloudy day read as an eclipse.
    const zen = _zen.copy(NIGHT_ZENITH).lerp(NOON_ZENITH, day)
      .lerp(_tmp.copy(CLOUD_DARK_DAY).multiplyScalar(0.1 + day * 0.9), cloud * 0.7);
    const hor = _hor.copy(NIGHT_HORIZON).lerp(NOON_HORIZON, day)
      .lerp(DUSK_HORIZON, dusk * 0.75 * (1 - cloud))
      .multiplyScalar(1 - cloud * 0.18);
    this.uniforms.uZenith.value.copy(zen);
    this.uniforms.uHorizon.value.copy(hor);
    // Less global dimming than before, because the cloud layer now actually
    // covers what is behind it - stars included - instead of only implying it.
    this.uniforms.uStars.value = (1 - day) * (1 - cloud * 0.5);
    this.uniforms.uHaze.value = cloud * 0.8;
    // Whiter as it climbs, warm and low-saturation only near the horizon. The
    // old constant lightness gave noon the same orange disc as sunset.
    this.uniforms.uSunColor.value.setHSL(
      0.09 - dusk * 0.05, 0.55 + dusk * 0.35 - day * 0.34, 0.62 + day * 0.24);

    // --- cloud ---------------------------------------------------------------
    this.uniforms.uTime.value = this.elapsed;
    this.uniforms.uCloud.value.set(
      0.16 + cloud * 0.78,      // how much of the sky it takes
      0.25 + cloud * 0.6,       // how dark the undersides go
      sun.y);                   // where it is lit from
    this.uniforms.uCloudLit.value.copy(CLOUD_LIT_NIGHT).lerp(CLOUD_LIT_DAY, day);
    this.uniforms.uCloudDark.value.copy(CLOUD_DARK_NIGHT).lerp(CLOUD_DARK_DAY, day);

    // The world's own light. Moonlight is cold and weak; daylight is neither.
    this.key.position.copy(sun.y > 0 ? sun : sun.clone().negate()).multiplyScalar(90);
    this.key.color.copy(sun.y > 0
      ? new THREE.Color(0xffe6bd).lerp(new THREE.Color(0xd08a52), dusk)
      : new THREE.Color(0x9db4d4));
    this.key.intensity = (sun.y > 0 ? 0.35 + day * 1.5 : 0.7) * (1 - cloud * 0.55);
    this.hemi.intensity = (0.55 + day * 1.3) * (1 - cloud * 0.4);
    this.hemi.color.copy(hor);

    // The mist in the low ground answers to the same weather. Thicker and
    // deeper as the air closes in, and it burns off through the middle of the
    // day the way real ground mist does - which is most of why walking into
    // dawn feels like getting somewhere.
    MIST[1] = 0.9 + cloud * 1.5;                       // how deep the layer lies
    MIST[2] = (0.85 + cloud * 0.13) * (1 - day * 0.3); // and how much it takes
    MIST[3] = 0.065 + cloud * 0.03;                    // how fast it builds
    // Its own colour, and pointedly not the fog's - see MIST_COLOR. It has to
    // stay well above the fog at night or it is black laid over black; by day
    // it goes nearly white, which is what mist in sunlight actually looks like.
    _mist.copy(_mistNight).lerp(_mistDay, day);
    MIST_COLOR[0] = _mist.r;
    MIST_COLOR[1] = _mist.g;
    MIST_COLOR[2] = _mist.b;

    // Fog belongs to the weather as much as to the hour.
    if (this.scene.fog) {
      this.scene.fog.color.copy(hor).multiplyScalar(0.55 + day * 0.35);
      // The dome's skirt matches the fog exactly, so there is no seam where one
      // becomes the other.
      this.uniforms.uFog.value.copy(this.scene.fog.color);
      this.scene.fog.far = CFG.world.fogFar * (1 - cloud * 0.45) * (0.75 + day * 0.9);
    }
  }
}
