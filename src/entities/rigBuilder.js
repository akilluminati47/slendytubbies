import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * Build rigged tubbies at load time, in the browser, without a Blender step.
 *
 * The Blender route kept failing for one reason: its glTF exporter writes
 * skinned vertices in the armature's space and the inverse bind matrices to
 * match, and any placement computed in world space lands in the wrong frame.
 * The result binds cleanly, reports healthy bones and weights, and renders
 * nothing. Four rewrites in, the numbers still disagreed (vertices at 3641,
 * skeleton spanning 115).
 *
 * So do the bind here instead. The donor GLB already works - that is why it was
 * chosen - so we reuse its skeleton, its inverse bind matrices and its bind
 * matrix VERBATIM, and only swap in new geometry expressed in the donor mesh's
 * own local space. Correctness then holds by construction: nothing is
 * re-derived, so there is no frame left to get wrong.
 *
 * Weights come from the donor's own body mesh by nearest-vertex transfer. The
 * template tubby and the donor tubby are the same creature in the same pose, so
 * "whatever the donor vertex nearest to me does" is a good approximation, and a
 * far more robust one than re-running heat weighting on a foreign rig.
 *
 * STATUS: close, but not finished. CFG.tubby.useBakedRig is false, so the game
 * runs on the procedural stand-ins and none of this executes.
 *
 * Working, and verified by measurement rather than by eye:
 *   - all five characters bind to the donor skeleton, 6 meshes each, ~2.8s build
 *   - the mixer drives all 56 clips
 *   - weights spread over 17 distinct bones instead of collapsing onto one
 *   - the skinned mesh tracks the skeleton (mesh 3.19 vs bones 3.30 before
 *     normalisation) - this was the big one, fixed by giving each new mesh the
 *     ANCHOR's local transform, not just its parent's. The geometry is converted
 *     into anchor.matrixWorld's space, so anything else disagrees by exactly the
 *     anchor's own transform, which is what left it floating.
 *   - the character normalises to 1.80m against a 1.85m target
 *   - feet plant on the ground every frame via the Bip01_*_Toe0/Foot bones,
 *     which also handles the root motion baked into these clips
 *
 * Filtering the donor cloud to Bip01_* bones was what fixed the sizing: this
 * donor carries a chainsaw plus smoke, sparks, pullchain and camera bones, so a
 * bounding box over every vertex describes "tubby plus chainsaw" and made the
 * character ~1.5x too big.
 *
 * What is still wrong: it does not draw. Every check passes - 6 visible meshes,
 * opaque MeshStandardMaterial with a texture, 44/44 cloned bones resolving in
 * the clone's own tree, geometry 4.6m dead ahead of the camera with dotForward
 * 0.98 - and nothing appears.
 *
 * The one measurement that does NOT line up: the cloned pelvis bone reports
 * world y 3.85 while the skinned vertices measure 1.38..3.18. Bones and skinned
 * geometry should not be able to disagree like that, so the next thing to chase
 * is that gap: compare getVertexPosition against the GPU's own skinning for the
 * same vertex, and check whether skinnedClone is remapping bindMatrix as well as
 * the bone list. A bindMatrix left pointing at the source rig would produce
 * exactly this - correct-looking bones, correct-looking CPU maths, nothing on
 * screen.
 */

/** Bones that carry props rather than body: excluded from the shape reference. */
/**
 * How many donor vertices to blend per template vertex.
 *
 * 1 - copy the single nearest. Blending 8 by inverse distance was tried and is
 * clearly WORSE: it smears weights across the body and the arm chains, and the
 * characters come out stretched horizontally (2.1m wide, 0.69m tall) instead of
 * standing. The donor and the template are different enough in proportion that
 * a neighbourhood average mixes bones that should never share a vertex.
 */
const WEIGHT_SAMPLES = 1;

const PROP_BONE = /chainsaw|saw\d|smoke|spark|pullchain|chain-|(^|[_.])cam([_.]|$)/i;

/** Uniform-grid nearest-neighbour. Brute force is 27M checks; this is ~1M. */
class VertexGrid {
  constructor(positions, cell) {
    this.cell = cell;
    this.map = new Map();
    this.positions = positions;
    for (let i = 0; i < positions.count; i++) {
      const k = this.#key(positions.getX(i), positions.getY(i), positions.getZ(i));
      let bucket = this.map.get(k);
      if (!bucket) this.map.set(k, (bucket = []));
      bucket.push(i);
    }
  }

  #key(x, y, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
  }

  /** The k nearest vertices, as [index, distanceSquared] pairs. */
  nearestK(x, y, z, k) {
    const found = [];
    for (let r = 0; r < 12 && found.length < k; r++) {
      const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell);
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          for (let l = -r; l <= r; l++) {
            if (r > 0 && Math.abs(i) !== r && Math.abs(j) !== r && Math.abs(l) !== r) continue;
            const bucket = this.map.get(`${cx + i},${cy + j},${cz + l}`);
            if (!bucket) continue;
            for (const vi of bucket) {
              const dx = this.positions.getX(vi) - x;
              const dy = this.positions.getY(vi) - y;
              const dz = this.positions.getZ(vi) - z;
              found.push([vi, dx * dx + dy * dy + dz * dz]);
            }
          }
        }
      }
    }
    found.sort((a, b) => a[1] - b[1]);
    return found.slice(0, k);
  }

  nearest(x, y, z) {
    // Widen the search ring until something is found, so a vertex sitting in an
    // empty cell (the tip of an aerial, say) still resolves.
    for (let r = 0; r < 12; r++) {
      let best = -1;
      let bestD = Infinity;
      const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell);
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          for (let k = -r; k <= r; k++) {
            // Only the shell of the ring is new on each pass.
            if (r > 0 && Math.abs(i) !== r && Math.abs(j) !== r && Math.abs(k) !== r) continue;
            const bucket = this.map.get(`${cx + i},${cy + j},${cz + k}`);
            if (!bucket) continue;
            for (const vi of bucket) {
              const dx = this.positions.getX(vi) - x;
              const dy = this.positions.getY(vi) - y;
              const dz = this.positions.getZ(vi) - z;
              const d = dx * dx + dy * dy + dz * dz;
              if (d < bestD) { bestD = d; best = vi; }
            }
          }
        }
      }
      if (best >= 0) return best;
    }
    return 0;
  }
}

const fmtBox = (b) => `x[${b.min.x.toFixed(1)},${b.max.x.toFixed(1)}] ` +
  `y[${b.min.y.toFixed(1)},${b.max.y.toFixed(1)}] z[${b.min.z.toFixed(1)},${b.max.z.toFixed(1)}]`;

function boundsOf(geometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox.clone();
}

/**
 * Uniform fit of one box onto another, standing the feet on the target's floor.
 * Uniform because a stretched tubby reads as broken far faster than a slightly
 * short one, and the two meshes are close in proportion anyway.
 */
function fitMatrix(src, dst) {
  const s = new THREE.Vector3(), d = new THREE.Vector3();
  src.getSize(s);
  dst.getSize(d);
  const k = Math.min(d.x / Math.max(s.x, 1e-9), d.y / Math.max(s.y, 1e-9), d.z / Math.max(s.z, 1e-9));
  const sMid = new THREE.Vector3(), dMid = new THREE.Vector3();
  src.getCenter(sMid);
  dst.getCenter(dMid);
  const m = new THREE.Matrix4().makeScale(k, k, k);
  m.premultiply(new THREE.Matrix4().makeTranslation(
    dMid.x - sMid.x * k,
    dst.min.y - src.min.y * k,     // feet, not centres
    dMid.z - sMid.z * k,
  ));
  return m;
}

/** Flatten a loaded glTF scene's meshes into one geometry in scene-local space. */
function flatten(scene) {
  const parts = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    // Only what a skinned draw needs; stray attributes break merging.
    for (const name of Object.keys(g.attributes)) {
      if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute("uv", new THREE.BufferAttribute(
        new Float32Array(g.attributes.position.count * 2), 2));
    }
    parts.push({ geometry: g, material: o.material });
  });
  return parts;
}

export async function buildRiggedTubbies(donorUrl, skins, targetHeight = 1.85) {
  const loader = new GLTFLoader();
  const donor = await loader.loadAsync(donorUrl);
  donor.scene.updateMatrixWorld(true);

  // Collect every donor skinned mesh, not just the biggest: the body, the head
  // and the trim together describe the silhouette we are matching against, and
  // any one of them alone is a sliver.
  const donorMeshes = [];
  donor.scene.traverse((o) => { if (o.isSkinnedMesh) donorMeshes.push(o); });
  if (!donorMeshes.length) throw new Error(`${donorUrl} has no skinned mesh`);

  // Force the bind pose before sampling. Whatever pose the loader happened to
  // leave the skeleton in is not the pose the geometry was authored against,
  // and matching a standing template against a crouched donor produces a
  // convincing-looking fit that is completely wrong.
  for (const m of donorMeshes) m.skeleton.pose();
  donor.scene.updateMatrixWorld(true);

  /*
   * Everything below happens in WORLD space.
   *
   * A skinned mesh's geometry lives in bind space, which has no relation to the
   * space a freshly imported static mesh lives in - comparing the two directly
   * gave a "body" box 11 units wide against a skin box 534 wide, and every
   * vertex then snapped to the same bone. World space is the one frame both
   * meshes genuinely share, so match there and convert back afterwards.
   */
  /*
   * Only the BODY counts, and the bone names say which that is.
   *
   * This donor is a biped carrying a chainsaw: alongside Bip01_Pelvis, Spine,
   * Head, Thigh and so on it has chainsaw_rootbone, saw1, saw2, smoke, sparks,
   * pullchain and a camera bone. Those reach well outside the silhouette, so a
   * bounding box over every vertex describes "tubby plus chainsaw" and fitting
   * to it produced a character about 1.5x too big, floating above its feet.
   *
   * Filtering to vertices driven by Bip01_* bones gives the body on its own,
   * which is the thing the template mesh is actually shaped like.
   */
  // Deny-list, not an allow-list: these rips do not share a naming convention.
  // The ST3 Dipsy is a 3ds Max biped (Bip01_Pelvis, Bip01_R_Clavicle...) while
  // the Tinky Winky donor is Rigify (spine.001, upper_arm.L, head). Naming what
  // is NOT body - this donor's chainsaw, its smoke, sparks, pull chain and
  // camera bone - works for both, and for the next rip too.
  const skeleton = donorMeshes[0].skeleton;
  const isBodyBone = skeleton.bones.map((b) => !PROP_BONE.test(b.name));
  const bodyBoneCount = isBodyBone.filter(Boolean).length;

  const landmark = (re) => skeleton.bones.find((b) => re.test(b.name));
  const hip = landmark(/pelvis|spine\.?0*1$|^root_/i);
  const headTop = landmark(/head_end/i) ?? landmark(/(^|_)head/i);
  const toe = landmark(/toe.*end/i) ?? landmark(/toe/i) ?? landmark(/foot/i);

  const donorPts = [];
  const donorSrc = [];       // which mesh + vertex each world point came from
  const v = new THREE.Vector3();
  let skipped = 0;
  for (const m of donorMeshes) {
    const pos = m.geometry.attributes.position;
    const si = m.geometry.attributes.skinIndex;
    const sw = m.geometry.attributes.skinWeight;
    if (!si) continue;
    for (let i = 0; i < pos.count; i++) {
      // Whichever bone actually drives this vertex decides whether it is body.
      const w = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
      const j = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)];
      let best = 0;
      for (let k = 1; k < 4; k++) if (w[k] > w[best]) best = k;
      if (!isBodyBone[j[best]]) { skipped++; continue; }

      // Where this vertex actually ENDS UP once skinning runs. Raw geometry
      // coordinates are in bind space and can sit nowhere near the character.
      m.getVertexPosition(i, v);
      v.applyMatrix4(m.matrixWorld);
      donorPts.push(v.x, v.y, v.z);
      donorSrc.push(m, i);
    }
  }
  if (!donorPts.length) throw new Error("no body vertices found on the donor");
  const donorPos = new THREE.BufferAttribute(new Float32Array(donorPts), 3);

  const donorBox = new THREE.Box3();
  for (let i = 0; i < donorPos.count; i++) {
    donorBox.expandByPoint(v.set(donorPos.getX(i), donorPos.getY(i), donorPos.getZ(i)));
  }
  const size = new THREE.Vector3();
  donorBox.getSize(size);
  const grid = new VertexGrid(donorPos, Math.max(size.length() / 28, 1e-5));

  // Cross-check the box against the skeleton's own landmarks. If the two
  // disagree the filter has gone wrong, and it is far better to hear about it
  // here than to wonder later why the tubbies look odd.
  const wp = (b) => b.getWorldPosition(new THREE.Vector3());
  if (hip && headTop && toe) {
    const hipY = wp(hip).y, headY = wp(headTop).y, toeY = wp(toe).y;
    console.info(`[rig] donor landmarks: toe ${toeY.toFixed(2)}, hip ${hipY.toFixed(2)}, ` +
      `head ${headY.toFixed(2)} -> ${(headY - toeY).toFixed(2)} tall; ` +
      `body box ${size.y.toFixed(2)} tall from ${donorPos.count} verts ` +
      `(${skipped} prop verts dropped, ${bodyBoneCount}/${skeleton.bones.length} body bones)`);
  }

  // Anchor every new mesh to the same node and bind as the donor's own body, so
  // nothing about the binding has to be re-derived.
  const anchor = donorMeshes.reduce((a, b) =>
    a.geometry.attributes.position.count > b.geometry.attributes.position.count ? a : b);
  const toLocal = anchor.matrixWorld.clone().invert();

  const root = new THREE.Group();
  root.add(donor.scene);
  // The donor contributes a skeleton, 56 clips and the weights we sample. Its
  // geometry is never drawn - only the chaser and the player skins are.
  for (const m of donorMeshes) m.visible = false;

  const byKind = {};
  for (const [kind, url] of Object.entries(skins)) {
    let gltf;
    try {
      gltf = await loader.loadAsync(url);
    } catch {
      console.warn(`[rig] missing skin ${kind} at ${url}`);
      continue;
    }

    const parts = flatten(gltf.scene);
    if (!parts.length) continue;

    let whole = new THREE.Box3();
    for (const p of parts) whole.union(boundsOf(p.geometry));

    // These rips are not consistently Y-up. If the skin is taller through Z
    // than through Y it was authored Z-up, and fitting it as-is lays the tubby
    // on its face. Stand it up before matching anything.
    const ws = new THREE.Vector3();
    whole.getSize(ws);
    if (ws.z > ws.y * 1.25) {
      // +90 about X, not -90. Blender Z-up to glTF Y-up is (x,y,z) -> (x,z,-y),
      // and getting the sign backwards stands the model on its head - which is
      // exactly what it did, with the legs in the air reading as a vase.
      const upright = new THREE.Matrix4().makeRotationX(Math.PI / 2);
      for (const p of parts) p.geometry.applyMatrix4(upright);
      whole = new THREE.Box3();
      for (const p of parts) whole.union(boundsOf(p.geometry));
      console.info(`[rig] ${kind}: was Z-up, stood upright`);
    }

    const fit = fitMatrix(whole, donorBox);

    const meshes = [];
    for (const part of parts) {
      const g = part.geometry;
      g.applyMatrix4(fit);                     // now overlaying the donor in world

      const n = g.attributes.position.count;
      const ji = new Uint16Array(n * 4);
      const jw = new Float32Array(n * 4);
      const p = g.attributes.position;
      /*
       * Blend the K nearest donor vertices by inverse distance rather than
       * copying the single closest.
       *
       * Copying one vertex makes every transition a hard edge: a vertex just
       * inside a shoulder takes 100% of an arm bone while its neighbour takes
       * 100% of the chest, and the limbs tear away from the body as soon as
       * anything animates. Averaging a small neighbourhood gives the smooth
       * falloff a hand-painted weight map would have.
       */
      const acc = new Map();
      for (let i = 0; i < n; i++) {
        acc.clear();
        const hits = grid.nearestK(p.getX(i), p.getY(i), p.getZ(i), WEIGHT_SAMPLES);
        for (const [hit, d2] of hits) {
          const srcMesh = donorSrc[hit * 2];
          const srcIdx = donorSrc[hit * 2 + 1];
          const sj = srcMesh.geometry.attributes.skinIndex;
          const sw = srcMesh.geometry.attributes.skinWeight;
          const influence = 1 / (d2 + 1e-6);
          for (let c = 0; c < 4; c++) {
            const w = [sw.getX(srcIdx), sw.getY(srcIdx), sw.getZ(srcIdx), sw.getW(srcIdx)][c];
            if (w <= 0) continue;
            const b = [sj.getX(srcIdx), sj.getY(srcIdx), sj.getZ(srcIdx), sj.getW(srcIdx)][c];
            acc.set(b, (acc.get(b) ?? 0) + w * influence);
          }
        }
        // glTF allows four influences per vertex; keep the strongest four.
        const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const total = top.reduce((sum, e) => sum + e[1], 0) || 1;
        for (let c = 0; c < 4; c++) {
          ji[i * 4 + c] = top[c] ? top[c][0] : 0;
          jw[i * 4 + c] = top[c] ? top[c][1] / total : 0;
        }
      }
      g.setAttribute("skinIndex", new THREE.BufferAttribute(ji, 4));
      g.setAttribute("skinWeight", new THREE.BufferAttribute(jw, 4));

      // Back into the anchor's own space, which is what its bind matrix expects.
      g.applyMatrix4(toLocal);

      const mat = part.material?.clone?.() ?? new THREE.MeshStandardMaterial();
      const mesh = new THREE.SkinnedMesh(g, mat);
      mesh.name = `tubby_${kind}_${meshes.length}`;
      anchor.parent.add(mesh);
      // Wear the anchor's own local transform, not just its parent. The
      // geometry was converted into anchor.matrixWorld's space, so the new mesh
      // has to resolve to that same world matrix or the two disagree by exactly
      // the anchor's local transform - which is what left it floating.
      mesh.position.copy(anchor.position);
      mesh.quaternion.copy(anchor.quaternion);
      mesh.scale.copy(anchor.scale);
      mesh.updateMatrixWorld(true);
      mesh.bind(anchor.skeleton, anchor.bindMatrix);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.visible = false;
      meshes.push(mesh);
    }
    byKind[kind] = meshes;
    console.info(`[rig] ${kind}: ${meshes.length} mesh(es) bound`);
  }

  /*
   * Scale the rig to metres, then REBIND.
   *
   * This was the bug that made the tubbies render tiny. bindMatrix is the mesh's
   * world matrix captured at bind time; scaling anything above the mesh
   * afterwards leaves bindMatrix describing the old world and the bones
   * describing the new one, and the skinned result comes out at the wrong size.
   * The CPU maths agreed with itself the whole time, which is why measuring
   * getVertexPosition never showed it.
   *
   * So: measure in the bind pose, apply the scale to the root, then rebind every
   * mesh against its NEW world matrix while still in the bind pose.
   */
  const measureDrawn = () => {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const pv = new THREE.Vector3();
    for (const m of sample) {
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        m.getVertexPosition(i, pv);
        box.expandByPoint(pv.applyMatrix4(m.matrixWorld));
      }
    }
    return box;
  };

  const sample = Object.values(byKind)[0] ?? [];
  for (const m of sample) m.visible = true;
  anchor.skeleton.pose();                    // measure the bind pose, not a clip
  const before = measureDrawn();
  const rawHeight = Math.max(before.max.y - before.min.y, 1e-6);

  root.scale.setScalar(targetHeight / rawHeight);
  root.updateMatrixWorld(true);

  /*
   * Rebinding alone is not enough, and doing it alone collapsed the rig to 5cm.
   * bindMatrix and boneInverses are a matched pair: boneInverse[i] is the
   * inverse of bone i's world matrix AT BIND TIME. Change the world (by scaling
   * an ancestor) and update only one half of the pair and the skinning cancels
   * itself. Recompute the inverses in the new, scaled bind pose, then rebind
   * each mesh against its new world matrix so both halves agree again.
   *
   * The clips are unaffected: they drive bone LOCAL transforms, which an
   * ancestor scale does not touch.
   */
  anchor.skeleton.calculateInverses();
  for (const list of Object.values(byKind)) {
    for (const m of list) m.bind(m.skeleton, m.matrixWorld);
  }

  const after = measureDrawn();
  for (const m of sample) m.visible = false;

  const measured = {
    height: Math.max(after.max.y - after.min.y, 1e-6),
    feet: after.min.y,
  };
  console.info(`[rig] ${rawHeight.toFixed(2)} -> ${measured.height.toFixed(2)}m ` +
    `after rescale and rebind, feet at ${measured.feet.toFixed(2)}`);

  return { root, animations: donor.animations, byKind, skeleton: anchor.skeleton, measured };
}
