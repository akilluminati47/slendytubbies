import * as THREE from "three";
import { CFG } from "../game/config.js";
import { makeTubby, STRIDE_GAIN, RATE } from "../entities/tubbyModel.js";
import { heightAt } from "../world/world.js";
import { makeTorch, torchFor, holdInHand, aimInHand, gripPoseFor }
  from "../entities/torch.js";

/**
 * Another player, drawn with the same tubby model the AI uses.
 *
 * State arrives at ~15 Hz, so positions are interpolated rather than snapped.
 * We deliberately lag one update behind the newest packet: rendering toward a
 * position we have already received is smooth, whereas extrapolating ahead of
 * the network guesses wrong every time someone changes direction and produces
 * the rubber-banding that makes cheap netcode obvious.
 *
 * Everything below the position exists so that a team-mate is legible from
 * across a clearing: which way they are looking, whether their torch is lit,
 * whether they are walking or sprinting, whether they are in the air. In a game
 * about finding ten dishes together in the dark, a silhouette that only ever
 * slides about at a fixed height is not somebody you can work with.
 */

/**
 * The models face +Z at yaw 0; a camera at yaw 0 looks down -Z. So a player's
 * view angle and the body angle that matches it are half a turn apart, and
 * pointing a remote at its own view yaw stood everyone backwards - walking
 * forwards while facing the way they had come.
 */
/** How long somebody else's stumble is visible for, and how far it tips them. */
const STUMBLE_SHOW = 0.55;
const STUMBLE_PITCH = 0.38;

const MODEL_FLIP = Math.PI;

/** Where the wire's one word lands on the model's clip table. */
const CLIP = {
  idle: "idle",
  walk: "walk",
  run: "chase",
  // There is no jump in the donor's 27 clips, and the airborne read comes from
  // the body actually leaving the ground rather than from the pose. The run's
  // extended stride is the nearest thing to a leap the rig owns.
  jump: "chase",
};

const EYE = 1.40;          // torch height on the model - the same eye the local
                           // camera sits at, so a beam leaves both at one height
const SPAWN_IN = 1.4;      // seconds of arriving before they are solid
const _fwd = new THREE.Vector3();

export class RemotePlayer {
  constructor(scene, { id, name, role, isHost }) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.isHost = isHost;
    this.scene = scene;

    this.model = makeTubby(role === "guardian" ? "guardian" : role);
    // Their feet follow the heightfield too, so a team-mate on a slope stands
    // on it rather than through it.
    this.model.groundAt = heightAt;
    this.root = this.model.root;
    this.root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.castShadow = true; });
    scene.add(this.root);

    this.target = new THREE.Vector3();
    this.current = new THREE.Vector3();
    this.targetYaw = 0;
    this.yaw = 0;             // body angle, in the model's own convention
    this.viewYaw = 0;         // where they are actually looking
    this.pitch = 0;
    this.lift = 0;            // metres above their own ground, so jumps show
    this.anim = "idle";
    this.speed = 0;
    // One-frame flags for main to turn into sound, and the seconds left of a
    // visible stagger. remote.js has no audio of its own on purpose: what a
    // body did belongs here, what it sounds like belongs where the listener is.
    this.didJump = false;
    this.didLand = false;
    this.didTrip = false;
    this.didClick = false;
    this.didSee = false;
    this.stumbleLeft = 0;
    // Footfalls, same shape as the monster's: seconds to the next one, and a
    // one-frame flag when it lands.
    this.stepLeft = 0;
    this.stepped = false;
    this.stepPower = 0;
    // A real velocity, not a magnitude. The AI needs the direction to tell
    // somebody running away from somebody running past - see Tubby.canTake,
    // which is the whole reason a guest could not escape the way a host can.
    this.vel = { x: 0, z: 0 };
    this.torchOn = false;
    // One-shot metres of noise, decaying, exactly as the local player's does.
    // Without this a guest jumping or grabbing a dish was silent to the monster
    // while the host doing the same thing was heard across the map.
    this.noiseBurst = 0;
    this.seen = false;
    this.dead = false;

    // --- their torch -------------------------------------------------------
    // Built once and left in the scene with its intensity at zero when off.
    // Adding or removing a light changes the light count, and every material in
    // the scene recompiles when that happens - which on a torch being flicked
    // on and off is a stutter for everybody in the lobby.
    //
    // No shadows. The player's own torch is the one shadow-caster in the game
    // and it stays that way; three more would buy three more depth passes to
    // light people who are usually somewhere else.
    // Same reach as the one you carry yourself. A team-mate whose torch stopped
    // six metres short of where yours does is a team-mate you cannot read the
    // ground by, which is most of what lighting each other is for.
    this.torch = new THREE.SpotLight(0xfff0cf, 0, 40, 0.46, 0.55, 1.1);
    this.torch.castShadow = false;
    // Aimed in world space rather than parented to the body. The body turns to
    // face where it is walking and the beam follows where they are looking;
    // keeping both in one frame of reference is what makes a torch swing across
    // the trees when somebody strafes.
    this.torchAim = new THREE.Object3D();
    this.torch.target = this.torchAim;
    scene.add(this.torch, this.torchAim);

    // The torch in their hand, so a lit team-mate is visibly carrying the thing
    // doing the lighting - and the Guardian is visibly the one with the lamp.
    // Its beam cone is off: the SpotLight above already throws the light, and
    // two shafts from two places on the same body reads as a bug.
    let hand = null;
    this.root.traverse((o) => {
      if (!hand && o.isBone && /^hand[_ ]?r([_ ]|$)/i.test(o.name)) hand = o;
    });
    this.held = makeTorch(torchFor(role));
    // The cone angle belongs to the lamp, not to a constant: the Guardian's
    // throws wider, and it should do that for everybody watching and not only
    // for the Guardian.
    this.torch.angle = this.held.angle;
    if (hand && holdInHand(this.held, hand, this.root)) {
      this.held.beam.visible = false;
      this.held.group.visible = false;
      // Re-aimed after every pose. Held once and left, it inherits the arm -
      // so a team-mate's beam would swing off wherever their wrist had rolled
      // to, which is nothing to do with where they are looking.
      const held = this.held;
      this.model.afterPose = () => {
        if (held.group.visible) aimInHand(held, hand, this.root);
      };
    } else {
      this.held = null;
    }

    this.label = makeLabel(name, isHost);
    this.label.position.y = 2.25;
    this.root.add(this.label);

    // Their own copies of every material, so fading one avatar in cannot reach
    // any other model built from the same cached character - the menu parade
    // draws from that same cache.
    this.mats = [];
    this.root.traverse((o) => {
      if ((!o.isMesh && !o.isSkinnedMesh) || o === this.label) return;
      const own = (m) => {
        const c = m.clone();
        // clone() copies the documented properties and nothing else, and the
        // belly screen lives entirely in an onBeforeCompile hook - lose that
        // and the television goes back to being a photograph of static.
        c.onBeforeCompile = m.onBeforeCompile;
        c.customProgramCacheKey = m.customProgramCacheKey;
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) this.mats.push({ m, depth: m.depthWrite });
    });

    this.spawnLeft = 0;
    this.spawnAge = 0;
    this.blinkPhase = 0;
    this.spawnIn();
  }

  /**
   * Arrive, rather than simply be there.
   *
   * Somebody appearing in the world as a finished object at full opacity reads
   * as a rendering glitch; a thing that blinks itself into existence reads as
   * having arrived. The blink also does a job beyond the look - it is the only
   * moment where you can be sure which of the shapes in the clearing just
   * turned up, which matters most at the start of a round when everybody is
   * stood together and none of the names are legible yet.
   */
  spawnIn() {
    this.spawnLeft = SPAWN_IN;
    this.spawnAge = 0;
    this.blinkPhase = 0;
  }

  /**
   * One frame of arriving.
   *
   * Transparency is turned on for the duration and off again at the end rather
   * than left on: three sorts transparent objects separately and skips their
   * depth write, and a tubby permanently in that bucket would draw through its
   * own aerial. Toggling the flag costs nothing - it changes blend state, not
   * the compiled program.
   */
  #materialise(dt) {
    if (this.spawnLeft <= 0) return;
    this.spawnLeft -= dt;
    this.spawnAge += dt;
    const done = this.spawnLeft <= 0;
    const p = done ? 1 : 1 - this.spawnLeft / SPAWN_IN;

    // A blink that closes up as it settles: fast and mostly-off to begin with,
    // slower and mostly-on by the end, over a floor that rises to opaque.
    //
    // The phase is accumulated rather than computed as age x rate. Putting a
    // falling rate inside the argument makes the phase quadratic, and its
    // derivative goes negative near the end - the flicker literally runs
    // backwards, which showed up as one long dark stretch where the settle
    // should have been.
    this.blinkPhase += dt * (30 - 18 * p);
    const lit = Math.sin(this.blinkPhase) > 0.55 - p * 1.4;
    const floor = p * p * p;
    const v = done ? 1 : Math.min(1, floor + (lit ? 0.72 : 0.08) * (1 - floor));

    for (const { m, depth } of this.mats) {
      m.transparent = !done;
      m.opacity = v;
      m.depthWrite = done ? depth : false;
    }
    this.label.material.opacity = this.dead ? 0.35 : v;
  }

  apply({ pos, yaw, pitch, anim, lit, trip, saw }) {
    if (pos) {
      this.target.set(pos[0], 0, pos[2]);
      // The middle slot is height above their ground, not world Y - see
      // NetClient.sendState. Taken as given rather than eased: a hop lasts
      // 0.6s and smoothing it turns a jump into a shrug.
      this.lift = pos[1] || 0;
      if (!this.seen) {
        // First packet: place them, do not slide in from the origin.
        this.current.copy(this.target);
        this.seen = true;
      }
    }
    if (typeof yaw === "number") this.viewYaw = yaw;
    if (typeof pitch === "number") this.pitch = pitch;
    if (anim) {
      // The two ends of the hop, not the flight between them. Held as bursts
      // rather than read off the state so they decay on the same curve the local
      // player's do - otherwise a guest is loud for exactly as long as they are
      // airborne and the host is loud for a second and a half afterwards.
      //
      // Leaving the state is the landing, and it is the loud one. All a remote
      // sends is which of four things it is doing, so that transition is the
      // only landing there is to hear - and it lands a frame or two late, which
      // at this range is nothing.
      if (anim === "jump" && this.anim !== "jump") {
        this.heard(CFG.noise.jump);
        this.didJump = true;
      }
      if (anim !== "jump" && this.anim === "jump") {
        this.heard(CFG.noise.land);
        this.didLand = true;
      }
      this.anim = anim;
    }
    // A torch going on or off is a switch somebody threw, and at night it is
    // often the only thing that tells you a team-mate is still out there.
    if (lit !== undefined) {
      if (!!lit !== this.torchOn) this.didClick = true;
      this.torchOn = !!lit;
    }
    // Somebody else went over. A stumble is not one of the four things `anim`
    // can say, and it lasts a single frame against a packet every fifteenth of
    // one, so it travels as its own flag latched at the sender - otherwise a
    // guest could trip in front of the monster and make no sound at all, and
    // the loudest event in the game would be the host's alone.
    if (trip) {
      this.heard(CFG.noise.stumble);
      this.didTrip = true;
      this.stumbleLeft = STUMBLE_SHOW;
    }
    // Somebody's first sight of the thing. Carries no noise for the monster -
    // it is a squeak, not a shout - but the people they are playing with should
    // absolutely hear it, and hear which direction it came from.
    if (saw) this.didSee = true;
  }

  /**
   * Count their footfalls, so main can make a noise about them.
   *
   * Off the clip and its clamped playback, the same rule the local player and
   * the monster use - so all three sets of feet in a lobby are paced by one
   * rule rather than three, and a team-mate running past you sounds like the
   * legs you can see rather than a loop somebody chose the speed of.
   *
   * Nothing here is networked. Every client already knows where everyone is and
   * how fast they are going, so a footstep is cheaper to work out than to send.
   */
  #tickSteps(dt, clip) {
    this.stepped = false;
    if (this.dead || clip === "idle" || this.anim === "jump" || this.speed < 0.5) {
      this.stepLeft = Math.min(this.stepLeft, 0.08);
      return;
    }
    const c = this.model.byState?.get(clip);
    const own = (c?.userData?.groundSpeed ?? 0) * STRIDE_GAIN;
    if (!(own > 0) || !c?.duration) return;
    const playback = Math.min(Math.max(this.speed / own, RATE.min), RATE.max);
    this.stepLeft -= dt;
    if (this.stepLeft > 0) return;
    this.stepLeft += c.duration / (2 * playback);
    this.stepped = true;
    this.stepPower = Math.min(1, this.speed / CFG.player.sprintSpeed);
  }

  /** They just did something loud. Metres of hearing radius, one shot. */
  heard(metres) {
    this.noiseBurst = Math.max(this.noiseBurst, metres);
  }

  /**
   * How far away they can be heard from, in metres.
   *
   * The wire carries a word and a speed, not a noise budget, so this rebuilds
   * the local player's own model (Player.update) from what did arrive. It has
   * to agree with that model or the monster hunts guests and hosts by different
   * rules, which is exactly the unfairness this is here to remove.
   */
  get noise() {
    if (this.dead) return 0;
    const n = CFG.noise, base = CFG.tubby.hearingBase;
    let loud = n.idle;
    if (this.anim === "run") loud = n.sprint;
    else if (this.anim === "walk" || this.anim === "jump") {
      loud = n.walk * Math.min(1, this.speed / CFG.player.walkSpeed);
    }
    return Math.max(base * loud, this.noiseBurst);
  }

  update(dt, camera) {
    const prevX = this.current.x, prevZ = this.current.z;
    // 12/s converges in well under one network tick without visible stepping.
    this.current.lerp(this.target, Math.min(1, dt * 12));
    const vx = (this.current.x - prevX) / Math.max(dt, 1e-4);
    const vz = (this.current.z - prevZ) / Math.max(dt, 1e-4);
    // Eased, because a velocity read off two interpolated positions is noisy
    // enough to flicker the AI's "are they running away from me" test on and
    // off between frames.
    const k = Math.min(1, dt * 8);
    this.vel.x += (vx - this.vel.x) * k;
    this.vel.z += (vz - this.vel.z) * k;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // Same 22 m/s decay as the local player's, so a pickup rings out and fades
    // rather than pinning the monster to whoever took it.
    this.noiseBurst = Math.max(0, this.noiseBurst - dt * 22);

    // --- which way the body points -----------------------------------------
    // Where they are going while they are going somewhere, where they are
    // looking when they are not. That is the difference between a team-mate
    // walking backwards watching the treeline and one who is moonwalking.
    const view = this.viewYaw + MODEL_FLIP;
    this.targetYaw = this.speed > 0.8 ? Math.atan2(this.vel.x, this.vel.z) : view;

    let d = this.targetYaw - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 10);

    const ground = heightAt(this.current.x, this.current.z);
    this.root.position.set(this.current.x, ground + this.lift, this.current.z);
    // Going over, from the outside: a pitch forward that decays. Not a dip in
    // height, which would push the feet through the ground the leg solver has
    // just stood them on - this rotates the whole body about its base, which is
    // what catching a foot actually does to somebody.
    if (this.stumbleLeft > 0) {
      this.stumbleLeft = Math.max(0, this.stumbleLeft - dt);
      const p = 1 - this.stumbleLeft / STUMBLE_SHOW;
      this.root.rotation.x = -Math.sin(Math.PI * Math.pow(p, 0.45)) * STUMBLE_PITCH;
    } else if (this.root.rotation.x) {
      this.root.rotation.x = 0;
    }
    // So the ground fit knows the difference between standing and mid-hop - see
    // TubbyModel#standOnGround.
    this.model.lift = this.lift;
    if (!this.dead) this.root.rotation.y = this.yaw;

    // --- and where the head is pointed -------------------------------------
    let off = view - this.yaw;
    while (off > Math.PI) off -= Math.PI * 2;
    while (off < -Math.PI) off += Math.PI * 2;
    this.model.look?.(this.dead ? 0 : off, this.dead ? 0 : this.pitch);

    const clip = this.dead ? "idle" : (CLIP[this.anim] ?? "walk");
    this.model.play(clip);
    this.model.update(dt, this.speed);
    this.#tickSteps(dt, clip);

    this.#aimTorch(ground);
    this.#materialise(dt);

    // Name tags face the viewer, and only the viewer.
    if (camera) this.label.quaternion.copy(camera.quaternion);
  }

  /** Put their beam where they are looking, in world space. */
  #aimTorch(ground) {
    const on = this.torchOn && !this.dead;
    this.torch.intensity = on ? CFG.player.torchIntensity : 0;
    if (this.held) this.held.group.visible = on;
    // Their hand closes on it and opens again when they put it away - on the
    // pose for the torch they are actually carrying, since the Guardian's hand
    // goes over a handle where everyone else's shuts round a barrel.
    this.model.grip?.(on ? gripPoseFor(torchFor(this.role)) : null);
    if (!on) return;
    const y = ground + this.lift + EYE;
    this.torch.position.set(this.current.x, y, this.current.z);
    // Camera convention, because that is the frame the angle was measured in:
    // a view at yaw v and pitch p looks along (-sin v cos p, sin p, -cos v cos p).
    const cp = Math.cos(this.pitch);
    _fwd.set(-Math.sin(this.viewYaw) * cp, Math.sin(this.pitch), -Math.cos(this.viewYaw) * cp);
    this.torchAim.position.set(
      this.current.x + _fwd.x * 12, y + _fwd.y * 12, this.current.z + _fwd.z * 12);
  }

  /** A caught player stays on the map as a body - you should see who went down. */
  setDead(on) {
    this.dead = !!on;
    this.model.play(on ? "idle" : this.anim);
    this.model.look?.(0, 0);
    this.label.material.opacity = on ? 0.35 : 1;
    this.root.rotation.z = on ? Math.PI * 0.42 : 0;
    // The torch goes out with them. A beam still sweeping out of a body is the
    // sort of thing you lose an evening to.
    if (on) { this.torchOn = false; this.torch.intensity = 0; }
  }

  dispose(scene) {
    scene.remove(this.root, this.torch, this.torchAim);
    this.torch.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.label.geometry.dispose();
  }
}

function makeLabel(name, isHost) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d");
  ctx.font = "600 30px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = isHost ? "#c9e0cd" : "#d8d2c4";
  ctx.fillText(isHost ? `${name} ★` : name, 128, 34);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false,
    // Visible through trees on purpose: losing a team-mate behind scenery in a
    // fog this thick is frustrating, not tense.
    depthTest: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.28), mat);
  mesh.renderOrder = 900;
  return mesh;
}
