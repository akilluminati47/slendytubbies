import * as THREE from "three";
import { CFG } from "./game/config.js";
import { Input } from "./engine/input.js";
import { World } from "./world/world.js";
import { Player } from "./entities/player.js";
import { Tubby } from "./entities/tubby.js";
import { loadTubbyAssets } from "./entities/tubbyModel.js";
import { WristHUD } from "./game/wristHud.js";
import { HINTS } from "./game/hints.js";
import { Settings } from "./game/settings.js";
import { Audio } from "./game/audio.js";
import { UI } from "./game/ui.js";
import { MenuNav } from "./game/menuNav.js";
import { Spectator } from "./game/spectate.js";
import { NetClient, seedFromKey, ROLE_LABEL } from "./net/client.js";
import { RemotePlayer } from "./net/remote.js";

const $ = (id) => document.getElementById(id);
const SOLO_SEED = 20030815;

/* ------------------------------------------------------------------ engine */

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 400);

// Everything that moves with the player hangs off the rig - camera, torch,
// XR controllers. See the note in Player's constructor for why.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const input = new Input(renderer.domElement, renderer, rig);
const audio = new Audio();
const settings = new Settings();
const net = new NetClient();
settings.apply(renderer, audio);

const hasBakedAssets = Boolean(await loadTubbyAssets());

/* -------------------------------------------------------------- game state */

const clock = new THREE.Clock();
let world = null;
let player = null;
let wrist = null;
let running = false;
let paused = false;
let online = false;      // are we in a lobby?
let host = true;         // solo counts as host: we simulate the AI
let myRole = "guardian";
let netWorld = null;
let netAccum = 0;
let spectating = false;
let spectator = null;

const tubbies = [];
const remotes = new Map();
const game = { found: 0, total: 0, over: null, elapsed: 0 };

/**
 * Build the wasteland. The seed matters: in multiplayer it comes from the lobby
 * key, so every player generates an identical map from the password alone and
 * no terrain is ever transmitted.
 */
function buildWorld(seed) {
  world = new World(scene, seed);
  player = new Player(camera, input, world, rig);
  wrist = new WristHUD();
  spectator = new Spectator(camera, rig);
  game.total = world.custards.length;
  $("total").textContent = game.total;
}

/**
 * Everyone the monster should run away from: you, plus every other player in
 * the lobby. Fleeing from only the collector would send it straight through
 * someone else's face.
 *
 * Reused, not rebuilt: this is read once per tubby per frame, and handing the
 * collector a fresh array each time was pure garbage for no benefit.
 */
const _threats = [];
/**
 * A bitmask of taken dishes. Ten dishes fit in an int, so the whole shared
 * objective costs one number per tick - and a player joining halfway through is
 * immediately correct rather than seeing ten dishes that are not really there.
 */
function custardMask() {
  let mask = 0;
  for (let i = 0; i < world.custards.length; i++) {
    if (world.custards[i].taken) mask |= 1 << i;
  }
  return mask;
}

function threatPoints() {
  _threats.length = 0;
  _threats.push(player.pos);
  for (const r of remotes.values()) _threats.push(r.current);
  return _threats;
}

function spawnTubby(kind) {
  // Always spawn well outside the player's fog, never in their lap.
  let p, tries = 0;
  do {
    const a = Math.random() * Math.PI * 2, r = 55 + Math.random() * 40;
    p = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    tries++;
  } while (tries < 30 && p.distanceTo(player.pos) < 50);
  tubbies.push(new Tubby(scene, world, kind, p));
}

function begin() {
  input.touch.setInGame(true);
  ui.show("game");
  input.lock();
  running = true;
  paused = false;
  clock.getDelta();
}

/* ------------------------------------------------------------------- modes */

let menuNav;
const ui = new UI(settings, net, {
  onUnlockAudio: () => {
    // Runs inside the real user gesture, the only moment a browser will start
    // an AudioContext.
    audio.unlock();
    settings.apply(renderer, audio);
  },

  onSolo: () => {
    online = false;
    host = true;
    myRole = "guardian";
    buildWorld(SOLO_SEED);
    spawnTubby("tinkywinky");     // the CPU is always Tinky Winky
    begin();
  },

  onMultiplayer: async (key, name, create, opts) => {
    await net.connect(key, name, create, opts);
    // connect() resolves when the socket opens; the role arrives in `welcome`.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not answer")), 8000);
      net.addEventListener("welcome", () => { clearTimeout(timer); resolve(); }, { once: true });
    });

    online = true;
    host = net.isHost;
    myRole = net.role;
    buildWorld(seedFromKey(key));

    // The CPU exists on every client, but only the host runs its brain.
    spawnTubby("tinkywinky");

    for (const p of net.peers.values()) addRemote(p);
    begin();
  },

  onResume: () => resume(),
  onRestart: () => location.reload(),
  onEnterVR: async () => {
    audio.unlock();
    try {
      await input.xr.enter();
    } catch (err) {
      ui.setNote(`Could not start VR: ${err.message}`);
    }
  },
});

menuNav = new MenuNav(ui);

/* -------------------------------------------------------------- net events */

function addRemote(info) {
  if (remotes.has(info.id)) return;
  const r = new RemotePlayer(scene, info);
  if (info.pos) r.apply(info);
  remotes.set(info.id, r);
}

net.addEventListener("join", (e) => {
  addRemote(e.detail);
  ui.flash(`${e.detail.name} joined as ${ROLE_LABEL[e.detail.role] ?? e.detail.role}`);
});
net.addEventListener("leave", (e) => {
  const r = remotes.get(e.detail.id);
  if (r) ui.flash(`${r.name} left`);
  r?.dispose(scene);
  remotes.delete(e.detail.id);
});
net.addEventListener("state", (e) => remotes.get(e.detail.id)?.apply(e.detail));
net.addEventListener("host", (e) => {
  // The old host left and we were promoted: start simulating the monster.
  if (e.detail.id !== net.id) return;
  host = true;
  myRole = net.role;
});
net.addEventListener("world", (e) => {
  if (host) return;                      // we are the authority; ignore echoes
  netWorld = e.detail;
  applyCustardMask(e.detail.custards);
});

/**
 * Reconcile our dishes with the host's. Authoritative in one direction only:
 * the host can tell us a dish is gone, never that a gone dish is back, so a
 * late packet cannot resurrect something we already watched someone collect.
 */
function applyCustardMask(mask) {
  if (typeof mask !== "number" || !world) return;
  let found = 0;
  for (let i = 0; i < world.custards.length; i++) {
    const taken = (mask & (1 << i)) !== 0;
    if (taken) {
      world.take(world.custards[i]);
      found++;
    } else if (world.custards[i].taken) {
      found++;                           // ours is gone; keep counting it
    }
  }
  if (found !== game.found) {
    game.found = found;
    $("found").textContent = found;
  }
}
net.addEventListener("took", (e) => {
  const c = world?.custards[e.detail.i];
  if (!world?.take(c)) return;
  // The count is the lobby's, not yours - everyone is filling the same ten.
  if (e.detail.by !== net.id) {
    game.found++;
    $("found").textContent = game.found;
    audio.pickup();
    const who = net.peers.get(e.detail.by);
    if (who) ui.flash(`${who.name} found custard — ${game.found}/${game.total}`);
  }
});
net.addEventListener("dead", (e) => {
  const r = remotes.get(e.detail.id);
  if (!r) return;
  r.setDead(true);
  ui.flash(`${r.name} was caught`);
  // If we were watching them, move on rather than staring at a body.
  if (spectating) spectator.cycle(1);
});

net.addEventListener("over", () => {
  const detail = `Your lobby recovered ${game.found} of ${game.total} dishes.<br>` +
    `Tinky Winky got everyone.`;
  endGame("dead", "All caught", detail);
});

net.addEventListener("restart", () => {
  // The host called a new run; everyone reloads into the same lobby together.
  location.reload();
});

net.addEventListener("closed", () => {
  online = false;
  if (!game.over) ui.setNote("Lost connection to the lobby.");
});

/* --------------------------------------------------------------- lifecycle */

function pause() {
  if (!running || paused || game.over) return;
  paused = true;
  audio.suspend();
  input.gamepad.stop();
  input.release();               // we are giving the mouse back on purpose
  document.exitPointerLock?.();
  refreshHints();
  ui.show("pause");
}

function resume() {
  if (!paused) return;
  paused = false;
  audio.resume();
  input.touch.setInGame(true);
  ui.show("game");
  input.lock();
  clock.getDelta();     // throw away the time spent in the menu
}

// Losing pointer lock is how Esc reaches us in most browsers, so treat it as a
// pause rather than dumping the player into a live game with no cursor and no menu.
document.addEventListener("pointerlockchange", () => {
  if (running && !paused && !game.over && !document.pointerLockElement && !input.inVR) {
    pause();
  }
});

function refreshHints() {
  const scheme = input.scheme;
  let html = HINTS[scheme] ?? HINTS.keyboard;
  // A pad player needs the menu bindings too, not just the gameplay ones.
  if (HINTS.menu[scheme]) html += `<br><span class="menu-hint">${HINTS.menu[scheme]}</span>`;
  ui.setHints(html);
  document.body.dataset.scheme = scheme;
}
refreshHints();
addEventListener("pad", refreshHints);
addEventListener("touchui", refreshHints);

addEventListener("xr", (e) => {
  const d = e.detail;
  if (d.supported) ui.showVR(true);
  if (d.presenting === true) {
    if (CFG.xr.torchOnController) player?.attachTorchTo(input.xr.grips[1]);
    wrist?.attach(input.xr.grips[0]);
    audio.unlock();
    if (player) { running = true; paused = false; ui.show("game"); }
  } else if (d.presenting === false) {
    player?.detachTorch();
    wrist?.detach();
  }
  refreshHints();
});

if (!hasBakedAssets) {
  ui.setNote("Procedural stand-in models — see README to bake in the ripped meshes.");
}

/* -------------------------------------------------------------------- loop */

/** Everyone still alive and worth watching. */
function survivors() {
  return [...remotes.values()].filter((r) => !r.dead);
}

/**
 * Caught in a lobby: drop into spectator instead of ending. The run is only
 * over when the server says everyone is down, which it can see and we cannot.
 */
function beginSpectating() {
  spectating = true;
  player.alive = false;
  player.torch.intensity = 0;
  input.gamepad.stop();
  net.sendDead();
  spectator.start(survivors);
  document.body.classList.add("spectating");
  audio.caught();
}

function endGame(kind, headline, detail) {
  if (game.over) return;
  game.over = kind;
  player.alive = false;
  running = false;
  input.gamepad.stop();          // the loop is about to stop calling rumble()
  input.release();
  input.touch.setInGame(false);
  document.exitPointerLock?.();
  if (kind === "dead" && !spectating) audio.caught();
  if (kind === "won") audio.won();
  spectating = false;
  spectator?.stop();
  document.body.classList.remove("spectating");
  // Online, only the host may start the next run - a guest hitting retry would
  // otherwise drop out of a lobby everyone else is still sitting in.
  ui.showEnd(headline, detail, online ? { host, onAgain: () => net.sendRestart() } : null);
  if (input.xr.presenting) input.xr.pulse(1, 400);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  input.update(dt);

  // The title screen listens for DOM events, but a gamepad produces none.
  if (!running && !game.over && input.gamepad.anyPressed()) ui.padPressed();

  // Menus are fully controller-driven. Start pauses and resumes from either
  // side, and the nav read is skipped entirely while actually playing so the
  // jump button stays a jump button.
  const inMenu = !running || paused || game.over;
  const nav = input.gamepad.navPoll(dt);
  if (inMenu) menuNav.update(nav, input.gamepad.connected);
  if (nav.start && running) paused ? resume() : pause();
  if (input.intent.menu && running) paused ? resume() : pause();

  if (!running || paused || !player) { renderer.render(scene, camera); return; }
  game.elapsed += dt;

  if (spectating) {
    // Camera only. Jump cycles who you are watching - it is the button your
    // thumb is already on, and it does nothing else now that you are dead.
    if (input.intent.jump) {
      const t = spectator.cycle(1);
      if (t) ui.flash(`Watching ${t.name}`, 1800);
    }
    const watching = spectator.update(dt, input.intent);
    for (const [i, t] of tubbies.entries()) {
      if (host) t.update(dt, player, threatPoints());
      else { const w = netWorld?.tubby?.[i]; t.netApply(w?.p, w?.f, w?.s, dt); }
    }
    for (const r of remotes.values()) r.update(dt, camera);
    world.updateGlow(game.elapsed, spectator.pos);
    if (online) {
      netAccum += dt;
      if (netAccum >= 1 / 15) {
        netAccum = 0;
        if (host) net.sendWorld(tubbies.map((t) => t.netState()), custardMask());
      }
    }
    specHud(watching);
    renderer.render(scene, camera);
    return;
  }

  const wasGrounded = player.grounded;
  player.update(dt);
  if (!wasGrounded && player.grounded) audio.land();

  const got = player.tickCollect(dt, world.custards);
  if (got) {
    world.take(got);
    game.found++;
    $("found").textContent = game.found;
    audio.pickup();
    input.gamepad.rumble(0.5, game.elapsed);
    input.xr.pulse(0.4, 90);
    if (online) net.sendTook(world.custards.indexOf(got));
    // It bolts - away from everyone, faster than anyone can run, in full view.
    // No despawn: you watch it leave, and it comes back hunting.
    if (host) for (const t of tubbies) t.flee(threatPoints());   // once, on pickup
    if (game.found >= game.total) {
      endGame("won", "You got out",
        `All ${game.total} dishes recovered in ${game.elapsed.toFixed(0)} seconds.<br>It is still out there.`);
      return;
    }
  }

  let threat = 0;
  const threats = threatPoints();      // built once, shared by every tubby
  for (const [i, t] of tubbies.entries()) {
    if (host) {
      if (t.update(dt, player, threats) === "kill" && player.alive) {
        if (online) { beginSpectating(); break; }
        endGame("dead", "Caught", `You recovered ${game.found} of ${game.total} dishes.<br>It heard you.`);
        return;
      }
    } else {
      // Guests render the monster the host broadcasts, then do their own
      // proximity check - the host cannot see who it caught, only where it is.
      const w = netWorld?.tubby?.[i];
      // Snap the first time we hear about it, then interpolate. Otherwise it
      // visibly glides in from its local spawn point, which is nowhere near
      // where the host's monster actually is.
      if (w && !t.netSeen) {
        t.pos.set(w.p[0], 0, w.p[2]);
        t.facing = w.f ?? t.facing;
        t.netSeen = true;
      }
      t.netApply(w?.p, w?.f, w?.s, dt);
      if (player.alive &&
          Math.hypot(t.pos.x - player.pos.x, t.pos.z - player.pos.z) < CFG.tubby.killRange) {
        if (online) { beginSpectating(); break; }
        endGame("dead", "Caught", `You recovered ${game.found} of ${game.total} dishes.<br>It heard you.`);
        return;
      }
    }
    threat = Math.max(threat, t.threat(player));
  }

  for (const r of remotes.values()) r.update(dt, camera);

  world.updateGlow(game.elapsed, player.pos);

  if (online) {
    netAccum += dt;
    if (netAccum >= 1 / 15) {           // 15 Hz is ample for walking speed
      netAccum = 0;
      const moving = Math.hypot(player.vel.x, player.vel.z) > 0.6;
      net.sendState(player.pos, player.viewYaw(), moving ? "walk" : "idle");
      if (host) net.sendWorld(tubbies.map((t) => t.netState()), custardMask());
    }
  }

  audio.update(dt, threat);
  // Always call through, including at zero - rumble() stops the motors itself
  // when the threat clears. Skipping the call is what leaves a pad buzzing.
  input.gamepad.rumble(threat > 0.15 ? threat : 0, game.elapsed);
  if (input.xr.presenting && threat > 0.15) input.xr.pulse(threat * 0.5, 80);

  hud(threat);
  renderer.render(scene, camera);
}

// Ring circumference for r=17, so the arc can be driven by dasharray alone.
const ARC = 2 * Math.PI * 17;
const gBattery = { el: null, arc: null, val: null, last: -1 };
const gStamina = { el: null, arc: null, val: null, last: -1 };

function bindGauge(g, id) {
  g.el = $(id);
  g.arc = g.el.querySelector(".arc");
  g.val = g.el.querySelector(".val");
  g.arc.style.strokeDasharray = `0 ${ARC}`;
}
bindGauge(gBattery, "battery");
bindGauge(gStamina, "stamina");

/**
 * Drive one ring. Skips the DOM entirely when nothing visible has changed -
 * these run every frame, and writing identical strings 60 times a second is
 * free layout work for no reason.
 */
function gauge(g, v, lit) {
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  if (pct !== g.last) {
    g.last = pct;
    g.arc.style.strokeDasharray = `${(pct / 100) * ARC} ${ARC}`;
    g.val.textContent = pct;
    g.el.classList.toggle("low", pct <= 25);
    g.el.classList.toggle("critical", pct <= 10);
  }
  g.el.classList.toggle("lit", !!lit);
}

/** Spectating: a standing banner, plus who you are on. */
function specHud(watching) {
  $("dread").style.opacity = 0;
  $("spec-who").textContent = watching ? watching.name : "Nobody left to watch";
}

function hud(threat) {
  const bat = player.battery / CFG.player.batteryMax;
  const sta = player.stamina / CFG.player.staminaMax;

  if (input.xr.presenting) {
    wrist.draw(game.found, game.total, bat, sta, 0);
    return;
  }

  input.touch.setTorch(player.torchOn);
  gauge(gBattery, bat, player.torchOn);
  gauge(gStamina, sta, false);

  const dread = $("dread");
  dread.classList.toggle("beam", player.torchOn);
  dread.style.opacity = (threat * CFG.dread.maxOpacity).toFixed(3);
}

// setAnimationLoop, not requestAnimationFrame: WebXR drives the frame clock from
// the headset's display, and rAF simply never fires while presenting.
renderer.setAnimationLoop(frame);

// Debug handle: __dbg.tp(x, z), __dbg.here() to warp a tubby onto you, __dbg.reveal().
window.__dbg = {
  game, tubbies, remotes, scene, camera, input, rig, renderer, audio, settings, ui, net,
  get menuNav() { return menuNav; },
  pause, resume,
  get world() { return world; },
  get player() { return player; },
  get running() { return running; },
  get paused() { return paused; },
  get online() { return online; },
  get spectating() { return spectating; },
  spectator: () => spectator,
  get host() { return host; },
  get role() { return myRole; },
  roleLabel: () => ROLE_LABEL[myRole],
  stopRumble: () => input.gamepad.stop(),
  tp: (x, z) => player.pos.set(x, 0, z),
  here: (d = 6) => tubbies[0] && tubbies[0].pos.set(player.pos.x, 0, player.pos.z + d),
  reveal: () => (scene.fog.far = 400),
  custard: () => world.custards.filter((c) => !c.taken).map((c) => [c.pos.x | 0, c.pos.z | 0]),
  overlaps: () => {
    const o = world.obstacles;
    let n = 0;
    for (let i = 0; i < o.length; i++)
      for (let j = i + 1; j < o.length; j++)
        if (Math.hypot(o[i].x - o[j].x, o[i].z - o[j].z) < o[i].space + o[j].space - 1e-6) n++;
    return n;
  },
};
