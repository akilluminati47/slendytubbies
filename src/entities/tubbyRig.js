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
 * Target bone (in the skin) -> source bone (in the donor), per donor rig.
 *
 * There are two donors and they share nothing but a skeleton's worth of joints.
 * donor/dipsy is a 3ds Max biped out of Garry's Mod, with 56 clips of walking,
 * running, attacking and dying; the players ride that one. donor/tinkywinky is a
 * Rigify rig with 27 clips of its own, including TINKY_WALKING and AXE_HIT, so
 * the chaser moves like Tinky Winky rather than borrowing Dipsy's gait.
 *
 * resolve() matches on a normalised prefix, so the exporter's numeric suffixes
 * (Bip01_Pelvis_02_13, upper_arm.R_025_32, Body 1_01) do not need writing out.
 */
const DONOR_MAPS = {
  biped: [
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
  ],
  // Rigify. Note the skin has two spine joints to Rigify's three, so Body 2 maps
  // to the chest rather than the waist. forearm.R is safe against
  // forearmTwist.R, which does not share its prefix once the dot is kept.
  rigify: [
    ["Body 1", "spine.001"],
    ["Body 2", "spine.003"],
    ["Head", "head"],
    ["Arm R1", "upper_arm.R"],
    ["Arm R2", "forearm.R"],
    ["Hand R", "hand.R"],
    ["Arm L1", "upper_arm.L"],
    ["Arm L2", "forearm.L"],
    ["Hand L", "hand.L"],
    ["Leg R1", "thigh.R"],
    ["Leg R2", "shin.R"],
    ["Foot R", "foot.R"],
    ["Toe R", "toe.R"],
    ["Leg L1", "thigh.L"],
    ["Leg L2", "shin.L"],
    ["Foot L", "foot.L"],
    ["Toe L", "toe.L"],
  ],
};

/** Whichever map names the most of this donor's actual bones. */
function pickDonorMap(sourceBones) {
  let best = null, bestScore = -1;
  for (const [name, pairs] of Object.entries(DONOR_MAPS)) {
    const score = pairs.filter(([, src]) => resolve(sourceBones, src)).length;
    if (score > bestScore) { bestScore = score; best = { name, pairs, score }; }
  }
  return best;
}

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
 * So we pick the skin's rest deliberately: arms down at its sides, which is what
 * a tubby should look like while the donor is holding its saw. Everything the
 * donor's arms then do on top of that comes through as it should.
 *
 * Angles are degrees about a WORLD axis and they ACCUMULATE down the chain, each
 * bone being turned on top of the parent that has already moved. An earlier
 * table read 74 / 8 / 4 as if they were independent and so put the arm 86
 * degrees down, which on a body this round buries it: the arm is 0.83m long off
 * a shoulder 0.235m out from the centre line, so at 86 degrees the hand lands at
 * x 0.46 against a belly 0.45 wide. It disappeared inside the model.
 *
 * At 60 the hand sits at 0.68, comfortably clear, and the small negative steps
 * at elbow and wrist let the forearm splay outward the way a slack arm does
 * rather than curling back into the stomach.
 *
 * The model faces +Z with its arms along X, so its right hand is at -X and a
 * positive turn about Z drops that arm towards the ground.
 */
/**
 * How much of a joint's own motion to give back, per bone.
 *
 * The donors are people. A walking person counters their pelvis against their
 * chest - hips one way, shoulders the other - and on donor/dipsy that comes to
 * 35 degrees of twist through the waist. A tubby has no waist. Its chaser
 * counterpart, animated by someone who knew that, twists zero: the pelvis and
 * the chest turn as one block and the whole body sways instead, which is what a
 * waddle is.
 *
 * So the spine keeps a quarter of the human counter-rotation and the rest is
 * given back to the pelvis. Measured, not guessed: 35.4 degrees against the
 * chaser's 0.
 */
const DAMPED = [["Body 2", 0.75]];

/**
 * How far each leg works to its own side.
 *
 * The donor is a person with hips a hand's width apart, so its knees travel in
 * one plane and its ankles track a single line - measured, the sideways offset
 * of a knee off the hip-to-ankle line never exceeds 0.02 on a 1.85m figure.
 * Transferred faithfully that gives a tubby, which is as wide as it is tall, two
 * legs treading the same groove and a pair of knees that read as leaning
 * together.
 *
 * SPLAY tips each knee out onto its own side; STANCE walks the ankle targets
 * apart so the feet tread their own lines rather than one.
 */
const SPLAY = 0.42;
const STANCE = 0.055;

const REST_POSE = [
  ["Arm R1", 0, 0, 1, 60], ["Arm R2", 0, 0, 1, -6], ["Hand R", 0, 0, 1, -2],
  ["Arm L1", 0, 0, 1, -60], ["Arm L2", 0, 0, 1, 6], ["Hand L", 0, 0, 1, 2],
];

/**
 * Find a bone by name prefix, ignoring the exporter's numeric suffixes and
 * skipping the zero-length "_end" tip bones, which would otherwise win the match
 * for names like "Bip01_Head".
 */
function resolve(bones, prefix) {
  // GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName,
  // which turns whitespace into underscores and DELETES the characters reserved
  // by the animation path syntax, "[ ] . : /". So "Body 1_01" arrives as
  // "Body_1_01" and Rigify's "upper_arm.R_025_32" as "upper_armR_025_32", with
  // the dot simply gone. Normalise both sides the same way rather than writing
  // the tables in loader-mangled form, which would not survive a different
  // exporter - and note that dropping the dot is what keeps "forearm.R" from
  // colliding with "forearmTwist.R".
  const norm = (x) => x.toLowerCase().replace(/[[\].:/]/g, "").replace(/[ _]+/g, "_");
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
  const points = [], uvs = [];
  const uvAttr = geo.attributes.uv;
  for (let i = 0; i < geo.attributes.position.count; i++) {
    mesh.getVertexPosition(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let id = canon.get(key);
    if (id === undefined) {
      id = points.length;
      canon.set(key, id);
      points.push(v.clone());
      uvs.push(uvAttr ? new THREE.Vector2(uvAttr.getX(i), uvAttr.getY(i)) : null);
    }
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
    // Where this hole sits on the texture sheet, which is what lets a face
    // painted for another head be lined up with the holes in this one.
    // Not `seen`: that name is the visited-set for the walk above, in this very
    // block, and shadowing it here put the Set into the temporal dead zone. The
    // whole rig build threw and fell back to the procedural stand-ins.
    let uv = null, uvCount = 0;
    for (const g of group) {
      if (!uvs[g]) continue;
      uv = uv ? uv.add(uvs[g]) : uvs[g].clone();
      uvCount++;
    }
    if (uv && uvCount) uv.divideScalar(uvCount);
    rims.push({ centre, count: group.length, radius, uv });
  }
  return rims;
}

/**
 * Blur the skin weights so joints bend instead of creasing.
 *
 * These rips are rigidly bound: 767 of Po's 993 body vertices answer to exactly
 * one bone at full weight, nothing anywhere has more than two influences, and 18
 * of the 31 vertices around the shoulder are rigid. That is fine while the model
 * stands in its T-pose and ruinous the moment an arm comes down - the arm's
 * vertices swing and the body's neighbours, one edge away, do not, so the shell
 * tears into the hard spike that reads where a round tubby shoulder should be.
 *
 * The fix is the standard one: average each vertex's weights with those of the
 * vertices it shares an edge with, a couple of passes, so a hard boundary
 * becomes a gradient a few millimetres wide. Nothing else about the rig changes.
 *
 * Two details that matter here:
 *
 *   - Vertices are merged by position first. The exporter splits them along UV
 *     seams, and a seam whose two halves get different weights cracks open the
 *     moment the joint moves, which is worse than the crease being fixed.
 *   - Only four influences survive, because that is all a glTF skin can carry.
 *     The smallest are dropped and the rest renormalised.
 */
function smoothSkinWeights(meshes, { passes = 2, strength = 0.5 } = {}) {
  let touched = 0;
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const pos = geo.attributes.position;
    if (!si || !sw || pos.count < 8) continue;

    // --- merge by position so seams move together -------------------------
    const canon = new Map(), idOf = new Int32Array(pos.count);
    let groups = 0;
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
      let id = canon.get(key);
      if (id === undefined) { id = groups++; canon.set(key, id); }
      idOf[i] = id;
    }

    // --- weights as a sparse map per merged vertex ------------------------
    let weights = Array.from({ length: groups }, () => new Map());
    for (let i = 0; i < pos.count; i++) {
      const m = weights[idOf[i]];
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w <= 0.0001) continue;
        const b = si.getComponent(i, k);
        m.set(b, Math.max(m.get(b) ?? 0, w));
      }
    }

    // --- who touches whom -------------------------------------------------
    const index = geo.index;
    const n = index ? index.count : pos.count;
    const at = (i) => (index ? index.getX(i) : i);
    const near = Array.from({ length: groups }, () => new Set());
    for (let i = 0; i < n; i += 3) {
      const t = [idOf[at(i)], idOf[at(i + 1)], idOf[at(i + 2)]];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) if (a !== b) near[t[a]].add(t[b]);
      }
    }

    for (let pass = 0; pass < passes; pass++) {
      const next = weights.map((own, v) => {
        const neighbours = near[v];
        if (!neighbours.size) return own;
        const avg = new Map();
        for (const other of neighbours) {
          for (const [bone, w] of weights[other]) {
            avg.set(bone, (avg.get(bone) ?? 0) + w / neighbours.size);
          }
        }
        const out = new Map();
        for (const [bone, w] of own) out.set(bone, w * (1 - strength));
        for (const [bone, w] of avg) out.set(bone, (out.get(bone) ?? 0) + w * strength);
        return out;
      });
      weights = next;
    }

    // --- back into the four slots a glTF skin has -------------------------
    for (let i = 0; i < pos.count; i++) {
      const sorted = [...weights[idOf[i]]].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = sorted.reduce((a, [, w]) => a + w, 0) || 1;
      for (let k = 0; k < 4; k++) {
        const [bone, w] = sorted[k] ?? [0, 0];
        si.setComponent(i, k, bone);
        sw.setComponent(i, k, w / total);
      }
    }
    si.needsUpdate = true;
    sw.needsUpdate = true;
    touched++;
  }
  return touched;
}

/**
 * Drop the shoulder joints onto the shoulders.
 *
 * fitSkeleton() scales the whole skeleton by one number so it spans the same
 * height as its mesh, which is the best a single scale can do and is not enough
 * here. A tubby is not shaped like the human-ish rig it was given: its head is
 * enormous, so its shoulders sit far lower down the silhouette than the same
 * skeleton would put them on a person. After the uniform fit the arm chain ends
 * up at y 16.2 on a body 17.4 tall - level with the top of the head - while the
 * arm geometry it drives is centred at 11.4. Every arm rotation was pivoting
 * from somewhere inside the skull, which is why the arms read as detached from
 * the shoulder however good the angle was.
 *
 * In a T-pose the upper arm runs horizontally, so the vertices it dominates are
 * spread either side of where its joint belongs: their centroid is the answer,
 * and it needs no constant. Move the bone there and the elbow and hand follow,
 * landing within 0.1 of their own geometry.
 *
 * Only the shoulders. A thigh joint legitimately sits above the middle of the
 * leg it drives, so the same reasoning would drag it down into the knee - the
 * legs measured 2.5 out for exactly that reason and are correct as they are.
 *
 * The bind pose is preserved the same way fitSkeleton preserves it: whatever a
 * bone contributed to skinning before, `boneWorld * boneInverse`, it contributes
 * afterwards too. Only the pivot moves.
 */
function alignShoulders(scene, meshes) {
  scene.updateMatrixWorld(true);
  const skeleton = meshes[0].skeleton;
  const bones = skeleton.bones;
  const body = meshes.reduce((a, b) =>
    b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a);

  const before = bones.map((b, i) =>
    new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skeleton.boneInverses[i]));

  const v = new THREE.Vector3();
  const moved = [];
  for (const side of ["R", "L"]) {
    const bone = resolve(bones, `Arm ${side}1`);
    if (!bone) continue;
    const index = bones.indexOf(bone);

    const centre = new THREE.Vector3();
    let n = 0;
    const si = body.geometry.attributes.skinIndex;
    const sw = body.geometry.attributes.skinWeight;
    for (let i = 0; i < body.geometry.attributes.position.count; i++) {
      let best = -1, bestW = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bestW) { bestW = w; best = si.getComponent(i, k); }
      }
      if (best !== index) continue;
      body.getVertexPosition(i, v);
      centre.add(v.applyMatrix4(body.matrixWorld));
      n++;
    }
    if (n < 6) continue;
    centre.divideScalar(n);

    // Height and depth only. The joint's distance out from the centre line is
    // already right - it measured within 0.3 of the geometry - and forcing it to
    // the centroid would pull the shoulder out into the middle of the bicep.
    const at = bone.getWorldPosition(v.clone());
    const drop = new THREE.Vector3(0, centre.y - at.y, centre.z - at.z);
    if (drop.lengthSq() < 1e-8) continue;

    // The target is world-space; a bone's position is read in its parent's.
    bone.position.copy(bone.parent.worldToLocal(at.clone().add(drop)));
    scene.updateMatrixWorld(true);
    moved.push({ bone: bone.name, by: +drop.length().toFixed(2) });
  }
  if (!moved.length) return null;

  for (let i = 0; i < bones.length; i++) {
    skeleton.boneInverses[i] = new THREE.Matrix4()
      .copy(bones[i].matrixWorld).invert().multiply(before[i]);
  }
  skeleton.update();
  return moved;
}

/**
 * Put the head aerial back on the head.
 *
 * Every skin ships its aerial, and each is the right shape - Dipsy's straight
 * rod, Laa-Laa's curl, Po's ring, Tinky Winky's triangle - but all four are
 * authored at about 4% of body height and parked at chest level, so they spend
 * the whole game inside the torso where nobody has ever seen them.
 *
 * The aerial cannot be moved the way the eyes were. That trick rewrites a bone's
 * inverse bind, and the aerial hangs off the head bone, which also drives the
 * entire head; shifting it would take the face along. So the geometry itself is
 * moved instead. A vertex currently draws at `M * v`, where M is the head's
 * skinning matrix, so to make it draw at `T * M * v` for some placement T the
 * raw vertex has to become `M^-1 * T * M * v`. Done once at load, before any
 * clone shares the buffer.
 *
 * The guardian is skipped for free: its top hat hangs off a Hat bone of its own,
 * so it is not head-dominated, and it was never misplaced anyway.
 */
function seatAerial(scene, meshes) {
  scene.updateMatrixWorld(true);
  const skeleton = meshes[0].skeleton;
  const head = resolve(skeleton.bones, "Head");
  if (!head) return null;
  const headIndex = skeleton.bones.indexOf(head);

  const body = meshes.reduce((a, b) =>
    b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a);

  // The aerial is the small mesh the head bone drives on its own. The face, the
  // lids and the eyes answer to eye and mouth bones; the hat, where there is
  // one, answers to a hat bone.
  let aerial = null;
  for (const m of meshes) {
    if (m === body) continue;
    const count = m.geometry.attributes.position.count;
    if (count > 400) continue;
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    if (!si || !sw) continue;
    let head_ = 0;
    for (let i = 0; i < count; i++) {
      let best = -1, bestW = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bestW) { bestW = w; best = si.getComponent(i, k); }
      }
      if (best === headIndex) head_++;
    }
    if (head_ > count * 0.9) { aerial = m; break; }
  }
  if (!aerial) return null;

  // --- where it is now ------------------------------------------------------
  const v = new THREE.Vector3();
  const now = new THREE.Box3();
  const pos = aerial.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    aerial.getVertexPosition(i, v);
    now.expandByPoint(v.applyMatrix4(aerial.matrixWorld));
  }
  const size = now.getSize(new THREE.Vector3());
  const tall = Math.max(size.x, size.y, size.z);
  if (tall < 1e-6) return null;

  // --- where it belongs -----------------------------------------------------
  const shell = new THREE.Box3();
  const bp = body.geometry.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    body.getVertexPosition(i, v);
    shell.expandByPoint(v.applyMatrix4(body.matrixWorld));
  }
  const height = shell.max.y - shell.min.y;
  const crown = shell.max.y;

  // The crown is not the middle of the model: the head leans forward of the
  // body's centre line, so take the average of whatever is in the top slice.
  const cx = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < bp.count; i++) {
    body.getVertexPosition(i, v).applyMatrix4(body.matrixWorld);
    if (v.y < crown - height * 0.045) continue;
    cx.add(v);
    n++;
  }
  if (n) cx.divideScalar(n); else cx.set(0, crown, 0);

  // A Teletubby aerial reads at roughly a sixth of the figure. Uniform, so a
  // rod stays a rod and a ring stays a ring.
  const AERIAL_HEIGHT = 0.17;
  const scale = (height * AERIAL_HEIGHT) / tall;
  const grown = size.clone().multiplyScalar(scale);

  const T = new THREE.Matrix4()
    // Sit the base a little into the scalp so it reads as planted, not balanced.
    .makeTranslation(cx.x, crown - height * 0.012 + grown.y / 2, cx.z)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .multiply(new THREE.Matrix4().makeTranslation(
      ...now.getCenter(new THREE.Vector3()).multiplyScalar(-1).toArray()));

  // v' = M^-1 * T * M * v, so the same skinning draws it in the new place.
  const M = new THREE.Matrix4()
    .multiplyMatrices(head.matrixWorld, skeleton.boneInverses[headIndex]);
  const A = new THREE.Matrix4().copy(M).invert().multiply(T).multiply(M);

  const arr = aerial.geometry.attributes.position;
  for (let i = 0; i < arr.count; i++) {
    v.fromBufferAttribute(arr, i).applyMatrix4(A);
    arr.setXYZ(i, v.x, v.y, v.z);
  }
  arr.needsUpdate = true;
  aerial.geometry.computeBoundingBox();
  aerial.geometry.computeBoundingSphere();

  return { mesh: aerial.name, scaled: +scale.toFixed(2),
    height: +grown.y.toFixed(2), onto: +crown.toFixed(2) };
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
  const socket = {}, socketRadius = {}, socketUV = {};
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
    if (best) {
      socket[side] = best.centre;
      socketRadius[side] = best.radius;
      socketUV[side] = best.uv;
    }
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

  // Hand the sockets out. They are holes in the mesh, so nothing painted on the
  // sheet can ever cover them - whatever sits in them has to be geometry. Kept
  // in the head bone's own frame so they survive the rig being scaled later.
  const head = resolve(bones, "Head");
  const out = [];
  if (head) {
    const headScale = new THREE.Vector3().setFromMatrixScale(head.matrixWorld).x || 1;
    for (const side of ["R", "L"]) {
      if (!socket[side]) continue;
      out.push({
        side,
        local: head.worldToLocal(socket[side].clone()),
        radius: socketRadius[side] / headScale,
        // Which way the face points, in the head bone's frame. Needed because
        // the head joint sits up at the crown, so "outward from the joint"
        // points down the face rather than out of it.
        forward: new THREE.Vector3(0, 0, 1)
          .transformDirection(head.matrixWorld.clone().invert()).normalize(),
      });
    }
  }
  return { moved: moved.length, sockets: out, head, socketUV,
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
  const map = pickDonorMap(sourceBones);
  console.info(`[rig] donor ${donorUrl.split("/").slice(-2)[0]}: ` +
    `${map.name} rig, ${map.score}/${map.pairs.length} bones, ` +
    `${donor.animations.length} clips`);

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
    const shoulders = alignShoulders(scene, meshes);
    const eyes = seatFacialParts(scene, meshes);
    const aerial = seatAerial(scene, meshes);
    // Last, because everything above classifies vertices by which single bone
    // dominates them, and this is the step that stops that being true.
    smoothSkinWeights(meshes);

    // Build the map for THIS skin; every skin has the same rig, but resolve
    // against its own bones so a renamed joint fails loudly rather than silently.
    const pairs = [];
    const missing = [];
    for (const [t, srcName] of map.pairs) {
      const tb = resolve(targetBones, t);
      const sb = resolve(sourceBones, srcName);
      if (tb && sb) pairs.push([tb, sb]);
      else missing.push(`${t} -> ${srcName}`);
    }
    if (missing.length) {
      console.warn(`[rig] ${kind}: ${missing.length} unmapped: ${missing.join(", ")}`);
    }

    const damped = new Map();
    for (const [name, amount] of DAMPED) {
      const bone = resolve(targetBones, name);
      if (bone) damped.set(bone, amount);
    }

    for (const m of meshes) {
      m.frustumCulled = false;      // skinned bounds are computed unskinned
      m.castShadow = true;
    }

    characters[kind] = {
      kind, scene, meshes, pairs, damped,
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
      // Where the eye sockets are and which bone they ride on, for whoever wants
      // to put something in them. See seatFacialParts.
      sockets: eyes.sockets,
      socketUV: eyes.socketUV,
      head: eyes.head,
      // The guardian's eye geometry is 456 units wide on a body 4.8 tall and
      // buried 2500 below its feet; a rescale that extreme means the mesh cannot
      // be trusted, whatever we move it to.
      eyesTrustworthy: eyes.scale > 0.25 && eyes.scale < 4,
    };
    console.info(`[rig] ${kind}: ${targetBones.length} joints, ` +
      `${pairs.length}/${map.pairs.length} mapped, ` +
      `native ${characters[kind].nativeHeight.toFixed(2)}, ` +
      `skeleton grown x${fitted.k} to span ${fitted.boneSpan}/${fitted.meshSpan}, ` +
      `${eyes.moved} facial parts seated x${eyes.scale}` +
      (eyes.scale > 0.25 && eyes.scale < 4 ? "" : " (DISTRUSTED)") +
      (shoulders ? `, shoulders dropped ${shoulders[0].by}` : "") +
      (aerial ? `, aerial x${aerial.scaled} onto the crown` : ", no aerial"));
  }

  return { donor, characters, sourceBones, donorMesh: donorMeshes[0],
    donorHeight, donorBind };
}

/**
 * The donor's resting pose, measured from its own animation.
 *
 * Retargeting transfers how far a bone has turned from its rig's rest, so that
 * rest has to be the pose the rig actually holds. The node transforms these
 * files ship are not it: on donor/dipsy the upper arm sits 70 degrees away from
 * where all 56 of its clips put it, because the node pose is a leftover and
 * every clip has it holding a chainsaw. Measuring from the node pose therefore
 * handed the tubby a permanent 70 degree shrug and folded its arms into its
 * chest, which is exactly what it looked like.
 *
 * Averaging the clip gives the pose the donor really lives in - for a walk, a
 * mid-stride stance, which is the right neutral for a swing to be measured
 * against. Quaternions are averaged by summing with their signs aligned and
 * renormalising: crude in general, exact enough across one locomotion cycle.
 */
function donorReference(rig, clip, bones) {
  const mixer = new THREE.AnimationMixer(rig.donor.scene);
  mixer.clipAction(clip).play();

  const rot = new Map(bones.map((b) => [b, [0, 0, 0, 0]]));
  const pos = new Map(bones.map((b) => [b, new THREE.Vector3()]));
  const anchor = new Map();
  const q = new THREE.Quaternion(), t = new THREE.Vector3(), s = new THREE.Vector3();

  const SAMPLES = 24;
  for (let i = 0; i < SAMPLES; i++) {
    mixer.setTime((i / SAMPLES) * clip.duration * 0.999);
    rig.donor.scene.updateMatrixWorld(true);
    for (const bone of bones) {
      bone.matrixWorld.decompose(t, q, s);
      if (!anchor.has(bone)) anchor.set(bone, q.clone());
      const a = anchor.get(bone);
      // q and -q are the same rotation; align the signs or the sum cancels.
      const sign = (q.x * a.x + q.y * a.y + q.z * a.z + q.w * a.w) < 0 ? -1 : 1;
      const acc = rot.get(bone);
      acc[0] += q.x * sign; acc[1] += q.y * sign;
      acc[2] += q.z * sign; acc[3] += q.w * sign;
      pos.get(bone).add(t);
    }
  }
  mixer.stopAllAction();

  const out = { rot: new Map(), pos: new Map() };
  for (const [bone, a] of rot) {
    out.rot.set(bone, new THREE.Quaternion(a[0], a[1], a[2], a[3]).normalize());
    out.pos.set(bone, pos.get(bone).divideScalar(SAMPLES));
  }
  return out;
}

/**
 * Two-bone IK. Where must the upper and lower segment point for the joint at the
 * end of the chain to land on `target`?
 *
 * Writes into the caller's scratch vectors and returns false when the target is
 * unreachable or degenerate, which the caller reads as "leave the leg alone".
 */
function twoBone(root, target, pole, l1, l2, sc) {
  const reach = sc.reach.subVectors(target, root);
  const d = THREE.MathUtils.clamp(reach.length(),
    Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  if (d < 1e-5) return false;
  reach.normalize();

  // The bend plane is spanned by the reach line and the knee hint.
  const axis = sc.axis.crossVectors(reach, pole);
  if (axis.lengthSq() < 1e-8) return false;
  axis.normalize();

  // Law of cosines for the angle between the reach line and the upper segment,
  // turned TOWARDS the pole. The sign matters and is easy to get backwards: with
  // reach pointing down and the pole forward, axis = reach x pole points to the
  // model's left, and a positive turn about it swings the thigh forward so the
  // knee leads. Negating it put every knee behind the hip-ankle line - both
  // donors carry their knee 0.08 to 0.51 of a leg length in FRONT of that line,
  // and the retarget was coming out at -0.03 to -0.15. Backwards knees.
  const cos = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  sc.upper.copy(reach).applyAxisAngle(axis, Math.acos(cos));
  sc.knee.copy(root).addScaledVector(sc.upper, l1);
  sc.lower.subVectors(target, sc.knee);
  if (sc.lower.lengthSq() < 1e-10) return false;
  sc.lower.normalize();
  return true;
}

/**
 * Turn `bone` so the limb axis it points along lands on `want`, keeping whatever
 * twist the rotation retarget already gave it, and write the result as a local.
 */
function aimBone(bone, axis, want, current, sc) {
  sc.have.copy(axis).applyQuaternion(current).normalize();
  const world = sc.world.setFromUnitVectors(sc.have, want).multiply(current);
  bone.parent.matrixWorld.decompose(sc.t, sc.parentQ, sc.s);
  bone.quaternion.copy(sc.parentQ.invert().multiply(world));
  bone.updateMatrixWorld(true);
  return world.clone();
}

/**
 * Bake donor clips onto one character.
 *
 * A hand-rolled retarget rather than SkeletonUtils.retargetClip, which cannot
 * survive these files: it converts world rotations into bone space through the
 * parent's full matrix and decomposes the result, so the scale these Sketchfab
 * hierarchies carry lands in bone.scale, which it never writes a track for, and
 * the rig inflates the moment a clip plays. It also calls skeleton.pose(), which
 * on these files is destructive on its own.
 *
 * Rotations transfer as a delta from each rig's own reference pose:
 *
 *     D         = srcNow * srcRef^-1     // how far the donor turned
 *     dstWorldQ = D * dstRefQ            // turn the skin that far
 *
 * All quaternions, so scale cannot enter, and being a delta the two rigs need
 * not share bone axes, which they do not - one is a 3ds Max biped.
 *
 * That part is exact: measured against the donor, every leg bone comes out
 * deviating from its bind by the donor's own angle to within a tenth of a
 * degree. Exact angles are not the same as a walk, though, because these two are
 * different animals. The tubby's foot is 18% of its height against the donor's
 * 10%, its shin is shorter and its thigh longer, so identical joint angles threw
 * its toe to half a metre where the donor lifts 22cm, and left the foot cocked
 * upward through the whole stance instead of ever planting.
 *
 * Feet are the thing an audience actually reads, so the legs are solved by
 * position instead of by angle:
 *
 *   - the ankle goes where the donor's ankle goes, as a fraction of leg length,
 *     so stride and step height scale to the body doing the walking;
 *   - the foot then aims along the donor's own ankle-to-toe direction, so the
 *     sole goes flat at the moment the donor's does.
 *
 * Arms keep the pure rotation path. Nothing they do has to meet the ground, and
 * their reference pose is the whole point of REST_POSE.
 */
export function bakeClips(character, rig, clips, targetHeight = 1.85) {
  const { bind, bones, pairs, hip, damped } = character;
  const sourceOf = new Map(pairs);
  const order = bones.slice().sort((a, b) => bind.get(a).depth - bind.get(b).depth);

  // Back to native size before measuring anything. Every number on the bind
  // snapshot - bone lengths, the hip's rest position - is in the units the file
  // shipped, and scaleRig at the end of this function leaves the scene at 1.85m.
  // Baking a second time without this reads native-unit offsets against a scaled
  // skeleton and throws the hips several metres into the air; the game bakes
  // once per character so it never saw it, but a caller comparing clips does.
  character.scene.scale.set(1, 1, 1);
  character.scene.updateMatrixWorld(true);
  rig.donor.scene.updateMatrixWorld(true);
  const P = (b) => b.getWorldPosition(new THREE.Vector3());

  // --- the leg chains, if this rig has them --------------------------------
  const legs = [];
  for (const side of ["R", "L"]) {
    const t = {
      thigh: resolve(bones, `Leg ${side}1`), shin: resolve(bones, `Leg ${side}2`),
      foot: resolve(bones, `Foot ${side}`), toe: resolve(bones, `Toe ${side}`),
    };
    const s = {
      thigh: sourceOf.get(t.thigh), shin: sourceOf.get(t.shin),
      foot: sourceOf.get(t.foot), toe: sourceOf.get(t.toe),
    };
    if (!t.thigh || !t.shin || !t.foot || !s.thigh || !s.shin || !s.foot) continue;

    const bq = (b) => bind.get(b).worldQ.clone().invert();
    legs.push({
      t, s,
      // The model faces +Z, so its own right hand side is -X.
      out: side === "R" ? -1 : 1,
      l1: P(t.thigh).distanceTo(P(t.shin)),
      l2: P(t.shin).distanceTo(P(t.foot)),
      srcLen: P(s.thigh).distanceTo(P(s.shin)) + P(s.shin).distanceTo(P(s.foot)),
      // Each bone's own "down the limb" axis in its bind frame, so an aim can be
      // expressed without caring which way the artist pointed the joint.
      axThigh: P(t.shin).sub(P(t.thigh)).normalize().applyQuaternion(bq(t.thigh)),
      axShin: P(t.foot).sub(P(t.shin)).normalize().applyQuaternion(bq(t.shin)),
      axFoot: t.toe && s.toe
        ? P(t.toe).sub(P(t.foot)).normalize().applyQuaternion(bq(t.foot)) : null,
      // The same direction left in world terms: where this foot points when the
      // character is standing in its own rest pose.
      footRest: t.toe && s.toe ? P(t.toe).sub(P(t.foot)).normalize() : null,
    });
  }

  const mixer = new THREE.AnimationMixer(rig.donor.scene);
  const k = character.nativeHeight / rig.donorHeight;
  const srcHip = hip ? sourceOf.get(hip) : null;
  const hipParentInv = hip && hip.parent && srcHip
    ? hip.parent.matrixWorld.clone().invert() : null;

  const sc = {
    reach: new THREE.Vector3(), axis: new THREE.Vector3(), upper: new THREE.Vector3(),
    lower: new THREE.Vector3(), knee: new THREE.Vector3(), have: new THREE.Vector3(),
    world: new THREE.Quaternion(), parentQ: new THREE.Quaternion(),
    t: new THREE.Vector3(), s: new THREE.Vector3(),
  };
  const q = new THREE.Quaternion(), sq = new THREE.Quaternion(), inv = new THREE.Quaternion();
  const t = new THREE.Vector3(), s = new THREE.Vector3();
  const worldQ = new Map();
  const dHip = new THREE.Vector3(), dAnkle = new THREE.Vector3(), dKnee = new THREE.Vector3();
  const myHip = new THREE.Vector3(), along = new THREE.Vector3();
  const pole = new THREE.Vector3(), target = new THREE.Vector3(), tmp = new THREE.Vector3();

  const out = [];
  for (const clip of clips) {
    const ref = donorReference(rig, clip, [...sourceOf.values()].filter(Boolean));
    // Where the donor's own feet point at rest, so the foot can be transferred
    // as a change from that rather than copied outright.
    for (const L of legs) {
      if (!L.footRest) continue;
      const a = ref.pos.get(L.s.foot), b = ref.pos.get(L.s.toe);
      L.srcFootRest = a && b ? b.clone().sub(a).normalize() : null;
    }
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

      // --- pass one: the rotation retarget, written onto the skeleton ------
      worldQ.clear();
      for (const bone of order) {
        const b = bind.get(bone);
        const parentQ = (bone.parent && worldQ.get(bone.parent)) || b.parentWorldQ;
        const src = sourceOf.get(bone);
        if (src) {
          src.matrixWorld.decompose(t, sq, s);
          inv.copy(ref.rot.get(src) ?? b.worldQ).invert();
          q.copy(sq).multiply(inv).multiply(b.refQ);
          worldQ.set(bone, q.clone());
          bone.quaternion.copy(inv.copy(parentQ).invert().multiply(q));

          // Give part of the joint's motion back, where a human's articulation
          // does not belong on this body. See DAMPED.
          const give = damped.get(bone);
          if (give) {
            const parentRef = bone.parent && bind.get(bone.parent)
              ? bind.get(bone.parent).refQ : b.parentWorldQ;
            const rest = parentRef.clone().invert().multiply(b.refQ);
            bone.quaternion.slerp(rest, give);
            // The world rotation the children inherit has to follow.
            worldQ.set(bone, parentQ.clone().multiply(bone.quaternion));
          }
        } else {
          // Unmapped bones hold their reference local, so a corrected shoulder
          // does not drag its children back towards the T-pose.
          const parentRef = bone.parent && bind.get(bone.parent)
            ? bind.get(bone.parent).refQ : b.parentWorldQ;
          worldQ.set(bone, parentQ.clone()
            .multiply(parentRef.clone().invert()).multiply(b.refQ));
        }
      }

      // The hip's travel, in the skin's units, applied before the legs are
      // solved because the IK needs the hip where it will finally sit.
      if (hipPos) {
        tmp.setFromMatrixPosition(srcHip.matrixWorld)
          .sub(ref.pos.get(srcHip))
          .multiplyScalar(k)
          .add(bind.get(hip).worldP)
          .applyMatrix4(hipParentInv);
        hip.position.copy(tmp);
        tmp.toArray(hipPos, f * 3);
      }
      character.scene.updateMatrixWorld(true);

      // --- pass two: put the feet where the donor's feet are ---------------
      for (const L of legs) {
        L.t.thigh.getWorldPosition(myHip);
        L.s.thigh.getWorldPosition(dHip);
        L.s.foot.getWorldPosition(dAnkle);
        L.s.shin.getWorldPosition(dKnee);

        // Ankle offset from the hip, as a fraction of the donor's leg, applied
        // to the length of the leg this character actually has.
        target.subVectors(dAnkle, dHip)
          .multiplyScalar((L.l1 + L.l2) / L.srcLen)
          .add(myHip);
        // And out onto its own line, so the two feet do not tread one groove.
        target.x += L.out * STANCE * (L.l1 + L.l2);

        // Knee hint: where the donor puts its knee, off the hip-to-ankle line,
        // then tipped out onto this leg's own side. See SPLAY.
        along.subVectors(dAnkle, dHip).normalize();
        pole.subVectors(dKnee, dHip);
        pole.addScaledVector(along, -pole.dot(along));
        if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
        pole.normalize();
        pole.x += L.out * SPLAY;
        pole.addScaledVector(along, -pole.dot(along));   // keep it perpendicular
        pole.normalize();

        if (!twoBone(myHip, target, pole, L.l1, L.l2, sc)) continue;
        const upper = sc.upper.clone(), lower = sc.lower.clone();

        worldQ.set(L.t.thigh,
          aimBone(L.t.thigh, L.axThigh, upper, worldQ.get(L.t.thigh) ?? bind.get(L.t.thigh).worldQ, sc));
        worldQ.set(L.t.shin,
          aimBone(L.t.shin, L.axShin, lower, worldQ.get(L.t.shin) ?? bind.get(L.t.shin).worldQ, sc));

        // The foot swings the way the donor's foot swings - as a change from
        // each rig's own rest, not as a copied direction.
        //
        // Copying it outright put the tubbies permanently en pointe. Bip01_Toe0
        // sits at the ball of a human foot, an inch or two ahead of the ankle
        // and well below it, while the tubby's toe bone spans a whole 33cm foot
        // that should lie flat. Handing the second the first's direction pitched
        // the sole to 85 degrees nose-down and it never once went flat.
        if (L.axFoot && L.srcFootRest) {
          L.s.foot.getWorldPosition(tmp);
          L.s.toe.getWorldPosition(dKnee);
          const now = dKnee.sub(tmp).normalize();
          const swing = new THREE.Quaternion().setFromUnitVectors(L.srcFootRest, now);
          const want = L.footRest.clone().applyQuaternion(swing);
          worldQ.set(L.t.foot,
            aimBone(L.t.foot, L.axFoot, want, worldQ.get(L.t.foot) ?? bind.get(L.t.foot).worldQ, sc));
        }
      }

      // --- record whatever the skeleton is now holding ---------------------
      for (const [bone, values] of quats) bone.quaternion.toArray(values, f * 4);
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
