import * as THREE from "three";

/**
 * The air, and what is in it.
 *
 * These belong to the wasteland, not to the torch. That distinction is the
 * whole design: a beam does not CREATE dust, it finds dust that was already
 * there, and building them into the cone meant the air was empty until you
 * switched something on and empty again the moment you looked away. Here they
 * exist whatever anybody is holding, and the beam is one of the things that can
 * light them.
 *
 * Two populations in one buffer, because they are the same thing at two sizes:
 *
 *   dust  tiny and countless. In daylight it is the haze you see everywhere.
 *         At night it is invisible until a beam crosses it, and a beam must not
 *         make it brighter than daylight does - the torch reveals it, it does
 *         not set it on fire.
 *
 *   bugs  a few dozen, bigger, and moving with a mind of their own. Visible on
 *         their own at any hour, because something the size of a moth catches
 *         the sky; a beam only adds a shine as one crosses it.
 *
 * They live in a box that travels with you and wrap round inside it, so the
 * world is full of them everywhere without a single one existing where nobody
 * is. Everything moves in the vertex shader: nothing here is touched per frame
 * on the CPU beyond a handful of uniforms.
 */

/** How big the travelling box is, in metres. */
const BOX = new THREE.Vector3(52, 9, 52);

/**
 * How high the air stays thick, and how far above that it takes to clear.
 *
 * Dust settles. It is thickest in the first metre or so - about the height of
 * the boulders you walk round - and by the time you are looking at the tree
 * canopy there is nothing in the air at all, which is what makes the low band
 * read as ground haze rather than as snow.
 */
const ROCK_HEIGHT = 1.7;
const CLEARS_BY = 4.5;

/** How fast they find a lit torch, and how fast they give up on a dark one. */
const GATHER = 0.055;
const SCATTER = 0.9;

/** How many of each. Dust wants to look like too many to count. */
const DUST = 7000;
const BUGS = 220;

export class Motes {
  constructor(scene) {
    const total = DUST + BUGS;
    const seed = new Float32Array(total * 3);
    const wob = new Float32Array(total * 3);
    const kind = new Float32Array(total);

    for (let i = 0; i < total; i++) {
      seed[i * 3] = Math.random();
      seed[i * 3 + 1] = Math.random();
      seed[i * 3 + 2] = Math.random();
      wob[i * 3] = Math.random() * 6.2831853;
      wob[i * 3 + 1] = 0.4 + Math.random() * 1.6;
      wob[i * 3 + 2] = Math.random();
      kind[i] = i < DUST ? 0 : 1;
    }

    const geo = new THREE.BufferGeometry();
    // Positions are computed in the shader; this only has to exist and to be
    // the right length.
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 3));
    geo.setAttribute("wob", new THREE.BufferAttribute(wob, 3));
    geo.setAttribute("kind", new THREE.BufferAttribute(kind, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.uniforms = {
      uTime: { value: 0 },
      uEye: { value: new THREE.Vector3() },
      uBox: { value: BOX.clone() },
      // The ground under the camera, so height is measured from the terrain
      // rather than from sea level.
      uGround: { value: 0 },
      uLow: { value: ROCK_HEIGHT },
      uHigh: { value: ROCK_HEIGHT + CLEARS_BY },
      uDay: { value: 1 },
      // The torch that is revealing them: where it is, where it points, the
      // cosine of its cone and how far it carries. Off when intensity is zero.
      uTorchPos: { value: new THREE.Vector3() },
      uTorchDir: { value: new THREE.Vector3(0, 0, -1) },
      uTorchCos: { value: Math.cos(0.44) },
      uTorchRange: { value: 40 },
      uTorchOn: { value: 0 },
      // How thoroughly they have found the beam: nought the moment it comes on,
      // one after it has been burning a while. Night only.
      uLure: { value: 0 },
      uDustColor: { value: new THREE.Color(0xdfe6f2) },
      uBugColor: { value: new THREE.Color(0xfff0c8) },
    };

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        uniform float uTime, uDay, uTorchCos, uTorchRange, uTorchOn;
        uniform float uGround, uLow, uHigh, uLure;
        uniform vec3 uEye, uBox, uTorchPos, uTorchDir;
        attribute vec3 seed;
        attribute vec3 wob;
        attribute float kind;
        varying float vGlow;
        varying float vBug;

        void main() {
          vBug = kind;

          // Drift: dust falls slowly and slides with the air; a bug wanders.
          vec3 drift = kind > 0.5
            ? vec3(sin(uTime * wob.y * 0.6 + wob.x) * 1.7,
                   sin(uTime * wob.y * 0.9 + wob.z * 6.28) * 0.9,
                   cos(uTime * wob.y * 0.5 + wob.x * 1.7) * 1.7)
            // Sliding with the air and turning over in it, rather than
            // falling: nothing wraps vertically any more, so a steady descent
            // would empty the band into the floor inside a minute.
            : vec3(uTime * 0.09, 0.0, uTime * 0.05)
              + vec3(sin(uTime * 0.3 + wob.x) * 0.25,
                     sin(uTime * 0.21 + wob.x * 2.3) * 0.35,
                     cos(uTime * 0.27 + wob.x) * 0.25);

          // Wrapped across the ground so there is always air around you and
          // never any anywhere else - but NOT vertically.
          //
          // Wrapping height as well scrambles the one thing height is for.
          // The squared seed puts most of them in the bottom of the band, and
          // a modulo over that band redistributes them evenly again the moment
          // the camera changes altitude. So the height is read straight off the
          // seed, measured up from the terrain under you, and only the two
          // ground axes repeat.
          // (not "flat" - that is a reserved interpolation qualifier in GLSL
          // ES 3.0, and naming a vec2 with it fails to compile the whole
          // shader, which draws exactly nothing and says so only in a warning.)
          vec2 onGround = mod(seed.xz * uBox.xz + drift.xz - uEye.xz + uBox.xz * 0.5,
            uBox.xz) - uBox.xz * 0.5;
          float high = seed.y * seed.y * uBox.y + drift.y;
          vec3 rel = vec3(onGround.x, 0.0, onGround.y);
          vec3 world = vec3(uEye.x + onGround.x, uGround + high, uEye.z + onGround.y);

          // Drawn to the light.
          //
          // Leave a torch burning at night and the air in front of it fills up:
          // the moths find it first and everything else gets stirred in behind
          // them, and it follows the beam wherever it is pointed because the
          // beam is the thing they are following. Off during the day - nothing
          // is drawn to a torch it cannot see - and it takes a while to gather,
          // which is what makes it read as them arriving rather than as a
          // switch being thrown.
          float pull = uLure * (kind > 0.5 ? 1.0 : 0.22);
          if (pull > 0.002 && uTorchOn > 0.5) {
            // Each one holds station at its own distance down the beam.
            float along = 1.4 + fract(wob.z * 7.3) * (uTorchRange * 0.16);
            vec3 axis = uTorchPos + uTorchDir * along;
            vec3 up = abs(uTorchDir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
            vec3 side = normalize(cross(uTorchDir, up));
            vec3 vert = cross(side, uTorchDir);
            float ang = uTime * (0.5 + wob.y * 0.9) + wob.x;
            float rad = (0.18 + fract(wob.x) * 0.85) * (0.4 + along * 0.22);
            vec3 target = axis + (side * cos(ang) + vert * sin(ang)) * rad;
            world = mix(world, target, pull);
          }

          // How much of the torch is on this one.
          float torch = 0.0;
          if (uTorchOn > 0.5) {
            vec3 toM = world - uTorchPos;
            float dist = length(toM);
            float c = dot(normalize(toM), uTorchDir);
            torch = smoothstep(uTorchCos, uTorchCos + 0.05, c)
              * (1.0 - smoothstep(uTorchRange * 0.3, uTorchRange, dist));
          }

          if (kind > 0.5) {
            // A moth catches the sky on its own; the beam adds a shine.
            vGlow = (0.30 + 0.55 * uDay) + torch * 0.40;
          } else {
            // Dust is daylight's, and the beam can only bring it up TO what
            // daylight would have shown - never past it. Revealing, not
            // igniting: a speck that flares brighter under a torch than it ever
            // looks at noon is a speck nobody believes.
            float day = 0.05 + 0.95 * uDay;
            vGlow = min(day + torch * 0.85, 0.62);
          }

          vec4 mv = modelViewMatrix * vec4(world, 1.0);
          // Fade out at the box's edge so nothing ever winks into existence.
          float edge = 1.0 - smoothstep(0.34, 0.5, length(rel.xz / uBox.xz));
          // And gone by the time you are looking at the canopy.
          float above = world.y - uGround;
          float lift = (1.0 - smoothstep(uLow, uHigh, above))
            * smoothstep(-0.25, 0.05, above);
          vGlow *= edge * lift;
          float size = kind > 0.5 ? 5.5 + wob.z * 4.0 : 1.5 + wob.z * 1.1;
          gl_PointSize = size * 26.0 / max(-mv.z, 0.2);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uDustColor, uBugColor;
        varying float vGlow;
        varying float vBug;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = vGlow * (1.0 - r * 4.0);
          if (a < 0.004) discard;
          vec3 col = mix(uDustColor, uBugColor, vBug);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
    this.scene = scene;
  }

  /**
   * @param eye     where the camera is
   * @param hour    the sky's clock, for how much daylight there is
   * @param torch   the player's SpotLight, or null
   * @param ground  the terrain height under the camera
   */
  update(dt, eye, hour, torch, ground = 0) {
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uEye.value.copy(eye);
    u.uGround.value = ground;
    // Full daylight from eight to four, and nothing between nine and five the
    // other way; the hour either side of each is the fade.
    const h = ((hour % 24) + 24) % 24;
    u.uDay.value = THREE.MathUtils.clamp(
      Math.min((h - 5.0) / 2.0, (19.0 - h) / 2.0), 0, 1);

    const on = torch && torch.intensity > 1;
    u.uTorchOn.value = on ? 1 : 0;
    // They gather slowly and scatter quickly, and only after dark: a beam left
    // burning for half a minute has a cloud round it, and one flicked on and
    // off has nothing.
    const night = 1 - u.uDay.value;
    const want = on ? night : 0;
    const rate = want > u.uLure.value ? GATHER : SCATTER;
    u.uLure.value += (want - u.uLure.value) * Math.min(1, dt * rate);
    if (on) {
      torch.getWorldPosition(u.uTorchPos.value);
      torch.target.getWorldPosition(_aim);
      u.uTorchDir.value.copy(_aim).sub(u.uTorchPos.value).normalize();
      u.uTorchCos.value = Math.cos(torch.angle);
      u.uTorchRange.value = torch.distance || 40;
    }
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

const _aim = new THREE.Vector3();
