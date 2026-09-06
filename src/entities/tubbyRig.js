import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
// No SkeletonUtils here on purpose - see the comment above bakeClips().

/**
 * Animate the tubbies by RETARGETING, not by transferring weights.
 *
 * Every un_rendem123 skin ships its own skeleton - 56 to 58 joints, proper
 * artist-made weights, right down to eyelid and mouth bones. What they lack is
 * animation CLIPS. The catalogue's "0 animations" means no clips, not "static
 * mesh", and reading it the other way sent an earlier attempt down a long dead
 * end: transferring donor weights onto an already-weighted mesh, and flattening
 * its bind pose into its vertices to do so, which is exactly why those came out
 * mangled and prone.
 *
 * So: load each skin with its rig untouched, and borrow only the donor's motion.
 * The skin keeps its own weights, proportions, bind pose and face.
 */

/**
 * Target bone (in the skin) -> source bone (in the donor).
 *
 * The donor is a 3ds Max biped and the skins are named plainly, so this table is
 * the whole translation. Both sides carry numeric suffixes (Bip01_Pelvis_02_13,
 * Body 1_01) which resolve() strips by matching on prefix.
 */
const BONE_PAIRS = [
  ["Body 1", "Bip01_Pelvis"],
  ["Body 2", "Bip01_Spine1"],
  ["Head", "Bip01_Head"],
  ["Arm R1", "Bip01_R_UpperArm"],
  ["Arm R2", "Bip01_R_Forearm"],
  ["Hand R", "Bip01_R_Hand"],
  ["Arm L1", "Bip01_L_UpperArm"],
  ["Arm L2", "Bip01_L_Forearm"],
  ["Hand L", "Bip01_L_Hand"],
  ["Leg R1", "Bip01_R_Thigh"],
  ["Leg R2", "Bip01_R_Calf"],
  ["Foot R", "Bip01_R_Foot"],
  ["Toe R", "Bip01_R_Toe0"],
  ["Leg L1", "Bip01_L_Thigh"],
  ["Leg L2", "Bip01_L_Calf"],
  ["Foot L", "Bip01_L_Foot"],
  ["Toe L", "Bip01_L_Toe0"],
];

const HIP_TARGET = "Body 1";

/**
 * The pose the skin should hold when the donor is in ITS rest pose.
 *
 * Retargeting transfers how far each bone has turned away from its own rig's
 * rest, so the two rests are what the animation is measured against. The skin's
 * rest is a clean T-pose. The donor's rest is a chainsaw held across the chest,
 * because that is what the donor is: a GMod ragdoll that carries a saw in every
 * one of its 56 clips. Left alone, the tubby therefore holds a T-pose for the
 * whole walk cycle, arms rigidly out, which is exactly what it did.
 *
 * So we pick the skin's rest deliberately: arms down at its sides, turned in a
 * little, which is what a tubby should look like while the donor is holding its
 * saw. Everything the donor's arms then do on top of that comes through as it
 * should. Angles are degrees about a WORLD axis, applied outermost bone first so
 * the forearm and hand inherit the shoulder's swing.
 *
 * The model faces +Z with its arms along X, so its right hand is at -X and a
 * positive turn about Z drops that arm towards the ground.
 */
const REST_POSE = [
  ["Arm R1", 0, 0, 1, 74], ["Arm R2", 0, 0, 1, 8], ["Hand R", 0, 0, 1, 4],
  ["Arm L1", 0, 0, 1, -74], ["Arm L2", 0, 0, 1, -8], ["Hand L", 0, 0, 1, -4],
];

/**
 * Find a bone by name prefix, ignoring the exporter's numeric suffixes and
 * skipping the zero-length "_end" tip bones, which would otherwise win the match
 * for names like "Bip01_Head".
 */
function resolve(bones, prefix) {
  // GLTFLoader replaces spaces in node names with underscores, so "Body 1_01"
  // arrives as "Body_1_01". Normalise both sides rather than writing the table
  // in loader-mangled form, which would not survive a different exporter.
  const norm = (x) => x.toLowerCase().replace(/[ _]+/g, "_");
  const p = norm(prefix);
  const hits = bones.filter((b) => {
    const n = norm(b.name);
    return n.startsWith(p) && !n.includes("_end");
  });
  // Shortest wins: "Bip01_Spine1_04" over "Bip01_Spine1_04_something_longer".
  hits.sort((a, b) => a.name.length - b.name.length);
  return hits[0] ?? null;
}

function findSkinned(scene) {
  const out = [];
  scene.traverse((o) => { if (o.isSkinnedMesh) out.push(o); });
  return out;
}

/** World-space height of a skinned mesh set, in its current pose. */
function poseHeight(meshes) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 3) {
      m.getVertexPosition(i, v);
      box.expandByPoint(v.applyMatrix4(m.matrixWorld));
    }
  }
  return { box, height: Math.max(box.max.y - box.min.y, 1e-6) };
}


/**
 * Grow the skeleton until it fills the mesh it drives, without changing how the
 * mesh looks at bind.
 *
 * These rips ship a skeleton that is a miniature of their own geometry. On Po
 * every bone sits inside a cloud spanning 4.56 units tall and 5.5 wide, while
 * the mesh those bones drive is 17.11 tall and 19.8 wide: the outermost finger
 * bone is at x -2.74 and the fingertip vertex it owns is at x -9.9. The rig is
 * roughly a 3.75x miniature floating inside a correctly sized body.
 *
 * It still draws perfectly at bind, which is what makes this so easy to miss.
 * At bind the skinning matrix `bone.matrixWorld * boneInverse` comes out as a
 * uniform 0.037 scale on every bone. Uniform is invisible: it shrinks the raw
 * vertex data evenly to the size we see, and since we rescale to 1.85m anyway
 * the result is a flawless T-posed tubby. But rotating a bone rotates its
 * vertices about THAT BONE'S world position, and those positions are all far
 * inside the body, so every joint swings a lever several times longer than the
 * limb - which is why the arms stretched to the floor the moment they moved.
 *
 * The fix is a similarity transform on the bones alone. Scale the root joints by
 * k so the bone cloud matches the mesh, then rewrite each inverse bind as
 *
 *     boneInverse' = W'^-1 * (W * boneInverse)
 *
 * so that `W' * boneInverse'` still equals the original `W * boneInverse`. The
 * bind pose is therefore pixel-identical by construction - the only thing that
 * changes is where the joints are, which is the thing that was wrong.
 *
 * Not to be confused with calculateInverses(), which throws the file's numbers
 * away and asserts the current pose IS bind. That breaks these models, because
 * the per-bone corrections are not all the same: Move_All carries a -3.7 mirror
 * and the root joint a rotation, so discarding them splays the model flat.
 */
function fitSkeleton(scene, meshes) {
  const skeleton = meshes[0].skeleton;
  const bones = skeleton.bones;
  scene.updateMatrixWorld(true);

  // What each bone currently contributes to skinning. This is the invariant.
  const skinning = bones.map((b, i) =>
    new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skeleton.boneInverses[i]));

  // Measure the body against the bones that drive the body, and nothing else.
  // Two things would otherwise poison this: the guardian ships its eyeballs 2500
  // units below its feet, which stretches any all-meshes bounding box into
  // nonsense, and its hat bone sits above the head, which inflates the bone
  // cloud on that model but not on the other four.
  const body = meshes.reduce((a, b) =>
    b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a);
  const drives = new Set();
  {
    const si = body.geometry.attributes.skinIndex, sw = body.geometry.attributes.skinWeight;
    for (let i = 0; i < body.geometry.attributes.position.count; i++) {
      for (let k2 = 0; k2 < 4; k2++) {
        if (sw.getComponent(i, k2) > 0.05) drives.add(si.getComponent(i, k2));
      }
    }
  }

  const meshBox = poseHeight([body]).box;
  const boneBox = new THREE.Box3();
  const p = new THREE.Vector3();
  bones.forEach((b, i) => { if (drives.has(i)) boneBox.expandByPoint(b.getWorldPosition(p)); });

  const meshH = meshBox.max.y - meshBox.min.y;
  const boneH = boneBox.max.y - boneBox.min.y;
  const k = meshH / Math.max(boneH, 1e-6);
  // Leave a rig that already fits alone rather than nudging it by a few percent.
  if (k > 0.95 && k < 1.05) return { k: 1, boneSpan: +boneH.toFixed(2), meshSpan: +meshH.toFixed(2) };

  // Scaling the root joints scales the whole cloud about the rig's own base,
  // which is where the mesh is anchored too, so the two line up as they grow.
  const roots = bones.filter((b) => !(b.parent && b.parent.isBone));
  for (const r of roots) r.scale.multiplyScalar(k);
  scene.updateMatrixWorld(true);

  for (let i = 0; i < bones.length; i++) {
    skeleton.boneInverses[i] = new THREE.Matrix4()
      .copy(bones[i].matrixWorld).invert().multiply(skinning[i]);
  }
  // Every mesh on this skeleton needs its cached bone texture rebuilt.
  for (const m of meshes) {
    if (m.skeleton === skeleton) m.skeleton.update();
  }

  const after = new THREE.Box3();
  bones.forEach((b, i) => { if (drives.has(i)) after.expandByPoint(b.getWorldPosition(p)); });
  return {
    k: +k.toFixed(3),
    boneSpan: +(after.max.y - after.min.y).toFixed(2),
    meshSpan: +meshH.toFixed(2),
    roots: roots.map((r) => r.name),
  };
}

/**
 * Find the rims of the holes in a mesh, in world space.
 *
 * An edge on the boundary of a hole belongs to exactly one triangle, so counting
 * how many triangles use each edge finds them. Vertices are merged by position
 * first, because the exporter splits them along UV seams and an unmerged rim is
 * not a connected loop.
 *
 * Returns one entry per hole: its centroid and how many rim vertices it has.
 */
function holeRims(mesh) {
  const geo = mesh.geometry;
  const index = geo.index;
  const n = index ? index.count : geo.attributes.position.count;
  const at = (i) => (index ? index.getX(i) : i);

  // Merge coincident vertices so a rim reads as one loop.
  const v = new THREE.Vector3();
  const canon = new Map(), idOf = new Int32Array(geo.attributes.position.count);
  const points = [];
  for (let i = 0; i < geo.attributes.position.count; i++) {
    mesh.getVertexPosition(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let id = canon.get(key);
    if (id === undefined) { id = points.length; canon.set(key, id); points.push(v.clone()); }
    idOf[i] = id;
  }

  const edges = new Map();
  for (let i = 0; i < n; i += 3) {
    const t = [idOf[at(i)], idOf[at(i + 1)], idOf[at(i + 2)]];
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const e = edges.get(key);
      if (e) e.n++; else edges.set(key, { a, b, n: 1 });
    }
  }

  // Connected components over the boundary edges are the individual holes.
  const adj = new Map();
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }

  const seen = new Set(), rims = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start], group = [];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      group.push(cur);
      for (const next of adj.get(cur)) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    const centre = new THREE.Vector3();
    for (const g of group) centre.add(points[g]);
    centre.divideScalar(group.length);
    let radius = 0;
    for (const g of group) radius = Math.max(radius, points[g].distanceTo(centre));
    rims.push({ centre, count: group.length, radius });
  }
  return rims;
}

/**
 * Put the eyeballs back in their sockets.
 *
 * These rips draw the face with two empty hexagonal holes and the eyeballs
 * resting on the chest, a fifth of the model's height too low.
 *
 * The eye BONES are much closer to right than the geometry is, but not exact -
 * seating the eyeballs on them lifts the eyes clear of the chest and then a
 * little too far, leaving the sockets showing underneath. So aim at the sockets
 * themselves instead: they are literal holes in the face mesh, and the rim of a
 * hole is exactly the set of edges used by only one triangle. That gives a
 * measured target rather than a tuned offset, and it holds for any of the five
 * skins without a per-model number.
 *
 * The move is applied to the skinning, on the same principle as fitSkeleton():
 *
 *     boneInverse' = W^-1 * translate(T) * W * boneInverse
 *
 * which shifts everything that bone drives by T in world space and leaves every
 * other bone alone. Eyelids ride along with the eye on their own side.
 */
function seatFacialParts(scene, meshes) {
  const skeleton = meshes[0].skeleton;
  const bones = skeleton.bones;
  scene.updateMatrixWorld(true);

  const eyeOf = (name) => {
    // Not \b after the side letter: underscore is a word character, so there is
    // no boundary in "Eye_R_019" and the match would never fire.
    const m = /^eye(?:lid)?[_ ](?:up[_ ]|down[_ ])?([lr])(?:[_ ]|$)/i.exec(name);
    return m ? m[1].toUpperCase() : null;
  };
  const targets = bones.map((b, i) => ({ bone: b, i, side: eyeOf(b.name) }))
    .filter((t) => t.side);
  if (!targets.length) return { moved: 0 };

  // Where each eye currently is: the centroid and radius of the vertices it
  // dominates. Radius matters because the guardian's eyeballs are not merely
  // displaced, they are 456 units across on a model 4.8 units tall.
  const sums = new Map(targets.map(({ i }) => [i, { p: new THREE.Vector3(), n: 0, pts: [] }]));
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    if (!si || !sw) continue;
    for (let i = 0; i < m.geometry.attributes.position.count; i++) {
      let best = -1, bestW = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bestW) { bestW = w; best = si.getComponent(i, k); }
      }
      const slot = sums.get(best);
      if (!slot) continue;
      m.getVertexPosition(i, v);
      const world = v.applyMatrix4(m.matrixWorld).clone();
      slot.p.add(world);
      slot.pts.push(world);
      slot.n++;
    }
  }

  // Where they belong: the two sockets, taken as the holes nearest each eye bone.
  const face = meshes.find((m) => /face/i.test(m.material?.name ?? "")) ?? meshes[0];
  const rims = holeRims(face).filter((r) => r.count >= 4);
  const socket = {}, socketRadius = {};
  for (const side of ["R", "L"]) {
    const eye = targets.find((t) => t.side === side && /^eye[_ ]/i.test(t.bone.name));
    if (!eye) continue;
    const at = eye.bone.getWorldPosition(new THREE.Vector3());
    let best = null, bestD = Infinity;
    for (const r of rims) {
      // The mouth and the TV panel are holes too; they sit on the centre line,
      // so an eye's own socket is the nearest rim on its own side of the face.
      if (Math.sign(r.centre.x) !== Math.sign(at.x) && Math.abs(r.centre.x) > 1e-3) continue;
      const d = r.centre.distanceTo(at);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best) { socket[side] = best.centre; socketRadius[side] = best.radius; }
  }

  const centroid = new Map(), radius = new Map();
  for (const [i, slot] of sums) {
    if (!slot.n) continue;
    const c = slot.p.clone().divideScalar(slot.n);
    centroid.set(i, c);
    let r = 0;
    for (const q of slot.pts) r = Math.max(r, q.distanceTo(c));
    radius.set(i, r);
  }

  // An eyeball sits about this much bigger than the hole it looks through,
  // measured off the four skins that ship it correctly. On those it evaluates to
  // 1.0 and nothing moves; it only bites on the guardian, whose eyes are the
  // wrong size as well as in the wrong place.
  const EYE_TO_SOCKET = 1.45;

  const place = new THREE.Matrix4(), inv = new THREE.Matrix4();
  const moved = [];
  for (const { bone, i, side } of targets) {
    const aim = socket[side];
    // Everything on one side moves as a unit, measured from the eyeball itself,
    // so the lids keep their position and size relative to the eye they cover.
    const eye = targets.find(
      (t) => t.side === side && /^eye[_ ]/i.test(t.bone.name));
    const from = eye && centroid.get(eye.i);
    if (!aim || !from) continue;

    const want = EYE_TO_SOCKET * (socketRadius[side] ?? 0);
    const have = radius.get(eye.i) ?? 0;
    const s = want > 0 && have > 0 ? want / have : 1;

    // Scale about the eyeball's own centre, then move that centre to the socket.
    place.makeTranslation(aim.x, aim.y, aim.z)
      .multiply(new THREE.Matrix4().makeScale(s, s, s))
      .multiply(new THREE.Matrix4().makeTranslation(-from.x, -from.y, -from.z));

    inv.copy(bone.matrixWorld).invert();
    skeleton.boneInverses[i] = new THREE.Matrix4()
      .multiplyMatrices(inv, place)
      .multiply(bone.matrixWorld)
      .multiply(skeleton.boneInverses[i]);
    moved.push({ bone: bone.name, scaled: +s.toFixed(3) });
  }
  skeleton.update();
  return { moved: moved.length, sockets: Object.keys(socket).length,
    scale: moved[0]?.scaled ?? 1 };
}

/**
 * Snapshot a skeleton's bind pose exactly as the file describes it.
 *
 * Not skeleton.pose(). On these rips pose() is destructive: the glTF's
 * inverseBindMatrices disagree with the node transforms it ships, so posing from
 * them inflates Po from 17.4 units to 175. The transforms the loader built the
 * scene from are the only trustworthy bind pose, so read those and keep a copy.
 *
 * matrixWorld.decompose is used rather than setFromRotationMatrix because these
 * hierarchies are full of scale (see bakeClips) and decompose normalises it out.
 */
function snapshotBind(bones) {
  const bind = new Map();
  const t = new THREE.Vector3(), s = new THREE.Vector3();
  for (const b of bones) {
    const worldQ = new THREE.Quaternion();
    b.matrixWorld.decompose(t, worldQ, s);

    const parentWorldQ = new THREE.Quaternion();
    if (b.parent) b.parent.matrixWorld.decompose(t, parentWorldQ, s);

    let depth = 0;
    for (let n = b; n.parent; n = n.parent) depth++;

    bind.set(b, {
      depth, worldQ, parentWorldQ,
      localQ: b.quaternion.clone(),
      localP: b.position.clone(),
      worldP: new THREE.Vector3().setFromMatrixPosition(b.matrixWorld),
    });
  }
  return bind;
}

/**
 * Work out each bone's world rotation in the reference pose of REST_POSE, and
 * record it on the bind snapshot as `refQ`.
 *
 * Done by actually posing the skeleton and reading the result back, rather than
 * by composing the corrections by hand, so that a shoulder's swing carries the
 * elbow and hand with it for free. The pose is undone before we return: only the
 * numbers are kept.
 */
function referencePose(root, bones, bind, keep = false) {
  const order = [...bones].sort((a, b) => bind.get(a).depth - bind.get(b).depth);
  const saved = new Map(bones.map((b) => [b, b.quaternion.clone()]));
  const axis = new THREE.Vector3();
  const t = new THREE.Vector3(), s = new THREE.Vector3();
  const world = new THREE.Quaternion(), parent = new THREE.Quaternion();

  for (const [prefix, x, y, z, deg] of REST_POSE) {
    const bone = resolve(bones, prefix);
    if (!bone || !bone.parent) continue;
    root.updateMatrixWorld(true);
    bone.matrixWorld.decompose(t, world, s);
    bone.parent.matrixWorld.decompose(t, parent, s);
    // world' = fix * world, expressed back in the parent's frame.
    const fix = new THREE.Quaternion()
      .setFromAxisAngle(axis.set(x, y, z).normalize(), deg * Math.PI / 180);
    bone.quaternion.copy(parent.invert().multiply(fix).multiply(world));
  }

  root.updateMatrixWorld(true);
  for (const b of order) {
    const q = new THREE.Quaternion();
    b.matrixWorld.decompose(t, q, s);
    bind.get(b).refQ = q;
  }

  if (keep) return;                 // debugging: leave the rig standing in it
  for (const b of bones) b.quaternion.copy(saved.get(b));
  root.updateMatrixWorld(true);
}

/** Leave a character standing in its reference pose, for tools/rigcheck.html. */
export function showRestPose(character) {
  referencePose(character.scene, character.bones, character.bind, true);
  return character;
}

function restoreBind(bones, bind) {
  for (const b of bones) {
    const s = bind.get(b);
    if (!s) continue;
    b.quaternion.copy(s.localQ);
    b.position.copy(s.localP);
  }
}

/**
 * Scale a loaded rig to a real-world height.
 *
 * Just scale the scene. Nothing else.
 *
 * three.js SkinnedMeshes default to AttachedBindMode, in which bindMatrixInverse
 * is recomputed from matrixWorld on every updateMatrixWorld. The mesh's own world
 * transform therefore cancels out of the skinning entirely and the vertices
 * follow the BONES. Scaling an ancestor scales the bones, so the mesh follows at
 * exactly the right size, once.
 *
 * Do not call SkinnedMesh.bind() here to "reapply" the scale. An earlier version
 * did, believing the scale would otherwise be counted twice, and that is what
 * broke it: bind() pins bindMatrix to whatever world matrix happens to exist at
 * that instant, so every later move or rotation of the rig throws the mesh off.
 *
 * fitSkeleton() and seatFacialParts() do rewrite boneInverses, but they run at
 * load, in native units, and each is careful to leave `bone.matrixWorld *
 * boneInverse` holding the value the file drew correctly. This function only
 * scales, and must stay that way.
 */
function scaleRig(scene, meshes, targetHeight) {
  scene.updateMatrixWorld(true);
  const { height: raw } = poseHeight(meshes);
  scene.scale.multiplyScalar(targetHeight / raw);
  scene.updateMatrixWorld(true);

  const { box, height } = poseHeight(meshes);
  return { scale: targetHeight / raw, height, feet: box.min.y, raw };
}

/**
 * Load the donor and every skin, and build each skin's bone map.
 *
 * Skins come back at their NATIVE size, deliberately unscaled: clips have to be
 * baked in native units (see bakeClips) and scaling is the last step.
 */
export async function buildTubbyRigs(donorUrl, skinUrls) {
  const loader = new GLTFLoader();
  const donor = await loader.loadAsync(donorUrl);
  donor.scene.updateMatrixWorld(true);

  const donorMeshes = findSkinned(donor.scene);
  if (!donorMeshes.length) throw new Error(`${donorUrl} has no skinned mesh`);
  const sourceBones = donorMeshes[0].skeleton.bones;
  const donorHeight = poseHeight(donorMeshes).height;
  const donorBind = snapshotBind(sourceBones);

  const characters = {};
  for (const [kind, url] of Object.entries(skinUrls)) {
    const gltf = await loader.loadAsync(url);
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    const meshes = findSkinned(scene);
    if (!meshes.length) {
      console.warn(`[rig] ${kind} has no skeleton of its own - skipping`);
      continue;
    }
    const targetBones = meshes[0].skeleton.bones;

    // Make the joints line up with the geometry before anything reads or poses
    // them. See fitSkeleton() - without this every rotation tears the mesh.
    const fitted = fitSkeleton(scene, meshes);
    const eyes = seatFacialParts(scene, meshes);

    // Build the map for THIS skin; every skin has the same rig, but resolve
    // against its own bones so a renamed joint fails loudly rather than silently.
    const pairs = [];
    const missing = [];
    for (const [t, srcName] of BONE_PAIRS) {
      const tb = resolve(targetBones, t);
      const sb = resolve(sourceBones, srcName);
      if (tb && sb) pairs.push([tb, sb]);
      else missing.push(`${t} -> ${srcName}`);
    }
    if (missing.length) {
      console.warn(`[rig] ${kind}: ${missing.length} unmapped: ${missing.join(", ")}`);
    }

    for (const m of meshes) {
      m.frustumCulled = false;      // skinned bounds are computed unskinned
      m.castShadow = true;
    }

    characters[kind] = {
      kind, scene, meshes, pairs,
      target: meshes[0],
      bones: targetBones,
      bind: (() => {
        const b = snapshotBind(targetBones);
        referencePose(scene, targetBones, b);
        return b;
      })(),
      hip: resolve(targetBones, HIP_TARGET),
      nativeHeight: poseHeight(meshes).height,
      feet: 0,
      clips: null,
    };
    console.info(`[rig] ${kind}: ${targetBones.length} joints, ` +
      `${pairs.length}/${BONE_PAIRS.length} mapped, ` +
      `native ${characters[kind].nativeHeight.toFixed(2)}, ` +
      `skeleton grown x${fitted.k} to span ${fitted.boneSpan}/${fitted.meshSpan}, ` +
      `${eyes.moved} facial parts seated x${eyes.scale}`);
  }

  return { donor, characters, sourceBones, donorMesh: donorMeshes[0],
    donorHeight, donorBind };
}

/**
 * Bake donor clips onto one character.
 *
 * This is a hand-rolled retarget rather than SkeletonUtils.retargetClip, because
 * that one cannot survive these files. It converts a world rotation into bone
 * space with `bone.parent.matrixWorld.invert() * global` and then decomposes the
 * result, and these Sketchfab rips carry scale all the way down the chain: Body 1
 * sits at 100, its parent Move_All at 0.27, the wrappers at 0.01. The parent's
 * scale therefore lands in bone.scale, which retargetClip never writes a track
 * for, so nothing restores it and the rig inflates the moment a clip plays. It
 * also calls skeleton.pose(), which on these files is destructive on its own.
 *
 * What we do instead transfers the DELTA from each rig's own bind pose:
 *
 *     D         = srcWorldQ(t) * srcBindWorldQ^-1     // how far the donor turned
 *     dstWorldQ = D * dstBindWorldQ                   // turn the skin that far
 *     dstLocalQ = parentWorldQ(t)^-1 * dstWorldQ      // back into bone space
 *
 * Every term is a quaternion, so scale cannot enter at any point, and because it
 * is a delta the two rigs need not share bone axes, which they do not - one is a
 * 3ds Max biped. Bones we did not map hold their bind rotation, and bone.position
 * and bone.scale are never touched at all.
 */
export function bakeClips(character, rig, clips, targetHeight = 1.85) {
  const { bind, bones, pairs, hip } = character;
  const srcBind = rig.donorBind;
  const mixer = new THREE.AnimationMixer(rig.donor.scene);

  // Parents before children, so a bone's parent world rotation is already known.
  const order = bones.slice().sort((a, b) => bind.get(a).depth - bind.get(b).depth);
  const sourceOf = new Map(pairs);            // target bone -> donor bone

  // Donor travel is in donor units; the skin is baked at its native size.
  const k = character.nativeHeight / rig.donorHeight;
  const srcHip = hip ? sourceOf.get(hip) : null;
  const hipParentInv = hip && hip.parent && srcHip
    ? hip.parent.matrixWorld.clone().invert() : null;

  const worldQ = new Map();
  const q = new THREE.Quaternion(), sq = new THREE.Quaternion();
  const inv = new THREE.Quaternion();
  const t = new THREE.Vector3(), s = new THREE.Vector3();

  const out = [];
  for (const clip of clips) {
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play();

    const fps = 30;
    const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
    const dt = clip.duration / (frames - 1);
    const times = new Float32Array(frames);
    const quats = new Map(pairs.map(([tb]) => [tb, new Float32Array(frames * 4)]));
    const hipPos = hipParentInv ? new Float32Array(frames * 3) : null;

    for (let f = 0; f < frames; f++) {
      const time = f * dt;
      times[f] = time;
      // Never land exactly on duration: a looping clip wraps to frame 0 there.
      mixer.setTime(Math.min(time, clip.duration - 1e-5));
      rig.donor.scene.updateMatrixWorld(true);

      worldQ.clear();
      for (const bone of order) {
        const b = bind.get(bone);
        const parentQ = (bone.parent && worldQ.get(bone.parent)) || b.parentWorldQ;
        const src = sourceOf.get(bone);

        if (src) {
          src.matrixWorld.decompose(t, sq, s);
          // D = srcNow * srcBind^-1, applied to the skin's own bind rotation.
          inv.copy(srcBind.get(src).worldQ).invert();
          q.copy(sq).multiply(inv).multiply(b.refQ);
          worldQ.set(bone, q.clone());
          // Back into bone space using the parent's rotation only.
          inv.copy(parentQ).invert().multiply(q).toArray(quats.get(bone), f * 4);
        } else {
          // Unmapped bones hold whatever the reference pose left them at,
          // expressed relative to their parent there, so a fixed shoulder does
          // not drag unmapped children back towards the T-pose.
          const parentRef = bone.parent && bind.get(bone.parent)
            ? bind.get(bone.parent).refQ : b.parentWorldQ;
          worldQ.set(bone, parentQ.clone()
            .multiply(parentRef.clone().invert()).multiply(b.refQ));
        }
      }

      if (hipPos) {
        // Where the donor's pelvis has travelled, converted to the skin's units
        // and added to where the skin's own pelvis rests, then expressed in the
        // hip's parent frame - which is what a .position track is read in.
        new THREE.Vector3().setFromMatrixPosition(srcHip.matrixWorld)
          .sub(srcBind.get(srcHip).worldP)
          .multiplyScalar(k)
          .add(bind.get(hip).worldP)
          .applyMatrix4(hipParentInv)
          .toArray(hipPos, f * 3);
      }
    }

    const tracks = [];
    for (const [bone, values] of quats) {
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `.bones[${bone.name}].quaternion`, times, values));
    }
    if (hipPos) {
      tracks.push(new THREE.VectorKeyframeTrack(
        `.bones[${hip.name}].position`, times, hipPos));
    }
    out.push(new THREE.AnimationClip(clip.name, clip.duration, tracks));
  }

  mixer.stopAllAction();
  restoreBind(rig.sourceBones, rig.donorBind);
  restoreBind(bones, bind);
  rig.donor.scene.updateMatrixWorld(true);

  const fit = scaleRig(character.scene, character.meshes, targetHeight);
  character.feet = fit.feet;
  character.clips = out;
  return out;
}
