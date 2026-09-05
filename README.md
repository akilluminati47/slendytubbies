# Slendytubbies (three.js)

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
| Touch | drag left half | drag right half | Run (latches) | Jump | Torch | — |
| Quest / WebXR | L thumbstick | head + R snap turn | L grip | A / X | B / Y | — |

Button *indices* are identical across all three pad families under the W3C standard
mapping; only the printed labels differ, and Nintendo transposes A/B and X/Y physically.
`detectBrand()` picks the right glyphs so nobody is told to press the wrong button.

## How it plays

The tubby never cheats. It finds you two ways and only two ways:

* **Sight** — a ~100° cone out to 26 m, blocked by tree trunks. Your torch adds 4 m.
* **Hearing** — a radius set by what you are doing: standing still 1.4 m, walking 9 m,
  sprinting 22 m. Landing a jump is a 14 m burst, and **taking a dish is a 26 m burst**.

Walk over a dish to take it — no button, no hold. It is loud, but everything hunting you
immediately breaks off, resets to `patrol`, and is pushed back beyond the fog. So each
pickup is a spike of danger followed by a real breather.

Chase speed (5.4 m/s) sits just under your sprint (6.0), so you can outrun it for exactly
as long as your six seconds of stamina last. A second tubby joins at the halfway mark.

All tuning lives in [`src/game/config.js`](src/game/config.js).

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

To deploy (needs `npx wrangler login` first):

```bash
cd worker && npx wrangler deploy
```

With the Worker routed under `/api` on the same domain as the Pages site, the client needs
no configuration at all — it defaults to same-origin.

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

### Known issue — the baked rig does not render

`CFG.tubby.useBakedRig` is **false**, so the game uses the stand-ins. Flip it to `true` to
work on this.

The bake produces a structurally healthy GLB: 44 bones, 56 clips, skin weights summing to
1, indices in range, correct bone world positions, and a draw call that submits. It still
renders nothing, because the skinned vertices are transformed away from their own skeleton.

Diagnosis so far: glTF says a skinned mesh node's transform **must be ignored**, but
three.js folds that node's world matrix into `bindMatrix`. Sketchfab rips arrive wrapped in
nested nodes carrying ~0.031 scale factors, and Blender parents meshes to armatures through
a hidden parent-inverse matrix. Both are object transforms that the exporter drops.

Fixed so far: the armature is normalised to identity (with the actions' location channels
rescaled by hand, since Blender does not do that for you), and `flattenSkinnedNodes()` in
`tubbyModel.js` zeroes skinned-mesh node transforms and rebinds with an identity bind
matrix. That corrected X and Y — a vertex probe now lands at the right width and height —
but a residual offset remains, coming from **ancestor** wrapper nodes above the skinned
meshes, which the flatten pass does not touch.

Then `flattenSkinnedNodes()` was extended to reparent every skinned mesh to the glTF scene
root, dropping the whole wrapper chain rather than just the mesh's own node. That fixed X
and Z as well — a vertex probe now lands within a few centimetres of the root on both — but
**Y is still offset by ~70**, the same 1/0.03125 wrapper factor, now arriving through the
bones' own world transforms rather than the mesh nodes.

Next step: probe the bone world positions directly against the sidecar's `nativeHeight`.
If the bones sit at ~70 units while the geometry is authored at ~2.17, the inverse bind
matrices and the bone rest data disagree about scale, which points back at
`transform_apply` on the armature in `rig_transfer.py` — the export's `inverseBindMatrices`
would need recomputing after that apply. Comparing a fresh export that skips
`normalise_armature()` entirely would isolate which side is wrong.

`validateRig()` runs a vertex probe at load and is meant to reject a broken rig; its
threshold currently passes this one because the error only shows up once the rig is placed
in the world, not in the unplaced `gltf.scene`.

## Debug

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
