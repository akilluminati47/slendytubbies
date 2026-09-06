import * as THREE from "three";

/**
 * Being caught, as something you watch happen to you.
 *
 * Cutting straight from play to a black card with the word CAUGHT on it tells
 * the player they lost without ever showing them what got them, and the mask is
 * the best thing in the game. So the camera is taken away and made to do two
 * things a person cannot: it whips round to find the thing, and then it swings
 * out in front of its face, because from where you were standing when it reached
 * you the only thing on offer is the back of its head.
 *
 * The recording drives the length. The screen holds on the mask until the sound
 * stops and the game over card lands in the silence after it, so the two are
 * never competing for the same moment.
 */

const TURN = 0.34;      // seconds spent whipping round to find it
const SWING = 0.66;     // then coming round in front of the face
const NEAR_FOV = 26;    // degrees once we are there
const STANDOFF = 0.92;  // metres left between the lens and its face
const RISE = -0.06;     // and a shade below the mask, so it looms over the lens

export class Jumpscare {
  /**
   * Takes the chaser itself rather than just its model: the swing needs to know
   * which way the thing is facing, and only the entity knows that.
   */
  constructor({ camera, rig, input, tubby, seconds, onDone }) {
    this.camera = camera;
    this.rig = rig;
    this.input = input;
    this.tubby = tubby;
    this.onDone = onDone;
    // A floor under the timing: if the recording failed to load we still want
    // the whole gesture rather than a snap to the card mid-turn.
    this.seconds = Math.max(seconds || 0, TURN + SWING + 0.4);
    this.t = 0;
    this.push = 0;       // 0..1 through the swing, for whoever is dimming things
    this.done = false;

    this.baseFov = camera.fov;
    this.fromYaw = input.yaw;
    this.fromPitch = input.pitch;
    this.head = new THREE.Vector3();
    this.want = new THREE.Vector3();
    this.startPos = rig.position.clone();
    // Eye height above the rig, frozen. Player.update normally maintains this
    // along with the head bob, and it is not running while we hold the camera.
    this.eye = camera.position.y;
    // Which way it was pointing when it got you, taken once. Reading it live
    // makes the orbit chase a moving target and the mask drifts out of frame.
    this.face = tubby.facing ?? 0;
    // Where it stood, so nothing can walk it out of the shot.
    this.anchor = tubby.root.position.clone();
  }

  /** Hold the chaser exactly where it caught you, for as long as this runs. */
  pin() {
    this.tubby.root.position.copy(this.anchor);
    this.tubby.root.rotation.y = this.face;
  }

  /** Ease that starts fast and settles, which is how a head snaps round. */
  static #snap(x) { return 1 - (1 - x) ** 3; }

  update(dt) {
    if (this.done) return;
    this.t += dt;

    this.pin();
    // The face, not the head joint: that joint sits at the crown.
    this.tubby.model.faceWorld(this.head);

    // The model faces +Z at yaw 0, so this is the direction its mask points.
    const face = this.face;

    // --- come round to the front -------------------------------------------
    this.push = Math.min(1, Math.max(0, (this.t - TURN) / SWING));
    if (this.push > 0) {
      const eased = Jumpscare.#snap(this.push);
      // The rig is the floor the camera stands on, and the camera rides `eye`
      // above it, so aim the RIG low enough that the LENS ends up level with the
      // mask. Without that subtraction the camera parks a head-height above it
      // and spends the whole shot looking at the top of its scalp.
      this.want.set(
        this.head.x + Math.sin(face) * STANDOFF,
        this.head.y - this.eye + RISE,
        this.head.z + Math.cos(face) * STANDOFF);
      this.rig.position.lerpVectors(this.startPos, this.want, eased);

      this.camera.fov = this.baseFov + (NEAR_FOV - this.baseFov) * eased;
      this.camera.updateProjectionMatrix();
    }

    // --- and keep it in the middle of the frame throughout ------------------
    const at = this.rig.position;
    const dx = this.head.x - at.x, dz = this.head.z - at.z;
    const flat = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = Math.atan2(this.head.y - (at.y + this.eye), Math.max(flat, 0.01));

    // Take the short way round, or a turn to the left goes the long way about.
    let spin = wantYaw - this.fromYaw;
    while (spin > Math.PI) spin -= Math.PI * 2;
    while (spin < -Math.PI) spin += Math.PI * 2;

    const turn = Jumpscare.#snap(Math.min(1, this.t / TURN));
    // Once the whip round is done the aim is absolute, so the camera stays
    // locked on the face while it flies round it.
    this.input.yaw = turn < 1 ? this.fromYaw + spin * turn : wantYaw;
    this.input.pitch = turn < 1
      ? this.fromPitch + (wantPitch - this.fromPitch) * turn : wantPitch;

    // A shudder that grows as it arrives. Small: the lens is doing the work.
    const shake = 0.014 * this.push;
    this.input.yaw += Math.sin(this.t * 71) * shake;
    this.input.pitch += Math.sin(this.t * 53) * shake * 0.7;

    // Apply it ourselves. Player.update is what normally turns input.yaw and
    // input.pitch into a camera, and the frame loop skips it while this runs -
    // so writing the intent and stopping there left the camera pointing wherever
    // it happened to be when the thing caught you.
    this.rig.rotation.set(0, 0, 0);
    this.camera.position.set(0, this.eye, 0);
    this.camera.rotation.set(this.input.pitch, this.input.yaw, 0, "YXZ");

    if (this.t >= this.seconds) {
      this.done = true;
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
      this.onDone?.();
    }
  }
}
