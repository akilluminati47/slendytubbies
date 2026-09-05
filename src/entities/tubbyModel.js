import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as skinnedClone } from "three/addons/utils/SkeletonUtils.js";
import { CFG } from "../game/config.js";

/**
 * Two ways to get a tubby:
 *
 *   1. assets/game/tubbies.glb exists  ->  real meshes on a real skeleton, real clips.
 *      Built by tools/rig_transfer.py: un_rendem123's clean template meshes bound to a
 *      donor ST3 armature, every donor clip baked in, all five tubbies sharing one armature.
 *
 *   2. it does not exist yet  ->  procedural stand-ins with the same silhouette,
 *      proportions and colours, animated by hand below. The game is fully playable
 *      on these, so nothing is blocked on the asset download.
 *
 * Both expose the same interface: { root, play(name), update(dt, speed) }.
 */


/**
 * The real Slendytubbies face, lifted straight off the ripped NPC texture
 * (Rodolfoisreal1423's TinkyWinkyNPC) rather than approximated with geometry.
 *
 * The source texture paints the face onto a flat purple field with no alpha, so
 * we key the purple out into a canvas and use that as a transparent decal on the
 * front of the head. Chroma-keying is crude in general, but here the background
 * is a single flat colour and the face is desaturated bone-white, so a plain
 * saturation test separates them cleanly with no halo.
 */
const FACE_URL = "./assets/game/face_tinkywinky.png";
let facePromise = null;

export function loadFaceTexture() {
  if (facePromise) return facePromise;
  facePromise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height);
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        // Background is strongly purple: blue and red high, green low.
        const purple = b > 90 && r > 70 && g < r * 0.62 && g < b * 0.62;
        if (purple) d[i + 3] = 0;
      }
      ctx.putImageData(px, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      resolve(tex);
    };
    img.onerror = () => {
      console.warn("[tubbies] face texture missing - falling back to drawn eyes");
      resolve(null);
    };
    img.src = FACE_URL;
  });
  return facePromise;
}

export const TUBBIES = {
  tinkywinky: { color: 0x6b3fa0, aerial: "triangle" },
  dipsy:      { color: 0x2f8f3f, aerial: "rod" },
  laalaa:     { color: 0xd9b528, aerial: "curl" },
  po:         { color: 0xb02b2b, aerial: "circle" },
  guardian:   { color: 0xd8d8d0, aerial: "rod" },
};

let gltfCache = null;

/**
 * glTF 2.0, "Skins": the transform of a node with a skin "MUST be ignored" -
 * skinned vertices are positioned entirely by the joints and the inverse bind
 * matrices. Exporters therefore feel free to leave junk on those nodes, and
 * Blender in particular leaves the Sketchfab wrapper transform behind on the
 * first mesh of each imported hierarchy.
 *
 * three.js does NOT ignore it: GLTFLoader folds the node's world matrix into
 * bindMatrix, so that junk drags the mesh away from its own skeleton - ours
 * landed 70 m down the z axis with perfect bones and perfect weights.
 *
 * So implement the spec ourselves: lift every skinned mesh to the scene root and
 * rebind with an identity bind matrix, which drops the entire wrapper chain
 * rather than just the mesh's own node. Doing this at load makes the game robust
 * to whatever a given rip's exporter emitted, which matters more here than any
 * one asset being clean.
 */
function flattenSkinnedNodes(scene) {
  scene.updateMatrixWorld(true);
  const skinned = [];
  scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });

  for (const m of skinned) {
    // Reparent to the scene root. It is not enough to zero the mesh's own
    // transform: the wrapper nodes ABOVE it still contribute to matrixWorld, and
    // matrixWorld is the last thing applied to a skinned vertex. Moving the mesh
    // to the root removes that whole chain in one step.
    if (m.parent !== scene) scene.add(m);
    m.position.set(0, 0, 0);
    m.quaternion.identity();
    m.scale.set(1, 1, 1);
    m.updateMatrix();

    // With bindMatrix identity and the mesh at the root, the skinning reduces to
    //   world = rootMatrix * sum(w * bone.matrixWorld * boneInverse) * v
    // which is exactly what the inverse bind matrices already encode. The bones
    // keep their own transforms and are left completely alone.
    m.bind(m.skeleton, new THREE.Matrix4());
    m.frustumCulled = false;
  }

  scene.updateMatrixWorld(true);
  if (skinned.length) {
    console.info(`[tubbies] reparented ${skinned.length} skinned mesh(es) to the ` +
      `scene root and rebound with an identity bind matrix (glTF ignores skinned ` +
      `node transforms; three.js does not)`);
  }
}

/**
 * A skinned glTF can be structurally valid and still render nowhere. The usual
 * cause is a non-identity transform on the skinned mesh node: glTF says that
 * transform must be ignored, three.js folds it into bindMatrix instead, and the
 * two disagree. Catch it at load rather than shipping an invisible monster.
 */
function validateRig(gltf) {
  const skinned = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) return "no skinned meshes";
  if (!gltf.animations?.length) return "no animation clips";

  // Where does a vertex actually end up? Reproduce the skinning transform for
  // one vertex and check it lands near its own skeleton rather than 70 m away.
  const m = skinned[0];
  const sk = m.skeleton;
  if (!sk?.bones?.length) return "no skeleton";
  if (sk.bones.length !== sk.boneInverses.length) return "bone/inverse count mismatch";

  const pos = m.geometry.attributes.position;
  const si = m.geometry.attributes.skinIndex;
  const sw = m.geometry.attributes.skinWeight;
  if (!pos || !si || !sw) return "missing skinning attributes";

  const v = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(m.bindMatrix);
  const acc = new THREE.Vector3();
  const tmp = new THREE.Matrix4();
  const idx = [si.getX(0), si.getY(0), si.getZ(0), si.getW(0)];
  const wts = [sw.getX(0), sw.getY(0), sw.getZ(0), sw.getW(0)];
  for (let i = 0; i < 4; i++) {
    if (wts[i] <= 0) continue;
    const bone = sk.bones[idx[i]];
    if (!bone) return `skin index ${idx[i]} out of range`;
    tmp.multiplyMatrices(bone.matrixWorld, sk.boneInverses[idx[i]]);
    acc.add(v.clone().applyMatrix4(tmp).multiplyScalar(wts[i]));
  }
  acc.applyMatrix4(m.bindMatrixInverse).applyMatrix4(m.matrixWorld);

  // Compare against the skeleton's own extent - the vertex must live inside it.
  const box = new THREE.Box3();
  for (const b of sk.bones) box.expandByPoint(b.getWorldPosition(new THREE.Vector3()));
  const span = Math.max(box.max.distanceTo(box.min), 1e-3);
  const dist = box.distanceToPoint(acc);
  // A correctly bound vertex sits ON the skeleton, so anything beyond a small
  // fraction of the rig's own size is a broken bind, not slack. Being strict
  // here is the whole point: a loose threshold passes a rig that renders
  // nothing, and an invisible enemy is far worse than a stand-in one.
  if (dist > span * 0.25) {
    return `skinned vertex sits ${dist.toFixed(2)} from a skeleton only ` +
      `${span.toFixed(2)} across - node transforms are not flattened`;
  }
  return null;
}

/** Try once for the baked GLB; cache the failure so we do not retry per spawn. */
export async function loadTubbyAssets(url = "./assets/game/tubbies.glb") {
  if (gltfCache !== null) return gltfCache;
  if (!CFG.tubby.useBakedRig) {
    console.info("[tubbies] baked rig disabled (CFG.tubby.useBakedRig) - " +
      "using procedural stand-ins");
    gltfCache = false;
    return gltfCache;
  }
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    flattenSkinnedNodes(gltf.scene);
    const bad = validateRig(gltf);
    if (bad) {
      // A rig that binds wrong renders *nothing* while reporting healthy bones,
      // healthy weights and a healthy draw call - so an invisible enemy would
      // ship silently. Refuse it and fall back to the stand-ins instead.
      console.error(`[tubbies] ${url} failed validation: ${bad}. Using stand-ins. ` +
        `Re-run tools/rig_transfer.py.`);
      gltfCache = false;
      return gltfCache;
    }
    // rig_transfer.py exports at the donor's native scale on purpose and records
    // the real dimensions here; see the note at the top of that script.
    gltf.userData.fit = await fetch(url.replace(/\.glb$/, ".json"))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    gltfCache = gltf;
    console.info(`[tubbies] baked GLB loaded - ${gltf.animations.length} clips, ` +
      `native height ${gltf.userData.fit?.nativeHeight ?? "?"}`);
  } catch {
    gltfCache = false;
    console.info("[tubbies] no assets/game/tubbies.glb - using procedural stand-ins. " +
      "Run tools/fetch_sketchfab.py then tools/rig_transfer.py to swap in the real models.");
  }
  return gltfCache;
}

export function makeTubby(kind) {
  const spec = TUBBIES[kind] ?? TUBBIES.tinkywinky;
  return gltfCache ? new RiggedTubby(gltfCache, kind, spec) : new ProcTubby(spec);
}

/* ------------------------------------------------------------------ real ---- */

class RiggedTubby {
  constructor(gltf, kind, spec) {
    // Scale the whole cloned root uniformly. This is the only safe place to
    // resize a skinned rig: bones and bind matrices scale together, whereas
    // touching the armature alone breaks skinning (see tools/rig_transfer.py).
    this.root = new THREE.Group();
    const inner = skinnedClone(gltf.scene);
    this.root.add(inner);

    const fit = gltf.userData.fit;
    if (fit?.nativeHeight > 0) {
      const k = CFG.tubby.height / fit.nativeHeight;
      inner.scale.setScalar(k);
      // No y offset: the donor rig is authored with its feet on the origin and
      // the glTF wrapper node preserves that, so the root already stands on the
      // ground. (fit.feet is Blender world-space and is informational only.)
    }

    // rig_transfer.py names every part tubby_<kind>_<n>. A character is several
    // meshes (body, eyes, eyelids, aerial), so match on the prefix and show the
    // whole set; every other character rides the same armature, hidden.
    const mine = `tubby_${kind}_`;
    let shown = 0;
    inner.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.visible = o.name.startsWith(mine);
      o.castShadow = o.visible;
      // three.js derives a SkinnedMesh's bounding sphere from its *unskinned*
      // geometry, which for a rig scaled at the armature is far too small - the
      // mesh then gets culled while standing right in front of the camera.
      // These are 1.7 m characters in a 46 m fog, so per-mesh culling buys
      // nothing anyway.
      o.frustumCulled = false;
      if (o.visible) shown++;
    });
    if (!shown) console.warn(`[tubbies] no meshes named ${mine}* in the GLB`);

    this.mixer = new THREE.AnimationMixer(this.root);
    this.clips = gltf.animations;
    this.current = null;
    this.spec = spec;
    this.variant = Math.random();
    this.play("idle");
  }

  /**
   * Donor rigs name clips whatever the original ripper felt like - here it is
   * "<skeleton>|dipsy_run_main". So each game state maps to an ordered list of
   * candidate substrings, best first, and we take the first that hits.
   */
  static ALIASES = {
    idle:        ["idle1", "_idle", "idle"],
    walk:        ["walk_main", "walk1", "_walk", "walk"],
    investigate: ["walk_main", "walk1", "_walk", "walk"],
    chase:       ["run_main", "run1", "_run", "run", "walk_main"],
    attack:      ["attack1", "attack"],
    death:       ["_death", "death", "ragdoll"],
    spawn:       ["spawn1", "spawn"],
  };

  #candidates(name) {
    const keys = RiggedTubby.ALIASES[name] ?? [name];
    for (const key of keys) {
      // Match on the part after "|" so the skeleton name cannot produce a
      // false positive (this donor's skeleton is literally called "..._dipsy_...").
      const hits = this.clips.filter((c) => {
        const tail = c.name.split("|").pop().toLowerCase();
        return tail.includes(key);
      });
      if (hits.length) return hits;
    }
    return [];
  }

  play(name, fade = 0.25) {
    if (this.currentName === name) return;
    const hits = this.#candidates(name);
    if (!hits.length) return;
    // 56 clips is a gift: pick a variant per tubby so two on screen at once are
    // not lockstep copies of each other.
    const clip = hits[Math.floor(this.variant * hits.length) % hits.length];
    const next = this.mixer.clipAction(clip).reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = next;
    this.currentName = name;
  }

  update(dt, speed = 0) {
    // Scale playback to ground speed so the feet do not skate.
    this.mixer.timeScale = this.currentName === "idle" ? 1 : Math.max(0.6, speed / 2.4);
    this.mixer.update(dt);
  }
}

/* ------------------------------------------------------- procedural stand-in -- */

class ProcTubby {
  constructor(spec) {
    const skin = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14100d, roughness: 1 });

    // root is owned by Tubby (world position); everything visual hangs off `rig`
    // so the walk bounce cannot overwrite the terrain height set by the AI.
    this.root = new THREE.Group();
    this.rig = new THREE.Group();
    this.root.add(this.rig);

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.62, 6, 14), skin);
    body.position.y = 1.02;
    this.rig.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.33, 20, 16), skin);
    head.position.y = 1.72;
    this.head = head;
    this.rig.add(head);

    // The real ripped face, as a slightly curved decal across the front of the
    // head. Falls back to drawn eyes if the texture is not on disk.
    // A plane, not a sphere patch: a partial sphere's UVs only cover the slice of
    // texture space that slice of sphere occupies, so the face never appears.
    const faceGeo = new THREE.PlaneGeometry(0.5, 0.5);
    const faceMat = new THREE.MeshStandardMaterial({
      transparent: true, roughness: 0.75, depthWrite: false,
      color: 0xffffff, emissive: 0x2b2620, emissiveIntensity: 0.35,
    });
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.position.set(0, -0.01, 0.305);   // just proud of the 0.33 head sphere
    face.renderOrder = 2;
    face.visible = false;
    head.add(face);
    loadFaceTexture().then((tex) => {
      if (!tex) { fallbackEyes(head, dark); return; }
      faceMat.map = tex;
      faceMat.needsUpdate = true;
      face.visible = true;
    });

    head.add(makeAerial(spec.aerial, dark));

    // Belly screen.
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.26, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x0b0b0b, emissive: 0x101a10, roughness: 0.3 }));
    screen.position.set(0, 1.0, 0.42);
    this.rig.add(screen);

    this.limbs = [];
    const armGeo = new THREE.CapsuleGeometry(0.1, 0.42, 4, 8);
    const legGeo = new THREE.CapsuleGeometry(0.13, 0.38, 4, 8);
    for (const sx of [-1, 1]) {
      const arm = new THREE.Group();
      const am = new THREE.Mesh(armGeo, skin);
      am.position.y = -0.26;
      arm.add(am);
      arm.position.set(sx * 0.46, 1.32, 0);
      this.rig.add(arm);

      const leg = new THREE.Group();
      const lm = new THREE.Mesh(legGeo, skin);
      lm.position.y = -0.24;
      leg.add(lm);
      leg.position.set(sx * 0.19, 0.6, 0);
      this.rig.add(leg);

      this.limbs.push({ arm, leg, phase: sx > 0 ? 0 : Math.PI });
    }

    this.t = 0;
    this.state = "idle";
  }

  play(name) { this.state = name; }

  update(dt, speed = 0) {
    this.t += dt;
    const stride = this.state === "chase" ? 9 : 4.2;
    const amp = Math.min(1, speed / 3) * (this.state === "chase" ? 1.15 : 0.75);
    for (const l of this.limbs) {
      const s = Math.sin(this.t * stride + l.phase) * amp;
      l.leg.rotation.x = s * 0.85;
      // Arms out in front while chasing - reads as a lunge from a long way off.
      l.arm.rotation.x = this.state === "chase" ? -1.5 + s * 0.35 : -s * 0.7;
    }
    this.rig.position.y = Math.abs(Math.sin(this.t * stride)) * 0.05 * amp;
    this.head.rotation.z = Math.sin(this.t * 1.3) * 0.05;
  }
}

/** Used only if the ripped face texture cannot be loaded. */
function fallbackEyes(head, dark) {
  const eyeGeo = new THREE.SphereGeometry(0.075, 12, 10);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xf6f4ee, emissive: 0x605c50, emissiveIntensity: 0.5, roughness: 0.4,
  });
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.set(sx * 0.13, 0.05, 0.28);
    head.add(e);
  }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), dark);
  mouth.scale.set(1, 0.7, 0.5);
  mouth.position.set(0, -0.12, 0.29);
  head.add(mouth);
}

function makeAerial(kind, mat) {
  const g = new THREE.Group();
  g.position.y = 0.33;
  const stalk = (h) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, h, 6), mat);
    m.position.y = h / 2;
    return m;
  };
  if (kind === "rod") {
    g.add(stalk(0.5));
  } else if (kind === "circle") {
    g.add(stalk(0.3));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.022, 6, 16), mat);
    ring.position.y = 0.43;
    g.add(ring);
  } else if (kind === "triangle") {
    const tri = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.024, 3, 3), mat);
    tri.position.y = 0.32;
    tri.rotation.z = Math.PI / 2;
    g.add(stalk(0.2), tri);
  } else { // curl
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.02, 0.22, 0),
      new THREE.Vector3(0.14, 0.36, 0.05), new THREE.Vector3(0.02, 0.46, -0.04),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.024, 6), mat));
  }
  return g;
}
