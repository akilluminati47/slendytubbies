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
    this.fleeLeft = 0;
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

  update(dt, player, threats = null) {
    threats = threats || [player.pos];
    const fleeing = this.state === "flee";
    const seen = !fleeing && player.alive && this.#sees(player);
    const heard = !fleeing && player.alive && this.#hears(player);

    switch (this.state) {
      case "flee":
        // Deaf and blind while running. Being re-aggroed mid-flight by the very
        // noise of the pickup would defeat the point of the breather.
        this.fleeLeft -= dt;
        if (this.fleeLeft <= 0) {
          this.#enter("patrol");
        } else if (this.pos.distanceTo(this.target) < 8) {
          this.#aimAwayFrom(threats);   // hit the treeline; pick a new way out
        }
        break;

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

    const speed = {
      patrol: T.patrolSpeed, investigate: T.investigateSpeed,
      chase: T.chaseSpeed, flee: T.fleeSpeed,
    }[this.state];
    const turn = fleeing ? T.fleeTurnRate : T.turnRate;

    // Steer toward the target, then let the collision pass slide us round trees.
    const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
    const want = Math.atan2(dx, dz);
    let diff = want - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.heading += Math.max(-turn * dt, Math.min(turn * dt, diff));

    // Scalars, not a cloned Vector3: this runs every frame for every tubby and
    // the allocation bought nothing.
    const beforeX = this.pos.x, beforeZ = this.pos.z;
    this.pos.x += Math.sin(this.heading) * speed * dt;
    this.pos.z += Math.cos(this.heading) * speed * dt;
    this.world.resolve(this.pos, T.radius);
    const movedX = this.pos.x - beforeX, movedZ = this.pos.z - beforeZ;
    this.speedNow = Math.hypot(movedX, movedZ) / Math.max(dt, 1e-4);

    // Face where it actually WENT, not where it intended to go. Collision
    // resolution slides it around trees, so steering by `heading` alone makes it
    // moonwalk sideways along a trunk while still pointing down its old path.
    if (movedX * movedX + movedZ * movedZ > 1e-7) {
      const moved = Math.atan2(movedX, movedZ);
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
    if (this.speedNow < speed * 0.25) {
      if (this.state === "patrol") this.target = this.#wanderPoint();
      else if (fleeing) this.#aimAwayFrom(threats);   // snagged a trunk; go around
    }

    this.root.position.set(this.pos.x, heightAt(this.pos.x, this.pos.z), this.pos.z);
    this.root.rotation.y = this.facing;
    // Patrolling counts as walking. It used to fall through to idle, which was
    // harmless on the procedural stand-ins and foot-skates badly on a real clip.
    this.model.play(this.state === "chase" || this.state === "flee" ? "chase"
      : this.speedNow > 0.15 ? "walk" : "idle");
    this.model.update(dt, this.speedNow);

    if (player.alive && this.state === "chase" && !fleeing &&
        Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z) < T.killRange &&
        this.canTake(player)) {
      return "kill";
    }
    return null;
  }

  /**
   * Whether it can actually take someone it has caught up with.
   *
   * Slendytubbies 1 lets you outlast it on foot. Keep moving and keep your back
   * to it and it stalks - right behind you, close enough to hear, and unable to
   * close the deal. It takes you the moment you stop, get cornered, or turn to
   * look at what has been breathing behind you for the last thirty seconds.
   *
   * That last one is deliberate: the punishment for looking is the whole game.
   */
  canTake(player) {
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    const away = Math.hypot(dx, dz) || 1e-6;

    // Are they still running, and running away rather than past?
    const speed = Math.hypot(player.vel.x, player.vel.z);
    const fleeing = speed > T.escapeSpeed &&
      (player.vel.x * dx + player.vel.z * dz) / (speed * away) > 0.25;

    // Are they looking at it? Three.js cameras face -Z, so at yaw t the view
    // runs along (-sin t, -cos t).
    const yaw = player.input?.yaw ?? 0;
    const look = (-Math.sin(yaw) * -dx + -Math.cos(yaw) * -dz) / away;
    const facing = look > Math.cos(T.lookAngle * Math.PI / 180);

    return facing || !fleeing;
  }

  /** Close behind and hunting: what the "it is right there" cue asks about. */
  onYourHeels(player) {
    if (this.state !== "chase" || !player.alive) return false;
    const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    return d < T.heelsRange;
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
      // Guests run this every frame; lerp componentwise rather than allocating.
      const k = Math.min(1, dt * 12);
      this.pos.x += (pos[0] - this.pos.x) * k;
      this.pos.z += (pos[2] - this.pos.z) * k;
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
    this.model.play(this.state === "chase" || this.state === "flee" ? "chase"
      : this.state === "patrol" || this.state === "investigate" ? "walk" : "idle");
    this.model.update(dt, this.state === "chase" ? 5 : 1.5);
  }

  /** Compact form for the wire. */
  netState() {
    return { p: [+this.pos.x.toFixed(2), 0, +this.pos.z.toFixed(2)],
             f: +this.facing.toFixed(3), s: this.state };
  }

  /**
   * Bolt. Called when anyone takes a dish.
   *
   * It does NOT despawn or teleport - it turns and sprints away from everyone at
   * a speed you cannot match, in full view, and then goes back to hunting. You
   * get real breathing room and you get to watch it leave, which is a much
   * better beat than the monster blinking out of existence.
   */
  flee(from) {
    this.state = "flee";
    this.fleeLeft = T.fleeTime;
    this.lostFor = 0;
    this.#aimAwayFrom(from);
  }

  /** Point directly away from the nearest threat in `from` (array of {x,z}). */
  #aimAwayFrom(from) {
    const points = Array.isArray(from) ? from : [from];
    let ax = 0, az = 0;
    for (const p of points) {
      const dx = this.pos.x - p.x, dz = this.pos.z - p.z;
      const d = Math.max(0.5, Math.hypot(dx, dz));
      // Weight by inverse distance so the closest player dominates the choice.
      ax += dx / (d * d);
      az += dz / (d * d);
    }
    if (Math.abs(ax) < 1e-6 && Math.abs(az) < 1e-6) {
      this.heading = Math.random() * Math.PI * 2;
    } else {
      this.heading = Math.atan2(ax, az);
    }
    this.target.set(
      this.pos.x + Math.sin(this.heading) * 60,
      0,
      this.pos.z + Math.cos(this.heading) * 60,
    );
  }

  /** 0..1 - how close this tubby is to reaching you. Drives the red screen. */
  threat(player) {
    if (this.state !== "chase") return 0;   // "flee" reads as zero, so red clears
    const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    return Math.max(0, 1 - d / 20);
  }
}
