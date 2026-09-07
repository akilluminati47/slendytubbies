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
/**
 * How far a carried torch's visible shaft reaches, in metres.
 *
 * The same for both. The lamps are deliberately different sizes - that is how
 * you read the Guardian across a clearing - but a shaft of light scaled off the
 * size of the thing holding it made the black torch look like it had a dud
 * battery, which is a different claim entirely and not one the game means to
 * make. Equal reach; the cone angles still differ, so the searchlight throws
 * the wider beam.
 */
const HAND_BEAM = 1.9;

const RIGS = {
  handheld: {
    dir: `${BASE}/handheld/scene.gltf`,
    yaw: Math.PI / 2,      // its lens is on +X
    scale: 0.105,          // 2.0 units long -> 21 cm, a real torch
    // Held out at arm's length rather than pressed against the lens. A prop
    // 20 cm from a 72-degree camera fills a quarter of the screen whatever its
    // real size is, which is how the first pass came out looking like a
    // sofa-sized lamp.
    // Low and to the right, with the butt of it off the bottom corner - the
    // same read as the searchlight, which is the one the eye calibrates on. A
    // torch sitting whole in the frame looks like an object being shown to you
    // rather than one you are carrying.
    hold: [0.215, -0.205, -0.30],
    tilt: [0.05, -0.08, 0.10],
    lens: 0.115,           // metres from the group's origin to the glass
    length: 0.23,          // how long it should end up when held in a hand
    // Off the measured grip, in the character's own axes. The measurement puts
    // the torch on the palm; WHERE along the torch the hand sits is a judgement
    // about how it looks, so it was dialled at ?torch=1 rather than guessed.
    nudge: { side: -0.022, up: -0.044, forward: 0.22 },
    twist: [0, 0, 0],
    // And how the mitten closes on it. Also dialled, also not guessable - see
    // GRIPS below.
    grip: [[-4, 0, 0], [7, -4, 0], [9, -9, 0]],
    handBeam: HAND_BEAM,   // and how far its shaft carries when carried
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
    length: 0.30,          // a lamp, but one a tubby can actually carry
    // It has a carry handle across the top, and that is what a hand holds. The
    // flashlight has none - you grip it round the barrel - so it gets no flag
    // and is held against the palm by its side instead.
    handle: true,
    // Mostly down: a lamp hangs off the handle rather than sitting level with
    // it, and a touch forward so the housing clears the hand.
    nudge: { side: 0, up: -0.048, forward: 0.07 },
    twist: [0, 0, 0],
    // The thumb goes right over the handle on this one - it is a bar you wrap a
    // hand round, not a barrel you close a fist on.
    grip: [[0, 0, 0], [7, 0, 0], [-79, -2, -11]],
    handBeam: HAND_BEAM,
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
  // Named so anything hanging one off a bone can find and strip the last one.
  group.name = "torch:held";

  const model = cache?.[kind] ?? cache?.handheld;
  const body = model ? model.clone(true) : null;
  if (body) group.add(body);

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

  const torch = { group, body, beam, glow, angle: rig.angle, lens: rig.lens,
                  length: rig.length, cone: rig.cone, handBeam: rig.handBeam,
                  // Copied, not shared: the bench mutates these live and must
                  // not edit the table every torch is built from.
                  nudge: { side: 0, up: 0, forward: 0, ...(rig.nudge ?? {}) },
                  twist: [...(rig.twist ?? [0, 0, 0])],
                  anchor: null };
  // rig.lens above is the fallback for a model that never loaded; when there is
  // one, the glass is measured off it. The first-person torch hangs from the
  // camera and never goes through holdInHand, so it has to be done here too.
  measureProp(torch, !!rig.handle);

  group.position.set(...rig.hold);
  group.rotation.set(...rig.tilt);
  return torch;
}

/**
 * Hang a torch off a model's hand.
 *
 * The held-in-front-of-a-camera offsets are meaningless on a bone, so they are
 * cleared and replaced with a grip: down the finger line, lens forward. Bone
 * scales on these rigs are not 1, so the group is divided back out to keep the
 * prop life-sized whatever the hand it is attached to.
 */
/** The longest side of an object's world-space bounding box, in metres. */
function worldSpan(obj) {
  obj.updateWorldMatrix(true, true);
  const s = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  return Math.max(s.x, s.y, s.z);
}

const UP = new THREE.Vector3(0, 1, 0);

/** How far along the wrist-to-knuckle run to fall back to, when there is no skin. */
const PALM = 0.42;

/**
 * How far the torch sinks into the mitten, as a fraction of its own thickness.
 *
 * Nearly nothing. It rests ON the palm rather than inside it - centring it in
 * the hand's volume buried the barrel in the mitten - but a prop exactly
 * tangent to a surface reads as levitating beside it, so it bites a little.
 */
const BITE = 0.18;

/**
 * Where a torch sits in a hand, in the hand bone's own space.
 *
 * Three numbers, all read off the model:
 *
 *   point  the middle of the visible mitten. NOT the bone's origin - on these
 *          rigs the hand bone sits a quarter of a metre from the mitten it
 *          drives, which is why a torch pinned to the origin hung in empty air
 *          below the hand. Every vertex the bone drives is pulled back through
 *          its inverse bind matrix and averaged by weight, so it lands in the
 *          middle of the hand by construction, whatever the rig.
 *
 *   dir    which way is palm-side. The thumb is the only cue a rig reliably
 *          gives you for this - it sticks out across the gripping face - so it
 *          is the thumb bone's offset with the along-the-fingers part taken
 *          out of it, leaving the across-the-palm part.
 *
 *   reach  how far it is from that middle out to the palm's surface, along
 *          dir. The far edge of the same vertices.
 *
 * Bind space rather than the current pose, so the answer is the same mid-stride
 * as standing still, and cached on the bone because it cannot change.
 */
function handGrip(bone, root) {
  if (bone.userData.grip) return bone.userData.grip;

  const point = new THREE.Vector3(), v = new THREE.Vector3();
  const mine = [];
  let weight = 0;
  root?.traverse?.((skin) => {
    if (!skin.isSkinnedMesh) return;
    const bi = skin.skeleton.bones.indexOf(bone);
    if (bi < 0) return;
    const inv = skin.skeleton.boneInverses[bi];
    const { position, skinIndex, skinWeight } = skin.geometry.attributes;
    if (!skinIndex || !skinWeight) return;
    for (let i = 0; i < position.count; i++) {
      let w = 0;
      for (let j = 0; j < 4; j++) {
        if (skinIndex.getComponent(i, j) === bi) w += skinWeight.getComponent(i, j);
      }
      if (w <= 0.05) continue;
      v.fromBufferAttribute(position, i).applyMatrix4(skin.bindMatrix).applyMatrix4(inv);
      mine.push(v.clone());
      point.addScaledVector(v, w);
      weight += w;
    }
  });

  const bones = bone.children.filter((b) => b.isBone);
  const thumb = bones.find((b) => /thumb/i.test(b.name));
  const knuckles = bones.find((b) => /finger|index|middle/i.test(b.name))
    ?? bones.filter((b) => !/thumb/i.test(b.name))
      .sort((a, b) => b.position.lengthSq() - a.position.lengthSq())[0]
    ?? bones[0];

  if (weight > 0) point.divideScalar(weight);
  else if (knuckles) point.copy(knuckles.position).multiplyScalar(PALM);

  // Palm-side: the thumb, with the along-the-fingers part removed.
  const dir = new THREE.Vector3();
  if (thumb) {
    dir.copy(thumb.position);
    if (knuckles && knuckles !== thumb) {
      const along = knuckles.position.clone().normalize();
      dir.addScaledVector(along, -dir.dot(along));
    }
  }
  if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);   // no thumb to go on
  dir.normalize();

  let reach = 0;
  for (const q of mine) reach = Math.max(reach, q.sub(point).dot(dir));

  bone.userData.grip = { point, dir, reach };
  return bone.userData.grip;
}

/** Half an object's world extent along a world direction. */
function halfAlong(obj, dir) {
  obj.updateWorldMatrix(true, true);
  const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  return 0.5 * (Math.abs(dir.x) * size.x + Math.abs(dir.y) * size.y
    + Math.abs(dir.z) * size.z);
}

/** The uniform part of an object's world scale. */
function worldScale(obj) {
  const e = obj.matrixWorld.elements;
  return (Math.hypot(e[0], e[1], e[2]) + Math.hypot(e[4], e[5], e[6])
    + Math.hypot(e[8], e[9], e[10])) / 3;
}

/** How much of the lens assembly's depth counts as its front disc. */
const LENS_SLAB = 0.18;

/** The top fraction of a lamp that is its carry handle. */
const HANDLE_SLAB = 0.8;

/**
 * Read the glass, and the handle, off the model itself.
 *
 * `lens` used to be a hand-measured distance from the group's origin, and the
 * group's origin is wherever the model's author happened to leave their pivot -
 * so on the searchlight the cone started somewhere inside the lamp housing and
 * the bulb sat off the edge of the lens. Once the rig's yaw is baked in the
 * glass is simply the front face of the body, and a face is something the
 * geometry can be asked for.
 *
 * The handle is the top of it: on a lamp built to be carried, the bar across
 * the top is the part a hand goes round, and taking the centroid of the top
 * fifth lands on it without needing the author to have named anything - which
 * this rip does not, it is two meshes called body and glass.
 */
function measureProp(torch, hasHandle) {
  // Everything here is in the GROUP's frame, which the group's own scale
  // cancels out of - so this is measured once when the torch is built and never
  // needs redoing, however the thing is later sized or placed.
  if (!torch.body) return;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const toGroup = new THREE.Matrix4();
  torch.group.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(torch.group.matrixWorld).invert();
  const pts = [];
  let glass = null;
  torch.body.traverse((m) => {
    const pos = m.geometry?.attributes?.position;
    if (!pos) return;
    toGroup.multiplyMatrices(inv, m.matrixWorld);
    // A mesh the author called glass is the lens, and knowing exactly where
    // that is beats inferring it from the outline of the whole prop.
    const isLens = /glass|lens/i.test(m.name);
    if (isLens) glass = glass ?? [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toGroup);
      box.expandByPoint(v);
      if (isLens) glass.push(v.clone());
      if (hasHandle) pts.push(v.clone());
    }
  });
  if (box.isEmpty()) return;

  // The lens: the middle of the disc you can actually see.
  //
  // Three goes at this. The front face of the whole PROP is only an
  // approximation - the searchlight's housing is wider and taller than its
  // glass - and the front face of the glass mesh is not much better, because
  // that mesh is the whole lens assembly, a dome over a reflector cone a fifth
  // of its own length deep. A box round it has a centre that is not on the
  // disc.
  //
  // So take the glass vertices nearest the front and average those: the rim and
  // the dome, which is the circle a viewer sees lit. The housing box stays as
  // the fallback for a model whose author did not name the glass separately,
  // which is what the flashlight is.
  const mid = new THREE.Vector3();
  let lensZ;
  if (glass?.length) {
    let front = Infinity, back = -Infinity;
    for (const q of glass) { front = Math.min(front, q.z); back = Math.max(back, q.z); }
    const slab = front + (back - front) * LENS_SLAB;
    let n = 0;
    for (const q of glass) {
      if (q.z > slab) continue;
      mid.add(q);
      n++;
    }
    if (n) mid.divideScalar(n);
    lensZ = front;
  } else {
    box.getCenter(mid);
    lensZ = box.min.z;
  }
  torch.beam.position.set(mid.x, mid.y, lensZ);
  torch.glow.position.copy(torch.beam.position);

  if (!hasHandle) return;
  const cut = box.min.y + (box.max.y - box.min.y) * HANDLE_SLAB;
  const top = pts.filter((q) => q.y >= cut);
  if (!top.length) return;
  const anchor = new THREE.Vector3();
  for (const q of top) anchor.add(q);
  torch.anchor = anchor.divideScalar(top.length);
}

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Which way the character is looking, in world space. */
function facing(root) {
  const forward = new THREE.Vector3(0, 0, 1);
  if (!root) return forward;
  root.updateWorldMatrix(true, false);
  return forward.applyQuaternion(
    _q.setFromRotationMatrix(root.matrixWorld)).normalize();
}

/**
 * Point the torch where the character is looking, with its handle on top.
 *
 * Not down a finger. A fixed local rotation cannot do this - every one of these
 * rigs orients its hand bone differently, and "rotate -90 about local X" meant
 * something different on each; on these it put the lens through the knuckles.
 * So the WORLD orientation is chosen and pushed back through the bone, exactly
 * as the head twist does.
 *
 * A whole basis, not the shortest rotation between two vectors.
 * setFromUnitVectors(-Z, forward) says nothing about roll, and when the
 * character faces +Z - which is every one of them on the menu stage - those two
 * are ANTIPARALLEL, so the axis is degenerate and three picks a perpendicular
 * for you. Naming the up axis as well makes it a basis with one answer.
 */
function aim(torch, bone, root) {
  const forward = facing(root);
  const zAxis = forward.clone().negate();
  const xAxis = new THREE.Vector3().crossVectors(UP, zAxis);
  // Looking straight up or down would leave no cross product to work with.
  if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
  xAxis.normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const want = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));

  bone.updateWorldMatrix(true, false);
  bone.matrixWorld.decompose(_p, _q, _s);
  torch.group.quaternion.copy(_q.invert().multiply(want));
  // A hand-set roll/pitch/yaw on top, in the torch's OWN frame - post-
  // multiplied, so "turn it a bit" means the same thing from any angle.
  if (torch.twist.some((a) => a !== 0)) {
    torch.group.quaternion.multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...torch.twist)));
  }
  return forward;
}

export function holdInHand(torch, bone, root) {
  if (!bone) return false;
  // Whatever was in this hand before goes first.
  //
  // The menu parade keeps ONE model per character and walks it past again and
  // again, so a torch left on Laa-Laa's wrist is still there the next time she
  // comes round. Tracking "the last torch attached" was not enough - by then it
  // was somebody else's - and she came past holding two.
  dropFromHand(bone);

  torch.group.position.set(0, 0, 0);
  torch.group.scale.setScalar(1);

  // A shorter shaft, not no shaft.
  //
  // Killing the beam outright fixed the crowbar - four metres of cone swinging
  // off a wrist - and created a worse problem: a small unlit black object held
  // low against a dark body is invisible, which is exactly how it looked. The
  // cone is scaled instead, so it keeps its angle and loses its reach, and a
  // carried torch reads as a carried torch from across the lane.
  torch.beam.visible = true;
  torch.beam.scale.setScalar(1);
  torch.glow.material.opacity = 1;

  bone.add(torch.group);
  // Aimed before it is measured, because the box it is sized by is an
  // axis-aligned one and so depends on which way the thing is pointing.
  aim(torch, bone, root);

  // Size it by measuring what came out, not by dividing by the bone's scale.
  //
  // That was the obvious way and it was wrong by a factor of twenty: these rigs
  // carry scale at several joints and a rewritten set of inverse binds, so the
  // hand's world scale is not the number that ends up applied to a child of it.
  // The searchlight arrived five and a half metres long. Measuring the result
  // and correcting it needs to know nothing about the chain at all.
  //
  // Measure the BODY, though - not the group. The group contains the beam, and
  // the beam is metres long where the torch is centimetres, so a box round the
  // group is a box round the light. Sizing that to 21 cm sized the LIGHT to
  // 21 cm and dragged the torch down with it to a black chip four centimetres
  // long: the searchlight only looked survivable because its model is huge to
  // start with. What we want set is the length of the object in the hand.
  const longest = worldSpan(torch.body ?? torch.group);
  if (longest > 1e-5) torch.group.scale.setScalar(torch.length / longest);

  // And the same treatment for the shaft and the glass, for the same reason.
  //
  // Working the beam's scale out from the group's - cone * k, and solve - is
  // the crowbar mistake wearing a different hat: it leaves out every scale
  // between the bone and the world, which on these rigs is a factor of two.
  // Measuring what actually came out needs to know nothing about the chain.
  const reach = worldSpan(torch.beam);
  if (reach > 1e-5) torch.beam.scale.multiplyScalar(torch.handBeam / reach);
  const lens = worldSpan(torch.glow);
  if (lens > 1e-5) torch.glow.scale.multiplyScalar(torch.length * 0.42 / lens);

  placeInHand(torch, bone, root);
  return true;
}

/**
 * Aim a held torch and sit it in the palm. Every frame, after the mixer.
 *
 * Doing this once at attach was only ever right for the pose the character
 * happened to be in at that instant. A torch is a CHILD of the hand bone, so
 * from the next frame on it inherits whatever the arm is doing - which is how
 * the Guardian came to carry a heavy searchlight cocked over at forty-five
 * degrees, and why its roll changed as she walked. A lamp hangs from its handle
 * whatever the wrist is doing, and a beam points where its owner is looking
 * rather than where their wrist has rolled to.
 *
 * The POSITION still follows the hand - it is measured from the palm, and the
 * palm swings with the arm - so a carried lamp still travels through the walk
 * cycle. It is only the orientation that is taken off the world instead.
 */
export function placeInHand(torch, bone, root) {
  if (!bone || torch.group.parent !== bone) return false;
  const forward = aim(torch, bone, root);
  torch.group.updateWorldMatrix(true, true);

  // Slide the group so the torch you can SEE rests on the palm.
  //
  // Putting the group's ORIGIN there is not the same thing - these rips carry
  // their own pivots, and this one's is off the back of the barrel - and
  // putting the body's CENTRE there is not it either: that is the middle of the
  // hand's VOLUME, so the barrel ends up buried inside the mitten. Two points
  // have to meet: somewhere on the hand, and somewhere on the torch.
  const grip = handGrip(bone, root);
  const palmWorld = bone.localToWorld(grip.point.clone());
  const dirWorld = bone.localToWorld(grip.point.clone().add(grip.dir))
    .sub(palmWorld).normalize();

  // Which side of the hand the palm is on.
  //
  // The thumb gives the across-the-palm axis and nothing more - a thumb sticks
  // out sideways from a palm, it does not point out of one - so its sign says
  // nothing about which face is the gripping face, and taken at face value it
  // put both torches out through the BACK of the mitten. Measured on these
  // rigs, that axis lies exactly along the model's forward. Arms hang with the
  // palms facing back, so the palm is whichever way is not forward.
  if (dirWorld.dot(forward) > 0) dirWorld.negate();

  // On the hand: the surface of the mitten, sunk a little so the torch reads as
  // held rather than balanced against it.
  const half = halfAlong(torch.body ?? torch.group, dirWorld);
  const contact = palmWorld.addScaledVector(dirWorld,
    grip.reach * worldScale(bone) - BITE * half);

  // On the torch: the handle if it has one - a lamp is carried by its handle,
  // and the Guardian's has a bar across the top - otherwise the near side of
  // the barrel, which is what your palm touches when you hold a flashlight.
  const drawn = new THREE.Box3().setFromObject(torch.body ?? torch.group)
    .getCenter(new THREE.Vector3());
  const hold = torch.anchor
    ? torch.group.localToWorld(torch.anchor.clone())
    : drawn.clone().addScaledVector(dirWorld, -half);

  // Then the hand-set nudge, in the axes the eye actually judges it in: across
  // the character, straight up, and along the way it is looking. Taken off the
  // model's own basis rather than the world's, so it still means the same three
  // things when the character has turned round.
  const side = root
    ? new THREE.Vector3().setFromMatrixColumn(root.matrixWorld, 0).normalize()
    : new THREE.Vector3(1, 0, 0);
  const nudge = new THREE.Vector3()
    .addScaledVector(side, torch.nudge.side)
    .addScaledVector(UP, torch.nudge.up)
    .addScaledVector(forward, torch.nudge.forward);

  const origin = new THREE.Vector3().setFromMatrixPosition(torch.group.matrixWorld);
  torch.group.position.copy(bone.worldToLocal(
    origin.add(contact).sub(hold).add(nudge)));
  return true;
}

/** Take every torch out of a hand. Safe to call on a hand that has none. */
export function dropFromHand(bone) {
  if (!bone) return;
  for (const child of [...bone.children]) {
    if (child.name === "torch:held") bone.remove(child);
  }
}

/**
 * How the mitten closes on each torch, in radians, one entry per grip bone.
 *
 * Dialled by hand at ?torch=1 and then baked, because there was no deriving it:
 * the bend that reads as a hand closing is different for the two props - a fist
 * round a barrel is not the same shape as a hand over a carry handle - and it is
 * different per bone, which is why the single guessed axis this replaces
 * (GRIP_AXIS, one angle scaled per bone) could never have got there. It spent
 * the whole time switched off because at any strength that closed the hand it
 * sheared the mitten into a blade instead.
 *
 * Degrees in the table, radians out; the table is what a person reads.
 */
const RAD = Math.PI / 180;

export function gripPoseFor(kind) {
  const rows = RIGS[kind]?.grip ?? RIGS.handheld.grip;
  return rows.map(([x, y, z]) => ({ x: x * RAD, y: y * RAD, z: z * RAD }));
}

/** Which torch a role carries. The Guardian's is the big one. */
export function torchFor(role) {
  return role === "guardian" ? "searchlight" : "handheld";
}
