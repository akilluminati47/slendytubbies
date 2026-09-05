# Slendytubbies (three.js)

**Play: <https://slendytubbies.pages.dev>**

A first-person survival-horror prototype: recover ten dishes of tubby custard from a
fogged wasteland while Tinky Winky hunts you by sight and sound.

```bash
npm run serve
```

then open <http://localhost:8322>.

## Controls

Every input path feeds one intent struct (`src/engine/intent.js`), so devices can be mixed
freely — pick up a pad mid-game, put it down, carry on with the mouse. No mode switch.

| | Move | Look | Sprint | Jump | Torch | Menu |
|---|---|---|---|---|---|---|
| Keyboard | WASD / arrows | mouse | Shift | Space | F | Esc |
| Xbox | L stick / d-pad | R stick | L3 · RT · LB | A | X | Start |
| PlayStation | L stick / d-pad | R stick | L3 · R2 · L1 | ✕ | □ | Options |
| Switch Pro | L stick / d-pad | R stick | L3 · ZR · L | B | Y | + |
| Touch | left-thumb stick | drag anywhere else | push stick to its edge | ↑ button | torch button | II button |
| Quest / WebXR | L thumbstick | head + R snap turn | L grip | A / X | B / Y | — |

**Menus are fully controller-driven.** Either stick or the d-pad moves the cursor (with
hold-to-repeat), A selects, B goes back, the bumpers switch tabs, Start pauses and resumes.
Sliders and the choice rows take left/right directly rather than making you "enter" them
first, which is the one thing that would make settings worse on a pad than a mouse.

Button *indices* are identical across all three pad families under the W3C standard
mapping; only the printed labels differ, and Nintendo transposes A/B and X/Y physically.
`detectBrand()` picks the right glyphs so nobody is told to press the wrong button.

## How it plays

The tubby never cheats. It finds you two ways and only two ways:

* **Sight** — a ~100° cone out to 26 m, blocked by tree trunks. Your torch adds 4 m.
* **Hearing** — a radius set by what you are doing: standing still 1.4 m, walking 9 m,
  sprinting 22 m. Landing a jump is a 14 m burst, and **taking a dish is a 26 m burst**.

Walk over a dish to take it — no button, no hold. It is loud, and everything hunting you
turns and **bolts** — 11 m/s, far faster than you can run, away from every player at once,
in full view. It never despawns; after a few seconds it settles and starts hunting again.
So each pickup is a spike of danger, then a breather you actually get to watch happen.

Chase speed (5.4 m/s) sits just under your sprint (6.0), so you can outrun it for exactly
as long as your six seconds of stamina last. A second tubby joins at the halfway mark.

All tuning lives in [`src/game/config.js`](src/game/config.js).

### What the AI actually costs

Profiled rather than assumed, because the obvious suspect was wrong. `Tubby#update` with
the player in sight — the expensive path, including the line-of-sight check against all 510
obstacles — measures **4.9 µs**. Two tubbies are ~0.1% of a 16.7 ms frame. Rendering is
0.54 ms, and 78% of that is the torch's shadow pass.

So the AI was never the problem and has not been "optimised" beyond removing per-frame
allocations from its hot path (a `Vector3.clone()` per tubby per frame, and a threat array
that was being rebuilt once per tubby rather than once per frame). That alone took it from
8.7 µs to 4.9 µs, but the real win was the light fix below.

### One light, not ten

Each custard dish used to carry its own `PointLight`. Taking one hid that light, which
changed the scene's light count — and three.js bakes the light count into every material's
shader, so the whole scene recompiled and dropped a fat frame at exactly the moment
something was chasing you. There is now a single dish light that World keeps parked on the
nearest un-taken dish. The count never changes, so nothing ever recompiles, and every
shader carries nine fewer lights besides.

## Multiplayer

Up to four players. **The host is always the Guardian** (the one with the hat); joiners
become Laa-Laa, Po and Dipsy in order; the CPU hunting everyone is always Tinky Winky
wearing the horror face.

Two kinds of lobby, one mechanism:

* **Public** — has a *name*, no password. It announces itself to a registry and anyone can
  see it listed with its host and headcount, and join with one click.
* **Private** — has a *password*, no name. The password is SHA-256 hashed in the browser
  and only the hash is ever sent; that hash *is* the Durable Object id. Nothing indexes
  it, so a private lobby is not merely unlisted, it is genuinely undiscoverable without
  the word. The password screen polls live, so you can see a friend is already in there
  before you commit.

That same hash also seeds the world generator, so every player walks an identical
wasteland derived from the lobby key alone — no terrain is ever transmitted.

The host simulates the CPU tubby and broadcasts it; the server drops `world` messages from
anyone else, so clients cannot fight over where the monster is. If the host leaves, the
longest-standing survivor is promoted and inherits the Guardian role.

### Dying with friends

Caught alone, the run ends. Caught in a lobby, you drop into **third-person
spectating** on a survivor — camera control only, jump to cycle who you watch. The run is
over only when the server sees that everyone is down, which it can tell and a client cannot.

The end screen is then **host-gated**: only the host gets a live "Play again", which
broadcasts a restart to the whole lobby. A guest hitting retry would otherwise tear
themselves out of a lobby everyone else is still sitting in, so guests are told who they are
waiting on and offered "Leave lobby" instead. The server drops `restart` from anyone but the
host, so the gate is real rather than a hidden button.

### Running the lobby server

Cloudflare Pages serves the game but cannot hold state or WebSockets, so lobbies need the
Worker in [`worker/`](worker/).

```bash
cd worker && npx wrangler dev --port 8787 --local
```

Point the game at it from the browser console, then reload:

```js
localStorage.setItem("slendytubbies.server", "http://127.0.0.1:8787")
```

The deployed lobby server is
<https://slendytubbies-lobbies.akilluminati47.workers.dev>, which is what
`CFG.net.server` points at. To redeploy it:

```bash
cd worker && npx wrangler deploy
```

## Deploying the game

`npm run deploy` builds `dist/` and pushes it to Cloudflare Pages.

The build step is not optional. Pages uploads whatever directory you give it and does **not**
honour `.assetsignore` — that is a Workers-static-assets feature — so deploying the repo root
publishes `node_modules/` and the entire raw `assets/models/` rip cache. `tools/build.mjs`
copies only what the browser actually loads: 27 files, 2.5 MB.

## Typography

Rock Salt (`assets/game/fonts/`) is the game's face, but it is a **display** face — no
bold, wide, and drawn with broken strokes that come apart below roughly 16px. So it is used
where it is big enough to earn its place: the title, headings, buttons, tabs and the custard
counter. Everything you actually have to *read* — labels, status lines, settings, the hints
row — is set in a clean sans, and anything numeric (slider values, headcounts, name and
password fields) is monospace so digits stay unambiguous.

Applying the scrawl to all of it, which was the first attempt, produced a menu nobody could
read at 10px.

## Layout

```
src/engine/    intent.js · input.js · gamepad.js · touch.js · xr.js
src/entities/  player.js · tubby.js · tubbyModel.js
src/world/     world.js · custard.js
src/game/      config.js · settings.js · audio.js · ui.js · hints.js · wristHud.js
src/net/       client.js · remote.js
worker/        Cloudflare Worker + Durable Objects (Lobby, Registry)
vendor/three/  the five three.js files the game imports, so it deploys standalone
tools/         serve.py · fetch_sketchfab.py · rig_transfer.py · gen_credits.py
```

Sound is synthesised at runtime (no audio files): wind, a heartbeat that tracks how close
the tubby is, and stingers. Browsers refuse to start an AudioContext without a user
gesture, which is exactly what the title screen is for — any key, click, tap or pad button
both begins the game and unlocks audio in the same press.

## Models

The game ships playable on **procedural stand-in tubbies** — correct silhouette and
proportions, hand-animated, wearing the real ripped Slendytubbies face texture.

`assets/models/` holds 23 downloaded models. To refresh them you need a Sketchfab API
token from <https://sketchfab.com/settings/password> (the *API Token* field, not your
password):

```bash
$env:SKETCHFAB_TOKEN="<token>"; python tools/fetch_sketchfab.py
```

Then bake the rig:

```bash
blender --background --python tools/rig_transfer.py -- --donor assets/models/donor/dipsy --skins assets/models/skin --out assets/game/tubbies.glb
```

### Why the pipeline looks like that

The cleanest meshes ([un_rendem123](https://sketchfab.com/un_rendem123/models)) are five
characters sharing one ~1,600-vertex *Teletubbie Template* — Po, Laa-Laa, Dipsy, Tinky
Winky, the Guardian — and they are **unrigged, 0 animations**. The richest animation sets
are on entirely different rips: abrisamibrahimovic's ST3 Dipsy carries **56 clips**.

So we do not retarget clips between skeletons (fragile — bone names never match). We keep
the donor's *skeleton and actions*, discard its mesh, and bind the clean template meshes to
that skeleton with heat-map weights. Shared topology means one bind serves all five, they
ride one armature in one GLB, and swapping character at runtime is mesh visibility.

### Known issue: the rigged models are not in yet

`CFG.tubby.useBakedRig` is **false**, so the game runs on the procedural stand-ins.

Two routes have been tried.

**Offline bake (`tools/rig_transfer.py`).** Abandoned. Blender's glTF exporter writes skinned
vertices in the *armature's* space and inverse bind matrices to match, so any placement
computed in world space lands in the wrong frame. The export binds cleanly and reports healthy
bones, healthy weights and a real draw call while rendering nothing. `tools/inspect_glb.mjs`
was written to settle it and did: vertices at y≈3641 against a skeleton spanning 115.
"Helpfully" normalising the armature to unit scale first made it worse, multiplying the bone
rest data by 32.

**In-browser bind (`src/entities/rigBuilder.js`).** Much closer, and the route worth
finishing. It reuses the donor's skeleton, bind matrix and inverse binds verbatim and only
swaps in new geometry, so there is no frame left to get wrong. All five characters bind, the
mixer drives all 56 clips, and weights spread across 17 bones rather than collapsing onto one.
Build takes ~2.8s.

What is still wrong is the scale and placement fit. It matches the skin's bounding box to the
donor's, but the donor's box is not the donor's *body* — this donor carries a chainsaw and has
bones reaching well outside the silhouette — so the character comes out about 1.5x too big and
floating above its own feet.

**Next step:** stop using bounding boxes for the fit. Match by landmarks instead: take the hip
and head bones from the donor skeleton in its bind pose (`Bip01_Pelvis` and the head chain are
both clearly named), and scale the skin so its own hip-to-head distance matches. That is
invariant to props and stray bones in a way a bounding box is not.

The rig source models are staged locally into `assets/game/rig/` and are gitignored; re-stage
them from `assets/models/` when picking this back up.

## Debug## Debug

`window.__dbg` in the console:

```js
__dbg.custard()    // coordinates of every remaining dish
__dbg.reveal()     // push the fog to 400 m
__dbg.here(6)      // warp a tubby 6 m in front of you
__dbg.overlaps()   // placement sanity check - must be 0
__dbg.stopRumble() // kill a stuck controller vibration
```

## Licence / credits

Non-commercial fan project. *Slendytubbies* is ZeoWorks'; *Teletubbies* is WildBrain's.
Model attributions are generated into [`CREDITS.md`](CREDITS.md) by `npm run credits`.
