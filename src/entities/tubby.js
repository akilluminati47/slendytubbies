import * as THREE from "three";
import { CFG } from "../game/config.js";
import { heightAt } from "../world/world.js";
import { makeTubby } from "./tubbyModel.js";

const T = CFG.tubby;

/**
 * States: patrol -> investigate -> chase -> (kill | lose) -> patrol.
 *
 * The tubby never cheats. It only learns where you are by sight (a cone, widened
 * when your torch is on) or by hearing (a radius set by what you are doing).
 * That is what makes "stand still in the dark" a real strategy.
 */
export class Tubby {
  constructor(scene, world, kind, spawn) {
    this.world = world;
    this.model = makeTubby(kind);
    this.kind = kind;
    this.root = this.model.root;
    this.root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.castShadow = true; });
    scene.add(this.root);

    this.pos = spawn.clone();
    this.heading = Math.random() * Math.PI * 2;
    this.facing = this.heading;   // rendered orientation, smoothed toward motion
    this.state = "patrol";
    this.target = this.#wanderPoint();
    this.lostFor = 0;
    this.growl = 0;
    this.speedNow = 0;
  }

  #wanderPoint() {
    const s = CFG.world.size * 0.42;
    return new THREE.Vector3((Math.random() - 0.5) * s * 2, 0, (Math.random() - 0.5) * s * 2);
  }

  /** Can it see the player right now? */
  #sees(player) {
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const range = T.sightRange + (player.torchOn ? CFG.noise.torchBonus : 0);
    if (d > range) return false;
    const toPlayer = Math.atan2(dx, dz);
    let diff = toPlayer - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > T.sightHalfAngle) return false;
    // Trees block line of sight - crouching behind one actually works.
    return !this.#blocked(player.pos, d);
  }

  #blocked(to, dist) {
    const steps = Math.min(24, Math.ceil(dist / 1.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = this.pos.x + (to.x - this.pos.x) * t;
      const z = this.pos.z + (to.z - this.pos.z) * t;
      for (const o of this.world.obstacles) {
        if (o.r < 0.4) continue;
        if ((x - o.x) ** 2 + (z - o.z) ** 2 < o.r * o.r) return true;
      }
    }
    return false;
  }

  #hears(player) {
    const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    return d < player.noise;
  }

  update(dt, player) {
    const seen = player.alive && this.#sees(player);
    const heard = player.alive && this.#hears(player);

    switch (this.state) {
      case "patrol":
        if (seen) this.#enter("chase", player.pos);
        else if (heard) this.#enter("investigate", player.pos);
        else if (this.pos.distanceTo(this.target) < 2.5) this.target = this.#wanderPoint();
        break;

      case "investigate":
        if (seen) this.#enter("chase", player.pos);
        else if (heard) this.target.set(player.pos.x, 0, player.pos.z);
        else {
          this.lostFor += dt;
          if (this.lostFor > T.loseInterest || this.pos.distanceTo(this.target) < 2)
            this.#enter("patrol");
        }
        break;

      case "chase":
        if (seen || heard) {
          this.lostFor = 0;
          this.target.set(player.pos.x, 0, player.pos.z);
        } else {
          this.lostFor += dt;
          if (this.lostFor > T.loseInterest) this.#enter("investigate");
        }
        break;
    }

    const speed = { patrol: T.patrolSpeed, investigate: T.investigateSpeed, chase: T.chaseSpeed }[this.state];

    // Steer toward the target, then let the collision pass slide us round trees.
    const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
    const want = Math.atan2(dx, dz);
    let diff = want - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.heading += Math.max(-T.turnRate * dt, Math.min(T.turnRate * dt, diff));

    const before = this.pos.clone();
    this.pos.x += Math.sin(this.heading) * speed * dt;
    this.pos.z += Math.cos(this.heading) * speed * dt;
    this.world.resolve(this.pos, T.radius);
    this.speedNow = this.pos.distanceTo(before) / Math.max(dt, 1e-4);

    // Face where it actually WENT, not where it intended to go. Collision
    // resolution slides it around trees, so steering by `heading` alone makes it
    // moonwalk sideways along a trunk while still pointing down its old path.
    const mx = this.pos.x - before.x, mz = this.pos.z - before.z;
    if (mx * mx + mz * mz > 1e-7) {
      const moved = Math.atan2(mx, mz);
      let d = moved - this.facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      // Ease into it so a one-frame collision nudge cannot snap it around.
      this.facing += d * Math.min(1, dt * 9);
    } else {
      let d = this.heading - this.facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.facing += d * Math.min(1, dt * 6);
    }

    // If a tree pinned us flat, pick a new heading rather than grinding into bark.
    if (this.speedNow < speed * 0.25 && this.state === "patrol") this.target = this.#wanderPoint();

    this.root.position.set(this.pos.x, heightAt(this.pos.x, this.pos.z), this.pos.z);
    this.root.rotation.y = this.facing;
    this.model.play(this.state === "chase" ? "chase" : this.state === "investigate" ? "walk" : "idle");
    this.model.update(dt, this.speedNow);

    if (player.alive && this.state === "chase" &&
        Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z) < T.killRange) {
      return "kill";
    }
    return null;
  }

  #enter(state, at) {
    this.state = state;
    this.lostFor = 0;
    if (at) this.target.set(at.x, 0, at.z);
    else this.target = this.#wanderPoint();
  }

  /**
   * Drive this tubby from the host's broadcast instead of from its own AI.
   *
   * Only the host simulates the CPU Tinky Winky; guests just render what they
   * are told. Running the AI on every client would give each player a different
   * monster in a different place, and no amount of interpolation fixes that.
   */
  netApply(pos, facing, state, dt) {
    if (pos) {
      this.pos.lerp(new THREE.Vector3(pos[0], 0, pos[2]), Math.min(1, dt * 12));
    }
    if (typeof facing === "number") {
      let d = facing - this.facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.facing += d * Math.min(1, dt * 10);
    }
    if (state) this.state = state;

    this.root.position.set(this.pos.x, heightAt(this.pos.x, this.pos.z), this.pos.z);
    this.root.rotation.y = this.facing;
    this.model.play(this.state === "chase" ? "chase"
      : this.state === "investigate" ? "walk" : "idle");
    this.model.update(dt, this.state === "chase" ? 5 : 1.5);
  }

  /** Compact form for the wire. */
  netState() {
    return { p: [+this.pos.x.toFixed(2), 0, +this.pos.z.toFixed(2)],
             f: +this.facing.toFixed(3), s: this.state };
  }

  /**
   * Break off and clear out. Called when the player takes a tank: the hunt
   * resets to square one rather than the tubby simply carrying on, so the red
   * screen releases and you get a real breather as a reward.
   */
  retreat(from, minDistance = 34) {
    this.state = "patrol";
    this.lostFor = 0;
    this.target = this.#wanderPoint();

    // If it is right on top of you, back it off to a distance you cannot see
    // through the fog - it "hides" rather than teleporting away in view.
    const dx = this.pos.x - from.x, dz = this.pos.z - from.z;
    const d = Math.hypot(dx, dz);
    if (d < minDistance) {
      const a = d > 1e-3 ? Math.atan2(dx, dz) : Math.random() * Math.PI * 2;
      const lim = CFG.world.size / 2 - 12;
      this.pos.x = Math.max(-lim, Math.min(lim, from.x + Math.sin(a) * minDistance));
      this.pos.z = Math.max(-lim, Math.min(lim, from.z + Math.cos(a) * minDistance));
      this.world.resolve(this.pos, T.radius);
    }
    // Send it somewhere away from the player so it does not wander straight back.
    this.heading = Math.atan2(this.pos.x - from.x, this.pos.z - from.z);
    this.facing = this.heading;   // it was teleported; do not spin to catch up
  }

  /** 0..1 - how close this tubby is to reaching you. Drives the red screen. */
  threat(player) {
    if (this.state !== "chase") return 0;
    const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    return Math.max(0, 1 - d / 20);
  }
}
