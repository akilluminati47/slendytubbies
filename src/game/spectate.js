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
const ORBIT = { distance: 5.4, height: 2.3, minPitch: -0.55, maxPitch: 0.85 };

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
      this.#place();
      return null;
    }

    const p = target.current ?? target.pos;
    this.pos.lerp(p, Math.min(1, dt * 4));   // lazy follow reads as a camera operator
    this.#place();
    return target;
  }

  #place() {
    const d = ORBIT.distance * Math.cos(this.pitch);
    const x = this.pos.x + Math.sin(this.yaw) * d;
    const z = this.pos.z + Math.cos(this.yaw) * d;
    const y = heightAt(this.pos.x, this.pos.z) + ORBIT.height +
      ORBIT.distance * Math.sin(this.pitch);

    // The rig owns world placement everywhere else, so keep that true here and
    // leave the camera itself at the rig origin.
    this.rig.position.set(x, Math.max(y, heightAt(x, z) + 0.6), z);
    this.rig.rotation.set(0, 0, 0);
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(this.pos.x, heightAt(this.pos.x, this.pos.z) + 1.3, this.pos.z);
  }
}
