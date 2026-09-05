/**
 * The single shape every input device produces. Nothing downstream of here
 * knows or cares whether a frame came from a keyboard, a DualSense, a thumb on
 * glass, or a Quest controller.
 *
 *   move    -1..1 on each axis in *view space*. z < 0 is forward.
 *   look    radians to add to yaw/pitch this frame (already dt-scaled).
 *   sprint  held
 *   jump    edge-triggered - true on the frame the button went down
 *   torch   edge-triggered - true on the frame the button went down
 *   snap    -1 | 0 | 1, one-shot comfort turn (VR, and gamepad if you want it)
 */
export function blankIntent() {
  return {
    move: { x: 0, z: 0 },
    look: { x: 0, y: 0 },
    sprint: false,
    jump: false,
    torch: false,
    menu: false,
    snap: 0,
  };
}

/** Merge a source's contribution into the accumulating frame intent. */
export function mergeIntent(into, from) {
  // Strongest stick wins rather than summing, so holding two devices at once
  // cannot push you past full speed.
  if (Math.hypot(from.move.x, from.move.z) > Math.hypot(into.move.x, into.move.z)) {
    into.move.x = from.move.x;
    into.move.z = from.move.z;
  }
  into.look.x += from.look.x;
  into.look.y += from.look.y;
  into.sprint ||= from.sprint;
  into.jump ||= from.jump;
  into.torch ||= from.torch;
  into.menu ||= from.menu;
  into.snap ||= from.snap;
  return into;
}

/**
 * Radial deadzone with a squared response curve.
 *
 * Per-axis deadzones are the classic mistake: they carve a cross out of the
 * stick's range and make diagonals feel notchy. Deadzone the *magnitude*,
 * rescale what is left to 0..1, then square it for fine control near centre.
 */
export function stick(x, y, dead = 0.18, curve = 2) {
  const mag = Math.hypot(x, y);
  if (mag < dead) return { x: 0, y: 0, mag: 0 };
  const scaled = Math.min(1, (mag - dead) / (1 - dead));
  const shaped = Math.pow(scaled, curve);
  return { x: (x / mag) * shaped, y: (y / mag) * shaped, mag: shaped };
}

/** Rising-edge detector for button-like values. */
export class Edge {
  constructor() { this.prev = new Map(); }
  hit(key, now) {
    const was = this.prev.get(key) || false;
    this.prev.set(key, now);
    return now && !was;
  }
}
