import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as skinnedClone } from "three/addons/utils/SkeletonUtils.js";
import { CFG } from "../game/config.js";
import { buildTubbyRigs, bakeClips } from "./tubbyRig.js";

/**
 * Two ways to get a tubby:
 *
 *   1. the rigged models load  ->  the real ripped meshes on their own skeletons,
 *      wearing donor clips retargeted onto them at load time. See tubbyRig.js.
 *
 *   2. anything goes wrong, or CFG.tubby.useBakedRig is off  ->  procedural
 *      stand-ins with the same silhouette, proportions and colours, animated by
 *      hand below. The game is fully playable on these, so a missing or broken
 *      asset costs fidelity and nothing else.
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
// Resolved against this module, not against whatever page imported it. The
// page-relative form worked from index.html and 404ed from tools/rigcheck.html,
// which then quietly fell back to the procedural stand-ins - so the bench was
// showing something other than the game while claiming to show the game.
const FACE_URL = new URL("../../assets/game/face_tinkywinky.png", import.meta.url).href;
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
// A hair of sink so the sole meets the ground rather than hovering on it.
const FOOT_SINK = 0.01;

export const TUBBIES = {
  tinkywinky: { color: 0x6b3fa0, aerial: "triangle" },
  dipsy:      { color: 0x2f8f3f, aerial: "rod" },
  laalaa:     { color: 0xd9b528, aerial: "curl" },
  po:         { color: 0xb02b2b, aerial: "circle" },
  guardian:   { color: 0xd8d8d0, aerial: "rod" },
};

let rigCache = null;

/**
 * Which donor clip stands in for each game state, best candidate first.
 *
 * Both donors are matched against the same table. The rippers named their clips
 * however they felt like - "dipsy_run_main" on the biped, "TINKY_RUNNING_ARMED"
 * on the Rigify one - so the Tinky Winky names lead, being specific enough that
 * they cannot collide with anything in the other donor's 56.
 */
const CLIP_FOR = {
  // IDLE_POSE, not IDLE_LOOKAROUND: the lookaround leaves the chaser's head
  // cranked to one side at t=0, so it stood in the menu parade facing sideways.
  idle:        ["idle_pose", "idle1", "_idle", "idle"],
  walk:        ["tinky_walking", "walk_main", "walk1", "_walk", "walk"],
  investigate: ["tinky_walking", "walk_main", "walk1", "_walk", "walk"],
  chase:       ["tinky_running_armed", "run_main", "run1", "_run", "run"],
  flee:        ["tinky_running_armed", "run_main", "run1", "_run", "run"],
  attack:      ["axe_hit1", "axe_hit", "attack1", "attack"],
  death:       ["_death", "death", "ragdoll", "trap_caught_left"],
  spawn:       ["teleport_forward", "spawn1", "spawn"],
};

function pickClip(clips, keys) {
  for (const key of keys) {
    // Match on the part after "|": this donor's skeleton is literally called
    // "..._dipsy_chainsaw_ref_skeleton", which would false-positive on anything.
    const hit = clips.find((c) => c.name.split("|").pop().toLowerCase().includes(key));
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve every game state to a donor clip, then bake the distinct set once.
 *
 * Baking costs about 5ms a second of clip, so this deliberately bakes the eight
 * the game asks for rather than all 56 - and it bakes each clip once even when
 * three states share it, which walk, investigate and the two run states do.
 */
function bakeStates(character, rig, height) {
  const wanted = new Map();
  const forState = {};
  for (const [state, keys] of Object.entries(CLIP_FOR)) {
    const clip = pickClip(rig.donor.animations, keys);
    if (!clip) continue;
    forState[state] = clip.name;
    wanted.set(clip.name, clip);
  }

  const baked = bakeClips(character, rig, [...wanted.values()], height);
  const byName = new Map(baked.map((c) => [c.name, c]));
  character.byState = new Map(
    Object.entries(forState)
      .map(([state, name]) => [state, byName.get(name)])
      .filter(([, clip]) => clip));
  return character;
}

/** The set of bones each vertex of a mesh leans on most. */
function dominantBones(mesh) {
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  const out = new Set();
  if (!si || !sw) return out;
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    let best = -1, bestW = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bestW) { bestW = w; best = si.getComponent(i, k); }
    }
    if (best >= 0) out.add(best);
  }
  return out;
}

/**
 * Bounding box of the pixels a predicate accepts, or null if it accepts none.
 */
function contentBox(data, w, h, accept) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!accept(data[i], data[i + 1], data[i + 2], data[i + 3])) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Derive a normal map for the chaser's mask from the mask itself.
 *
 * The face arrives as a flat photograph and gets painted onto the tubby's own
 * head, which is a smooth infant sphere. Lit like that it reads as a sticker:
 * the brow, the hollow sockets and the open jaw are all drawn, and none of them
 * catch the light, so the shading fights the picture. The mask needs relief of
 * its own, and the picture already contains it - on a bone-white face the bright
 * parts are what stands proud (cheekbones, brow, the bridge of the nose) and the
 * dark parts are what falls away (the sockets, the mouth).
 *
 * So read luminance as a height field and take its slope. Blurred first, or the
 * texture's own grain turns into a rash of bumps.
 *
 * Only the face gets relief. The same sheet carries the belly TV and the trim
 * around it, which are flat and must stay flat, so everything outside `box` is
 * written as the neutral normal.
 */
function maskNormalMap(source, box, strength = 2.6) {
  const w = source.width, h = source.height;
  const read = source.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, w, h).data;

  // Luminance, box-blurred by one pixel each way.
  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const i = (yy * w + xx) * 4;
          sum += (read[i] * 0.299 + read[i + 1] * 0.587 + read[i + 2] * 0.114) / 255;
          n++;
        }
      }
      height[y * w + x] = sum / n;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(w, h);
  const at = (x, y) => height[Math.min(h - 1, Math.max(0, y)) * w +
    Math.min(w - 1, Math.max(0, x))];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = !box || (x >= box.x && x < box.x + box.w &&
        y >= box.y && y < box.y + box.h);
      if (!inside) {
        out.data[i] = 128; out.data[i + 1] = 128; out.data[i + 2] = 255; out.data[i + 3] = 255;
        continue;
      }
      // Sobel, which is a slope estimate that survives a low-resolution source.
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      out.data[i] = (nx * 0.5 + 0.5) * 255;
      out.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      out.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/**
 * Put something solid in the eye sockets.
 *
 * The sockets are holes cut clean through the head, so nothing painted on the
 * texture can ever cover them - on the chaser they showed as two purple
 * hexagons straight through the mask. Whatever fills them has to be geometry.
 *
 * They ride on the head bone, in its own frame, so they follow every clip for
 * free and survive being cloned with the rest of the rig.
 */
function fillSockets(character, { sclera, pupil, bulge = 1.15 }) {
  if (!character.sockets?.length || !character.head) return 0;
  let n = 0;
  for (const socket of character.sockets) {
    const r = socket.radius * bulge;
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(r, 14, 12),
      new THREE.MeshStandardMaterial({ color: sclera, roughness: 0.42 }));
    eye.position.copy(socket.local);
    eye.frustumCulled = false;
    character.head.add(eye);
    n++;

    if (pupil === undefined) continue;
    const iris = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.52, 12, 10),
      new THREE.MeshStandardMaterial({ color: pupil, roughness: 0.3 }));
    // Out of the face, not away from the joint: the head bone sits at the crown,
    // so its radial direction runs down the cheek instead of forwards.
    iris.position.copy(socket.local)
      .addScaledVector(socket.forward ?? new THREE.Vector3(0, 0, 1), r * 0.62);
    iris.frustumCulled = false;
    character.head.add(iris);
  }
  return n;
}

/**
 * Build the chaser a mask, as an actual object worn over its face.
 *
 * Painting the rip's face onto the tubby's own head never worked and could not:
 * that head is a baby's, with a snout, a brow and a small mouth slot moulded
 * into it, and two eye sockets cut clean through the shell in places that have
 * nothing to do with where the mask's eyes are drawn. The result had two sets of
 * eyes - the mask's, painted, and the holes lower down - and a nose ridge
 * running through the middle of somebody else's face.
 *
 * So the mask stops being a texture on that head and becomes a smooth shell of
 * its own, curved to sit on the skull and carrying the rip's face and nothing
 * else. It covers the sockets, so the holes stop showing, and its relief comes
 * from a normal map derived from the face rather than from the head underneath.
 *
 * The shell is a plane bent onto the head's own sphere, which keeps the texture
 * coordinates trivial - a plane already has the UVs we want, and a spherical cap
 * does not.
 */
function buildMaskPlate(character, { face, normalMap }) {
  const skeleton = character.target.skeleton;
  const head = character.head;
  if (!head || !character.sockets?.length) return null;

  const body = character.meshes.reduce((a, b) =>
    b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a);
  const headIndex = skeleton.bones.indexOf(head);
  character.scene.updateMatrixWorld(true);

  // --- the skull the mask has to sit on ------------------------------------
  const v = new THREE.Vector3();
  const box = new THREE.Box3();
  const si = body.geometry.attributes.skinIndex;
  const sw = body.geometry.attributes.skinWeight;
  for (let i = 0; i < body.geometry.attributes.position.count; i++) {
    let best = -1, bestW = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bestW) { bestW = w; best = si.getComponent(i, k); }
    }
    if (best !== headIndex) continue;
    body.getVertexPosition(i, v);
    box.expandByPoint(v.applyMatrix4(body.matrixWorld));
  }
  if (box.isEmpty()) return null;
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y) * 0.5;

  // --- where the face points, and how wide it is ---------------------------
  const mid = new THREE.Vector3();
  for (const s of character.sockets) mid.add(s.local);
  mid.divideScalar(character.sockets.length);
  head.localToWorld(mid);

  const forward = character.sockets[0].forward.clone()
    .transformDirection(head.matrixWorld).normalize();
  // A mask spans a good deal wider than the gap between the eyes.
  const gap = character.sockets.length > 1
    ? head.localToWorld(character.sockets[0].local.clone())
        .distanceTo(head.localToWorld(character.sockets[1].local.clone()))
    : radius;
  // Wide enough to bury the sockets and the snout, no wider: bent onto a sphere,
  // a plate much past the head's own radius wraps round towards the ears.
  const width = Math.max(gap * 2.3, radius * 1.3);
  const height = width * 1.16;

  // --- a plane, bent onto that sphere --------------------------------------
  const SEG = 20;
  const geo = new THREE.PlaneGeometry(width, height, SEG, SEG);
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
  const up = new THREE.Vector3().crossVectors(forward, right).normalize();
  // Sit the plate on the eye line rather than the middle of the skull, or the
  // mask rides high and the jaw hangs off the bottom of it.
  const pole = new THREE.Vector3().copy(centre)
    .addScaledVector(forward, radius)
    .addScaledVector(up, (mid.y - centre.y) * 0.55);

  const pos = geo.attributes.position;
  const q = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    q.copy(pole)
      .addScaledVector(right, pos.getX(i))
      .addScaledVector(up, pos.getY(i));
    // Out onto the skull, proud enough that the moulded nose underneath cannot
    // poke back through the middle of somebody else's face.
    q.sub(centre).setLength(radius * 1.035).add(centre);
    pos.setXYZ(i, q.x, q.y, q.z);
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: face,
    normalMap,
    normalScale: new THREE.Vector2(1.35, 1.35),
    transparent: true,
    // Cut rather than blend: a blended edge over a head this dark haloes.
    alphaTest: 0.45,
    roughness: 0.62,
    side: THREE.DoubleSide,
  });

  const plate = new THREE.Mesh(geo, mat);
  plate.frustumCulled = false;
  plate.renderOrder = 3;
  // Into the head bone's frame, so it wears the mask through every clip.
  plate.applyMatrix4(new THREE.Matrix4().copy(head.matrixWorld).invert());
  head.add(plate);
  return { width: +width.toFixed(2), radius: +radius.toFixed(2) };
}

/**
 * Give the chaser the face off the TinkyWinkyNPC rip.
 *
 * That rip is the one model in the set with no skeleton at all - 6 meshes, 0
 * skins - so it can never be animated, but its face is the whole reason it was
 * fetched. So the face travels as a texture instead of as geometry: the rigged
 * skin and the rip lay their faces out the same way, centred on the sheet with
 * the mouth above the eyes, they just differ in size and in what surrounds them.
 *
 * Both boxes are found rather than hard-coded, by asking what each sheet's
 * background is: the rip paints its face on flat purple, and the skin paints
 * its on the grey noise of the belly TV, which is the rest of the same sheet and
 * has to survive untouched.
 */
async function wearHorrorFace(character) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error(`${FACE_URL} did not load`));
    i.src = FACE_URL;
  });

  // --- the face, cut off its purple field ---------------------------------
  const cut = document.createElement("canvas");
  cut.width = img.width;
  cut.height = img.height;
  const cutCtx = cut.getContext("2d", { willReadFrequently: true });
  cutCtx.drawImage(img, 0, 0);
  const px = cutCtx.getImageData(0, 0, cut.width, cut.height);
  for (let i = 0; i < px.data.length; i += 4) {
    const r = px.data[i], g = px.data[i + 1], b = px.data[i + 2];
    // Strongly purple: blue and red high, green well below both.
    if (b > 90 && r > 70 && g < r * 0.62 && g < b * 0.62) px.data[i + 3] = 0;
  }
  cutCtx.putImageData(px, 0, 0);

  const box = contentBox(px.data, cut.width, cut.height, (r, g, b, a) => a > 8);
  if (!box) {
    console.warn("[tubbies] no face found on the rip's sheet");
    return false;
  }

  // Trimmed to the face itself, so the plate's own texture coordinates land it
  // squarely without anyone having to know where it sat on the original sheet.
  const mask = document.createElement("canvas");
  mask.width = box.w;
  mask.height = box.h;
  mask.getContext("2d").drawImage(cut, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

  const faceTex = new THREE.CanvasTexture(mask);
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.anisotropy = 4;
  // The rip is drawn mouth-above-eyes, the way the tubby's own sheet is, because
  // the head's UVs turn it over. The plate's UVs do not, and CanvasTexture flips
  // once by default, so leaving flipY on served the mask upside down - a grin
  // across the brow and the sockets down by the jaw.
  faceTex.flipY = false;
  faceTex.needsUpdate = true;

  const normalMap = new THREE.CanvasTexture(maskNormalMap(mask, null));
  normalMap.flipY = false;
  normalMap.needsUpdate = true;

  const plate = buildMaskPlate(character, { face: faceTex, normalMap });
  if (!plate) {
    console.warn("[tubbies] could not fit the mask to the chaser's head");
    return false;
  }

  // The tubby's own eyes go. The mask has its own, painted, and the sockets it
  // covers are holes - anything left in them shows through as a second pair.
  const bones = character.target.skeleton.bones;
  const isEye = (i) => /^eye(lid)?[_ ]/i.test(bones[i]?.name ?? "");
  let hidden = 0;
  for (const m of character.meshes) {
    const driven = dominantBones(m);
    if (!driven.size || ![...driven].every(isEye)) continue;
    m.visible = false;
    hidden++;
  }

  // Small black plugs sit behind the mask, so no light finds its way through
  // the empty sockets from the side.
  fillSockets(character, { sclera: 0x05050a, bulge: 0.85 });

  console.info(`[tubbies] chaser wears a mask plate ${plate.width} across ` +
    `on a head of ${plate.radius}, ${hidden} eye meshes hidden, ` +
    `relief from a generated normal map`);
  return true;
}

/**
 * The belly TV, as an actual television.
 *
 * Every skin ships its screen as a patch of frozen grey speckle baked into the
 * same sheet as the face - a photograph of static, which reads as dirty felt the
 * moment you stand still and look at it. It costs almost nothing to make it
 * move: the screen is a known rectangle in texture space, so a few lines
 * injected into the material's fragment shader can replace whatever the sheet
 * says inside that rectangle with noise that changes every frame.
 *
 * One shared clock drives all five, so a lobby full of tubbies is still one
 * uniform update per frame rather than five.
 *
 * The cells are deliberately chunky. Per-pixel noise on a screen this small
 * shimmers into flat grey the instant it is more than a few metres away, which
 * is exactly the look we are trying to get rid of.
 */

/**
 * Flag the vertices that belong to the screen, as a mesh attribute.
 *
 * A bounding box in texture space was the obvious way and it is wrong: the face
 * and the screen share one sheet, their islands interleave, and a rectangle
 * drawn round the screen's texture coordinates also caught the top of the face.
 * Po walked around with a patch of static on its forehead.
 *
 * Which triangles are the screen is not a texture question at all - it is a
 * question about where they sit on the body, and the answer there is exact.
 */
function markScreenVertices(mesh) {
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v);
    lo = Math.min(lo, v.applyMatrix4(mesh.matrixWorld).y);
    hi = Math.max(hi, v.y);
  }
  // This mesh carries the face and the screen. The screen is the low half.
  const cut = lo + (hi - lo) * 0.5;

  const flag = new Float32Array(pos.count);
  const box = { u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity };
  const uv = mesh.geometry.attributes.uv;
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v);
    if (v.applyMatrix4(mesh.matrixWorld).y > cut) continue;
    flag[i] = 1;
    n++;
    if (!uv) continue;
    const u = uv.getX(i), w = uv.getY(i);
    box.u0 = Math.min(box.u0, u); box.u1 = Math.max(box.u1, u);
    box.v0 = Math.min(box.v0, w); box.v1 = Math.max(box.v1, w);
  }
  if (n < 4) return null;
  mesh.geometry.setAttribute("aScreen", new THREE.BufferAttribute(flag, 1));
  return box;
}

const tvClock = { value: 0 };

/**
 * Make the screen on this character's belly play static.
 *
 * Returns false when the mesh does not carry a screen, which is every case
 * except the one mesh that does.
 */
function animateBellyTV(character) {
  const face = character.meshes.find((m) => /face/i.test(m.material?.name ?? ""));
  if (!face) return false;
  character.scene.updateMatrixWorld(true);
  const box = markScreenVertices(face);
  if (!box) return false;

  // Cloned, or all five would share one material and the last one to be set up
  // would win the screen for everybody.
  face.material = face.material.clone();
  face.material.onBeforeCompile = (shader) => {
    shader.uniforms.uTvTime = tvClock;
    shader.uniforms.uTvBox = { value: new THREE.Vector4(box.u0, box.v0, box.u1, box.v1) };
    // A varying carries the flag through, so the test is "is this the screen"
    // rather than "is this near the screen on the sheet".
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aScreen;
        varying float vScreen;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vScreen = aScreen;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uTvTime;
        uniform vec4 uTvBox;
        varying float vScreen;
        // Cheap hash. Quality does not matter here - television static is the
        // one thing in graphics where a bad random number generator is correct.
        float tvHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        {
          vec2 tvT = (vMapUv - uTvBox.xy) / (uTvBox.zw - uTvBox.xy);
          if (vScreen > 0.5) {
            // Chunky cells, and a clock that ticks rather than slides, so it
            // reads as frames of static instead of a drifting wash.
            vec2 cell = floor(tvT * vec2(26.0, 20.0));
            float tick = floor(uTvTime * 14.0);
            float r = tvHash(cell + tick * 1.7);
            float g = tvHash(cell + tick * 1.7 + 41.0);
            float b = tvHash(cell + tick * 1.7 + 97.0);
            // Mostly luminance with a little colour fringing, the way an aerial
            // picture breaks up, rather than confetti.
            float lum = (r + g + b) / 3.0;
            vec3 snow = mix(vec3(lum), vec3(r, g, b), 0.35);
            diffuseColor.rgb = pow(snow, vec3(0.85)) * 0.92 + 0.04;
          }
        }`);
  };
  face.material.needsUpdate = true;
  return true;
}

/**
 * Take the warmth out of the chaser.
 *
 * The mask covers the front of its face and nothing else, so the skin around it
 * and the beige inside its ears stayed the colour of a children's television
 * presenter while the middle of its head was a corpse. The fix is not another
 * mesh: it is that the chaser should not have pink anywhere.
 *
 * So every texture it wears gets its skin tones - warm, red leading blue - pulled
 * to the mask's own dead grey, wherever they happen to live on the sheet. That
 * catches the face surround and the ear linings in one pass without anybody
 * having to know which is which. Its purple body is not a skin tone and is left
 * exactly as it is.
 */
function greyTheChaser(character) {
  let changed = 0;
  const done = new Map();
  for (const mesh of character.meshes) {
    const map = mesh.material?.map;
    if (!map?.image) continue;
    if (done.has(map)) { mesh.material = done.get(map); continue; }

    const src = map.image;
    const w = src.width ?? src.videoWidth, h = src.height ?? src.videoHeight;
    if (!w || !h) continue;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const px = ctx.getImageData(0, 0, w, h);
    const d = px.data;
    let hits = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      // Warm and pale: the flesh on these sheets, and nothing else on them.
      if (!(r > 95 && r > b + 14 && r >= g && g > b - 10)) continue;
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      // Towards the mask: cold, desaturated, and a shade darker than the skin.
      const grey = Math.min(255, lum * 0.86 + 8);
      d[i] = grey * 0.99;
      d[i + 1] = grey;
      d[i + 2] = Math.min(255, grey * 1.05);
      hits++;
    }
    if (!hits) continue;
    ctx.putImageData(px, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = map.colorSpace;
    tex.flipY = map.flipY;
    tex.wrapS = map.wrapS;
    tex.wrapT = map.wrapT;
    tex.anisotropy = map.anisotropy;
    tex.needsUpdate = true;

    const mat = mesh.material.clone();
    mat.map = tex;
    mat.needsUpdate = true;
    mesh.material = mat;
    done.set(map, mat);
    changed++;
  }
  return changed;
}

/**
 * Build every character once, in the browser. There is no offline bake.
 *
 * Two donors, because the chaser and the players want different animation. The
 * players ride donor/dipsy for its 56 clips of ordinary locomotion; the chaser
 * rides donor/tinkywinky, which has 27 of its own, so Tinky Winky moves like
 * Tinky Winky. See tubbyRig.js for what had to be corrected in the skins first.
 */
/** Advance every belly screen. One uniform, however many tubbies are on it. */
export function tickTV(dt) { tvClock.value += dt; }

export async function loadTubbyAssets(base = "./assets/game/rig") {
  if (rigCache !== null) return rigCache;
  if (!CFG.tubby.useBakedRig) {
    console.info("[tubbies] rigged models disabled (CFG.tubby.useBakedRig) - " +
      "using procedural stand-ins");
    rigCache = false;
    return rigCache;
  }
  try {
    const t0 = performance.now();
    const [chaser, players] = await Promise.all([
      buildTubbyRigs(`${base}/donor/tinkywinky/scene.gltf`,
        { tinkywinky: `${base}/skin/tinkywinky/scene.gltf` }),
      buildTubbyRigs(`${base}/donor/dipsy/scene.gltf`, {
        dipsy: `${base}/skin/dipsy/scene.gltf`,
        laalaa: `${base}/skin/laalaa/scene.gltf`,
        po: `${base}/skin/po/scene.gltf`,
        guardian: `${base}/skin/guardian/scene.gltf`,
      }),
    ]);

    // Grey first: it rewrites the sheets, and everything after this clones the
    // materials that wear them.
    const greyed = greyTheChaser(chaser.characters.tinkywinky);
    await wearHorrorFace(chaser.characters.tinkywinky);
    console.info(`[tubbies] chaser desaturated on ${greyed} sheets`);

    // The guardian's eyeballs ship 456 units wide and 2500 below its feet, so
    // seatFacialParts had to shrink them a thousandfold and what came out the
    // other side was two flat smears. Its sockets get built eyes instead.
    const guardian = players.characters.guardian;
    if (guardian && !guardian.eyesTrustworthy) {
      for (const m of guardian.meshes) {
        const driven = dominantBones(m);
        const names = guardian.target.skeleton.bones;
        if (driven.size && [...driven].every((i) => /^eye(lid)?[_ ]/i.test(names[i]?.name ?? ""))) {
          m.visible = false;
        }
      }
      // 1.45 is the ratio the four intact skins ship: their eyeball stands
      // that much prouder than the hole it looks through.
      const n = fillSockets(guardian, { sclera: 0xf2efe6, pupil: 0x141017, bulge: 1.45 });
      console.info(`[tubbies] guardian given ${n} built eyes`);
    }

    const characters = {};
    let screens = 0;
    for (const rig of [chaser, players]) {
      for (const [kind, character] of Object.entries(rig.characters)) {
        characters[kind] = bakeStates(character, rig, CFG.tubby.height);
        if (animateBellyTV(character)) screens++;
      }
    }
    console.info(`[tubbies] ${screens} belly screens playing static`);

    const short = Object.entries(characters)
      .filter(([, c]) => c.byState.size < 4)
      .map(([kind, c]) => `${kind} has only ${c.byState.size} states`);
    if (short.length) throw new Error(short.join(", "));

    rigCache = characters;
    console.info(`[tubbies] ${Object.keys(characters).length} rigs built in ` +
      `${(performance.now() - t0) | 0}ms, ` +
      `${characters.po?.byState.size ?? 0} states each`);
  } catch (err) {
    console.warn("[tubbies] could not build the rigs, using stand-ins:", err.message);
    rigCache = false;
  }
  return rigCache;
}

/**
 * A second tubby of the same kind needs its own skeleton, or the two animate in
 * lockstep and stand in the same place.
 *
 * SkeletonUtils.clone rebinds each mesh to its CURRENT world matrix, but these
 * rips bind with an identity bindMatrix and rely on AttachedBindMode cancelling
 * the mesh transform out. Mixing the two conventions puts the copy back at the
 * wrong size, so the source's bindMatrix is restored afterwards.
 *
 * In practice the roles are all distinct - the host is the guardian, guests take
 * laalaa, po and dipsy, and the chaser is always Tinky Winky - so this is a
 * safety net rather than a path the game normally takes.
 */
function cloneCharacter(character) {
  const scene = skinnedClone(character.scene);
  const sources = [];
  character.scene.traverse((o) => { if (o.isSkinnedMesh) sources.push(o); });
  const copies = [];
  scene.traverse((o) => { if (o.isSkinnedMesh) copies.push(o); });
  copies.forEach((m, i) => {
    m.bind(m.skeleton, sources[i].bindMatrix);
    m.frustumCulled = false;
    m.castShadow = true;
  });
  return { ...character, scene, meshes: copies, target: copies[0] };
}

export function makeTubby(kind) {
  const spec = TUBBIES[kind] ?? TUBBIES.tinkywinky;
  const character = rigCache && rigCache[kind];
  return character ? new RiggedTubby(character, spec) : new ProcTubby(spec);
}

/* ------------------------------------------------------------------ real ---- */

class RiggedTubby {
  constructor(character, spec) {
    const mine = character.taken ? cloneCharacter(character) : character;
    character.taken = true;

    this.root = new THREE.Group();
    // No scaling here: bakeClips already scaled the rig. Scaling after the fact
    // is exactly what made these render at the wrong size before.
    this.inner = mine.scene;
    this.inner.position.y = -mine.feet;
    this.root.add(this.inner);

    // These clips carry root motion, so a fixed offset that stands the bind pose
    // on the ground leaves an idling tubby hovering. Track the foot bones and
    // plant the lowest one every frame instead.
    this.footBones = [];
    this.inner.traverse((o) => {
      if (o.isBone && /^(foot|toe)[_ ][lr]([_ ]|$)/i.test(o.name)) this.footBones.push(o);
    });
    this.soleDrop = this.#measureSoleDrop();

    // The jumpscare needs to know where to point the camera.
    this.sockets = mine.sockets;
    this.headBone = null;
    this.inner.traverse((o) => {
      if (!this.headBone && o.isBone && /^head[_ ]/i.test(o.name)) this.headBone = o;
    });

    this.mixer = new THREE.AnimationMixer(mine.target);
    this.byState = mine.byState;
    this.current = null;
    this.currentName = null;
    this.spec = spec;
    this.play("idle", 0);
  }

  /** Where the head JOINT is, in world space. */
  headWorld(out) {
    if (this.headBone) return this.headBone.getWorldPosition(out);
    return out.copy(this.root.position).setY(this.root.position.y + 1.55);
  }

  /**
   * Where the FACE is, which is not the same thing and is what a camera wants.
   *
   * The head joint on these rigs sits at the crown, level with the very top of
   * the skull, so pointing a lens at it frames the aerial and cuts the mask off
   * at the bottom of the shot. The eye sockets are already measured when the
   * eyes are seated, and their midpoint is the middle of the face by
   * definition.
   */
  faceWorld(out) {
    if (this.headBone && this.sockets?.length) {
      out.set(0, 0, 0);
      for (const s of this.sockets) out.add(s.local);
      out.divideScalar(this.sockets.length);
      return this.headBone.localToWorld(out);
    }
    return this.headWorld(out);
  }

  play(name, fade = 0.25) {
    if (this.currentName === name) return;
    const clip = this.byState.get(name);
    if (!clip) return;
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
   * How far the sole hangs below the lowest foot JOINT, in the bind pose.
   *
   * Measured rather than guessed, because the ankle sits well up inside the
   * foot: planting the joint itself on the ground buried these tubbies 13cm
   * deep. One pass over the vertices at construction, never per frame.
   */
  #measureSoleDrop() {
    if (!this.footBones.length) return 0;
    this.inner.position.y = 0;
    this.inner.updateMatrixWorld(true);
    let joint = Infinity;
    for (const b of this.footBones) joint = Math.min(joint, b.getWorldPosition(_v).y);
    let sole = Infinity;
    this.inner.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        o.getVertexPosition(i, _v);
        sole = Math.min(sole, _v.applyMatrix4(o.matrixWorld).y);
      }
    });
    return Number.isFinite(joint) && Number.isFinite(sole) ? joint - sole : 0;
  }

  /**
   * Stand the sole on the root's own height, whatever the clip is doing, so
   * every animation lands on the ground rather than only the one an offset
   * happened to be measured from. These clips carry root motion, so a fixed
   * offset is not enough on its own.
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
    this.inner.position.y =
      this.root.position.y - lowest + this.soleDrop - FOOT_SINK;
  }
}

/* ------------------------------------------------------- procedural stand-in -- */

class ProcTubby {
  /** Same contract as the rigged model, so the jumpscare works on either. */
  headWorld(out) { return this.head.getWorldPosition(out); }
  faceWorld(out) { return this.head.getWorldPosition(out); }

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
