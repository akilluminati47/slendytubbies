import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as skinnedClone } from "three/addons/utils/SkeletonUtils.js";
import { CFG } from "../game/config.js";
import { buildRiggedTubbies } from "./rigBuilder.js";

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

const _v = new THREE.Vector3();
// The toe joint sits inside the foot, not on its sole.
const FOOT_SINK = 0.04;

export const TUBBIES = {
  tinkywinky: { color: 0x6b3fa0, aerial: "triangle" },
  dipsy:      { color: 0x2f8f3f, aerial: "rod" },
  laalaa:     { color: 0xd9b528, aerial: "curl" },
  po:         { color: 0xb02b2b, aerial: "circle" },
  guardian:   { color: 0xd8d8d0, aerial: "rod" },
};

let gltfCache = null;

/**
 * Build the rigged set once, in the browser.
 *
 * There is no Blender step: rigBuilder binds the clean template meshes to the
 * donor's own skeleton at load time, reusing the donor's bind matrix and
 * inverse binds verbatim. See the note at the top of rigBuilder.js for why the
 * offline bake was abandoned.
 */
export async function loadTubbyAssets(base = "./assets/game/rig") {
  if (gltfCache !== null) return gltfCache;
  if (!CFG.tubby.useBakedRig) {
    console.info("[tubbies] rigged models disabled (CFG.tubby.useBakedRig) - " +
      "using procedural stand-ins");
    gltfCache = false;
    return gltfCache;
  }
  try {
    const t0 = performance.now();
    const skins = {};
    for (const kind of Object.keys(TUBBIES)) {
      skins[kind] = `${base}/skin/${kind}/scene.gltf`;
    }
    const rig = await buildRiggedTubbies(`${base}/donor/dipsy/scene.gltf`, skins);

    const bad = validateRig(rig);
    if (bad) {
      console.error(`[tubbies] rig failed validation: ${bad}. Using stand-ins.`);
      gltfCache = false;
      return gltfCache;
    }

    // Normalise against the drawn character, measured by the builder. The
    // skeleton's own extent is the wrong ruler - it includes the donor's
    // chainsaw and camera bones.
    rig.scale = CFG.tubby.height / rig.measured.height;
    rig.feet = rig.measured.feet;

    gltfCache = rig;
    console.info(`[tubbies] rigged set built in ${(performance.now() - t0) | 0}ms - ` +
      `${rig.animations.length} clips, ${Object.keys(rig.byKind).length} characters, ` +
      `scaled by ${rig.scale.toFixed(4)} to ${CFG.tubby.height}m`);
  } catch (err) {
    console.warn("[tubbies] could not build the rigged set, using stand-ins:", err.message);
    gltfCache = false;
  }
  return gltfCache;
}

/**
 * A rig can be structurally perfect and still render nowhere, so check the one
 * thing that actually matters: does a skinned vertex land on its own skeleton?
 */
function validateRig(rig) {
  const kinds = Object.keys(rig.byKind);
  if (!kinds.length) return "no characters were bound";
  if (!rig.animations?.length) return "no animation clips";

  const mesh = rig.byKind[kinds[0]][0];
  if (!mesh) return "character has no meshes";
  rig.root.updateMatrixWorld(true);

  const box = new THREE.Box3();
  for (const b of rig.skeleton.bones) box.expandByPoint(b.getWorldPosition(new THREE.Vector3()));
  const span = Math.max(box.max.distanceTo(box.min), 1e-3);

  const pos = mesh.geometry.attributes.position;
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  const v = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(mesh.bindMatrix);
  const acc = new THREE.Vector3();
  const tmp = new THREE.Matrix4();
  for (let i = 0; i < 4; i++) {
    const w = [sw.getX(0), sw.getY(0), sw.getZ(0), sw.getW(0)][i];
    if (w <= 0) continue;
    const idx = [si.getX(0), si.getY(0), si.getZ(0), si.getW(0)][i];
    const bone = rig.skeleton.bones[idx];
    if (!bone) return `skin index ${idx} out of range`;
    tmp.multiplyMatrices(bone.matrixWorld, rig.skeleton.boneInverses[idx]);
    acc.add(v.clone().applyMatrix4(tmp).multiplyScalar(w));
  }
  acc.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);

  const dist = box.distanceToPoint(acc);
  if (dist > span * 0.25) {
    return `a skinned vertex sits ${dist.toFixed(2)} from a skeleton only ` +
      `${span.toFixed(2)} across`;
  }
  return null;
}

export function makeTubby(kind) {
  const spec = TUBBIES[kind] ?? TUBBIES.tinkywinky;
  return gltfCache ? new RiggedTubby(gltfCache, kind, spec) : new ProcTubby(spec);
}

/* ------------------------------------------------------------------ real ---- */

class RiggedTubby {
  constructor(rig, kind, spec) {
    // An independent copy per tubby: two on screen must not share a skeleton,
    // or they animate in lockstep and stand in the same place.
    this.root = new THREE.Group();
    const inner = skinnedClone(rig.root);
    inner.scale.setScalar(rig.scale);
    inner.position.y = -rig.feet * rig.scale;
    this.root.add(inner);
    this.inner = inner;

    // These rips have root motion baked into the clips, so a fixed offset that
    // stands the bind pose on the ground leaves an idling tubby hovering a
    // metre up. Track the actual foot bones instead and plant them every frame.
    this.footBones = [];
    inner.traverse((o) => {
      if (o.isBone && /Bip01_[LR]_(Toe0|Foot)/i.test(o.name)) this.footBones.push(o);
    });

    const mine = `tubby_${kind}_`;
    let shown = 0;
    inner.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.visible = o.name.startsWith(mine);
      o.castShadow = o.visible;
      // three.js derives a SkinnedMesh's bounding sphere from its unskinned
      // geometry, which culls a character standing right in front of you.
      o.frustumCulled = false;
      if (o.visible) shown++;
    });
    if (!shown) console.warn(`[tubbies] nothing named ${mine}* in the rig`);

    this.mixer = new THREE.AnimationMixer(inner);
    this.clips = rig.animations;
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
    flee:        ["run_main", "run1", "_run", "run"],
    attack:      ["attack1", "attack"],
    death:       ["_death", "death", "ragdoll"],
    spawn:       ["spawn1", "spawn"],
  };

  #candidates(name) {
    const keys = RiggedTubby.ALIASES[name] ?? [name];
    for (const key of keys) {
      // Match on the part after "|" so the skeleton name cannot produce a false
      // positive - this donor's skeleton is literally called "..._dipsy_...".
      const hits = this.clips.filter((c) => c.name.split("|").pop().toLowerCase().includes(key));
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
    this.#plantFeet();
  }

  /**
   * Put the lowest foot bone on the root's own height, whatever the clip is
   * doing. Two bone lookups per frame, and it means every animation lands on
   * the ground instead of only the one the offset was measured from.
   */
  #plantFeet() {
    if (!this.footBones.length) return;
    this.inner.position.y = 0;
    this.inner.updateMatrixWorld(true);
    let lowest = Infinity;
    for (const b of this.footBones) {
      lowest = Math.min(lowest, b.getWorldPosition(_v).y);
    }
    if (!Number.isFinite(lowest)) return;
    // A little sink so the sole meets the ground rather than the joint centre.
    this.inner.position.y = this.root.position.y - lowest - FOOT_SINK;
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
