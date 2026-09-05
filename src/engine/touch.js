import { blankIntent, stick } from "./intent.js";
import { CFG } from "../game/config.js";

/**
 * Phones and tablets.
 *
 * Layout follows the usual mobile-FPS convention: a floating movement stick in
 * a zone at the lower left, and look on *everything outside that zone* rather
 * than a strict right half - so a thumb sweeping across the upper left still
 * turns the camera instead of dead-zoning.
 *
 * Sprint is the stick pushed to its outer edge, not a button. On a phone you
 * have two thumbs, both already busy; a third control for running is one you
 * cannot reach without stopping looking.
 *
 * The overlay stays in the layout from the start and is merely inert until a
 * real touch happens. It used to be display:none until activated, with the
 * activating listener attached to the hidden element itself - which meant it
 * received no pointer events and so could never appear at all.
 *
 * Multi-touch is tracked by pointerId, so moving and looking at once works,
 * which is the single most important thing to get right here.
 */

const CSS = `
.tc-root { position:fixed; inset:0; z-index:5; touch-action:none;
  -webkit-user-select:none; user-select:none;
  opacity:0; visibility:hidden; transition:opacity .18s; }
.tc-root.on { opacity:1; visibility:visible; }

/* The root never swallows input; only the explicit zones and buttons do. */
.tc-zone { position:absolute; pointer-events:none; }
.tc-root.on .tc-zone { pointer-events:auto; }
#tc-move { left:0; bottom:0; }
#tc-look { inset:0; }

.tc-stick { position:absolute; width:136px; height:136px; margin:-68px 0 0 -68px;
  border:1px solid rgba(216,210,196,.3); border-radius:50%; opacity:0;
  transition:opacity .12s, border-color .1s, box-shadow .1s;
  pointer-events:none; z-index:2; }
.tc-stick.on { opacity:1; }
/* The ring lights when the stick is far enough out to be sprinting, so the
   threshold is something you can see rather than guess at. */
.tc-stick.sprint { border-color:#7d9b86; box-shadow:0 0 22px rgba(125,155,134,.4); }
.tc-stick.sprint .tc-nub { background:rgba(125,155,134,.34); border-color:#7d9b86; }
.tc-nub { position:absolute; left:50%; top:50%; width:56px; height:56px;
  margin:-28px 0 0 -28px; border-radius:50%; background:rgba(216,210,196,.24);
  border:1px solid rgba(216,210,196,.45); }

/* A permanent hint of where the stick lives, so it is discoverable before the
   first touch rather than an invisible region you have to guess at. */
.tc-home { position:absolute; left:104px; bottom:104px; width:132px; height:132px;
  margin:0 0 -66px -66px; border:1px dashed rgba(216,210,196,.16);
  border-radius:50%; pointer-events:none; transition:opacity .2s; }
.tc-root.using-stick .tc-home { opacity:0; }

.tc-btn { position:absolute; border-radius:50%; pointer-events:none;
  border:1px solid rgba(216,210,196,.32); background:rgba(10,10,10,.46);
  color:#d8d2c4; font:600 11px/1.1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.1em; text-transform:uppercase; display:grid;
  place-content:center; text-align:center; z-index:3; -webkit-backdrop-filter:blur(2px);
  backdrop-filter:blur(2px); }
.tc-root.on .tc-btn { pointer-events:auto; }
.tc-btn.held { background:rgba(216,210,196,.28); border-color:rgba(216,210,196,.6); }
.tc-btn.latched { border-color:#7d9b86; color:#bcd4c2; }
/* Equal and stacked: with sprint moved onto the stick these are the only two
   actions left, and two identical circles under one thumb beat two different
   shapes in two different places. */
#tc-jump   { right:24px; bottom:158px; width:92px; height:92px; }
#tc-torch  { right:24px; bottom:52px;  width:92px; height:92px; }
.tc-btn svg { width:38px; height:38px; stroke:currentColor; stroke-width:1.7;
  fill:none; stroke-linecap:round; stroke-linejoin:round; }
/* The torch is several strokes and reads heavy; a single-stroke arrow next to it
   looks faint. Thicken the arrow so the pair carries equal weight. */
#tc-jump svg { stroke-width:2.7; width:40px; height:40px; }
.tc-btn.held svg { stroke:#fff; }
#tc-torch.lit { border-color:rgba(255,240,207,.7); color:#fff0cf;
  box-shadow:0 0 20px rgba(255,240,207,.25); }
#tc-pause  { right:18px; top:18px; width:52px; height:52px; font-size:15px; bottom:auto; }
`;

export class TouchSource {
  constructor(root = document.body) {
    this.enabled = false;
    this.pointers = new Map();       // pointerId -> { role, ... }
    this.moveVec = { x: 0, y: 0 };
    this.lookDelta = { x: 0, y: 0 };
    this.torchQueued = false;
    this.jumpQueued = false;
    this.menuQueued = false;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    this.el = document.createElement("div");
    this.el.className = "tc-root";
    this.el.innerHTML = `
      <div class="tc-zone" id="tc-look"></div>
      <div class="tc-zone" id="tc-move"></div>
      <div class="tc-home"></div>
      <div class="tc-stick" id="tc-stick"><div class="tc-nub" id="tc-nub"></div></div>
      <button class="tc-btn" id="tc-jump" aria-label="Jump">
        <svg viewBox="0 0 24 24"><path d="M12 20V5"/><path d="M5.5 11.5 12 5l6.5 6.5"/></svg>
      </button>
      <button class="tc-btn" id="tc-torch" aria-label="Torch">
        <!-- Torch pointing up: barrel, then a wider lamp head, with the beams
             radiating from the lamp FACE. They were previously drawn off the
             sides of the head, where no light actually comes out. -->
        <svg viewBox="0 0 24 24">
          <path d="M10.3 11.8h3.4v9.9h-3.4z"/>
          <path d="M8.6 7.6h6.8l-1.7 4.2h-3.4z"/>
          <!-- Beams sit in a clear gap AHEAD of the lamp face (y 7.6), not
               touching it - light leaves the torch, it does not grow out of it. -->
          <path d="M12 5.2V2.4"/>
          <path d="M9.2 5.7 7.7 3.4"/>
          <path d="M14.8 5.7 16.3 3.4"/>
        </svg>
      </button>
      <button class="tc-btn" id="tc-pause">II</button>`;
    root.appendChild(this.el);

    this.stickEl = this.el.querySelector("#tc-stick");
    this.nubEl = this.el.querySelector("#tc-nub");
    this.moveZone = this.el.querySelector("#tc-move");
    this.lookZone = this.el.querySelector("#tc-look");

    this.#sizeZones();
    addEventListener("resize", () => this.#sizeZones());
    this.#watchForTouch();
    this.#wireButtons();
    this.#wireZones();
  }

  /**
   * The move zone is a slab at the lower left; look is everything else. Sizing
   * it in JS rather than CSS keeps the numbers next to the tuning that uses them.
   */
  #sizeZones() {
    const z = CFG.touch.stickZone;
    this.moveZone.style.width = `${z.width * 100}%`;
    this.moveZone.style.height = `${z.height * 100}%`;
  }

  /**
   * Listen at the window for the first genuine touch. This CANNOT live on the
   * overlay: the overlay is inert until activated, so it would never hear the
   * touch that is supposed to activate it.
   */
  #watchForTouch() {
    const onFirst = (e) => {
      if (e.pointerType && e.pointerType !== "touch") return;
      this.#activate();
      removeEventListener("pointerdown", onFirst, true);
      removeEventListener("touchstart", onFirst, true);
    };
    addEventListener("pointerdown", onFirst, { capture: true, passive: true });
    addEventListener("touchstart", onFirst, { capture: true, passive: true });
  }

  #activate() {
    if (this.enabled) return;
    this.enabled = true;
    this.el.classList.add("on");
    document.body.classList.add("touch");
    dispatchEvent(new CustomEvent("touchui", { detail: { on: true } }));
  }

  #wireButtons() {
    const hold = (id, onDown, onUp) => {
      const el = this.el.querySelector(id);
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        el.classList.add("held");
        onDown(el);
      });
      const release = () => { el.classList.remove("held"); onUp?.(el); };
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
      return el;
    };

    hold("#tc-jump", () => (this.jumpQueued = true));
    hold("#tc-torch", () => (this.torchQueued = true));
    hold("#tc-pause", () => (this.menuQueued = true));
  }

  #wireZones() {
    const R = 60;   // pixels of stick travel to full deflection

    const start = (e, role) => {
      e.preventDefault();
      const zone = role === "move" ? this.moveZone : this.lookZone;
      // Capture keeps a finger that slides out of its zone still driving that
      // zone. It can throw if the pointer is already gone, and losing the whole
      // gesture because of that would be far worse than losing the capture.
      try { zone.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
      if (role === "move") {
        // Floating stick: the origin is wherever the thumb actually landed.
        this.pointers.set(e.pointerId, { role, ox: e.clientX, oy: e.clientY });
        this.stickEl.style.left = `${e.clientX}px`;
        this.stickEl.style.top = `${e.clientY}px`;
        this.stickEl.classList.add("on");
        this.el.classList.add("using-stick");
      } else {
        this.pointers.set(e.pointerId, { role, lx: e.clientX, ly: e.clientY });
      }
    };

    this.moveZone.addEventListener("pointerdown", (e) => start(e, "move"), { passive: false });
    this.lookZone.addEventListener("pointerdown", (e) => start(e, "look"), { passive: false });

    const move = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      e.preventDefault();
      if (p.role === "move") {
        const dx = Math.max(-R, Math.min(R, e.clientX - p.ox));
        const dy = Math.max(-R, Math.min(R, e.clientY - p.oy));
        this.nubEl.style.transform = `translate(${dx}px, ${dy}px)`;
        this.moveVec = { x: dx / R, y: dy / R };
        this.stickEl.classList.toggle("sprint",
          Math.hypot(dx, dy) / R >= CFG.touch.sprintAt);
      } else {
        // Accumulate; poll() drains it. Touch deltas are already frame-rate
        // independent, so they must NOT be multiplied by dt again.
        this.lookDelta.x += (e.clientX - p.lx) * CFG.touch.lookSens;
        this.lookDelta.y += (e.clientY - p.ly) * CFG.touch.lookSens;
        p.lx = e.clientX;
        p.ly = e.clientY;
      }
    };

    const end = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (p.role !== "move") return;
      this.moveVec = { x: 0, y: 0 };
      this.nubEl.style.transform = "";
      this.stickEl.classList.remove("on", "sprint");
      this.el.classList.remove("using-stick");
    };

    for (const zone of [this.moveZone, this.lookZone]) {
      zone.addEventListener("pointermove", move, { passive: false });
      zone.addEventListener("pointerup", end);
      zone.addEventListener("pointercancel", end);
    }

    // Kill the browser gestures that ruin a fullscreen game.
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
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

    // Sprint is the raw deflection, not the shaped one: the response curve
    // squashes the top of the range, so shaped magnitude never reaches 1.
    intent.sprint = Math.hypot(this.moveVec.x, this.moveVec.y) >= CFG.touch.sprintAt;
    intent.jump = this.jumpQueued;
    intent.torch = this.torchQueued;
    intent.menu = this.menuQueued;
    this.jumpQueued = this.torchQueued = this.menuQueued = false;

    return intent;
  }

  /** Light the torch button while the torch is actually on. */
  setTorch(on) {
    this.el.querySelector("#tc-torch")?.classList.toggle("lit", !!on);
  }

  /** Hide the pad while a menu is up; it would sit over the buttons. */
  setInGame(on) {
    if (!this.enabled) return;
    this.el.classList.toggle("on", on);
  }
}
