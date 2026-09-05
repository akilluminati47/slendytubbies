import { blankIntent, stick, Edge } from "./intent.js";
import { CFG } from "../game/config.js";

/**
 * Xbox, DualSense/DualShock, Switch Pro/Joy-Con, and anything else the browser
 * reports under the W3C "standard" mapping, which is nearly everything over
 * USB or Bluetooth in 2026.
 *
 * Button INDICES are identical across all three families; only the printed
 * labels differ, which is purely a UI concern:
 *
 *   index  Xbox   PlayStation   Nintendo
 *   0      A      Cross         B      <- bottom face button
 *   1      B      Circle        A
 *   2      X      Square        Y      <- left face button
 *   3      Y      Triangle      X
 *   6/7    LT/RT  L2/R2         ZL/ZR
 *   10/11  L3/R3  L3/R3         L3/R3
 *   12-15  D-pad up/down/left/right
 *
 * Nintendo's face buttons are physically transposed versus Xbox, so a prompt
 * reading "press A" is wrong on a Pro Controller. detectBrand() drives the
 * on-screen glyphs so every player sees their own button.
 */

const BTN = {
  south: 0, east: 1, west: 2, north: 3,
  l1: 4, r1: 5, l2: 6, r2: 7,
  select: 8, start: 9, l3: 10, r3: 11,
  up: 12, down: 13, left: 14, right: 15,
};

export const BRAND_GLYPHS = {
  xbox:        { south: "A", west: "X", north: "Y", sprint: "LS", torch: "X", jump: "A" },
  playstation: { south: "✕", west: "□", north: "△", sprint: "L3", torch: "□", jump: "✕" },
  nintendo:    { south: "B", west: "Y", north: "X", sprint: "L", torch: "Y", jump: "B" },
  generic:     { south: "A", west: "X", north: "Y", sprint: "L3", torch: "X", jump: "A" },
};

export function detectBrand(id = "") {
  const s = id.toLowerCase();
  if (/dualsense|dualshock|playstation|054c|sony/.test(s)) return "playstation";
  if (/switch|joy-?con|pro controller|nintendo|057e/.test(s)) return "nintendo";
  if (/xbox|xinput|045e|microsoft/.test(s)) return "xbox";
  return "generic";
}

// Re-trigger a touch faster than the effect expires, so it reads as continuous
// while still self-terminating the moment we stop asking.
const RUMBLE_MS = 220;
const RUMBLE_PERIOD = 0.16;

export class GamepadSource {
  constructor() {
    this.edge = new Edge();
    this.brand = null;
    this.connected = false;
    this.index = null;
    this.rumbleUntil = 0;
    this.rumbling = false;

    // Anything that can stop our frame loop must also stop the motors, or the
    // pad keeps buzzing with nobody left to tell it otherwise.
    const panic = () => this.stop();
    addEventListener("blur", panic);
    addEventListener("pagehide", panic);
    addEventListener("beforeunload", panic);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) panic();
    });

    addEventListener("gamepadconnected", (e) => {
      this.index = e.gamepad.index;
      this.brand = detectBrand(e.gamepad.id);
      this.connected = true;
      dispatchEvent(new CustomEvent("pad", { detail: { connected: true, brand: this.brand } }));
      console.info(`[gamepad] ${e.gamepad.id} -> ${this.brand}, mapping "${e.gamepad.mapping}"`);
    });
    addEventListener("gamepaddisconnected", (e) => {
      if (e.gamepad.index !== this.index) return;
      this.rumbling = false;
      this.connected = false;
      this.index = null;
      dispatchEvent(new CustomEvent("pad", { detail: { connected: false } }));
    });
  }

  #pad() {
    const pads = navigator.getGamepads?.() || [];
    // Prefer the pad we latched onto, but fall back to any live one - some
    // browsers renumber pads across a sleep/wake or a Bluetooth reconnect.
    const mine = this.index != null ? pads[this.index] : null;
    if (mine && mine.connected) return mine;
    for (const p of pads) {
      if (p && p.connected) {
        this.index = p.index;
        this.brand ??= detectBrand(p.id);
        return p;
      }
    }
    return null;
  }

  poll(dt) {
    const intent = blankIntent();
    const p = this.#pad();
    if (!p) { this.connected = false; return intent; }
    this.connected = true;

    const b = (i) => p.buttons[i] !== undefined && p.buttons[i].pressed;
    const v = (i) => (p.buttons[i] ? p.buttons[i].value : 0);

    // --- sticks ---------------------------------------------------------
    const ls = stick(p.axes[0] ?? 0, p.axes[1] ?? 0, CFG.pad.deadzone);
    intent.move.x = ls.x;
    intent.move.z = ls.y;          // stick up is -1, which is our forward

    const rs = stick(p.axes[2] ?? 0, p.axes[3] ?? 0, CFG.pad.deadzone);
    intent.look.x = -rs.x * CFG.pad.lookSpeed * dt;
    intent.look.y = -rs.y * CFG.pad.lookSpeed * dt * (CFG.pad.invertY ? -1 : 1);

    // --- d-pad falls back in for players who prefer it -------------------
    if (ls.mag === 0) {
      intent.move.x = (b(BTN.right) ? 1 : 0) - (b(BTN.left) ? 1 : 0);
      intent.move.z = (b(BTN.down) ? 1 : 0) - (b(BTN.up) ? 1 : 0);
    }

    intent.sprint = b(BTN.l3) || v(BTN.r2) > 0.5 || b(BTN.l1);
    intent.jump = this.edge.hit("jump", b(BTN.south));
    intent.torch = this.edge.hit("torch", b(BTN.west));
    intent.menu = this.edge.hit("menu", b(BTN.start));

    return intent;
  }

  /** True on the frame ANY button goes down - used to dismiss the title screen. */
  anyPressed() {
    const p = this.#pad();
    if (!p) return false;
    const down = p.buttons.some((b) => b.pressed);
    return this.edge.hit("any", down);
  }

  /**
   * Dual-rumble scaled by how close the tubby is.
   *
   * Every effect is given a duration slightly longer than the re-trigger
   * interval so it stays continuous while being re-armed, and SHORT enough that
   * it always dies on its own if we stop calling. A long effect plus a caller
   * that goes away - a lost frame loop, a game-over, a closed tab - leaves the
   * motors spinning in the driver until the pad is re-paired, which is exactly
   * the failure this guards against. stop() is also wired to blur/hide/unload.
   */
  rumble(threat, now) {
    if (threat < 0.05) { this.stop(); return; }
    if (now < this.rumbleUntil) return;
    const p = this.#pad();
    const act = p?.vibrationActuator;
    if (!act?.playEffect) return;
    this.rumbleUntil = now + RUMBLE_PERIOD;
    this.rumbling = true;
    act.playEffect("dual-rumble", {
      duration: RUMBLE_MS,
      strongMagnitude: Math.min(1, threat * 0.85),
      weakMagnitude: Math.min(1, threat * 0.4),
    }).catch(() => {});
  }

  /** Silence every connected pad. Safe to call repeatedly. */
  stop() {
    this.rumbleUntil = 0;
    if (!this.rumbling) return;
    this.rumbling = false;
    for (const p of navigator.getGamepads?.() || []) {
      const act = p?.vibrationActuator;
      if (!act) continue;
      // reset() is the correct call but is not everywhere yet; a zero-magnitude
      // effect cancels the running one on the browsers that lack it.
      try { act.reset?.(); } catch {}
      try {
        act.playEffect?.("dual-rumble",
          { duration: 1, strongMagnitude: 0, weakMagnitude: 0 })?.catch(() => {});
      } catch {}
    }
  }
}
