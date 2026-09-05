import * as THREE from "three";
import { blankIntent, stick, Edge } from "./intent.js";
import { CFG } from "../game/config.js";

/**
 * Meta Quest (2 / 3 / 3S / Pro) and any other WebXR headset the browser exposes.
 *
 * The "xr-standard" gamepad mapping every Touch-style controller reports:
 *   axes[0..1]  touchpad (unused on Quest)
 *   axes[2..3]  thumbstick
 *   buttons[0]  trigger      buttons[1] squeeze/grip
 *   buttons[3]  thumbstick click
 *   buttons[4]  A / X        buttons[5] B / Y
 *
 * Locomotion is smooth on the left stick (head-relative) with *snap* turning on
 * the right. Smooth turning is the single biggest cause of VR nausea, so snap
 * is the default and CFG.xr.snapDegrees = 0 opts into smooth for players who
 * have their VR legs.
 */
export class XRSource {
  constructor(renderer, rig) {
    this.renderer = renderer;
    this.rig = rig;
    this.edge = new Edge();
    this.presenting = false;
    this.supported = false;
    this.controllers = [];
    this.grips = [];

    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");

    // Controller nodes live under the rig so they inherit locomotion.
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      const g = renderer.xr.getControllerGrip(i);
      rig.add(c, g);
      this.controllers.push(c);
      this.grips.push(g);
    }

    renderer.xr.addEventListener("sessionstart", () => {
      this.presenting = true;
      document.body.classList.add("xr");
      dispatchEvent(new CustomEvent("xr", { detail: { presenting: true } }));
    });
    renderer.xr.addEventListener("sessionend", () => {
      this.presenting = false;
      document.body.classList.remove("xr");
      dispatchEvent(new CustomEvent("xr", { detail: { presenting: false } }));
    });

    navigator.xr?.isSessionSupported?.("immersive-vr").then((ok) => {
      this.supported = ok;
      dispatchEvent(new CustomEvent("xr", { detail: { supported: ok } }));
    }).catch(() => {});
  }

  async enter() {
    if (!navigator.xr) throw new Error("WebXR unavailable");
    const session = await navigator.xr.requestSession("immersive-vr", {
      optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
    });
    await this.renderer.xr.setSession(session);
    return session;
  }

  /** Simple haptic pulse on whichever controllers can do it. */
  pulse(intensity, ms = 120) {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const src of session.inputSources) {
      const act = src.gamepad?.hapticActuators?.[0];
      act?.pulse?.(Math.min(1, intensity), ms);
    }
  }

  poll(dt) {
    const intent = blankIntent();
    const session = this.renderer.xr.getSession();
    if (!session) return intent;

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const hand = src.handedness;            // "left" | "right" | "none"
      const ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0], gp.axes[1]];
      const btn = (i) => !!gp.buttons[i]?.pressed;
      const val = (i) => gp.buttons[i]?.value ?? 0;

      if (hand === "left") {
        const s = stick(ax[0] ?? 0, ax[1] ?? 0, CFG.xr.deadzone, 1.5);
        intent.move.x = s.x;
        intent.move.z = s.y;
        // Grip to sprint - it is the button your hand is already closed around.
        intent.sprint = val(1) > 0.6 || btn(3);
        if (this.edge.hit("xr-torch", btn(5))) intent.torch = true;
        if (this.edge.hit("xr-jump-l", btn(4))) intent.jump = true;
      } else if (hand === "right") {
        const s = stick(ax[0] ?? 0, ax[1] ?? 0, CFG.xr.deadzone, 1);
        if (CFG.xr.snapDegrees > 0) {
          // Edge-triggered so one flick is exactly one increment.
          const dir = s.x > 0.7 ? 1 : s.x < -0.7 ? -1 : 0;
          if (this.edge.hit("xr-snapL", dir === -1) && dir === -1) intent.snap = -1;
          if (this.edge.hit("xr-snapR", dir === 1) && dir === 1) intent.snap = 1;
          if (dir === 0) { this.edge.hit("xr-snapL", false); this.edge.hit("xr-snapR", false); }
        } else {
          intent.look.x = -s.x * CFG.xr.smoothTurnSpeed * dt;
        }
        if (this.edge.hit("xr-jump", btn(4))) intent.jump = true;
        if (this.edge.hit("xr-torch-r", btn(5))) intent.torch = true;
      }
    }
    return intent;
  }
}
