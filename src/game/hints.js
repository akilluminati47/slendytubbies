/**
 * Control prompts per input scheme. Showing an Xbox player "press X to collect"
 * when they are holding a DualSense is a small thing that reads as sloppiness,
 * and on a Switch Pro the A/B glyphs are physically swapped, so guessing is
 * actively wrong rather than merely unhelpful.
 */
const k = (s) => `<kbd>${s}</kbd>`;

export const HINTS = {
  keyboard:
    `${k("WASD")} move · ${k("Shift")} sprint · ${k("Space")} jump · ${k("F")} torch · ${k("Esc")} cursor`,
  xbox:
    `${k("L")} move · ${k("R")} look · ${k("LS")} sprint · ${k("A")} jump · ${k("X")} torch`,
  playstation:
    `${k("L")} move · ${k("R")} look · ${k("L3")} sprint · ${k("✕")} jump · ${k("□")} torch`,
  nintendo:
    `${k("L")} move · ${k("R")} look · ${k("L")} sprint · ${k("B")} jump · ${k("Y")} torch`,
  generic:
    `${k("L")} move · ${k("R")} look · ${k("L3")} sprint · ${k("A")} jump · ${k("X")} torch`,
  touch:
    `Drag left to move · drag right to look · buttons bottom-right`,
  xr:
    `${k("L stick")} move · ${k("R stick")} snap turn · ${k("grip")} sprint · ${k("A/X")} jump · ${k("B/Y")} torch`,

  /** Shown near the reticle when a tank is close - walk over it to take it. */
  nearby: "Walk over the custard to take it",
};
