import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * The torch, as an object in a hand.
 *
 * There was only ever a SpotLight before - light arriving from nowhere, which
 * is fine until you notice that everything else in the world casts and receives
 * and the one thing lighting it has no body at all. A held torch does three
 * things a bare light cannot: it says where the beam is coming from, it gives
 * the hand something to lag behind with when you turn, and it makes the thing
 * you switch on and off visibly the thing you are holding.
 *
 * Two of them. The Guardian carries the searchlight - the host is the one with
 * the big lamp, which is a piece of information you can read across a clearing
 * and never have to be told. Everybody else carries the slim black one.
 */

const BASE = new URL("../../assets/game/torch", import.meta.url).href;

/**
 * How each rip has to be turned and sized to become a held prop.
 *
 * Both arrive pointing somewhere arbitrary and sized to whatever their author
 * was working in, so this is measured rather than guessed: the flashlight is
 * two units long down its own +X with the lens on the positive end, and the
 * searchlight is a quarter of a unit deep down +Z with the glass on the
 * positive end. `yaw` turns that end to face -Z, which is where a camera looks.
 */
const RIGS = {
  handheld: {
    dir: `${BASE}/handheld/scene.gltf`,
    yaw: Math.PI / 2,      // its lens is on +X
    scale: 0.105,          // 2.0 units long -> 21 cm, a real torch
    // Held out at arm's length rather than pressed against the lens. A prop
    // 20 cm from a 72-degree camera fills a quarter of the screen whatever its
    // real size is, which is how the first pass came out looking like a
    // sofa-sized lamp.
    hold: [0.175, -0.145, -0.36],
    tilt: [0.05, -0.08, 0.10],
    lens: 0.115,           // metres from the group's origin to the glass
    cone: 3.4,
    angle: 0.44,           // matches the SpotLight exactly
  },
  searchlight: {
    dir: `${BASE}/searchlight/scene.gltf`,
    yaw: Math.PI,          // its glass is on +Z
    // Deliberately oversized. This is not a torch, it is a lamp somebody is
    // lugging about, and the whole point of the Guardian carrying it is that it
    // is enormous - shrinking it to a sensible 16 cm made it a slightly bigger
    // flashlight, which says nothing at all.
    scale: 1.1,            // 0.253 units deep -> 28 cm of lamp head
    hold: [0.20, -0.20, -0.26],
    tilt: [0.04, -0.06, 0.06],
    lens: 0.16,
    cone: 4.2,
    // A wider throw than the handheld, because it is a bigger lamp and should
    // look like one. The SpotLight is widened to match in Player.
    angle: 0.58,
  },
};

let cache = null;
let glowTex = null;

/**
 * A soft round glow for the lens.
 *
 * A SpriteMaterial with no map is a flat white quad, and additive blending
 * makes that a lit square hanging off the front of the torch - which is exactly
 * how it looked. A sprite needs something to be a shape.
 */
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, "rgba(255,246,222,0.95)");
  g.addColorStop(0.35, "rgba(255,238,196,0.36)");
  g.addColorStop(1.0, "rgba(255,230,180,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

/** Fetch both once. Returns false if neither is on disk, so callers can cope. */
export async function loadTorchAssets() {
  if (cache) return true;
  const loader = new GLTFLoader();
  cache = {};
  for (const [kind, rig] of Object.entries(RIGS)) {
    try {
      const gltf = await loader.loadAsync(rig.dir);
      // Bake the orientation and size in once, so every clone is already a
      // prop rather than a model somebody has to remember to turn.
      const root = new THREE.Group();
      gltf.scene.rotation.y = rig.yaw;
      gltf.scene.scale.setScalar(rig.scale);
      root.add(gltf.scene);
      root.traverse((o) => {
        if (!o.isMesh) return;
        // Held 20 cm from the lens and lit by its own beam. Shadows off: it
        // would be casting into the very light it is the source of.
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
      });
      cache[kind] = root;
    } catch (err) {
      console.warn(`[torch] ${kind} did not load:`, err.message);
    }
  }
  return Object.keys(cache).length > 0;
}

/**
 * The shaft of light.
 *
 * Not a shader. The falloff is baked into per-vertex alpha - bright at the lens,
 * nothing by the far end - which costs one attribute and no compile and reads
 * the same as the expensive version at the size it is drawn. Additive, so it
 * brightens what is behind it rather than fogging it, and it never writes depth
 * so it cannot cut a hole in whatever it passes over.
 */
function beamCone(len, angle) {
  const r = Math.tan(angle) * len;
  const geo = new THREE.ConeGeometry(r, len, 18, 1, true);
  // Point it down -Z with the apex on the lens: +Y becomes +Z, then slide the
  // whole thing back so the tip sits at the origin.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, -len / 2);

  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.abs(pos.getZ(i)) / len);   // 0 at the lens
    col[i * 4] = 1; col[i * 4 + 1] = 0.94; col[i * 4 + 2] = 0.78;
    col[i * 4 + 3] = (1 - t) ** 3 * 0.075;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4));

  const beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Only the far wall. DoubleSide draws both walls of the cone and additive
    // blending sums them, which doubled the brightness and gave the shaft a
    // hard silhouette wherever it crossed something pale - a bright rectangle
    // on the nearest tree trunk.
    side: THREE.BackSide,
    // Fogging the beam would dim it by distance from the CAMERA, and the camera
    // is the thing holding it.
    fog: false,
    toneMapped: false,
  }));
  beam.frustumCulled = false;
  beam.renderOrder = 3;
  return beam;
}

/**
 * One torch, ready to be parented to a camera or a controller.
 *
 * Returns the group plus the numbers a caller needs to match its own light to
 * this one - the cone angle above all, so a searchlight throws a searchlight's
 * beam rather than a torch's.
 */
export function makeTorch(kind = "handheld") {
  const rig = RIGS[kind] ?? RIGS.handheld;
  const group = new THREE.Group();

  const model = cache?.[kind] ?? cache?.handheld;
  if (model) group.add(model.clone(true));

  const beam = beamCone(rig.cone, rig.angle);
  beam.position.z = -rig.lens;
  group.add(beam);

  // A glow on the glass, so the source of the beam is the brightest thing on
  // the prop rather than a dark disc with light appearing in front of it.
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(),
    color: 0xfff1d2, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    toneMapped: false,
  }));
  glow.scale.setScalar(kind === "searchlight" ? 0.11 : 0.07);
  glow.position.z = -rig.lens;
  group.add(glow);

  group.position.set(...rig.hold);
  group.rotation.set(...rig.tilt);
  return { group, beam, glow, angle: rig.angle, lens: rig.lens };
}

/**
 * Hang a torch off a model's hand.
 *
 * The held-in-front-of-a-camera offsets are meaningless on a bone, so they are
 * cleared and replaced with a grip: down the finger line, lens forward. Bone
 * scales on these rigs are not 1, so the group is divided back out to keep the
 * prop life-sized whatever the hand it is attached to.
 */
export function holdInHand(torch, bone) {
  if (!bone) return false;
  const s = new THREE.Vector3();
  bone.getWorldScale(s);
  const k = 1 / Math.max(1e-4, (s.x + s.y + s.z) / 3);
  torch.group.scale.setScalar(k);
  torch.group.position.set(0, 0.02 * k, 0.06 * k);
  torch.group.rotation.set(-Math.PI / 2, 0, 0);
  bone.add(torch.group);
  return true;
}

/** Which torch a role carries. The Guardian's is the big one. */
export function torchFor(role) {
  return role === "guardian" ? "searchlight" : "handheld";
}
