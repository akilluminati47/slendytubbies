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
 * STATUS: not finished. CFG.tubby.useBakedRig is false, so the game runs on the
 * procedural stand-ins and none of this executes.
 *
 * What works: all five characters bind to the donor skeleton, the mixer drives
 * all 56 clips, and the weight transfer spreads across 17 distinct bones rather
 * than collapsing onto one. Build takes ~2.8s.
 *
 * What does not: the scale/placement fit. Matching the skin's bounding box to
 * the donor's is wrong, because the donor's box is not the donor's BODY - this
 * donor carries a chainsaw and 44 bones that reach well outside the silhouette,
 * so the box is far larger than the character. The result is a tubby roughly
 * 1.5x too big, floating above its own feet.
 *
 * The fix is to stop using bounding boxes for this at all. Match by landmarks
 * instead: find the hip and head bones in the donor skeleton (Bip01_Pelvis and
 * the head chain are both named clearly), take their world positions in the
 * bind pose, and scale the skin so its own hip-to-head distance matches. That
 * is invariant to props, stray bones and whatever else the rip dragged along,
 * which a bounding box is not.
 */

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

export async function buildRiggedTubbies(donorUrl, skins) {
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
  const donorPts = [];
  const donorSrc = [];       // which mesh + vertex each world point came from
  const v = new THREE.Vector3();
  for (const m of donorMeshes) {
    const pos = m.geometry.attributes.position;
    if (!m.geometry.attributes.skinIndex) continue;
    for (let i = 0; i < pos.count; i++) {
      // Where this vertex actually ENDS UP once skinning runs. Raw geometry
      // coordinates are in bind space and can sit nowhere near the character.
      m.getVertexPosition(i, v);
      v.applyMatrix4(m.matrixWorld);
      donorPts.push(v.x, v.y, v.z);
      donorSrc.push(m, i);
    }
  }
  const donorPos = new THREE.BufferAttribute(new Float32Array(donorPts), 3);

  const donorBox = new THREE.Box3();
  for (let i = 0; i < donorPos.count; i++) {
    donorBox.expandByPoint(v.set(donorPos.getX(i), donorPos.getY(i), donorPos.getZ(i)));
  }
  const size = new THREE.Vector3();
  donorBox.getSize(size);
  const grid = new VertexGrid(donorPos, Math.max(size.length() / 28, 1e-5));

  // Anchor every new mesh to the same node and bind as the donor's own body, so
  // nothing about the binding has to be re-derived.
  const anchor = donorMeshes.reduce((a, b) =>
    a.geometry.attributes.position.count > b.geometry.attributes.position.count ? a : b);
  const toLocal = anchor.matrixWorld.clone().invert();

  const root = new THREE.Group();
  root.add(donor.scene);
  for (const m of donorMeshes) m.visible = false;   // the donor itself stays hidden

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
      const upright = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
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
      for (let i = 0; i < n; i++) {
        const hit = grid.nearest(p.getX(i), p.getY(i), p.getZ(i));
        const srcMesh = donorSrc[hit * 2];
        const srcIdx = donorSrc[hit * 2 + 1];
        const sj = srcMesh.geometry.attributes.skinIndex;
        const sw = srcMesh.geometry.attributes.skinWeight;
        ji[i * 4] = sj.getX(srcIdx); ji[i * 4 + 1] = sj.getY(srcIdx);
        ji[i * 4 + 2] = sj.getZ(srcIdx); ji[i * 4 + 3] = sj.getW(srcIdx);
        jw[i * 4] = sw.getX(srcIdx); jw[i * 4 + 1] = sw.getY(srcIdx);
        jw[i * 4 + 2] = sw.getZ(srcIdx); jw[i * 4 + 3] = sw.getW(srcIdx);
      }
      g.setAttribute("skinIndex", new THREE.BufferAttribute(ji, 4));
      g.setAttribute("skinWeight", new THREE.BufferAttribute(jw, 4));

      // Back into the anchor's own space, which is what its bind matrix expects.
      g.applyMatrix4(toLocal);

      const mat = part.material?.clone?.() ?? new THREE.MeshStandardMaterial();
      const mesh = new THREE.SkinnedMesh(g, mat);
      mesh.name = `tubby_${kind}_${meshes.length}`;
      anchor.parent.add(mesh);
      mesh.bind(anchor.skeleton, anchor.bindMatrix);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.visible = false;
      meshes.push(mesh);
    }
    byKind[kind] = meshes;
    console.info(`[rig] ${kind}: ${meshes.length} mesh(es) bound`);
  }

  return { root, animations: donor.animations, byKind, skeleton: anchor.skeleton };
}
