import * as THREE from "three";
import { makeTorch, holdInHand, placeInHand, dropFromHand } from "../entities/torch.js";

/**
 * A bench for putting a torch in a hand, at ?torch=1.
 *
 * Everything about how a held prop looks is a question you answer by looking at
 * it, and this file exists because the alternative - edit a number, rebuild,
 * reload, wait for the parade to bring the right character round, squint - is
 * slow enough that it was answered wrong four times running. The grip, the
 * palm side, the size and the bulb were each found by measuring something and
 * believing the measurement instead of the picture. Sliders close that gap:
 * the change is on screen while your hand is still on the control.
 *
 * Two things are adjustable here.
 *
 * The TORCH, in the character's own three axes - across, up, along the way it
 * is looking - plus a roll/pitch/yaw in the torch's own frame. These sit on top
 * of the automatic placement rather than replacing it, so the measured grip
 * still does the work of finding the palm and these only say where along the
 * prop the hand sits.
 *
 * The HAND, bone by bone. The rig has two finger segments and a thumb and the
 * code to curl them has been there all along, switched off behind GRIP_ENABLED
 * because no bend axis had been found that reads as a closing hand rather than
 * as a mitten sheared into a blade. That is not a thing to guess a second time;
 * it is a thing to turn by hand and watch. Whatever comes out of here is what
 * gets baked in.
 *
 * Behind a query flag, so it is a tool and not a feature - nobody arrives at
 * this game and finds developer controls on their screen.
 */

/** Is the game running as the torch bench? */
export const TORCH_BENCH = new URLSearchParams(location.search).has("torch");

const SAVED = "slendytubbies.torch";

const CHARACTERS = ["guardian", "laalaa", "po", "dipsy"];
const KINDS = ["handheld", "searchlight"];
const CLIPS = ["idle", "walk", "chase"];

/** Which bone each grip row drives, in the order tubbyModel collects them. */
const GRIP_ROWS = ["Fingers 1", "Fingers 2", "Thumb"];

const DEG = 180 / Math.PI;

const CSS = `
#tbench { position:fixed; top:10px; left:10px; z-index:40; width:296px;
  max-height:calc(100vh - 20px); overflow-y:auto; padding:12px 14px 10px;
  border-radius:14px; color:#d8d2c4; font:12px/1.45 'Courier New', monospace;
  letter-spacing:.02em; border:1px solid rgba(226,220,204,.14);
  background:rgba(10,10,13,.78); -webkit-backdrop-filter:blur(18px);
  backdrop-filter:blur(18px); box-shadow:0 24px 60px -28px #000; }
#tbench h4 { font-size:11px; letter-spacing:.16em; text-transform:uppercase;
  color:#8f8878; margin:10px 0 6px; font-weight:400; }
#tbench h4:first-child { margin-top:0; }
#tbench .row { display:flex; gap:5px; margin-bottom:6px; flex-wrap:wrap; }
#tbench button { flex:1; min-width:0; padding:5px 2px; cursor:pointer;
  font:inherit; font-size:10.5px; color:#8f8878; border-radius:7px;
  border:1px solid #3a4136; background:rgba(38,48,34,.45); }
#tbench button:hover { border-color:#8fae82; }
#tbench button.on { color:#cfe6d3; border-color:#8fae82; background:rgba(64,86,58,.5); }
#tbench label { display:flex; align-items:center; gap:6px; margin:3px 0; }
#tbench label > span { width:44px; color:#8f8878; flex:none; }
#tbench input[type=range] { flex:1; min-width:0; accent-color:#8fae82; height:13px; }
#tbench input[type=number] { width:58px; flex:none; font:inherit; font-size:11px;
  color:#d8d2c4; background:rgba(0,0,0,.45); border:1px solid #3a4136;
  border-radius:5px; padding:2px 4px; }
#tbench .sub { color:#c9e0cd; font-size:10.5px; letter-spacing:.08em; margin:7px 0 2px; }
#tbench pre { margin:7px 0 0; padding:6px 7px; border-radius:7px; font-size:10px;
  color:#98907f; background:rgba(0,0,0,.45); white-space:pre-wrap;
  word-break:break-all; max-height:132px; overflow-y:auto; }
#tbench .hint { color:#6f6a5e; font-size:10px; margin-top:6px; line-height:1.5; }
#tbench .wide { width:100%; margin-top:6px; padding:6px; }
`;

/** Read whatever was last Set here. */
function readSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED) || "null"); } catch { return null; }
}

/**
 * A slider with a number box beside it, kept in step.
 *
 * Both, not one or the other: dragging is how you find a value and typing is
 * how you land on it, and a bench that only offers the first makes you chase
 * the last two decimal places with a mouse.
 */
function slider(parent, name, { min, max, step, value, onInput }) {
  const l = document.createElement("label");
  l.innerHTML = `<span>${name}</span>`;
  const r = document.createElement("input");
  r.type = "range"; r.min = min; r.max = max; r.step = step; r.value = value;
  const n = document.createElement("input");
  n.type = "number"; n.min = min; n.max = max; n.step = step; n.value = value;
  l.append(r, n);
  parent.appendChild(l);

  let quiet = false;
  const push = (v, from) => {
    if (quiet) return;
    quiet = true;
    // The box may be typed past the slider's range; let it, and let the slider
    // sit at its end rather than dragging the typed value back.
    if (from !== r) r.value = v;
    if (from !== n) n.value = v;
    quiet = false;
    onInput(+v);
  };
  r.addEventListener("input", () => push(r.value, r));
  n.addEventListener("input", () => push(n.value, n));
  return {
    set(v) { quiet = true; r.value = v; n.value = +(+v).toFixed(4); quiet = false; },
    get() { return +n.value; },
  };
}

/**
 * @param hooks.showcase  the menu parade, whose stage and renderer this borrows
 */
export function installTorchBench({ showcase } = {}) {
  if (!TORCH_BENCH || !showcase) return null;

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  // The stage only draws on the front screens, and the title card sits over the
  // middle of it - which is where the hand is.
  document.body.dataset.screen = "title";
  const chrome = document.createElement("style");
  chrome.textContent = `#title, #mode, #lobby, #hud, .byline { opacity:0 !important;
    pointer-events:none !important; }`;
  document.head.appendChild(chrome);

  const el = document.createElement("div");
  el.id = "tbench";
  document.body.appendChild(el);

  const saved = readSaved() ?? {};
  const state = {
    who: "laalaa",
    kind: "handheld",
    clip: "idle",
    playing: false,
    mode: "orbit",
    turn: 0,
    // Per torch kind, because the two are held differently and the whole point
    // is to settle both.
    // The baked-in values are the starting point, so a fresh session opens on
    // what the game actually ships rather than on zero - and anything Set here
    // since then wins over both.
    torch: {
      handheld: { side: -0.022, up: -0.044, forward: 0.22, rx: 0, ry: 0, rz: 0,
                  ...(saved.handheld?.torch ?? {}) },
      searchlight: { side: 0, up: -0.048, forward: 0.07, rx: 0, ry: 0, rz: 0,
                     ...(saved.searchlight?.torch ?? {}) },
    },
    grip: {
      handheld: saved.handheld?.grip
        ?? [[-4, 0, 0], [7, -4, 0], [9, -9, 0]].map(([x, y, z]) => ({ x, y, z })),
      searchlight: saved.searchlight?.grip
        ?? [[0, 0, 0], [7, 0, 0], [-79, -2, -11]].map(([x, y, z]) => ({ x, y, z })),
    },
  };

  let model = null;
  let bone = null;
  let torch = null;

  /* ------------------------------------------------------------- rebuild -- */

  const findHand = (root) => {
    let found = null;
    root.traverse((o) => {
      if (!found && o.isBone && /^hand[_ ]?r([_ ]|$)/i.test(o.name)) found = o;
    });
    return found;
  };

  /** Put the chosen character on the stage with the chosen torch in hand. */
  const rebuild = () => {
    const next = showcase.hold(state.who);
    if (!next) return false;
    if (model && model !== next && bone) dropFromHand(bone);
    model = next;
    bone = findHand(model.root);
    model.play(state.clip, 0);
    model.mixer.timeScale = state.playing ? 1 : 0;
    torch = makeTorch(state.kind);
    place();
    applyGrip();
    return true;
  };

  /** Push the current offsets into the torch and hang it back on the bone. */
  const place = () => {
    if (!torch || !bone) return;
    const t = state.torch[state.kind];
    torch.nudge.side = t.side;
    torch.nudge.up = t.up;
    torch.nudge.forward = t.forward;
    torch.twist = [t.rx / DEG, t.ry / DEG, t.rz / DEG];
    holdInHand(torch, bone, model.root);
    torch.beam.visible = true;
    // The same re-level the game does, so the bench is judging what ships.
    model.afterPose = () => placeInHand(torch, bone, model.root);
  };

  const applyGrip = () => {
    if (!model) return;
    const pose = state.grip[state.kind];
    model.gripPose = pose.map((a) => ({ x: a.x / DEG, y: a.y / DEG, z: a.z / DEG }));
  };

  /* ------------------------------------------------------------ controls -- */

  const pickRow = (label, values, get, set) => {
    el.insertAdjacentHTML("beforeend", `<h4>${label}</h4>`);
    const row = document.createElement("div");
    row.className = "row";
    const buttons = values.map((v) => {
      const b = document.createElement("button");
      b.textContent = v;
      b.addEventListener("click", () => { set(v); paintRow(); });
      row.appendChild(b);
      return [b, v];
    });
    el.appendChild(row);
    const paintRow = () => {
      for (const [b, v] of buttons) b.classList.toggle("on", get() === v);
    };
    paintRow();
    return paintRow;
  };

  const paintWho = pickRow("Character", CHARACTERS,
    () => state.who, (v) => { state.who = v; rebuild(); });
  const paintKind = pickRow("Torch", KINDS,
    () => state.kind, (v) => { state.kind = v; rebuild(); syncAll(); });
  const paintClip = pickRow("Clip", CLIPS,
    () => state.clip, (v) => { state.clip = v; model?.play(v, 0.12); });

  const playRow = document.createElement("div");
  playRow.className = "row";
  const playBtn = document.createElement("button");
  const paintPlay = () => {
    playBtn.textContent = state.playing ? "Playing" : "Paused";
    playBtn.classList.toggle("on", state.playing);
  };
  playBtn.addEventListener("click", () => {
    state.playing = !state.playing;
    if (model) model.mixer.timeScale = state.playing ? 1 : 0;
    paintPlay();
  });
  paintPlay();
  playRow.appendChild(playBtn);

  // Turning the character is how you check a grip from the other side without
  // flying the camera through their arm.
  const spinBtn = document.createElement("button");
  spinBtn.textContent = "Turn 45°";
  spinBtn.addEventListener("click", () => {
    state.turn = (state.turn + Math.PI / 4) % (Math.PI * 2);
    showcase.turn = state.turn;
    place();          // the nudge is in the model's axes, so it moves with it
  });
  playRow.appendChild(spinBtn);
  el.appendChild(playRow);

  const paintMode = pickRow("Drag does", ["orbit", "move", "turn"],
    () => state.mode, (v) => { state.mode = v; });

  // The stage is lit for a horror menu, which is the wrong light for looking at
  // a black object held against a dark body - the exact thing that made the
  // first pass at this invisible and sent me looking for a bug that was not
  // there. The lamps keep their own base level so this only ever scales it.
  el.insertAdjacentHTML("beforeend", `<h4>Stage</h4>`);
  const lights = [];
  showcase.scene.traverse((o) => { if (o.isLight) lights.push([o, o.intensity]); });
  slider(el, "light", {
    min: 0.2, max: 8, step: 0.1, value: 1,
    onInput: (v) => { for (const [lamp, base] of lights) lamp.intensity = base * v; },
  });

  /* ---- torch offsets ---- */
  el.insertAdjacentHTML("beforeend", `<h4>Torch in hand</h4>`);
  const offBox = document.createElement("div");
  el.appendChild(offBox);
  offBox.insertAdjacentHTML("beforeend", `<div class="sub">position (m)</div>`);
  const put = (key) => (v) => { state.torch[state.kind][key] = v; place(); report(); };
  const sx = slider(offBox, "side", { min: -0.3, max: 0.3, step: 0.002, value: 0, onInput: put("side") });
  const sy = slider(offBox, "up", { min: -0.3, max: 0.3, step: 0.002, value: 0, onInput: put("up") });
  const sz = slider(offBox, "fwd", { min: -0.3, max: 0.3, step: 0.002, value: 0, onInput: put("forward") });
  offBox.insertAdjacentHTML("beforeend", `<div class="sub">turn (°)</div>`);
  const rx = slider(offBox, "pitch", { min: -180, max: 180, step: 1, value: 0, onInput: put("rx") });
  const ry = slider(offBox, "yaw", { min: -180, max: 180, step: 1, value: 0, onInput: put("ry") });
  const rz = slider(offBox, "roll", { min: -180, max: 180, step: 1, value: 0, onInput: put("rz") });

  /* ---- the hand ---- */
  el.insertAdjacentHTML("beforeend", `<h4>Hand bones (°)</h4>`);
  const gripBox = document.createElement("div");
  el.appendChild(gripBox);
  const gripCtl = GRIP_ROWS.map((name, i) => {
    gripBox.insertAdjacentHTML("beforeend", `<div class="sub">${name}</div>`);
    const set = (axis) => (v) => { state.grip[state.kind][i][axis] = v; applyGrip(); report(); };
    return {
      x: slider(gripBox, "x", { min: -150, max: 150, step: 1, value: 0, onInput: set("x") }),
      y: slider(gripBox, "y", { min: -150, max: 150, step: 1, value: 0, onInput: set("y") }),
      z: slider(gripBox, "z", { min: -150, max: 150, step: 1, value: 0, onInput: set("z") }),
    };
  });

  const zeroBtn = document.createElement("button");
  zeroBtn.className = "wide";
  zeroBtn.textContent = "Open the hand (zero all)";
  zeroBtn.addEventListener("click", () => {
    for (const a of state.grip[state.kind]) { a.x = 0; a.y = 0; a.z = 0; }
    applyGrip(); syncAll(); report();
  });
  el.appendChild(zeroBtn);

  /* ---- output ---- */
  const setBtn = document.createElement("button");
  setBtn.className = "wide";
  setBtn.textContent = "Set these";
  el.appendChild(setBtn);
  const out = document.createElement("pre");
  out.textContent = "drag in the view, or type a value";
  el.appendChild(out);
  el.insertAdjacentHTML("beforeend", `<div class="hint">
    Drag in the view; wheel zooms. Values are per torch, so set the black one
    and the lamp separately. "Set these" saves them and copies the numbers -
    tell me to bake them in. Nothing here ships without ?torch=1.</div>`);

  const snapshot = () => ({
    handheld: { torch: { ...state.torch.handheld }, grip: state.grip.handheld.map((a) => ({ ...a })) },
    searchlight: { torch: { ...state.torch.searchlight }, grip: state.grip.searchlight.map((a) => ({ ...a })) },
  });

  const report = () => {
    const t = state.torch[state.kind];
    const g = state.grip[state.kind];
    out.textContent =
      `${state.kind}\n` +
      `nudge { side: ${t.side.toFixed(3)}, up: ${t.up.toFixed(3)}, ` +
      `forward: ${t.forward.toFixed(3)} }\n` +
      `twist  ${t.rx}° ${t.ry}° ${t.rz}°\n` +
      g.map((a, i) => `${GRIP_ROWS[i]}  ${a.x} ${a.y} ${a.z}`).join("\n");
  };

  setBtn.addEventListener("click", () => {
    const picked = snapshot();
    try { localStorage.setItem(SAVED, JSON.stringify(picked)); } catch { /* private mode */ }
    window.__torch = picked;
    navigator.clipboard?.writeText(JSON.stringify(picked, null, 2)).catch(() => {});
    report();
    out.textContent += "\n\nsaved - tell me to bake it in";
  });

  /** Put every control where the state says it is. */
  const syncAll = () => {
    const t = state.torch[state.kind];
    sx.set(t.side); sy.set(t.up); sz.set(t.forward);
    rx.set(t.rx); ry.set(t.ry); rz.set(t.rz);
    state.grip[state.kind].forEach((a, i) => {
      gripCtl[i].x.set(a.x); gripCtl[i].y.set(a.y); gripCtl[i].z.set(a.z);
    });
    paintWho(); paintKind(); paintClip(); paintMode();
    report();
  };

  /* --------------------------------------------------------------- mouse -- */

  const cam = showcase.camera;
  // Round behind the shoulder and slightly above: the one angle that has both
  // the palm and the length of the torch in it, which is what you are judging.
  const view = { yaw: 2.5, pitch: 0.26, dist: 0.85 };
  const target = new THREE.Vector3();
  const basis = new THREE.Matrix4();

  /**
   * What the camera pivots on: the middle of the palm.
   *
   * Not the torch. Orbiting the torch means the torch never moves in the frame
   * however far you drag it - the camera goes with it - so the one thing you
   * are trying to see is the one thing you cannot. The hand is the fixed point
   * here, which makes the offsets visible as offsets.
   *
   * The palm is the same point holdInHand works from, cached on the bone, so
   * the view is centred on the thing the placement is measured against.
   */
  const aimAt = () => {
    if (!bone) return false;
    bone.updateWorldMatrix(true, true);
    const palm = bone.userData.grip?.point;
    target.set(0, 0, 0);
    if (palm) target.copy(palm);
    target.applyMatrix4(bone.matrixWorld);
    return true;
  };

  const placeCamera = () => {
    if (!aimAt()) return;
    const cp = Math.cos(view.pitch);
    cam.position.set(
      target.x + Math.sin(view.yaw) * cp * view.dist,
      target.y + Math.sin(view.pitch) * view.dist,
      target.z + Math.cos(view.yaw) * cp * view.dist);
    cam.lookAt(target);
  };

  const canvas = document.querySelector("canvas");
  let drag = null;
  canvas?.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#tbench")) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  const stop = () => { drag = null; };
  canvas?.addEventListener("pointerup", stop);
  canvas?.addEventListener("pointercancel", stop);

  canvas?.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!dx && !dy) return;

    if (state.mode === "orbit") {
      view.yaw -= dx * 0.006;
      view.pitch = Math.max(-1.3, Math.min(1.3, view.pitch + dy * 0.005));
      return;
    }

    const t = state.torch[state.kind];
    if (state.mode === "turn") {
      t.ry = Math.round(t.ry - dx * 0.5);
      t.rx = Math.round(t.rx + dy * 0.5);
      place(); syncAll();
      return;
    }

    // Move: drag in the screen plane, and with shift along the view axis - then
    // put that world movement back into the character's own axes, which is what
    // the numbers are in. Doing it through the basis rather than by mapping
    // "right means side" keeps the drag honest once the character has turned.
    if (!model) return;
    const k = view.dist * 0.0022;
    const step = new THREE.Vector3();
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const into = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate();
    if (e.shiftKey) step.addScaledVector(into, -dy * k);
    else step.addScaledVector(right, dx * k).addScaledVector(up, -dy * k);

    model.root.updateWorldMatrix(true, false);
    basis.extractRotation(model.root.matrixWorld);
    const mSide = new THREE.Vector3().setFromMatrixColumn(basis, 0);
    const mFwd = new THREE.Vector3().setFromMatrixColumn(basis, 2);
    t.side = +(t.side + step.dot(mSide)).toFixed(4);
    t.up = +(t.up + step.y).toFixed(4);
    t.forward = +(t.forward + step.dot(mFwd)).toFixed(4);
    place(); syncAll();
  });

  canvas?.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.dist = Math.max(0.25, Math.min(6, view.dist * (1 + Math.sign(e.deltaY) * 0.12)));
  }, { passive: false });

  /* ---------------------------------------------------------------- tick -- */

  // Wrapped rather than given its own loop: the camera has to be set for the
  // frame that is about to be drawn, and the stage's draw IS that frame.
  const drawn = showcase.draw.bind(showcase);
  showcase.draw = (dt, renderer, running) => {
    if (!model && !rebuild()) return drawn(dt, renderer, running);
    showcase.turn = state.turn;
    placeCamera();
    return drawn(dt, renderer, running);
  };

  syncAll();
  // On the window as well as returned: this is a bench, and being able to poke
  // at it from the console is most of what a bench is for.
  const api = { state, snapshot, view, place, applyGrip, sync: syncAll };
  window.__bench = api;
  return api;
}
