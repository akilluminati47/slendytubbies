import { CARVED, GROUND, BARK, ROCK } from "../world/surface.js";

/**
 * A panel for setting the procedural surfaces by eye.
 *
 * Every number in surface.js was arrived at by editing a file, rebuilding,
 * reloading, walking back to a bit of ground and squinting - which is a slow
 * way to answer a question that is entirely about how something looks, and it
 * is why the first three attempts at the ground were all wrong in different
 * directions. Sliders answer it in seconds because the change is on screen
 * while your hand is still on the control.
 *
 * Behind ?tune=1, so it is a tool rather than a feature. Nobody arrives at this
 * game and finds developer controls on their screen.
 *
 * "Set these" does not write to the source - a web page cannot - it puts the
 * values somewhere they can be read back out and baked in properly, and prints
 * the exact line to paste.
 */

const KINDS = [
  { kind: GROUND, label: "Ground" },
  { kind: BARK, label: "Bark" },
  { kind: ROCK, label: "Rock" },
];

const CSS = `
#tuner { position:fixed; top:12px; left:12px; z-index:30; width:250px;
  padding:12px 14px 10px; border-radius:14px; color:#d8d2c4;
  font:12px/1.5 'Courier New', monospace; letter-spacing:.02em;
  border:1px solid rgba(226,220,204,.14); background:rgba(10,10,13,.72);
  -webkit-backdrop-filter:blur(18px); backdrop-filter:blur(18px);
  box-shadow:0 24px 60px -28px #000; }
#tuner h4 { font-size:11px; letter-spacing:.16em; text-transform:uppercase;
  color:#8f8878; margin:0 0 8px; font-weight:400; }
#tuner .grp { margin-bottom:9px; }
#tuner .grp > b { display:block; font-weight:400; color:#c9e0cd; font-size:11px;
  letter-spacing:.1em; margin-bottom:3px; }
#tuner label { display:flex; align-items:center; gap:7px; margin:2px 0; }
#tuner label span { width:52px; color:#8f8878; }
#tuner input[type=range] { flex:1; accent-color:#8fae82; height:14px; }
#tuner output { width:34px; text-align:right; color:#d8d2c4; }
#tuner button { width:100%; margin-top:6px; padding:6px; cursor:pointer;
  font:inherit; color:#c9e0cd; border-radius:8px;
  border:1px solid #4c5a45; background:rgba(38,48,34,.6); }
#tuner button:hover { border-color:#8fae82; }
#tuner pre { margin:7px 0 0; padding:6px 7px; border-radius:7px; font-size:10.5px;
  color:#98907f; background:rgba(0,0,0,.4); white-space:pre-wrap; word-break:break-all; }
#tuner .hint { color:#6f6a5e; font-size:10.5px; margin-top:6px; }
`;

/** Is the game running as a tuning bench rather than as a game? */
export const TUNING = new URLSearchParams(location.search).has("tune");

/**
 * @param hooks.setChaser  (on) => void - spawn or remove the monster
 */
export function installTuner(hooks = {}) {
  if (!TUNING) return null;

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement("div");
  el.id = "tuner";
  el.innerHTML = `<h4>Surface</h4>`;
  document.body.appendChild(el);

  const rows = [];
  for (const { kind, label } of KINDS) {
    const grp = document.createElement("div");
    grp.className = "grp";
    grp.innerHTML = `<b>${label}</b>`;
    const mk = (name, min, max, step) => {
      const l = document.createElement("label");
      l.innerHTML = `<span>${name}</span>`;
      const r = document.createElement("input");
      r.type = "range"; r.min = min; r.max = max; r.step = step;
      const o = document.createElement("output");
      l.append(r, o);
      grp.appendChild(l);
      return { r, o };
    };
    rows.push({ kind, label, bump: mk("bump", 0, 8, 0.05), mottle: mk("mottle", 0, 1, 0.01) });
    el.appendChild(grp);
  }

  // The monster is off while you tune, because you cannot look at a rock for
  // ninety seconds with something hunting you - and being caught mid-drag ends
  // the round and takes the world with it.
  let chaserOn = false;
  const chaser = document.createElement("button");
  const paintChaser = () => {
    chaser.textContent = chaserOn ? "Chaser: on" : "Chaser: off";
    chaser.style.color = chaserOn ? "#d8a0a0" : "#c9e0cd";
  };
  chaser.addEventListener("click", () => {
    chaserOn = !chaserOn;
    hooks.setChaser?.(chaserOn);
    paintChaser();
  });
  paintChaser();
  el.appendChild(chaser);

  const set = document.createElement("button");
  set.textContent = "Set these";
  el.appendChild(set);
  const out = document.createElement("pre");
  out.textContent = "walk somewhere lit, then drag";
  el.appendChild(out);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Esc frees the mouse. Reload to start over. " +
    "Nothing here ships without ?tune=1.";
  el.appendChild(hint);

  /** Everything carved of one kind - the ground is one material, rocks are three. */
  const of = (kind) => CARVED.filter((c) => c.kind === kind);

  const sync = () => {
    for (const row of rows) {
      const live = of(row.kind)[0];
      if (!live) continue;
      // Adopt whatever the code currently sets, so the sliders start where the
      // game is rather than snapping it somewhere else the moment they appear.
      if (row.bump.r.value === "") return;
      row.bump.r.value = live.u.uSurfBump.value;
      row.mottle.r.value = live.u.uSurfMottle.value;
    }
  };

  const paint = () => {
    for (const row of rows) {
      row.bump.o.textContent = (+row.bump.r.value).toFixed(2);
      row.mottle.o.textContent = (+row.mottle.r.value).toFixed(2);
    }
  };

  const apply = (row) => {
    for (const c of of(row.kind)) {
      c.u.uSurfBump.value = +row.bump.r.value;
      c.u.uSurfMottle.value = +row.mottle.r.value;
    }
    paint();
  };

  for (const row of rows) {
    row.bump.r.addEventListener("input", () => apply(row));
    row.mottle.r.addEventListener("input", () => apply(row));
  }

  set.addEventListener("click", () => {
    const picked = {};
    const lines = [];
    for (const row of rows) {
      picked[row.label.toLowerCase()] = {
        bump: +(+row.bump.r.value).toFixed(2),
        mottle: +(+row.mottle.r.value).toFixed(2),
      };
      lines.push(`${row.label}: bump ${(+row.bump.r.value).toFixed(2)}` +
        `, mottle ${(+row.mottle.r.value).toFixed(2)}`);
    }
    // Somewhere it survives a reload and can be read back out and baked in.
    try { localStorage.setItem("slendytubbies.surface", JSON.stringify(picked)); } catch {}
    window.__surface = picked;
    out.textContent = lines.join("\n") + "\nsaved - tell me to bake it in";
    navigator.clipboard?.writeText(JSON.stringify(picked)).catch(() => {});
  });

  // The materials compile on their first draw, so the sliders cannot know where
  // to start until a frame has been rendered with them.
  const waitForCompile = setInterval(() => {
    if (!of(GROUND).length) return;
    clearInterval(waitForCompile);
    sync();
    paint();
  }, 200);

  return { rows, sync };
}
