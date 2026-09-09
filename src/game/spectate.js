import * as THREE from "three";
import { heightAt } from "../world/world.js";

/**
 * Third-person spectating after Tinky Winky catches you in a lobby.
 *
 * Dying alone ends the run, but dying with friends still playing should not -
 * you watch them instead. Control is deliberately limited to the camera: you
 * orbit a survivor and can cycle between them, and that is all. A dead player
 * who could still move would be a second, invisible participant.
 */
const ORBIT = {
  distance: 5.4, height: 2.3, minPitch: -0.55, maxPitch: 0.85,
  // How close it is willing to be pulled, and how far above the ground it
  // insists on staying.
  minDistance: 1.1, clearance: 0.55,
  // Steps taken looking for a distance that clears the ground. Sixteen over
  // four and a bit metres is a quarter of a metre a step, which is finer than
  // the terrain changes under it.
  probes: 16,
  // How fast it slides in and back out again. Coming in has to be quicker than
  // going out or the camera walks into the hill before it reacts; going out
  // slowly is what stops it snapping wide the moment a rise passes underneath.
  pullIn: 14, pushOut: 3.5,
};

export class Spectator {
  constructor(camera, rig) {
    this.camera = camera;
    this.rig = rig;
    this.active = false;
    this.targets = [];
    this.index = 0;
    this.yaw = 0;
    this.pitch = 0.22;
    this.pos = new THREE.Vector3();
    // Where the boom actually is, as opposed to how long it would like to be.
    this.reach = ORBIT.distance;
  }

  /** `getTargets` returns the living players we are allowed to watch. */
  start(getTargets) {
    this.getTargets = getTargets;
    this.active = true;
    this.index = 0;
    const t = this.current();
    if (t) this.pos.copy(t.current ?? t.pos);
  }

  stop() { this.active = false; }

  current() {
    this.targets = this.getTargets?.() ?? [];
    if (!this.targets.length) return null;
    this.index = ((this.index % this.targets.length) + this.targets.length) % this.targets.length;
    return this.targets[this.index];
  }

  cycle(dir = 1) {
    if (!this.targets.length) return null;
    this.index = (this.index + dir + this.targets.length) % this.targets.length;
    return this.current();
  }

  /**
   * Look with the same intent the living use, so a spectator's stick and mouse
   * behave exactly as they did a moment ago.
   */
  update(dt, intent) {
    if (!this.active) return null;

    this.yaw += intent.look.x;
    this.pitch = Math.max(ORBIT.minPitch,
      Math.min(ORBIT.maxPitch, this.pitch - intent.look.y));

    const target = this.current();
    if (!target) {
      // Nobody left to watch: hold the last position rather than snapping to
      // the origin, which would look like a crash.
      this.#place(dt);
      return null;
    }

    const p = target.current ?? target.pos;
    this.pos.lerp(p, Math.min(1, dt * 4));   // lazy follow reads as a camera operator
    this.#place(dt);
    return target;
  }

  /**
   * Where the boom can sit without going through the hill.
   *
   * Walked from the full length inwards, taking the first distance whose camera
   * position still clears the ground. It used to hold the length and shove the
   * camera UP instead, which keeps it out of the dirt and does something worse
   * on the way: the shot rises off the subject and tilts down at them, so
   * backing into a bank turns a chase into a map. Pulling in keeps the framing
   * and only loses the distance, which is what every third-person camera does
   * and what it looks wrong not to do.
   */
  #reachFor(dt) {
    const foot = heightAt(this.pos.x, this.pos.z);
    let want = ORBIT.minDistance;
    for (let i = 0; i <= ORBIT.probes; i++) {
      const len = ORBIT.minDistance +
        (ORBIT.distance - ORBIT.minDistance) * (1 - i / ORBIT.probes);
      const flat = len * Math.cos(this.pitch);
      const x = this.pos.x + Math.sin(this.yaw) * flat;
      const z = this.pos.z + Math.cos(this.yaw) * flat;
      const y = foot + ORBIT.height + len * Math.sin(this.pitch);
      if (y > heightAt(x, z) + ORBIT.clearance) { want = len; break; }
    }
    const k = want < this.reach ? ORBIT.pullIn : ORBIT.pushOut;
    this.reach += (want - this.reach) * Math.min(1, dt * k);
    return this.reach;
  }

  #place(dt) {
    const len = this.#reachFor(dt);
    const foot = heightAt(this.pos.x, this.pos.z);
    const flat = len * Math.cos(this.pitch);
    const x = this.pos.x + Math.sin(this.yaw) * flat;
    const z = this.pos.z + Math.cos(this.yaw) * flat;
    const y = foot + ORBIT.height + len * Math.sin(this.pitch);

    // The rig owns world placement everywhere else, so keep that true here and
    // leave the camera itself at the rig origin. The floor stays as a last
    // resort - a hill steeper than the shortest boom can clear still must not
    // put the lens underground.
    this.rig.position.set(x, Math.max(y, heightAt(x, z) + ORBIT.clearance), z);
    this.rig.rotation.set(0, 0, 0);
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(this.pos.x, foot + 1.3, this.pos.z);
  }
}
