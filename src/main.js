import * as THREE from "three";
import { CFG } from "./game/config.js";
import { Input } from "./engine/input.js";
import { World, heightAt } from "./world/world.js";
import { Player } from "./entities/player.js";
import { Tubby } from "./entities/tubby.js";
import { loadTubbyAssets, tickTV } from "./entities/tubbyModel.js";
import { WristHUD } from "./game/wristHud.js";
import { HINTS } from "./game/hints.js";
import { Settings } from "./game/settings.js";
import { Audio } from "./game/audio.js";
import { UI } from "./game/ui.js";
import { Showcase } from "./game/showcase.js";
import { Jumpscare } from "./game/jumpscare.js";
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
  showcase?.resize(innerWidth, innerHeight);
});

const input = new Input(renderer.domElement, renderer, rig);
const audio = new Audio();
const settings = new Settings();
const net = new NetClient();
settings.apply(renderer, audio);

audio.preload("jumpscare", "./assets/game/jumpscare.mp3");
audio.preload("scream", "./assets/game/scream.mp3");
audio.preload("heartbeat", "./assets/game/heartbeat.mp3");

const hasBakedAssets = Boolean(await loadTubbyAssets());

// The menu backdrop. Built after the rigs so it has something to parade, and
// before anything else so the title screen is never empty.
const showcase = new Showcase();
showcase.resize(innerWidth, innerHeight);

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
let scare = null;        // the capture sequence, while it is playing

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
    ui.tally(game.total - game.found);
    if (who) ui.flash(`${who.name} found custard: ${game.found}/${game.total}`);
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
  ui.setNote("Procedural stand-in models. See README to bake in the ripped meshes.");
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
  // Nothing synthesised when you are caught: the recording already played over
  // the jumpscare and a drone on top of it only muddies both.
  if (kind === "won") audio.won();
  spectating = false;
  spectator?.stop();
  document.body.classList.remove("spectating");
  // Online, only the host may start the next run - a guest hitting retry would
  // otherwise drop out of a lobby everyone else is still sitting in.
  ui.showEnd(headline, detail, online ? { host, onAgain: () => net.sendRestart() } : null);
  if (input.xr.presenting) input.xr.pulse(1, 400);
}

/**
 * Hand the camera over and let the player watch it happen.
 *
 * The mask is the best thing in the game and the old cut to a black card never
 * showed it. The recording sets the length: the push holds on the face until the
 * sound stops, and the card lands in the silence afterwards.
 */
/**
 * The sound for realising it is right there.
 *
 * Not on proximity alone - it is behind you for most of a run and a noise every
 * time would be wallpaper. It fires on the turn: close, hunting, and now inside
 * your view. Once per chase, so glancing back and forth does not machine-gun it.
 */
let heartTimer = null;

function checkSpotted(dt) {
  if (!player?.alive || spectating) return;
  for (const t of tubbies) {
    if (!t.onYourHeels(player)) { t.seenCue = false; continue; }
    if (t.seenCue) continue;
    const dx = t.pos.x - player.pos.x, dz = t.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    const look = (-Math.sin(input.yaw) * dx + -Math.cos(input.yaw) * dz) / d;
    if (look < Math.cos(CFG.tubby.lookAngle * Math.PI / 180)) continue;
    t.seenCue = true;
    input.gamepad.rumble(0.7, game.elapsed);
    // The heart comes in over the back half of the shock and carries on after
    // it, so the fright trails rather than stopping dead with the noise.
    audio.playSample("jumpscare", 0.8).then((seconds) => {
      if (!seconds) return;
      clearTimeout(heartTimer);
      heartTimer = setTimeout(() => {
        if (player?.alive && running) audio.playSample("heartbeat", 0.65);
      }, seconds * 500);
    });
  }
}

function beginScare(tubby) {
  player.alive = false;
  world?.stain(player.pos.x, player.pos.z, 1.15);
  // No synth sting under it. The recording is the whole joke and a sawtooth
  // drone across it just muddies both.
  tubby.model.play?.("attack", 0.08);

  const finish = () => {
    scare = null;
    if (online) { beginSpectating(); return; }
    endGame("dead", "Caught",
      `You recovered ${game.found} of ${game.total} dishes.<br>It heard you.`);
  };

  // If the recording never arrives - blocked, missing, undecodable - do not
  // strand the player staring at the floor waiting for a sound.
  const guard = setTimeout(() => {
    if (!scare) { console.warn("[scare] no recording, cutting straight to the card"); finish(); }
  }, 900);

  // playSample resolves with the recording's length once it has decoded, so the
  // sequence is built the moment we know how long to hold on the mask.
  audio.playSample("scream", 0.95).then((seconds) => {
    clearTimeout(guard);
    console.info(`[scare] holding ${seconds.toFixed(2)}s on the mask`);
    scare = new Jumpscare({
      camera, rig, input, tubby, seconds, onDone: finish,
    });
  });
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  input.update(dt);
  tickTV(dt);        // the belly screens run whether or not the game does
  if (running && !paused) world?.sky?.update(dt);

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

  if (scare) {
    scare.update(dt);
    // Only the model advances - no AI, no steering. The chaser holds the spot it
    // caught you on until the card lands, or it wanders out of its own close-up.
    for (const t of tubbies) t.model.update(dt, 0);
    // The dread overlay is at its loudest when the thing is on top of you, which
    // is exactly when it would bleach out the one shot of the mask. Pull it off.
    $("dread").style.opacity = String(0.55 * (1 - scare.push));
    renderer.render(scene, camera);
    return;
  }

  if (!running || paused || !player) {
    // On the front screens the cast walks past instead; anywhere else - paused,
    // or reading the end card - the real world stays behind the panel.
    if (!showcase.draw(dt, renderer, running)) renderer.render(scene, camera);
    return;
  }
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
    ui.tally(game.total - game.found);
    audio.pickup();
    input.gamepad.rumble(0.5, game.elapsed);
    input.xr.pulse(0.4, 90);
    if (online) net.sendTook(world.custards.indexOf(got));
    // It does not bolt. Slendytubbies 1 rules: taking a dish makes noise and the
    // noise is the point - it comes towards you, it does not give you a breather.
    if (game.found >= game.total) {
      endGame("won", "You got out",
        `All ${game.total} dishes recovered in ${game.elapsed.toFixed(0)} seconds.<br>It is still out there.`);
      return;
    }
  }

  let threat = 0;
  checkSpotted(dt);

  const threats = threatPoints();      // built once, shared by every tubby
  for (const [i, t] of tubbies.entries()) {
    if (host) {
      if (t.update(dt, player, threats) === "kill" && player.alive) {
        beginScare(t);
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
const gDaylight = { el: null, arc: null, val: null, last: -1 };

function bindGauge(g, id) {
  g.el = $(id);
  g.arc = g.el.querySelector(".arc");
  g.val = g.el.querySelector(".val");
  g.arc.style.strokeDasharray = `0 ${ARC}`;
}
bindGauge(gBattery, "battery");
bindGauge(gStamina, "stamina");
bindGauge(gDaylight, "daylight");

/**
 * Drive one ring. Skips the DOM entirely when nothing visible has changed -
 * these run every frame, and writing identical strings 60 times a second is
 * free layout work for no reason.
 */
/**
 * The hour ring.
 *
 * It sweeps once per in-game hour rather than showing the whole day, because a
 * day-long ring would creep too slowly to read as moving at all - and a dial
 * that is always turning tells you the world is on a clock without anyone
 * having to explain it. The face underneath says which hour, and the whole
 * thing lights while the sun is up and goes cold once it is down.
 */
function clockGauge(g, sky) {
  if (!g.el || !sky) return;
  const pct = sky.hourFraction;
  g.arc.style.strokeDasharray = `${pct * ARC} ${ARC}`;
  if (g.val.textContent !== sky.clock) g.val.textContent = sky.clock;
  g.el.classList.toggle("lit", sky.daylight);
  // Weather rides the same dial: heavier skies pull the ring back.
  g.el.classList.toggle("low", sky.weather === "rain");
}

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
  clockGauge(gDaylight, world?.sky);
  // Lit while the legs are actually going, which is what drains it.
  gauge(gStamina, sta, player.sprinting);

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
  get scare() { return scare; },
  // Stage the capture on demand. Waiting for the AI to corner you is a poor way
  // to look at a one-second sequence.
  scareNow: (dist = 1.15) => {
    const t = tubbies[0];
    if (!t || !player?.alive) return "not in a run";
    const yaw = input.yaw;
    t.pos.set(player.pos.x - Math.sin(yaw) * dist, 0, player.pos.z - Math.cos(yaw) * dist);
    t.root.position.set(t.pos.x, heightAt(t.pos.x, t.pos.z), t.pos.z);
    beginScare(t);
    return "staged";
  },
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
