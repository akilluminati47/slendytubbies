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
#tuner .wx { display:flex; gap:4px; margin-top:4px; }
#tuner .wx button { margin-top:0; padding:4px 0; font-size:10px; color:#6f6a5e;
  border-color:#3a4136; }
`;

/** Is the game running as a tuning bench rather than as a game? */
export const TUNING = new URLSearchParams(location.search).has("tune");

const SAVED = "slendytubbies.surface";

/** Whatever was last set here, or null. */
function readSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED) || "null"); } catch { return null; }
}

const WEATHERS = ["clear", "hazy", "overcast", "rain"];

/**
 * @param hooks.setChaser  (on) => void - spawn or remove the monster
 * @param hooks.getSky     () => Sky - the live sky, once a world exists
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

  // --- time and weather --------------------------------------------------
  // The light is most of what a surface looks like, so a bench that cannot
  // change it can only tell you how the ground reads at whatever o'clock you
  // happened to load. And the clock runs at a minute a second, so it has to be
  // possible to stop it - otherwise the thing you are judging drifts under you
  // while your hand is on the slider.
  const sky = document.createElement("div");
  sky.className = "grp";
  sky.innerHTML = "<b>Sky</b>";
  const timeRow = document.createElement("label");
  timeRow.innerHTML = "<span>hour</span>";
  const timeR = document.createElement("input");
  timeR.type = "range"; timeR.min = 0; timeR.max = 23.99; timeR.step = 0.25;
  timeR.value = 12;
  const timeO = document.createElement("output");
  timeRow.append(timeR, timeO);
  sky.appendChild(timeRow);

  const wx = document.createElement("div");
  wx.className = "wx";
  const wxButtons = WEATHERS.map((name) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.dataset.wx = name;
    wx.appendChild(b);
    return b;
  });
  sky.appendChild(wx);

  const freeze = document.createElement("button");
  let frozen = true;
  const paintFreeze = () => {
    freeze.textContent = frozen ? "Clock: held" : "Clock: running";
    freeze.style.color = frozen ? "#c9e0cd" : "#8f8878";
  };
  freeze.addEventListener("click", () => { frozen = !frozen; paintFreeze(); });
  paintFreeze();
  sky.appendChild(freeze);
  el.appendChild(sky);

  const clock = () => hooks.getSky?.();
  const paintTime = () => {
    const h = +timeR.value;
    timeO.textContent = `${String(Math.floor(h)).padStart(2, "0")}:` +
      String(Math.floor((h % 1) * 60)).padStart(2, "0");
  };
  timeR.addEventListener("input", () => {
    const s = clock();
    if (s) s.hour = +timeR.value;
    paintTime();
  });
  paintTime();

  const setWeather = (name) => {
    const s = clock();
    if (!s) return;
    s.weather = name;
    // Snapped rather than eased. The game takes about half a minute to change
    // its mind about the weather, which is right in play and useless here.
    s.wet = { clear: 0, hazy: 0.35, overcast: 0.7, rain: 1 }[name];
    s.rainfall = name === "rain" ? 1 : 0;
    s.weatherLeft = 1e6;   // and it stays put
    for (const b of wxButtons) {
      b.style.color = b.dataset.wx === name ? "#c9e0cd" : "#6f6a5e";
      b.style.borderColor = b.dataset.wx === name ? "#8fae82" : "#3a4136";
    }
  };
  for (const b of wxButtons) b.addEventListener("click", () => setWeather(b.dataset.wx));

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

  /**
   * Where the sliders start.
   *
   * From whatever was last Set here if there is one, so a session resumes
   * where the last one stopped instead of throwing the work away; otherwise
   * from whatever the code currently sets, so they never snap the world
   * somewhere else the moment they appear.
   */
  const sync = () => {
    const saved = readSaved();
    for (const row of rows) {
      const live = of(row.kind)[0];
      if (!live) continue;
      const was = saved?.[row.label.toLowerCase()];
      row.bump.r.value = was ? was.bump : live.u.uSurfBump.value;
      row.mottle.r.value = was ? was.mottle : live.u.uSurfMottle.value;
      apply(row);
    }
    if (saved) out.textContent = "resumed from your last Set";
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

  // Hold the clock, or follow it.
  //
  // The sky keeps its own time whether or not anybody is playing, at a minute a
  // second - so without this the light walks a full hour past you every minute
  // you spend on a slider, and the surface you decided on at noon is being
  // judged at one o'clock by the time you have finished.
  let armedSky = false;
  const holdClock = () => {
    const s = clock();
    if (s) {
      if (!armedSky) {
        armedSky = true;
        s.hour = +timeR.value;
        setWeather(s.weather ?? "clear");
      }
      if (frozen) s.hour = +timeR.value;
      else { timeR.value = s.hour; paintTime(); }
    }
    requestAnimationFrame(holdClock);
  };
  requestAnimationFrame(holdClock);

  return { rows, sync };
}
