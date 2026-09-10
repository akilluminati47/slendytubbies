import * as THREE from "three";
import { CFG } from "../game/config.js";
import { heightAt } from "../world/world.js";
import { makeTorch, torchFor } from "./torch.js";
import { locomotion, handAt } from "./tubbyModel.js";

const _dir = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _want = new THREE.Vector3();

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
    // Seconds the torch has been flat and unused, and whether it is on its way
    // back. See the recharge in update().
    this.flat = 0;
    this.recovering = false;
    this.torchOn = true;
    this.jumped = false;    // one-frame flags, read by main's audio
    this.stumbled = false;
    // Seconds left of a trip, and which branch we are standing on so that
    // crossing one fires once rather than every frame we are over it.
    this.stumble = 0;
    this.onBranch = -1;
    // Where the torch actually is, as opposed to where the gait wants it.
    this.torchAt = new THREE.Vector3();
    this.clicked = false;
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
    // --- and the reason the ground had a grid drawn on it ------------------
    //
    // The dark lines across the floor on a phone were shadow acne, not the
    // procedural surface: the terrain's own triangles self-shadowing, which is
    // why they only ever appeared inside the lit pool and why no amount of
    // shader precision made them go away. Depth bias alone is a fixed nudge in
    // depth units, and it was tuned against a desktop depth buffer; a phone's
    // is routinely half the bits, so the same number stopped clearing the
    // quantisation step and every triangle started shadowing itself.
    //
    // normalBias is the fix rather than a bigger depth bias. It moves the
    // lookup along the surface NORMAL, in metres, so it scales with how
    // glancing the light is - which is exactly when acne appears and exactly
    // what a fixed depth bias cannot know about. 6cm against a shadow texel
    // that covers about 4cm of ground at the far end of a 40m beam: enough to
    // clear the step on a coarse depth buffer, small enough that nothing
    // detaches from the thing casting it.
    //
    // The depth bias stays, much smaller, for the head-on case normalBias
    // barely moves.
    this.torch.shadow.bias = -0.0004;
    this.torch.shadow.normalBias = 0.06;
    this.torch.target.position.set(0, 0, -1);
    this.torch.add(this.torch.target);

    // The light and the thing holding it travel together. Everything that used
    // to move the bare light now moves this, so VR gets the prop in its hand
    // for free rather than a beam leaving an empty fist.
    this.torchRig = new THREE.Group();
    this.torchRig.add(this.torch);
    camera.add(this.torchRig);
    this.held = null;

    this.fill = new THREE.PointLight(0xbfd0e0, 6, 6, 1.6);
    camera.add(this.fill);
  }

  /**
   * Take everything this player hung off the camera back off it.
   *
   * A round used to end with a page reload, so nothing ever had to be undone.
   * Restarting in place instead means the constructor's camera.add() runs again
   * on the same camera - and the old rig was still on it: a torch frozen where
   * the last round left it, the new one bobbing beside it, and a second
   * shadow-casting SpotLight in the scene costing a depth pass a frame and
   * recompiling every material on the way in.
   */
  dispose() {
    this.torchRig.parent?.remove(this.torchRig);
    this.fill.parent?.remove(this.fill);
    this.torch.shadow?.map?.dispose();
    this.torch.dispose?.();
    this.fill.dispose?.();
    this.held = null;
  }

  /**
   * In VR the torch belongs in your hand, not glued to your eyeballs - being
   * able to point it independently of where you are looking is most of what
   * makes a VR horror game feel different.
   */
  attachTorchTo(node) {
    if (!node || this.torchRig.parent === node) return;
    node.add(this.torchRig);
    this.torchRig.position.set(0, 0, 0);
  }

  detachTorch() {
    if (this.torchRig.parent === this.cam) return;
    this.cam.add(this.torchRig);
    this.torchRig.position.set(0, 0, 0);
  }

  /**
   * Put the right torch in this player's hand.
   *
   * Called once the role is known, which is after construction - the Guardian
   * carries the searchlight and everybody else the slim black one, and the
   * SpotLight is widened to match so a bigger lamp actually throws a bigger
   * beam rather than the same cone behind a different shell.
   */
  setTorch(role) {
    if (this.held) {
      this.torchRig.remove(this.held.group);
      this.held = null;
    }
    this.held = makeTorch(torchFor(role));
    this.torchRig.add(this.held.group);
    this.torch.angle = this.held.angle;
    this.#showHeld(this.torchOn);
  }

  #showHeld(on) {
    if (!this.held) return;
    // Away entirely when it is off. A dark torch held permanently in the corner
    // of the screen is a prop you stop seeing, and it takes a quarter of the
    // view with it; putting it away means switching the torch on is something
    // that happens in your hand rather than only out in the world.
    this.held.group.visible = on;
  }

  /** Yaw the player is actually facing, headset rotation included. */
  viewYaw() {
    this.cam.getWorldDirection(_dir);
    return Math.atan2(-_dir.x, -_dir.z);
  }

  /**
   * What this body is visibly doing, in one word.
   *
   * This is what travels to the other players - they cannot see our intent
   * flags, our stamina or our velocity, only the result - so it is derived here
   * once rather than guessed at both ends.
   */
  get motion() {
    if (!this.grounded || this.lift > 0.02) return "jump";
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed < 0.6) return "idle";
    return this.sprinting ? "run" : "walk";
  }

  get sprinting() {
    // Not while going over. Recovering your feet is the cost of the trip, and
    // being able to sprint straight through one would make it scenery.
    return this.input.intent.sprint && this.stumble <= 0
      && this.stamina > 0.05 && this.vel.lengthSq() > 0.5;
  }

  /**
   * Go over: no launch, a crouch, a shake, and a bite out of the bar.
   *
   * Its own noise, and the biggest one there is. You did not leave the ground,
   * so this is not the landing's number - it is louder than the landing's,
   * because a body going down through dead wood with nothing caught quietly is
   * the least controlled sound in the game, and the only one you did not choose.
   */
  #trip() {
    this.stumble = CFG.player.stumbleTime;
    this.stamina = Math.max(0, this.stamina - CFG.player.stumbleCost);
    this.noiseBurst = Math.max(this.noiseBurst, CFG.noise.stumble);
    this.stumbled = true;
  }

  update(dt) {
    if (!this.alive) return;
    const intent = this.input.intent;
    this.jumped = false;
    this.stumbled = false;

    const wasLit = this.torchOn;
    if (intent.torch && this.battery > 0) this.torchOn = !this.torchOn;
    if (this.battery <= 0) this.torchOn = false;
    if (this.torchOn) this.battery = Math.max(0, this.battery - dt);

    // --- and it charges itself back up ------------------------------------
    //
    // The wait is counted only while the thing is actually flat and idle. Using
    // the beam at all sends it back to zero, so a player cannot sit at the top
    // of the ramp tapping the switch and drawing on it forever - the recovery
    // is for somebody who ran it dry and left it alone, which is the only
    // situation it is meant to rescue.
    // Whether it is recovering is its OWN state rather than a reading of the
    // battery, and that distinction is the whole of it: gating the timer on
    // "battery is empty" means the first scrap of charge the ramp puts in stops
    // the timer that is putting it there. It settles at three thousandths of a
    // second of torch and stays there forever, which is a very quiet way to do
    // nothing at all.
    if (this.torchOn) { this.flat = 0; this.recovering = false; }
    else if (this.battery <= 0.001) this.recovering = true;
    if (this.recovering) {
      this.flat += dt;
      const t = Math.min(1, Math.max(0, this.flat - CFG.player.rechargeWait)
                            / CFG.player.rechargeTime);
      // Smoothstep, so it starts slow, gathers, and settles rather than
      // arriving at a flat one second per second.
      this.battery = Math.max(this.battery,
                              CFG.player.rechargeTo * t * t * (3 - 2 * t));
    }
    // The beam is either fully on or fully off - no battery ramp, no threat
    // dimming, nothing. A torch that quietly fades is indistinguishable from the
    // scene getting darker, which makes it impossible to judge what you can see.
    this.torch.intensity = this.torchOn ? CFG.player.torchIntensity : 0;
    this.fill.intensity = this.torchOn ? 6 : 1.2;
    this.#showHeld(this.torchOn);
    // The switch was thrown - by the player, or by the battery running out
    // under them, which is worth hearing precisely because they did not do it.
    this.clicked = this.torchOn !== wasLit;

    // --- jump -----------------------------------------------------------
    // Coyote time: still jumpable for a moment after walking off a lip. Without
    // it, uneven terrain eats inputs and the jump feels broken rather than strict.
    this.sinceGrounded = this.grounded ? 0 : this.sinceGrounded + dt;
    this.stumble = Math.max(0, this.stumble - dt);
    const canJump = intent.jump && this.stumble <= 0
      && (this.grounded || this.sinceGrounded < CFG.player.coyoteTime);
    if (canJump && Math.random() < CFG.player.stumbleChance) {
      // The hop that did not happen. It consumes the input rather than
      // deferring it, so this is a missed jump and not one that fires late.
      this.#trip();
    } else if (canJump) {
      this.vy = CFG.player.jumpSpeed;
      this.grounded = false;
      this.sinceGrounded = CFG.player.coyoteTime;   // no double jump
      // A hop is a breath and a shout at the same time. It hands back a tenth
      // of the sprint bar, which is what makes it a way to keep running rather
      // than a way to clear a rock - and it is the loudest thing in the game,
      // so keeping it up means never being unheard again.
      //
      // The push-off is the quiet half of it though. What everything hears is
      // you coming down again, a moment later and a few metres along, which is
      // both the truer sound and the more useful one to be hunted by: a chain of
      // hops leaves a trail of thuds behind where you now are.
      this.stamina = Math.min(CFG.player.staminaMax,
                              this.stamina + CFG.player.jumpStamina);
      this.noiseBurst = Math.max(this.noiseBurst, CFG.noise.jump);
      // Raised for exactly one frame, for whoever wants to make a noise about
      // it. "grounded went false" is not the same event - walking off a lip
      // does that too, and a ledge should not sound like a jump.
      this.jumped = true;
    }
    if (!this.grounded || this.lift > 0) {
      this.vy -= CFG.player.gravity * dt;
      this.lift += this.vy * dt;
      if (this.lift <= 0) {
        // And here is the bill: the loudest one-shot in the game. Gated on how
        // fast you were falling, so stepping off a kerb does not ring it.
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

    // --- what is underfoot ----------------------------------------------
    // Asked after the collision pass, against where we ended up rather than
    // where we aimed. Crossing onto a stick fires once: standing on one and
    // turning round on the spot is not tripping over it twice.
    const was = this.onBranch;
    this.onBranch = this.grounded ? this.world.branchUnder(this.pos.x, this.pos.z) : -1;
    if (this.onBranch >= 0 && this.onBranch !== was && sprint && this.stumble <= 0
        && Math.random() < CFG.player.branchTripChance) {
      this.#trip();
    }

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
      //
      // The rate is the animation's, not a number chosen here. One footfall is
      // 2pi of `bob` - the head drops onto each foot, which is why the vertical
      // below runs at twice the sway - so the whole rig, the beam and the sound
      // all come off the same cadence as the legs everybody else can see.
      const gait = locomotion(speed);
      if (this.grounded) {
        this.bob += gait
          ? dt * Math.PI * 2 / gait.period
          : speed * dt * (sprint ? CFG.player.strideSprint : CFG.player.strideWalk);
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

      // The hand lags the head. A torch welded to the camera reads as a decal on
      // the lens; letting it fall behind a turn by a few hundredths of a second
      // and swing back is the whole difference between held and painted on.
      if (this.torchRig.parent === this.cam) {
        const k = Math.min(1, dt * 9);
        this.swayYaw = (this.swayYaw ?? this.input.yaw);
        let dy = this.input.yaw - this.swayYaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.swayYaw += dy * k;
        this.swayPitch = (this.swayPitch ?? this.input.pitch);
        this.swayPitch += (this.input.pitch - this.swayPitch) * k;
        this.torchRig.rotation.y = THREE.MathUtils.clamp(dy * 0.55, -0.22, 0.22);
        this.torchRig.rotation.x =
          THREE.MathUtils.clamp((this.input.pitch - this.swayPitch) * 0.5, -0.16, 0.16);
        // And a little bounce from the stride, so it moves when you walk -
        // plus a drift that never stops, so it moves when you do not.
        //
        // Standing still used to freeze the beam to the pixel, which reads as a
        // light bolted to the world rather than one somebody is holding up. The
        // three rates are deliberately unrelated, so the loop never lines up
        // and starts reading as a rhythm.
        this.breath = (this.breath ?? 0) + dt;
        // The idle drift never switches off now. It used to be scaled by how
        // still you were, so the hand that would not keep steady standing up
        // became perfectly steady the moment you walked - the two motions took
        // turns instead of adding up. A hand does both at once.
        const drift = CFG.player.idleSway;

        // The hand's own path, not a sine on the vertical.
        //
        // In the parade and on everybody else's screen this torch is parented
        // to a hand bone and goes wherever the clip takes it - which is a
        // flattened oval, mostly fore and aft, with the rise and fall a smaller
        // part of it and a quarter cycle out of step. What was here instead was
        // a pure up-and-down bounce, so the same character was holding its light
        // two different ways depending on who was looking.
        //
        // handAt gives the clip's shape and phase, normalised so its largest
        // excursion is 1; torchSwing says what that 1 is worth in metres up here
        // where the thing is 40 cm from a lens rather than out on an arm.
        handAt(gait?.hand, this.bob / (Math.PI * 4), _hand);
        const swing = CFG.player.torchSwing *
          Math.min(1, this.bobAmount / CFG.player.bobWalk);
        _want.set(
          _hand.x * swing + Math.sin(this.breath * 0.83) * drift,
          _hand.y * swing + Math.sin(this.breath * 1.31 + 1.1) * drift * 0.8,
          _hand.z * swing);

        // Followed, not tracked exactly.
        //
        // A hand is on the end of an arm and a lamp has weight; neither snaps to
        // a new position because the hips did. Reproducing the bone's path to
        // the millimetre put a full cycle of it through the lens every third of
        // a second at a sprint, which is a shake rather than a walk. An ease
        // takes the high end off by itself and leaves the low end alone, so a
        // stroll still swings and a sprint blurs into a sway - and the idle
        // drift, which is slower than either, passes through untouched.
        this.torchAt.lerp(_want, 1 - Math.exp(-CFG.player.torchEase * dt));
        this.torchRig.position.copy(this.torchAt);
        this.torchRig.rotation.z = Math.sin(this.breath * 0.61) * drift * 3.5
          - this.torchAt.x * CFG.player.torchRoll;
      }

      // Twice a stride up and down, once a stride side to side: the figure of
      // eight a head traces when it is walking rather than being winched.
      //
      // The sway has to go along the camera's OWN right, not along world X -
      // the rig carries no yaw outside VR, the camera does, so setting
      // position.x here would swing you east and west whichever way you were
      // facing.
      const bobY = Math.sin(this.bob) * this.bobAmount;
      const bobX = Math.sin(this.bob * 0.5) * this.bobAmount * CFG.player.bobSway;
      let roll = Math.sin(this.bob * 0.5) * CFG.player.bobRoll *
        (this.bobAmount / Math.max(CFG.player.bobSprint, 1e-6));

      // Going over: drop, wobble, come back up.
      //
      // The dip is raised to a power under one so it arrives almost at once and
      // recovers slowly, which is the shape of catching your own weight - a
      // symmetrical bounce would read as a deliberate crouch. The shake is a
      // fast wobble that dies with it, and it is a ROLL rather than a shove:
      // moving the camera sideways during a trip makes it look as though
      // something hit you.
      let dip = 0;
      if (this.stumble > 0) {
        const p = 1 - this.stumble / CFG.player.stumbleTime;
        const fade = 1 - p;
        dip = Math.sin(Math.PI * Math.pow(p, 0.42)) * 0.15;
        roll += Math.sin(p * 41) * 0.035 * fade * fade;
      }

      this.cam.position.set(
        bobX * Math.cos(this.input.yaw),
        CFG.player.height + bobY - dip,
        -bobX * Math.sin(this.input.yaw));
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
