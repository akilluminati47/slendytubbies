import * as THREE from "three";
import { CFG } from "../game/config.js";
import { heightAt } from "../world/world.js";

const _dir = new THREE.Vector3();

export class Player {
  /**
   * The camera is never positioned directly. It hangs off `rig`, and we move
   * the rig. That is what makes VR work: while presenting, WebXR owns the
   * camera's local transform (head tracking), and writing to it would fight the
   * headset. Flat and VR then share one locomotion path instead of two.
   */
  constructor(camera, input, world, rig) {
    this.cam = camera;
    this.input = input;
    this.world = world;
    this.rig = rig;

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.stamina = CFG.player.staminaMax;
    this.battery = CFG.player.batteryMax;
    this.torchOn = true;
    this.noise = 0;        // metres of hearing radius this frame
    this.bob = 0;
    this.bobAmount = 0;    // eased, so bob never starts or stops abruptly
    this.alive = true;

    // Vertical state. `lift` is height above the terrain, so the terrain itself
    // stays the ground truth and jumping never desyncs from the heightfield.
    this.lift = 0;
    this.vy = 0;
    this.grounded = true;
    this.sinceGrounded = 0;
    this.noiseBurst = 0;   // one-shot noise (pickup, landing) that decays

    // One shadow-casting light in the whole scene: your own torch. A tubby that
    // throws a shadow across a tree is how you notice it before it reaches you.
    this.torch = new THREE.SpotLight(0xfff0cf, 420, 40, 0.44, 0.5, 1.1);
    this.torch.castShadow = true;
    this.torch.shadow.mapSize.set(1024, 1024);
    this.torch.shadow.camera.near = 0.4;
    this.torch.shadow.camera.far = 40;
    this.torch.shadow.bias = -0.0015;
    this.torch.target.position.set(0, 0, -1);
    this.torch.add(this.torch.target);
    camera.add(this.torch);

    this.fill = new THREE.PointLight(0xbfd0e0, 6, 6, 1.6);
    camera.add(this.fill);
  }

  /**
   * In VR the torch belongs in your hand, not glued to your eyeballs - being
   * able to point it independently of where you are looking is most of what
   * makes a VR horror game feel different.
   */
  attachTorchTo(node) {
    if (!node || this.torch.parent === node) return;
    node.add(this.torch);
    this.torch.position.set(0, 0, 0);
  }

  detachTorch() {
    if (this.torch.parent === this.cam) return;
    this.cam.add(this.torch);
    this.torch.position.set(0, 0, 0);
  }

  /** Yaw the player is actually facing, headset rotation included. */
  viewYaw() {
    this.cam.getWorldDirection(_dir);
    return Math.atan2(-_dir.x, -_dir.z);
  }

  get sprinting() {
    return this.input.intent.sprint && this.stamina > 0.05 && this.vel.lengthSq() > 0.5;
  }

  update(dt) {
    if (!this.alive) return;
    const intent = this.input.intent;

    if (intent.torch && this.battery > 0) this.torchOn = !this.torchOn;
    if (this.battery <= 0) this.torchOn = false;
    if (this.torchOn) this.battery = Math.max(0, this.battery - dt);
    // The beam is either fully on or fully off - no battery ramp, no threat
    // dimming, nothing. A torch that quietly fades is indistinguishable from the
    // scene getting darker, which makes it impossible to judge what you can see.
    this.torch.intensity = this.torchOn ? CFG.player.torchIntensity : 0;
    this.fill.intensity = this.torchOn ? 6 : 1.2;

    // --- jump -----------------------------------------------------------
    // Coyote time: still jumpable for a moment after walking off a lip. Without
    // it, uneven terrain eats inputs and the jump feels broken rather than strict.
    this.sinceGrounded = this.grounded ? 0 : this.sinceGrounded + dt;
    if (intent.jump && (this.grounded || this.sinceGrounded < CFG.player.coyoteTime)) {
      this.vy = CFG.player.jumpSpeed;
      this.grounded = false;
      this.sinceGrounded = CFG.player.coyoteTime;   // no double jump
    }
    if (!this.grounded || this.lift > 0) {
      this.vy -= CFG.player.gravity * dt;
      this.lift += this.vy * dt;
      if (this.lift <= 0) {
        // Landing is loud - a jump is a fast way to move and it should cost you.
        if (this.vy < -3) this.noiseBurst = Math.max(this.noiseBurst, CFG.noise.land);
        this.lift = 0;
        this.vy = 0;
        this.grounded = true;
      }
    }

    // --- movement -------------------------------------------------------
    const sprint = this.sprinting;
    const target = sprint ? CFG.player.sprintSpeed : CFG.player.walkSpeed;

    // Rotate the stick vector into world space by the direction we are facing.
    // three.js cameras look down -Z, so at yaw θ forward is (-sinθ, -cosθ) and
    // right is (cosθ, -sinθ). intent.move.z is negative for forward, hence:
    //   world = right * move.x + forward * (-move.z)
    const yaw = this.viewYaw();
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const wishX = (intent.move.x * cos + intent.move.z * sin) * target;
    const wishZ = (-intent.move.x * sin + intent.move.z * cos) * target;

    const moving = wishX !== 0 || wishZ !== 0;
    const k = 1 - Math.exp(-(moving ? CFG.player.accel : CFG.player.friction) * dt);
    this.vel.x += (wishX - this.vel.x) * k;
    this.vel.z += (wishZ - this.vel.z) * k;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.world.resolve(this.pos, CFG.player.radius);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (sprint) this.stamina = Math.max(0, this.stamina - dt);
    else this.stamina = Math.min(CFG.player.staminaMax, this.stamina + dt * CFG.player.staminaRegen);

    // --- noise ----------------------------------------------------------
    const n = CFG.noise;
    let loud = n.idle;
    if (speed > 0.4) loud = sprint ? n.sprint : n.walk * (speed / CFG.player.walkSpeed);
    this.noise = CFG.tubby.hearingBase * loud;
    // Bursts are already in metres and decay over about a second, so a pickup
    // rings out and then fades rather than pinning the tubby to you forever.
    this.noise = Math.max(this.noise, this.noiseBurst);
    this.noiseBurst = Math.max(0, this.noiseBurst - dt * 22);

    // --- place the rig ---------------------------------------------------
    const ground = heightAt(this.pos.x, this.pos.z) + this.lift;
    this.rig.position.set(this.pos.x, ground, this.pos.z);

    if (this.input.inVR) {
      // Headset supplies head height and look; we only supply comfort turning.
      this.rig.rotation.set(0, this.input.yaw, 0);
    } else {
      this.rig.rotation.set(0, 0, 0);
      // No head bob in the air; it reads as a stumble rather than a stride.
      if (this.grounded) {
        this.bob += speed * dt *
          (sprint ? CFG.player.strideSprint : CFG.player.strideWalk);
      }

      // Ease the AMPLITUDE rather than snapping it on at full size. Stepping
      // straight to peak bob on the first frame of movement is most of what
      // makes bob feel like a camera bug instead of footfalls, and sprinting
      // exaggerated it worst of all.
      const want = this.grounded && speed > 0.35
        ? (sprint ? CFG.player.bobSprint : CFG.player.bobWalk) *
          Math.min(1, speed / CFG.player.walkSpeed)
        : 0;
      this.bobAmount += (want - this.bobAmount) * Math.min(1, dt * CFG.player.bobEase);

      const bobY = Math.sin(this.bob) * this.bobAmount;
      const roll = Math.sin(this.bob * 0.5) * CFG.player.bobRoll *
        (this.bobAmount / Math.max(CFG.player.bobSprint, 1e-6));
      this.cam.position.set(0, CFG.player.height + bobY, 0);
      this.cam.rotation.set(this.input.pitch, this.input.yaw, roll, "YXZ");
    }
  }

  /**
   * Walk-over pickup: no button, no hold. Returns the tank taken this frame.
   *
   * Grabbing one is loud (CFG.noise.pickup), so the tension moves from "stand
   * still and be heard" to "you just announced exactly where you are".
   */
  tickCollect(dt, custards) {
    this.nearCustard = null;
    let best = Infinity;
    for (const c of custards) {
      if (c.taken) continue;
      const d = Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z);
      // Only flag one you are actually near, or the HUD nags for the whole game.
      if (d < best && d < CFG.player.hintRadius) { best = d; this.nearCustard = c; }
    }
    if (this.nearCustard && best < CFG.player.pickupRadius) {
      this.noiseBurst = Math.max(this.noiseBurst, CFG.noise.pickup);
      const got = this.nearCustard;
      this.nearCustard = null;
      return got;
    }
    return null;
  }
}
