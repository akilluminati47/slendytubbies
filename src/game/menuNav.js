/**
 * Drive the menus with a controller.
 *
 * A pad player should never have to reach for a mouse, so every screen is fully
 * navigable: sticks or d-pad to move, A to activate, B to go back, bumpers to
 * switch tabs, Start to resume. Sliders and the choice rows take left/right
 * directly, because stepping a volume slider is the one thing that is genuinely
 * worse if you have to "enter" it first.
 *
 * Focus order is derived from the DOM each time the screen changes rather than
 * kept in a hand-written list - new controls are then navigable for free, and
 * the order always matches what the player sees.
 */
const FOCUSABLE = [
  ".tab",
  ".lobby-row:not([disabled])",
  ".btn:not([disabled])",
  ".set-row input[type=range]",
  ".set-toggle",
  ".set-choices button",
  ".field input",
].join(",");

export class MenuNav {
  constructor(ui) {
    this.ui = ui;
    this.index = 0;
    this.screen = null;
    this.items = [];
  }

  /** The screen the player is actually looking at, or null while playing. */
  #activeScreen() {
    for (const id of ["title", "mode", "lobby", "pause", "end"]) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains("hide")) return el;
    }
    return null;
  }

  #rescan(screenEl) {
    this.items = [...screenEl.querySelectorAll(FOCUSABLE)]
      .filter((el) => el.offsetParent !== null && !el.disabled);
    if (this.index >= this.items.length) this.index = 0;
  }

  #paint() {
    for (const el of document.querySelectorAll(".nav-focus")) {
      el.classList.remove("nav-focus");
    }
    const el = this.items[this.index];
    if (!el) return;
    el.classList.add("nav-focus");
    // Long screens (the settings list) scroll; keep the cursor on screen.
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  #move(delta) {
    if (!this.items.length) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.#paint();
  }

  /**
   * Left/right means different things depending on what is focused, and getting
   * that mapping right is most of what makes a pad feel native here.
   */
  #horizontal(dir) {
    const el = this.items[this.index];
    if (!el) return;

    if (el.type === "range") {
      const step = parseFloat(el.step) || 1;
      const min = parseFloat(el.min), max = parseFloat(el.max);
      el.value = Math.max(min, Math.min(max, parseFloat(el.value) + step * dir));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // Tabs, toggles and choice rows sit side by side, so left/right should walk
    // along them rather than jumping to a different part of the screen.
    if (el.classList.contains("tab") || el.classList.contains("set-toggle") ||
        el.parentElement?.classList.contains("set-choices")) {
      el.click();
      return;
    }
    this.#move(dir);
  }

  /** Called every frame. `nav` comes from GamepadSource#navPoll. */
  update(nav) {
    const screenEl = this.#activeScreen();

    if (!screenEl) {          // in game: nothing to navigate
      this.screen = null;
      if (document.querySelector(".nav-focus")) this.#paint();
      return;
    }

    // The title screen is dismissed by any input at all, handled elsewhere.
    if (screenEl.id === "title") { this.screen = "title"; return; }

    if (this.screen !== screenEl.id) {
      this.screen = screenEl.id;
      this.index = 0;
      this.#rescan(screenEl);
      this.#paint();
    } else if (this.items.some((el) => el.offsetParent === null || el.disabled)) {
      // The lobby list repaints under us as players come and go.
      const current = this.items[this.index];
      this.#rescan(screenEl);
      const again = this.items.indexOf(current);
      this.index = again >= 0 ? again : Math.min(this.index, this.items.length - 1);
      this.#paint();
    }

    if (nav.up) this.#move(-1);
    if (nav.down) this.#move(1);
    if (nav.left) this.#horizontal(-1);
    if (nav.right) this.#horizontal(1);

    if (nav.tabPrev || nav.tabNext) {
      const tabs = [...screenEl.querySelectorAll(".tab")];
      if (tabs.length) {
        const at = tabs.findIndex((t) => t.classList.contains("on"));
        tabs[(at + (nav.tabNext ? 1 : -1) + tabs.length) % tabs.length].click();
        this.index = 0;
        this.#rescan(screenEl);
        this.#paint();
      }
    }

    if (nav.accept) {
      const el = this.items[this.index];
      if (el?.tagName === "INPUT" && el.type !== "range") el.focus();
      else el?.click();
      // Whatever we just pressed may have swapped the screen out under us.
      queueMicrotask(() => {
        const now = this.#activeScreen();
        if (now && now.id === this.screen) { this.#rescan(now); this.#paint(); }
      });
    }

    if (nav.back) {
      const back = screenEl.querySelector("#lobby-back:not(.hide), #lobby-back2, #resume");
      const visible = [...screenEl.querySelectorAll("#lobby-back, #lobby-back2, #resume")]
        .find((el) => el.offsetParent !== null);
      (visible || back)?.click();
    }
  }
}
