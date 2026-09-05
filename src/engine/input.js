import { CFG } from "../game/config.js";
import { blankIntent, mergeIntent, Edge } from "./intent.js";
import { GamepadSource } from "./gamepad.js";
import { TouchSource } from "./touch.js";
import { XRSource } from "./xr.js";

/**
 * Owns yaw/pitch and merges every device into one intent per frame.
 *
 * Sources are polled unconditionally and contribute nothing when idle, so a
 * player can pick up a pad mid-game, put it down, and carry on with the mouse
 * without any mode switch. In VR the headset owns pitch, so we stop applying
 * it there - injecting pitch into an HMD is an instant nausea bug.
 */
export class Input {
  constructor(canvas, renderer, rig) {
    this.canvas = canvas;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.wantLock = false;   // does the game want the mouse captured right now?
    this.edge = new Edge();
    this.intent = blankIntent();

    this.gamepad = new GamepadSource();
    this.touch = new TouchSource();
    this.xr = new XRSource(renderer, rig);

    this.#wireKeyboard();
    this.#wireMouse();
    this.#wireRecapture();
  }

  get inVR() { return this.xr.presenting; }

  #wireKeyboard() {
    addEventListener("keydown", (e) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
        e.preventDefault();
      }
      if (!e.repeat) this.keys.add(e.code);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
  }

  #wireMouse() {
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.keys.clear();
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked && !this.dragging) return;
      this.mouseDX = (this.mouseDX || 0) + e.movementX;
      this.mouseDY = (this.mouseDY || 0) + e.movementY;
    });
  }

  /**
   * Free mouse look via pointer lock. Drag-look is a LAST RESORT, only enabled
   * when a lock request actually rejects - never on a timer. The old timer
   * version latched drag-look on during the normal request latency and left the
   * game feeling like click-to-look even once pointer lock had succeeded.
   */
  lock() {
    this.wantLock = true;
    if (this.xr.presenting || this.locked) return;

    let req;
    try {
      // unadjustedMovement gives raw deltas with no OS mouse acceleration, which
      // is what an FPS wants. Chrome rejects the options form if unsupported, so
      // fall back to the plain call.
      req = this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      req = this.canvas.requestPointerLock();
    }

    if (req && typeof req.catch === "function") {
      req.catch((err) => {
        if (err?.name === "NotSupportedError") {
          // unadjustedMovement not available - plain lock is fine.
          try { this.canvas.requestPointerLock(); return; } catch { /* fall through */ }
        }
        if (err?.name === "SecurityError") {
          // Chrome enforces a cooldown after an exit; one retry clears it.
          clearTimeout(this.relockTimer);
          this.relockTimer = setTimeout(() => this.lock(), 1300);
          return;
        }
        this.#enableDragLook();
      });
    }
  }

  /** Click anywhere in the game to recapture the mouse after Esc or a tab-out. */
  #wireRecapture() {
    this.canvas.addEventListener("mousedown", () => {
      if (this.wantLock && !this.locked && !this.xr.presenting) this.lock();
    });
  }

  #enableDragLook() {
    if (this.dragLook) return;
    this.dragLook = true;
    console.info("[input] pointer lock refused - hold the left mouse button to look");
    this.canvas.addEventListener("mousedown", () => (this.dragging = true));
    addEventListener("mouseup", () => (this.dragging = false));
  }

  /** Called when the game deliberately gives the mouse back (pause, game over). */
  release() {
    this.wantLock = false;
    clearTimeout(this.relockTimer);
  }

  down(code) { return this.keys.has(code); }

  #keyboardIntent() {
    const i = blankIntent();
    const on = (...c) => c.some((k) => this.keys.has(k));

    i.move.x = (on("KeyD", "ArrowRight") ? 1 : 0) - (on("KeyA", "ArrowLeft") ? 1 : 0);
    i.move.z = (on("KeyS", "ArrowDown") ? 1 : 0) - (on("KeyW", "ArrowUp") ? 1 : 0);
    const len = Math.hypot(i.move.x, i.move.z);
    if (len > 1) { i.move.x /= len; i.move.z /= len; }

    i.look.x = -(this.mouseDX || 0) * CFG.player.mouseSens;
    i.look.y = -(this.mouseDY || 0) * CFG.player.mouseSens;
    this.mouseDX = this.mouseDY = 0;

    i.sprint = on("ShiftLeft", "ShiftRight");
    i.jump = this.edge.hit("kb-jump", on("Space"));
    i.torch = this.edge.hit("kb-torch", on("KeyF"));
    i.menu = this.edge.hit("kb-menu", on("Escape"));
    return i;
  }

  /** Call once per frame, before anything reads this.intent. */
  update(dt) {
    const i = blankIntent();
    mergeIntent(i, this.#keyboardIntent());
    mergeIntent(i, this.gamepad.poll(dt));
    mergeIntent(i, this.touch.poll(dt));
    if (this.xr.presenting) mergeIntent(i, this.xr.poll(dt));

    this.yaw += i.look.x;
    if (i.snap) this.yaw -= i.snap * (CFG.xr.snapDegrees * Math.PI / 180);

    // The headset is the authority on pitch while presenting.
    if (!this.xr.presenting) {
      this.pitch += i.look.y;
      const lim = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    } else {
      this.pitch = 0;
    }

    this.intent = i;
    return i;
  }

  /** Which glyph set the HUD should draw. */
  get scheme() {
    if (this.xr.presenting) return "xr";
    if (this.touch.enabled) return "touch";
    if (this.gamepad.connected) return this.gamepad.brand || "generic";
    return "keyboard";
  }
}
