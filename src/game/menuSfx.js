/**
 * The menus, out loud.
 *
 * Two sounds and nothing else: one for arriving somewhere, one for choosing it.
 * That is the whole vocabulary a menu needs, and giving buttons and sliders and
 * tabs each their own noise would only make the set harder to learn without
 * telling anybody anything they cannot already see.
 *
 * Delegated from the document rather than bound to the controls, because the
 * lobby rebuilds its panes when you switch tabs and anything bound to the old
 * elements would quietly stop making noise - the same reason the on-screen
 * keyboard listens this way.
 *
 * Only the pointer is handled here. A controller moving the cursor goes through
 * MenuNav, which makes the same call itself; its A button ends in .click() on
 * the focused element, so selection arrives here either way and there is one
 * place that decides what "chosen" sounds like.
 */

/** Everything that counts as a control worth acknowledging. */
const CONTROLS = [
  ".tab",
  ".lobby-row:not([disabled])",
  ".btn:not([disabled])",
  ".set-row input[type=range]",
  ".set-toggle",
  ".set-choices button",
  ".field input",
  "#osk .osk-key",
].join(",");

/** Nothing sounds twice inside this many ms. */
const GAP = 45;

export function installMenuSfx(audio) {
  let last = null;
  let at = 0;

  const fresh = (el) => {
    const now = performance.now();
    // Moving within one control is not arriving at a control: a slider fires a
    // stream of these as the pointer crosses it, and a run of blips reads as a
    // fault rather than as feedback.
    if (el === last && now - at < 400) return false;
    if (now - at < GAP) return false;
    last = el;
    at = now;
    return true;
  };

  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.(CONTROLS);
    if (el && fresh(el)) audio.blip();
  }, true);

  // Capture, so it is heard even where a handler stops the event on its way up.
  document.addEventListener("click", (e) => {
    if (e.target.closest?.(CONTROLS)) audio.select();
  }, true);
}
