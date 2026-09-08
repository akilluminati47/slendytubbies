/**
 * The scrawl that circles the title card while the game loads.
 *
 * There is a real gap at the start - two glTF loads, a rig bake, and a first
 * frame's worth of shader compilation - and until it finishes the splash is a
 * name on a black rectangle with nothing behind it. Not a slow gap, but a dead
 * one, and a dead screen reads as a broken screen.
 *
 * So something is drawn on it, in the same hand as the name above it: a white
 * arrow flying a loop around the card, laid down like a pen stroke and rubbed
 * out behind itself.
 *
 * It has to start BEFORE the loading does, which is the only real constraint on
 * where this lives. main.js awaits its assets at the top level, so anything it
 * calls after that await is already too late to be a loading animation; a module
 * it imports runs first, and this is that module.
 */

/** How the flight is shaped, and how much of it is left to chance. */
const ARC = {
  points: 440,          // samples around the loop
  trail: 0.17,          // how much of the loop the stroke covers, 0..1
  seconds: [2.6, 4.2],  // one lap, rolled per load
  lobes: [2, 5],        // how many times the radius swells on a lap
  swell: [0.07, 0.17],  // and by how much of the radius
  wobble: 0.9,          // pen shake, in px at the smallest
  head: 15,             // arrowhead arm length in px
};

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/**
 * One flight path, as an SVG path string.
 *
 * A closed loop built from harmonics of one angle, so it joins itself exactly
 * and the arrow can fly it forever without a seam. Every term is rolled fresh:
 * two swells at whole-number rates, their phases, the tilt of the whole thing,
 * an aspect that leans it towards an oval, and the direction of travel. That is
 * enough combinations that watching two identical loads back to back would be
 * bad luck rather than a bug.
 *
 * The wobble is three sine terms at unrelated rates rather than noise, because
 * noise per sample is a shaky line and this wants an unsteady one - the
 * difference between a pen held badly and a pen held by somebody.
 */
function flightPath(cx, cy, rx, ry) {
  const k1 = Math.round(rand(ARC.lobes[0], ARC.lobes[1]));
  let k2 = Math.round(rand(ARC.lobes[0], ARC.lobes[1]));
  if (k2 === k1) k2 = k1 + 1;
  const a1 = rand(ARC.swell[0], ARC.swell[1]);
  const a2 = rand(ARC.swell[0], ARC.swell[1]) * 0.6;
  const p1 = rand(0, Math.PI * 2), p2 = rand(0, Math.PI * 2);
  const tilt = rand(0, Math.PI * 2);
  const dir = Math.random() < 0.5 ? 1 : -1;
  const w = [rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)];

  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  let d = "";
  for (let i = 0; i <= ARC.points; i++) {
    const th = dir * (i / ARC.points) * Math.PI * 2;
    const swell = 1 + a1 * Math.sin(k1 * th + p1) + a2 * Math.sin(k2 * th + p2);
    const shake = ARC.wobble * (Math.sin(th * 11 + w[0])
                              + Math.sin(th * 17 + w[1]) * 0.6
                              + Math.sin(th * 29 + w[2]) * 0.35);
    const ex = Math.cos(th) * (rx * swell + shake);
    const ey = Math.sin(th) * (ry * swell + shake);
    const x = cx + ex * cos - ey * sin;
    const y = cy + ex * sin + ey * cos;
    d += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
  }
  return d + "Z";
}

let live = null;

/**
 * Put the arrow up. Safe to call twice; the second call does nothing.
 *
 * Skipped entirely when the machine has been told to keep still - a shape
 * whipping round the screen is exactly what that setting is asking about - and
 * the card is left as it was, which is a name on a rectangle for a second or
 * two and no worse than it was before.
 */
export function startLoader() {
  if (live) return;
  const host = document.getElementById("title");
  if (!host || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "loading-arrow");
  svg.setAttribute("aria-hidden", "true");

  // Three strokes on one path, at falling width and opacity, with the shortest
  // at the front. A single dash is a worm; three of different lengths taper
  // behind the head and read as ink running out.
  const trails = [
    { w: 2.6, o: 0.95, len: 0.30 },
    { w: 2.0, o: 0.45, len: 0.62 },
    { w: 1.4, o: 0.18, len: 1.00 },
  ].map(() => document.createElementNS("http://www.w3.org/2000/svg", "path"));

  const head = document.createElementNS("http://www.w3.org/2000/svg", "path");
  head.setAttribute("class", "arrow-head");
  svg.append(...trails, head);
  host.appendChild(svg);

  const state = { svg, trails, head, path: null, total: 0, t0: 0, lap: 0, raf: 0 };

  // Sized off the CARD, not the window, so the loop hugs the thing it is about
  // rather than the edges of a phone.
  const shape = () => {
    const card = host.querySelector(".card");
    const r = card ? card.getBoundingClientRect() : { left: 0, top: 0, width: 320, height: 160 };
    const w = innerWidth, h = innerHeight;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // Outside the card whichever way the loop is tilted.
    //
    // Sizing the two radii from the card's width and height separately gives an
    // oval the same shape as the card, and then the tilt rotates it - so the
    // SHORT axis can end up lying across the card's long one and the arrow flies
    // straight through the title. Both radii start from the half-diagonal
    // instead, which is the one distance that clears the corners at every angle,
    // and the swell can only take 7% back off that.
    const clear = Math.hypot(r.width, r.height) * 0.5 + 34;
    const rx = Math.min(Math.max(r.width * 0.5 + 58, clear), w * 0.45);
    const ry = Math.min(Math.max(r.height * 0.5 + 54, clear), h * 0.4);
    const d = flightPath(cx, cy, rx, ry);
    for (const p of state.trails) p.setAttribute("d", d);
    state.path = state.trails[0];
    state.total = state.path.getTotalLength();
    state.lap = rand(ARC.seconds[0], ARC.seconds[1]) * 1000;
  };
  shape();
  addEventListener("resize", shape);
  state.onResize = shape;

  const lens = [0.30, 0.62, 1.0];
  state.t0 = performance.now();
  const tick = (now) => {
    state.raf = requestAnimationFrame(tick);
    const total = state.total;
    if (!total) return;
    const at = ((now - state.t0) % state.lap) / state.lap;   // 0..1 round the loop
    const nose = at * total;
    state.trails.forEach((p, i) => {
      const seg = total * ARC.trail * lens[i];
      p.style.strokeDasharray = `${seg} ${total}`;
      // The dash is drawn BACK from the nose, so the bright short one is the
      // tip and the faint long one is what it has already flown through.
      p.style.strokeDashoffset = `${seg - nose}`;
    });
    // The head, pointed the way it is going. The tangent is taken from a point
    // slightly behind rather than differentiated, which on a path this dense is
    // the same answer and a great deal less arithmetic.
    const a = state.path.getPointAtLength(nose % total);
    const b = state.path.getPointAtLength((nose - 9 + total) % total);
    const ang = Math.atan2(a.y - b.y, a.x - b.x);
    const arm = (s) => `${a.x - Math.cos(ang + s) * ARC.head} ` +
                       `${a.y - Math.sin(ang + s) * ARC.head}`;
    head.setAttribute("d", `M${arm(0.62)}L${a.x} ${a.y}L${arm(-0.62)}`);
  };
  state.raf = requestAnimationFrame(tick);
  state.up = performance.now();
  // A floor under the whole thing. The hint used to be visible from the first
  // paint and is now waiting on the parade's first frame - so if the parade
  // never comes, because a model failed to load or the stand-ins are in use and
  // the showcase declines to draw, the splash would sit there with no
  // instruction on it forever. Whatever else happens, it says what to press.
  state.giveUp = setTimeout(stopLoader, 12000);
  live = state;
}

/**
 * Take it down, and let the hint underneath wake up.
 *
 * The class goes on the body rather than the element because the hint is styled
 * from the stylesheet and should stay that way; all this knows is that loading
 * is over. The node is removed after the fade rather than left at zero opacity,
 * so a full-screen SVG is not sitting in the compositor for the rest of the
 * session doing nothing.
 */
export function stopLoader() {
  document.body.classList.add("loaded");
  if (!live) return;
  const { svg, raf, onResize, giveUp } = live;
  const live0 = live.up;
  live = null;
  clearTimeout(giveUp);
  cancelAnimationFrame(raf);
  removeEventListener("resize", onResize);
  // A load fast enough that this never really appeared should not then fade out
  // of nothing: below the time its own fade-in takes, it just goes. The
  // difference between a quick load and a flicker is entirely this.
  if (performance.now() - live0 < 450) { svg.remove(); return; }
  svg.classList.add("done");
  setTimeout(() => svg.remove(), 900);
}
