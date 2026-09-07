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
    this.quarryId = null;      // who it is currently hunting; see chooseQuarry
    this.target = this.#wanderPoint();
    this.lostFor = 0;
    this.fleeLeft = 0;
    this.stride = T.strides[0];
    this.strideLeft = 0;
    this.alignLeft = 0;
    this.#rollStride();
    this.growl = 0;
    this.speedNow = 0;
  }

  /**
   * Pick a walking pace and keep it for a while.
   *
   * Re-rolled on a timer rather than at every waypoint, so a change of pace
   * happens mid-crossing where you can see it happen, instead of only ever at
   * the moment it turns a corner.
   */
  #rollStride() {
    this.stride = T.strides[Math.floor(Math.random() * T.strides.length)];
    this.strideLeft = T.strideHold[0] + Math.random() * (T.strideHold[1] - T.strideHold[0]);
  }

  #wanderPoint() {
    const s = CFG.world.size * 0.42;
    return new THREE.Vector3((Math.random() - 0.5) * s * 2, 0, (Math.random() - 0.5) * s * 2);
  }

  /** Is that point inside the cone it is looking down? */
  #inCone(pos) {
    const toPoint = Math.atan2(pos.x - this.pos.x, pos.z - this.pos.z);
    let diff = toPoint - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff) <= T.sightHalfAngle;
  }

  /** Can it see the player right now? */
  #sees(player) {
    const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const range = T.sightRange + (player.torchOn ? CFG.noise.torchBonus : 0);
    if (d > range) return false;
    if (!this.#inCone(player.pos)) return false;
    // Trees block line of sight - crouching behind one actually works.
    return !this.#blocked(player.pos, d);
  }

  /**
   * Is a torch being shone at it?
   *
   * A light in the dark carries a great deal further than a shape does, which
   * is the point: the beam that lets you find dishes is also the thing that
   * tells something across the map exactly where you are. Three conditions, all
   * of them things the player can actually control - the beam has to be pointed
   * at it, it has to be facing your way to catch the light, and nothing can be
   * stood in between. That last one does most of the work in a forest of 420
   * trunks, which is what keeps this from firing every few seconds.
   */
  #lit(player) {
    if (!player.torchOn) return false;
    const dx = this.pos.x - player.pos.x, dz = this.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > T.torchRange || d < 1e-4) return false;
    // Three.js cameras face -Z, so at yaw t the beam runs along (-sin t, -cos t).
    const yaw = player.input?.yaw ?? 0;
    const aim = (-Math.sin(yaw) * dx + -Math.cos(yaw) * dz) / d;
    if (aim < Math.cos(T.torchBeam * Math.PI / 180)) return false;
    if (!this.#inCone(player.pos)) return false;
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
    const alive = !fleeing && player.alive;
    // A beam in the face counts as being seen, at nearly twice the range.
    const lit = alive && this.#lit(player);
    const seen = alive && (this.#sees(player) || lit);
    const heard = alive && this.#hears(player);

    // What makes it snap round onto you: a jump, or a torch found from further
    // off than it could ever have spotted you by shape. Both are the player
    // announcing themselves rather than being caught out.
    this.alignLeft = Math.max(0, this.alignLeft - dt);
    const startled = alive &&
      ((heard && player.noise >= T.alertNoise) ||
       (lit && !this.#sees(player)));

    this.strideLeft -= dt;
    if (this.strideLeft <= 0) this.#rollStride();

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
        if (startled) this.#align(player.pos);
        if (seen) this.#enter("chase", player.pos);
        else if (heard) this.#enter("investigate", player.pos);
        else if (this.pos.distanceTo(this.target) < 2.5) this.target = this.#wanderPoint();
        break;

      case "investigate":
        if (startled) this.#align(player.pos);
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
      patrol: this.stride, investigate: T.investigateSpeed,
      chase: T.chaseSpeed, flee: T.fleeSpeed,
    }[this.state];
    // It whips round when it has just been startled and when bolting; it swings
    // round the rest of the time.
    const turn = fleeing || this.alignLeft > 0 ? T.fleeTurnRate : T.turnRate;

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
    // The clip is chosen by how fast it is actually travelling, not by which
    // state it is in.
    //
    // A clip only carries speed/own inside the 0.82x-2.45x playback clamp, so
    // the walk (0.429 m/s native) tops out at 1.05 - and investigate has always
    // run at 2.2 on the walk clip, which is a five-fold skate nobody had put a
    // number to. Anything above runAbove now takes the run instead, which fixes
    // that and lets the brisk patrol stride be a jog rather than a glide.
    this.model.play(this.state === "chase" || this.state === "flee" ? "chase"
      : this.speedNow > T.runAbove ? "chase"
      : this.speedNow > 0.15 ? "walk" : "idle");
    this.model.update(dt, this.speedNow);

    return this.takes(player) ? "kill" : null;
  }

  /**
   * Is this person caught, right now?
   *
   * One definition, used by the host running the AI and by a guest checking
   * itself against the monster the host broadcasts. It used to be written out
   * twice and the two copies did not agree: the guest's was a bare distance
   * test, so a guest sprinting away with their back turned was taken on contact
   * while the host doing exactly the same thing was stalked and left alive. The
   * escape is the best mechanic in the game and half the lobby did not have it.
   */
  takes(player) {
    if (!player?.alive || this.state !== "chase") return false;
    const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    return d < T.killRange && this.canTake(player);
  }

  /**
   * Pick who to hunt, out of everyone still standing.
   *
   * The AI only ever saw the local player, which in a lobby meant the host was
   * the only person it could ever want - guests were scenery it happened to
   * walk through. Choosing every frame also means a catch re-paths it for free:
   * the person it was chasing simply stops being a candidate, and the next
   * nearest becomes the best answer on the very next tick.
   *
   * Seeing beats hearing beats proximity, and whoever it is already on gets a
   * small bonus so it does not dither between two people equally far away.
   */
  chooseQuarry(candidates) {
    let best = null, bestScore = -Infinity;
    for (const q of candidates) {
      if (!q.alive) continue;
      const d = Math.hypot(q.pos.x - this.pos.x, q.pos.z - this.pos.z);
      let score = -d;
      if (this.#sees(q)) score += 1000;
      else if (this.#hears(q)) score += 500;
      if (q.id && q.id === this.quarryId) score += 14;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    // Losing the one it was on is what a catch looks like from here, so drop
    // the state that would otherwise have it stand over the body.
    if (best && best.id !== this.quarryId) {
      this.quarryId = best.id;
      this.lostFor = 0;
      if (this.state === "chase" || this.state === "investigate") {
        this.target.set(best.pos.x, 0, best.pos.z);
      }
    }
    return best;
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

  /**
   * Is it hunting this player, looking straight at them, with a clear line?
   *
   * What the "oh god it has seen me" cue asks about. Deliberately not a
   * distance test: being noticed from across a clearing is the moment worth
   * reacting to, and it is a worse one than being noticed at arm's length
   * because there is still a whole clearing to get across.
   *
   * The line of sight matters as much as the angle. A tubby locked onto you
   * through a trunk is not looking at you in any sense you could react to.
   */
  eyesOnYou(player) {
    if (this.state !== "chase" || !player?.alive) return false;
    if (!this.#inCone(player.pos)) return false;
    const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    return !this.#blocked(player.pos, d);
  }

  #enter(state, at) {
    this.state = state;
    this.lostFor = 0;
    if (at) this.target.set(at.x, 0, at.z);
    else this.target = this.#wanderPoint();
  }

  /**
   * Swing round onto whatever that was, without breaking stride.
   *
   * The heading is set outright rather than steered, so the very next step is
   * already in the right direction; the rendered facing is left to catch up
   * over the following half second at the fast turn rate, which is what makes
   * it read as a head snapping round rather than a body teleporting.
   *
   * Deliberately not a stop. A thing that halts to stare gives you a moment to
   * use; a thing that simply corrects its course and keeps walking gives you
   * none, and is the worse of the two to be on the wrong end of.
   */
  #align(at) {
    this.heading = Math.atan2(at.x - this.pos.x, at.z - this.pos.z);
    this.alignLeft = T.alignHold;
    if (this.state === "patrol") this.#enter("investigate", at);
    else this.target.set(at.x, 0, at.z);
  }

  /**
   * Drive this tubby from the host's broadcast instead of from its own AI.
   *
   * Only the host simulates the CPU Tinky Winky; guests just render what they
   * are told. Running the AI on every client would give each player a different
   * monster in a different place, and no amount of interpolation fixes that.
   */
  netApply(pos, facing, state, dt, speed) {
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

    // How fast it is going is on the wire now, because it is no longer implied
    // by the state: a patrol picks a stride and keeps it, so a guest guessing
    // "walking, about 1.5" would have every wander at the wrong pace and the
    // brisk one skating badly.
    if (typeof speed === "number") this.speedNow = speed;

    this.root.position.set(this.pos.x, heightAt(this.pos.x, this.pos.z), this.pos.z);
    this.root.rotation.y = this.facing;
    // Same rule the host runs: the clip follows the speed, not the state.
    this.model.play(this.state === "chase" || this.state === "flee" ? "chase"
      : this.speedNow > T.runAbove ? "chase"
      : this.speedNow <= 0.15 ? "idle" : "walk");
    this.model.update(dt, this.state === "chase" ? T.chaseSpeed : this.speedNow);
  }

  /** Compact form for the wire. */
  netState() {
    return { p: [+this.pos.x.toFixed(2), 0, +this.pos.z.toFixed(2)],
             f: +this.facing.toFixed(3), s: this.state,
             v: +this.speedNow.toFixed(2) };
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
