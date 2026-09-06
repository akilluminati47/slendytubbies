import * as THREE from "three";
import { CFG } from "../game/config.js";

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
 * The moon keeps its own calendar, and it is only ever in the sky. Nothing reads
 * it out; a player either notices it filling out across rounds or does not.
 */

const DAY_MINUTES = 48;                     // real minutes for a full day
const DAY_SECONDS = DAY_MINUTES * 60;
const HOUR = DAY_SECONDS / 24;              // 120s of real time per hour

/** Sunrise and sunset, in hours. Deliberately a long night. */
const DAWN = 6.4;
const DUSK = 19.1;

const WEATHERS = ["clear", "hazy", "overcast", "rain"];

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
    this.moonPhase = rand();          // 0 new, 0.5 full, 1 new again
    this.weather = "clear";
    this.weatherLeft = 40 + rand() * 90;
    this.wet = 0;                     // 0..1, eased, so weather arrives slowly

    const geo = new THREE.SphereGeometry(1, 32, 20);
    this.uniforms = {
      uZenith: { value: new THREE.Color(0x05070f) },
      uHorizon: { value: new THREE.Color(0x131a26) },
      uSunDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunColor: { value: new THREE.Color(0xffd9a0) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonPhase: { value: this.moonPhase },
      uStars: { value: 1 },
      uHaze: { value: 0 },
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
        uniform vec3 uZenith, uHorizon, uSunDir, uSunColor, uMoonDir;
        uniform float uMoonPhase, uStars, uHaze;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        void main() {
          vec3 d = normalize(vDir);
          float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(up, 0.85));

          // Stars, thinned out by daylight and by cloud.
          if (uStars > 0.01 && d.y > -0.05) {
            vec2 g = floor(d.xz / max(abs(d.y), 0.25) * 90.0);
            float s = hash(g);
            float star = smoothstep(0.9975, 1.0, s) * uStars * smoothstep(-0.05, 0.25, d.y);
            col += vec3(star) * (0.6 + 0.4 * hash(g + 7.0));
          }

          // The sun: a disc, and a great deal of glow around it near the horizon.
          float sd = dot(d, normalize(uSunDir));
          col += uSunColor * pow(max(sd, 0.0), 220.0) * 6.0;
          col += uSunColor * pow(max(sd, 0.0), 6.0) * 0.28;

          // The moon, with a phase: a second disc offset across the first
          // subtracts the shadowed part, which is what a phase physically is.
          vec3 m = normalize(uMoonDir);
          float md = dot(d, m);
          float disc = smoothstep(0.99955, 0.99975, md);
          if (disc > 0.0) {
            // Where along the face the terminator sits, -1 to 1.
            float term = cos(uMoonPhase * 6.2831853);
            vec3 side = normalize(cross(m, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));
            float across = dot(normalize(d - m * md), side);
            float lit = smoothstep(term - 0.12, term + 0.12, across);
            // A new moon is not black, it is barely there.
            col = mix(col, vec3(0.86, 0.88, 0.82), disc * (0.12 + 0.88 * lit));
          }
          col += vec3(0.55, 0.6, 0.72) * pow(max(md, 0.0), 12.0) * 0.05;

          col = mix(col, uHorizon, uHaze * (1.0 - up) * 0.8);
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

    this.weatherLeft -= dt;
    if (this.weatherLeft <= 0) this.#rollWeather();
    const wetTarget = { clear: 0, hazy: 0.35, overcast: 0.7, rain: 1 }[this.weather];
    this.wet += (wetTarget - this.wet) * Math.min(1, dt * 0.25);

    // The sun rides a circle through the sky; the moon rides the other side of
    // it, so one is always up when the other is not.
    const t = ((this.hour - DAWN) / (DUSK - DAWN)) * Math.PI;
    const sun = new THREE.Vector3(Math.cos(t + Math.PI), Math.sin(t), 0.35).normalize();
    this.uniforms.uSunDir.value.copy(sun);
    this.uniforms.uMoonDir.value.copy(sun).negate();
    this.uniforms.uMoonPhase.value = this.moonPhase;

    // How far up the sun is, which is what actually decides the light.
    const day = THREE.MathUtils.clamp(sun.y * 3.0 + 0.15, 0, 1);
    const dusk = THREE.MathUtils.clamp(1 - Math.abs(sun.y) * 6, 0, 1);
    const cloud = this.wet;

    const night = new THREE.Color(0x05070f);
    const noon = new THREE.Color(0x2b4a74);
    const zen = night.clone().lerp(noon, day).multiplyScalar(1 - cloud * 0.45);
    const hor = new THREE.Color(0x131a26)
      .lerp(new THREE.Color(0x7d8fa6), day)
      .lerp(new THREE.Color(0xc4713a), dusk * 0.75 * (1 - cloud))
      .multiplyScalar(1 - cloud * 0.3);
    this.uniforms.uZenith.value.copy(zen);
    this.uniforms.uHorizon.value.copy(hor);
    this.uniforms.uStars.value = (1 - day) * (1 - cloud * 0.9);
    this.uniforms.uHaze.value = cloud * 0.8;
    this.uniforms.uSunColor.value.setHSL(0.09 - dusk * 0.05, 0.55 + dusk * 0.35, 0.62);

    // The world's own light. Moonlight is cold and weak; daylight is neither.
    this.key.position.copy(sun.y > 0 ? sun : sun.clone().negate()).multiplyScalar(90);
    this.key.color.copy(sun.y > 0
      ? new THREE.Color(0xffe6bd).lerp(new THREE.Color(0xd08a52), dusk)
      : new THREE.Color(0x9db4d4));
    this.key.intensity = (sun.y > 0 ? 0.35 + day * 1.5 : 0.7) * (1 - cloud * 0.55);
    this.hemi.intensity = (0.55 + day * 1.3) * (1 - cloud * 0.4);
    this.hemi.color.copy(hor);

    // Fog belongs to the weather as much as to the hour.
    if (this.scene.fog) {
      this.scene.fog.color.copy(hor).multiplyScalar(0.55 + day * 0.35);
      this.scene.fog.far = CFG.world.fogFar * (1 - cloud * 0.45) * (0.75 + day * 0.9);
    }
  }
}
