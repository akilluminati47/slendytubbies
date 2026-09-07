import * as THREE from "three";

/**
 * Rain.
 *
 * A fixed box of streaks that travels with the camera, which is the only
 * sensible way to do weather in an open world: rain is everywhere, so there is
 * nothing to be gained by simulating the half of the map you cannot see. The
 * box is small enough that every drop in it is close enough to read as a drop
 * rather than as noise.
 *
 * Nothing moves on the CPU. Each drop knows where it started and the vertex
 * shader works out where it has fallen to from the clock, so a downpour costs
 * one uniform write a frame rather than four thousand position updates. The
 * fall wraps with a modulo, so drops leave the bottom of the box and reappear
 * at the top for as long as it rains.
 */

const DROPS = 2200;
const BOX = new THREE.Vector3(26, 18, 26);   // metres, centred on the camera
const LEN = 0.42;                            // how long a streak is drawn

export class Rain {
  constructor(scene) {
    const pos = new Float32Array(DROPS * 2 * 3);
    const tip = new Float32Array(DROPS * 2);
    const life = new Float32Array(DROPS * 2);

    for (let i = 0; i < DROPS; i++) {
      const x = (Math.random() - 0.5) * BOX.x;
      const y = Math.random() * BOX.y;
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
        uniform float uTime, uFall, uAmount;
        uniform vec2 uWind;
        varying float vFade;

        void main() {
          vec3 p = position;
          float fall = uTime * uFall * aRate;
          // Wrapped, so a drop leaving the bottom is the same drop arriving at
          // the top. The box is ${BOX.y} m tall and centred on the eye.
          p.y = mod( p.y - fall, ${BOX.y.toFixed(1)} ) - ${(BOX.y / 2).toFixed(1)};
          // Slanted by the wind, by how far it has already fallen.
          p.xz += uWind * ( ${(BOX.y / 2).toFixed(1)} - p.y ) * 0.06;
          // Wrap the slant back into the box too, or the whole shower drifts
          // out of it and the near air goes empty.
          p.x = mod( p.x + ${(BOX.x / 2).toFixed(1)}, ${BOX.x.toFixed(1)} ) - ${(BOX.x / 2).toFixed(1)};
          p.z = mod( p.z + ${(BOX.z / 2).toFixed(1)}, ${BOX.z.toFixed(1)} ) - ${(BOX.z / 2).toFixed(1)};
          // The tail sits above the head, along the direction of travel.
          p.y += aTip * ${LEN.toFixed(2)};
          p.xz -= uWind * aTip * ${(LEN * 0.06).toFixed(4)};

          // Faded at the walls of the box, so it has no edges.
          float r = length( p.xz );
          vFade = ( 1.0 - smoothstep( ${(BOX.x * 0.22).toFixed(1)}, ${(BOX.x * 0.5).toFixed(1)}, r ) ) * uAmount;

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
  }

  /**
   * @param eye    where the camera is; the box is hung on it
   * @param amount 0..1, how hard it is raining
   */
  update(dt, eye, amount) {
    this.uniforms.uAmount.value = amount;
    // Skipped entirely when it is dry. A shower nobody can see is still two and
    // a half thousand transparent primitives being sorted and drawn.
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;
    this.uniforms.uTime.value += dt;
    if (eye) this.mesh.position.copy(eye);
  }

  /** The colour of the light it is falling through. */
  setColor(c) { this.uniforms.uColor.value.copy(c); }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
