import { blankIntent, stick, Edge } from "./intent.js";
import { CFG } from "../game/config.js";

/**
 * Phones and tablets. Builds its own DOM overlay and only shows it once a real
 * touch has happened, so a laptop with a touchscreen does not get thumb-sticks
 * thrown over its mouse-and-keyboard game.
 *
 * Left half of the screen  = floating movement stick, spawned wherever the
 *                            thumb lands rather than pinned to a fixed corner.
 * Right half               = drag to look, plus the action buttons.
 *
 * Multi-touch is tracked by pointerId, so moving and looking at the same time
 * works - the single most common thing to get wrong on mobile.
 */

const CSS = `
.tc-root { position:fixed; inset:0; z-index:5; touch-action:none;
  -webkit-user-select:none; user-select:none; display:none; }
.tc-root.on { display:block; }
.tc-stick { position:absolute; width:132px; height:132px; margin:-66px 0 0 -66px;
  border:1px solid rgba(216,210,196,.28); border-radius:50%; opacity:0;
  transition:opacity .12s; pointer-events:none; }
.tc-stick.on { opacity:1; }
.tc-nub { position:absolute; left:50%; top:50%; width:54px; height:54px;
  margin:-27px 0 0 -27px; border-radius:50%; background:rgba(216,210,196,.22);
  border:1px solid rgba(216,210,196,.4); }
.tc-btn { position:absolute; right:22px; width:74px; height:74px; border-radius:50%;
  border:1px solid rgba(216,210,196,.3); background:rgba(10,10,10,.42);
  color:#d8d2c4; font:11px/1.1 "Courier New",monospace; letter-spacing:.1em;
  text-transform:uppercase; display:grid; place-content:center; text-align:center;
  pointer-events:auto; backdrop-filter:blur(2px); }
.tc-btn.held { background:rgba(216,210,196,.26); }
#tc-jump { bottom:150px; width:94px; height:94px; right:14px; }
#tc-sprint   { bottom:44px; }
#tc-torch    { bottom:44px; right:112px; }
`;

export class TouchSource {
  constructor(root = document.body) {
    this.enabled = false;
    this.edge = new Edge();
    this.pointers = new Map();       // pointerId -> { role, ... }
    this.moveVec = { x: 0, y: 0 };
    this.lookDelta = { x: 0, y: 0 };
    this.sprintLatched = false;
    this.torchQueued = false;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    this.el = document.createElement("div");
    this.el.className = "tc-root";
    this.el.innerHTML = `
      <div class="tc-stick" id="tc-stick"><div class="tc-nub" id="tc-nub"></div></div>
      <button class="tc-btn" id="tc-jump">Jump</button>
      <button class="tc-btn" id="tc-sprint">Run</button>
      <button class="tc-btn" id="tc-torch">Torch</button>`;
    root.appendChild(this.el);

    this.stickEl = this.el.querySelector("#tc-stick");
    this.nubEl = this.el.querySelector("#tc-nub");

    this.#wireButtons();
    this.#wireSurface();
  }

  /** Reveal on the first genuine touch. Pointer type, not screen width. */
  #activate() {
    if (this.enabled) return;
    this.enabled = true;
    this.el.classList.add("on");
    document.body.classList.add("touch");
    dispatchEvent(new CustomEvent("touchui", { detail: { on: true } }));
  }

  #wireButtons() {
    const hold = (el, onDown, onUp) => {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        el.classList.add("held");
        this.#activate();
        onDown();
      });
      const release = (e) => {
        el.classList.remove("held");
        onUp?.(e);
      };
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
    };

    hold(this.el.querySelector("#tc-jump"), () => (this.jumpQueued = true));
    hold(this.el.querySelector("#tc-torch"), () => (this.torchQueued = true));
    // Sprint latches: nobody wants to hold a third finger down while running.
    hold(this.el.querySelector("#tc-sprint"), () => {
      this.sprintLatched = !this.sprintLatched;
      this.el.querySelector("#tc-sprint").classList.toggle("latched", this.sprintLatched);
    });
  }

  #wireSurface() {
    const surface = this.el;

    surface.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      this.#activate();
      surface.setPointerCapture(e.pointerId);

      if (e.clientX < innerWidth * 0.5) {
        // Floating stick: origin is wherever the thumb actually landed.
        this.pointers.set(e.pointerId, { role: "move", ox: e.clientX, oy: e.clientY });
        this.stickEl.style.left = `${e.clientX}px`;
        this.stickEl.style.top = `${e.clientY}px`;
        this.stickEl.classList.add("on");
      } else {
        this.pointers.set(e.pointerId, { role: "look", lx: e.clientX, ly: e.clientY });
      }
    }, { passive: false });

    surface.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      e.preventDefault();

      if (p.role === "move") {
        const R = 58;
        const dx = Math.max(-R, Math.min(R, e.clientX - p.ox));
        const dy = Math.max(-R, Math.min(R, e.clientY - p.oy));
        this.nubEl.style.transform = `translate(${dx}px, ${dy}px)`;
        this.moveVec = { x: dx / R, y: dy / R };
      } else {
        // Accumulate; poll() drains it. Touch deltas are already frame-rate
        // independent, so they must NOT be multiplied by dt again.
        this.lookDelta.x += (e.clientX - p.lx) * CFG.touch.lookSens;
        this.lookDelta.y += (e.clientY - p.ly) * CFG.touch.lookSens;
        p.lx = e.clientX;
        p.ly = e.clientY;
      }
    }, { passive: false });

    const end = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (p.role === "move") {
        this.moveVec = { x: 0, y: 0 };
        this.nubEl.style.transform = "";
        this.stickEl.classList.remove("on");
      }
    };
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);

    // Kill the browser gestures that ruin a fullscreen game.
    surface.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("gesturestart", (e) => e.preventDefault());
  }

  poll() {
    const intent = blankIntent();
    if (!this.enabled) return intent;

    const s = stick(this.moveVec.x, this.moveVec.y, 0.12, 1.6);
    intent.move.x = s.x;
    intent.move.z = s.y;

    intent.look.x = -this.lookDelta.x;
    intent.look.y = -this.lookDelta.y;
    this.lookDelta.x = this.lookDelta.y = 0;

    intent.sprint = this.sprintLatched && s.mag > 0.4;
    intent.jump = this.jumpQueued;
    this.jumpQueued = false;
    intent.torch = this.torchQueued;
    this.torchQueued = false;

    return intent;
  }
}
