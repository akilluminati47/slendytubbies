import * as THREE from "three";
import { solveTwoBone, levelFoot, groundNormal } from "./footwork.js";
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
// Scratch for the head twist. It runs once per drawn tubby per frame and
// allocating four quaternions each time was pure garbage for no benefit.
const _axis = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _dq2 = new THREE.Quaternion();
const _scr = new THREE.Vector3();
const _eul = new THREE.Euler();
const _sole = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
// A hair of sink so the sole meets the ground rather than hovering on it.
const FOOT_SINK = 0.01;

/**
 * How high above its own ground a foot still counts as planted, and how high
 * before it is fully in the air, in metres.
 */
const PLANTED = 0.03;
const AIRBORNE = 0.17;

/**
 * How hard the sole is rolled flat, planted and in mid-swing.
 *
 * Not zero in the air. The complaint that started this was that the toes point
 * at the sky - most of the way through the chase clip, a little through the
 * walk - and a foot that is only corrected once it lands still spends the whole
 * stride pointing upward on the way there. Half strength in flight keeps the
 * toe-off shape the animator put in and takes out the exaggeration.
 */
const LEVEL_DOWN = 1.0;
const LEVEL_AIR = 0.5;

/** How far the pelvis is allowed to move to keep a foot reachable. */
const PELVIS_LIMIT = 0.55;

/**
 * How far above the weight-bearing foot the other one has to be before it
 * counts as swinging rather than as standing, in metres.
 */
const STANCE = 0.12;

/** How much the toes are squared while a foot is still in the air. */
const SQUARE_AIR = 0.55;

/** How fast the body settles onto a new height, per second. */
const PELVIS_EASE = 40;

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
/**
 * How far a clip may be pushed from the speed it was animated at.
 *
 * Below the floor the motion turns to treacle; above the ceiling the legs blur
 * and stop reading as legs. Between them the clip still looks like itself, so
 * these two numbers are the whole of what the animation can do - and since a
 * clip travels a known distance per cycle, they turn straight into a band of
 * ground speeds it can carry honestly. Everything that picks a speed for a body
 * goes through carries()/gaitFor() rather than guessing at these.
 */
export const RATE = { min: 0.82, max: 2.45 };

/**
 * How much of the clip's own head swing to take back out, 0 to 1.
 *
 * The donor animates a big roll of the head into both cycles, and these clips
 * play at up to twice the rate it was made at.
 */
const HEAD_CALM = 0.38;

/**
 * The clips a body can travel on, slowest first. Idle is not travel.
 *
 * "stride" is deliberately absent: it carries the same speed as "walk" to
 * within a percent, so offering it here would only make gaitFor toss a coin
 * between two identical bands. It is a costume, not a gear - see variantFor.
 */
const GAITS = ["walk", "chase"];

const CLIP_FOR = {
  // IDLE_POSE, not IDLE_LOOKAROUND: the lookaround leaves the chaser's head
  // cranked to one side at t=0, so it stood in the menu parade facing sideways.
  idle:        ["idle_pose", "idle1", "_idle", "idle"],
  walk:        ["tinky_walking", "walk_main", "walk1", "_walk", "walk"],
  investigate: ["tinky_walking", "walk_main", "walk1", "_walk", "walk"],
  chase:       ["tinky_running_armed", "run_main", "run1", "_run", "run"],
  // A second walk, at the same speed as the first. Not a wider gait - it was
  // baked to find out whether it was one, and it is within 1% - but a different
  // animation, which is worth having when five bodies walk past the lens in a
  // line. See variantFor. The donor's only other travelling clip is a three
  // second running ATTACK, which measured at 0.18 m/s because it is a lunge and
  // not a loop: there is exactly one running cycle in this donor, and no amount
  // of naming it differently would make a second one.
  stride:      ["tinky_walking_armed", "walk_main_2", "walk2"],
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
  // Big enough that the mask reaches the edges of the face it replaces, rather
  // than sitting on it as a smaller oval with tubby showing round the outside.
  // Past about 1.8 radii it starts wrapping towards the ears.
  const width = Math.max(gap * 3.1, radius * 1.62);
  const height = width * 1.2;

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
    // Cut, not blended: a soft edge over a head this dark haloes.
    alphaTest: 0.5,
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
  const maskCtx = mask.getContext("2d", { willReadFrequently: true });
  maskCtx.drawImage(cut, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

  // Push the skin outwards into the transparent corners until it runs edge to
  // edge. The rip is an oval on a field of nothing, and cutting that oval out
  // left a visible seam where it stopped and the head began - a mask sitting on
  // a face rather than being one.
  // Nothing is invented outside the face. Growing the skin into the corners and
  // softening it only ever produced a halo in the colour the key was removing;
  // the mask is simply drawn bigger instead, and cut out where it ends.

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

  // Now that the mask exists, the rest of the chaser can be made out of it.
  const greyed = greyTheChaser(character, cheekRamp(mask));

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

  console.info(`[tubbies] chaser wears a mask plate ${plate.width} across, ` +
    `${greyed} sheets recoloured through its own cheeks, ` +
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
 * Flag the screen's vertices, and give them a coordinate of their own.
 *
 * Two things are wrong with reading the belly screen through its texture
 * coordinates. The first is that the face and the screen share one sheet and
 * their islands interleave, so a rectangle drawn round the screen's UVs also
 * caught the top of the face - Po walked around with static on its forehead.
 * The second is that the screen's UVs are mirrored down the middle, so anything
 * generated from them comes out bookmatched, a Rorschach blot rather than snow.
 *
 * Both go away if the screen is described in its own terms: which vertices it is,
 * and where each one sits across the panel. Position answers both, and position
 * does not mirror.
 */
function markScreen(mesh) {
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
  const box = new THREE.Box3();
  const raw = [];
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v);
    const world = v.clone().applyMatrix4(mesh.matrixWorld);
    raw.push(v.clone());
    if (world.y > cut) continue;
    flag[i] = 1;
    box.expandByPoint(v);
    n++;
  }
  if (n < 4) return null;

  // Across and up the panel, 0..1, from the geometry rather than the sheet.
  //
  // Which local axis is "up" has to be asked, not assumed. These meshes are
  // Z-up with a wrapper rotation putting them right way round in the world, so
  // the screen spans 3.0 along local Z and only 0.7 along local Y - that 0.7
  // being the belly's curvature, not its height. Normalising down Y therefore
  // divided the panel by how far it bulged, which is what drew the chevron and
  // left the middle of the screen dead.
  const size = box.getSize(new THREE.Vector3());
  const toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const localUp = new THREE.Vector3(0, 1, 0).transformDirection(toLocal);
  const axis = ["x", "y", "z"];
  const up = axis[[localUp.x, localUp.y, localUp.z]
    .map(Math.abs).indexOf(Math.max(Math.abs(localUp.x), Math.abs(localUp.y), Math.abs(localUp.z)))];
  // Across is whichever of the other two the panel is widest along.
  const rest = axis.filter((a) => a !== up);
  const across = size[rest[0]] >= size[rest[1]] ? rest[0] : rest[1];

  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = size[across] > 1e-6
      ? (raw[i][across] - box.min[across]) / size[across] : 0;
    uv[i * 2 + 1] = size[up] > 1e-6
      ? (raw[i][up] - box.min[up]) / size[up] : 0;
  }
  mesh.geometry.setAttribute("aScreen", new THREE.BufferAttribute(flag, 1));
  mesh.geometry.setAttribute("aScreenUv", new THREE.BufferAttribute(uv, 2));
  return true;
}

const tvClock = { value: 0 };

/**
 * A seeded set of CRT faults, so no two sets are the same.
 *
 * Every one of these is a real thing a dying television does, and every one is
 * rolled per spawn: the tube's convergence, how badly the frame is holding, how
 * fast the roll bar crawls, how coarse the shadow mask is. `menace` biases the
 * roll - the chaser always takes the worst set it can, so its screen is the one
 * that looks wrong from across a clearing.
 */
function rollTube(seed, menace = 0) {
  // Cheap deterministic stream from one integer.
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => (((s = (s * 1664525 + 1013904223) >>> 0) >>> 8) / 16777216);
  const pick = (lo, hi) => {
    const a = rnd(), b = rnd();
    // Two rolls, keep the worse one, when this tube is supposed to be nastier.
    return lo + (hi - lo) * (menace ? Math.max(a, b) : a);
  };
  return {
    cells: new THREE.Vector2(18 + Math.round(pick(0, 14)), 13 + Math.round(pick(0, 10))),
    triad: 22 + pick(0, 26),          // shadow-mask pitch across the panel
    rollSpeed: 0.06 + pick(0, 0.5),   // how fast the frame slips
    skew: -0.55 + pick(0, 1.1),       // and how far off level it slips
    warp: 0.03 + pick(0, 0.09),       // barrel on the glass, gently
    bleed: 0.1 + pick(0, 0.45),       // convergence error, colour off the edges
    jitter: pick(0, 0.5),             // horizontal tearing
    tick: 10 + pick(0, 12),           // frames a second of snow
  };
}

/**
 * Make the screen on this character's belly play static.
 *
 * The panel is drawn in the fragment shader rather than as a texture: it wants
 * to move, and a movie of static is a lot of bytes to ship for something you
 * mostly see out of the corner of your eye.
 */
function animateBellyTV(character, { seed = 1, menace = 0 } = {}) {
  const face = character.meshes.find((m) => /face/i.test(m.material?.name ?? ""));
  if (!face) return null;
  character.scene.updateMatrixWorld(true);
  if (!markScreen(face)) return null;

  const tube = rollTube(seed, menace);

  // Cloned, or all five share one material and the last one set up wins the
  // screen for everybody.
  face.material = face.material.clone();
  face.material.onBeforeCompile = (shader) => {
    shader.uniforms.uTvTime = tvClock;
    shader.uniforms.uCells = { value: tube.cells };
    shader.uniforms.uTube = {
      value: new THREE.Vector4(tube.triad, tube.rollSpeed, tube.skew, tube.warp),
    };
    shader.uniforms.uTube2 = {
      value: new THREE.Vector3(tube.bleed, tube.jitter, tube.tick),
    };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aScreen;
        attribute vec2 aScreenUv;
        varying float vScreen;
        varying vec2 vScreenUv;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vScreen = aScreen;
        vScreenUv = aScreenUv;`);

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uTvTime;
        uniform vec2 uCells;
        uniform vec4 uTube;
        uniform vec3 uTube2;
        varying float vScreen;
        varying vec2 vScreenUv;
        // Quality does not matter here. Television static is the one place in
        // graphics where a bad random number generator is the correct one.
        float tvHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        if (vScreen > 0.5) {
          float triad = uTube.x, rollSpeed = uTube.y, skew = uTube.z, warp = uTube.w;
          float bleed = uTube2.x, jitter = uTube2.y, tick = uTube2.z;

          // Barrel: the glass is curved, so the picture is too.
          vec2 c = vScreenUv * 2.0 - 1.0;
          c *= 1.0 + warp * dot(c, c);
          vec2 t = c * 0.5 + 0.5;

          // The frame slips now and then rather than constantly. Each stretch of
          // a few seconds either holds or it does not, decided by a hash on the
          // clock, so the bar sweeps through in bursts the way a real one does.
          float era = floor(uTvTime * 0.22);
          float slipping = step(0.62, tvHash(vec2(era, 3.0)));
          // Level, not chevroned. A rolling frame is a horizontal bar; the tilt
          // only comes in on the tears, and only while it is actually slipping.
          float roll = fract(t.y - uTvTime * rollSpeed);
          float band = smoothstep(0.0, 0.05, roll) * smoothstep(0.18, 0.09, roll);
          band *= slipping;
          // The diagonal tear is its own event, rarer still.
          float tearEra = floor(uTvTime * 0.8);
          float tearing = step(0.88, tvHash(vec2(tearEra, 11.0)));
          float tear = fract(t.y - t.x * skew - uTvTime * (rollSpeed + 0.9));
          float tearBand = smoothstep(0.0, 0.03, tear) * smoothstep(0.10, 0.05, tear) * tearing;
          t.x += (band + tearBand) * jitter * 0.05 *
                 (tvHash(vec2(floor(t.y * 90.0), floor(uTvTime * 20.0))) - 0.5);

          float frame = floor(uTvTime * tick);
          vec2 cell = floor(t * uCells);
          float r = tvHash(cell + frame * 1.7);
          float g = tvHash(cell + frame * 1.7 + 41.0);
          float b = tvHash(cell + frame * 1.7 + 97.0);
          float lum = (r + g + b) / 3.0;
          vec3 snow = mix(vec3(lum), vec3(r, g, b), bleed);

          // Trinitron: vertical phosphor stripes, red green blue across the
          // face, with the gaps between them dark. An aperture grille has no
          // horizontal wires, which is what separates it from a shadow mask.
          float stripe = fract(t.x * triad);
          vec3 mask = vec3(
            smoothstep(0.66, 0.34, abs(stripe - 0.166) * 3.0),
            smoothstep(0.66, 0.34, abs(stripe - 0.5) * 3.0),
            smoothstep(0.66, 0.34, abs(stripe - 0.833) * 3.0));
          mask = mask * 0.85 + 0.35;

          vec3 out3 = snow * mask;
          out3 += band * 0.16 + tearBand * 0.22;     // the bars themselves glow
          // Scanline gaps, shallow. Deep ones read as corduroy at this size.
          out3 *= 1.0 - 0.06 * step(0.5, fract(t.y * uCells.y * 0.5));
          // Off the edge of the tube there is no picture at all.
          float lit = step(0.0, t.x) * step(t.x, 1.0) * step(0.0, t.y) * step(t.y, 1.0);
          out3 = pow(out3, vec3(0.78)) * 1.18 + 0.05;
          diffuseColor.rgb = mix(vec3(0.03), out3, lit);
        }`);
  };
  face.material.needsUpdate = true;
  return tube;
}

/**
 * A tone ramp lifted off the mask's cheeks.
 *
 * Greying the rest of the chaser by formula gave it flat, even grey skin around
 * a face full of modelled shadow, which read as two different materials stuck
 * together. Its ears should be made of whatever its cheeks are made of, so this
 * takes the cheeks apart into a lookup - for each brightness, what colour is the
 * mask actually that bright? - and everything else is recoloured through it.
 *
 * The cheeks specifically, not the whole face: the sockets and the mouth are
 * near black and would drag the dark end of the ramp somewhere no ear goes.
 */
function cheekRamp(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, w, h).data;

  const sums = new Float64Array(256 * 3);
  const hits = new Uint32Array(256);
  const patches = [[0.16, 0.44, 0.38, 0.74], [0.62, 0.44, 0.84, 0.74]];
  for (const [x0, y0, x1, y1] of patches) {
    for (let y = Math.floor(y0 * h); y < y1 * h; y++) {
      for (let x = Math.floor(x0 * w); x < x1 * w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 200) continue;
        const lum = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
        sums[lum * 3] += d[i];
        sums[lum * 3 + 1] += d[i + 1];
        sums[lum * 3 + 2] += d[i + 2];
        hits[lum]++;
      }
    }
  }

  // Fill the brightnesses the cheeks never reached from their nearest neighbour,
  // so the ramp is continuous across the whole range.
  const ramp = new Uint8ClampedArray(256 * 3);
  let last = -1;
  for (let l = 0; l < 256; l++) {
    if (hits[l]) {
      ramp[l * 3] = sums[l * 3] / hits[l];
      ramp[l * 3 + 1] = sums[l * 3 + 1] / hits[l];
      ramp[l * 3 + 2] = sums[l * 3 + 2] / hits[l];
      if (last < 0) for (let k = 0; k < l; k++) ramp.copyWithin(k * 3, l * 3, l * 3 + 3);
      last = l;
    } else if (last >= 0) {
      ramp.copyWithin(l * 3, last * 3, last * 3 + 3);
    }
  }
  return last < 0 ? null : ramp;
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
function greyTheChaser(character, ramp) {
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
      const lum = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
      if (ramp) {
        // Whatever the mask's cheek is at this brightness, the ear is too.
        const k = Math.min(255, Math.max(0, lum)) * 3;
        d[i] = ramp[k];
        d[i + 1] = ramp[k + 1];
        d[i + 2] = ramp[k + 2];
      } else {
        const grey = Math.min(255, lum * 0.86 + 8);
        d[i] = grey * 0.99;
        d[i + 1] = grey;
        d[i + 2] = Math.min(255, grey * 1.05);
      }
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
 * One donor. See the note at the call, and tubbyRig.js for what had to be
 * corrected in the skins before any of it would move at all.
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
    // One donor for everybody. It used to be two - the players rode a Garry's
    // Mod biped for its 56 clips - but that rig is a person, and every one of
    // its habits had to be argued out of the tubbies one at a time: a waist
    // that counter-rotates, hips a hand's width apart, a march with 92 degrees
    // of knee in it. Tinky Winky's own set was animated by somebody who knew
    // what shape the character is, and it needed none of that. It also halves
    // the download, since donor/dipsy was 9MB of animation nobody now plays.
    const rig = await buildTubbyRigs(`${base}/donor/tinkywinky/scene.gltf`, {
      tinkywinky: `${base}/skin/tinkywinky/scene.gltf`,
      dipsy: `${base}/skin/dipsy/scene.gltf`,
      laalaa: `${base}/skin/laalaa/scene.gltf`,
      po: `${base}/skin/po/scene.gltf`,
      guardian: `${base}/skin/guardian/scene.gltf`,
    });
    const chaser = rig, players = rig;

    await wearHorrorFace(rig.characters.tinkywinky);

    // The guardian's eyeballs ship 456 units wide and 2500 below its feet, so
    // seatFacialParts had to shrink them a thousandfold and what came out the
    // other side was two flat smears. Its sockets get built eyes instead.
    const guardian = rig.characters.guardian;
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
    const tubes = [];
    {
      for (const [kind, character] of Object.entries(rig.characters)) {
        characters[kind] = bakeStates(character, rig, CFG.tubby.height);
        // A different tube per set, rolled fresh each time the game loads. The
        // chaser always draws the worse of two rolls on every fault, so its
        // screen is the one that looks wrong from across a clearing.
        const tube = animateBellyTV(character, {
          seed: (Math.random() * 0xffffff) | 0,
          menace: kind === "tinkywinky" ? 1 : 0,
        });
        if (tube) tubes.push(`${kind} roll ${tube.rollSpeed.toFixed(2)}`);
      }
    }
    console.info(`[tubbies] ${tubes.length} tubes: ${tubes.join(", ")}`);

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

/**
 * What a body travelling at `speed` would be doing with its legs.
 *
 * The local player is the one character in the game with no model - you are a
 * camera - so the two things that should be following its animation had nothing
 * to follow and were given invented numbers instead: footsteps every 0.92 to
 * 1.42 metres, and a head bob of 6.0 radians per metre. The clips step every
 * 0.39 to 0.52. So your own feet sounded roughly one stride in three, against a
 * body that every other player in the lobby could see taking all of them.
 *
 * This is the missing model. Same clip choice and same playback clamp the real
 * ones use, so the answer is what a tubby standing where you are would be doing.
 *
 * `period` is seconds per FOOTFALL, not per cycle - a cycle is two of them - and
 * it comes from the CLAMPED playback, so when the body outruns its clip (which
 * yours does at a full sprint) the steps stretch out exactly as the visible ones
 * do rather than staying honest while the animation cannot.
 *
 * @returns null when the rigged models are not in use, so callers keep a
 *          fallback rather than dividing by a rig that never loaded.
 */
export function locomotion(speed, kind = null) {
  const chars = rigCache;
  if (!chars) return null;
  const character = (kind && chars[kind]) || chars.tinkywinky
    || chars[Object.keys(chars)[0]];
  const byState = character?.byState;
  if (!byState) return null;

  let best = null;
  for (const name of GAITS) {
    const clip = byState.get(name);
    const own = clip?.userData?.groundSpeed ?? 0;
    if (own <= 0.05) continue;
    const carried = THREE.MathUtils.clamp(speed, own * RATE.min, own * RATE.max);
    const miss = Math.abs(carried - speed);
    if (!best || miss < best.miss) best = { name, clip, own, miss };
  }
  if (!best) return null;

  const playback = THREE.MathUtils.clamp(speed / best.own, RATE.min, RATE.max);
  return {
    clip: best.name,
    duration: best.clip.duration,
    playback,
    period: best.clip.duration / (2 * playback),
    hand: best.clip.userData.handTrack ?? null,
  };
}

/**
 * The torch hand's offset at a point in the cycle, in metres of unit swing.
 *
 * Linear between samples: the track is 32 points around a cycle that lasts most
 * of a second, so the corners are far below what a hand moving this slowly can
 * show, and a smoother interpolation would cost more than it could be seen to
 * buy.
 */
export function handAt(track, phase, out) {
  if (!track) return out.set(0, 0, 0);
  const n = track.samples;
  const t = (phase - Math.floor(phase)) * n;
  const i = Math.floor(t), f = t - i;
  const a = (i % n) * 3, b = ((i + 1) % n) * 3;
  const d = track.data;
  return out.set(
    d[a] + (d[b] - d[a]) * f,
    d[a + 1] + (d[b + 1] - d[a + 1]) * f,
    d[a + 2] + (d[b + 2] - d[a + 2]) * f);
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

    // The two leg chains, for the ground work in #standOnGround.
    //
    // Found by name because this rig names them plainly - Leg_R1 is the thigh,
    // Leg_R2 the shin, then the foot and the toe - and a chain that comes up
    // short simply does not get walked, so a rig without one animates exactly
    // as it did before.
    this.legs = [];
    for (const side of ["r", "l"]) {
      const find = (re) => {
        let hit = null;
        this.inner.traverse((o) => {
          if (!hit && o.isBone && re.test(o.name)) hit = o;
        });
        return hit;
      };
      const hip = find(new RegExp(`^leg_${side}1`, "i"));
      const knee = find(new RegExp(`^leg_${side}2`, "i"));
      const ankle = find(new RegExp(`^foot_${side}([_ ]|$)`, "i"));
      const toe = find(new RegExp(`^toe_${side}([_ ]|$)`, "i"));
      if (hip && knee && ankle && toe) this.legs.push({ hip, knee, ankle, toe });
    }
    // Snapshotted for the same reason the fingers are: these are bones the
    // solve writes to every frame, and a clip with no track for one of them
    // would never put it back - the rotation would compound until the leg span.
    this.legRest = this.legs.flatMap((l) =>
      [l.hip, l.knee, l.ankle].map((b) => [b, b.quaternion.clone()]));

    // The underside of each foot, as points rather than as one number.
    //
    // soleDrop is a single distance measured in the bind pose, and it is only
    // the truth while the foot is flat: pitch a toe down and the tip of it goes
    // below that estimate, which is how a sole ended up five centimetres inside
    // the stage even with a floor clamp. A point per foot bone, taken in bind
    // space and carried by the bone, is exact in any pose - and it is four
    // points to transform, not four thousand vertices.
    for (const leg of this.legs) leg.soles = this.#soleOf([leg.ankle, leg.toe]);

    /**
     * Where the ground is under a point: (x, z) => world y, or null for a flat
     * floor at the root's own height.
     *
     * Set by whoever owns the world - the menu stage is a flat plane and wants
     * the null.
     */
    this.groundAt = null;

    /**
     * How far the body is off its own ground, in metres.
     *
     * Set by whoever is moving it. The ground fit reads the root's height as
     * "where the feet belong", which is true standing and wrong in the air: a
     * remote player's root carries their jump, so mid-jump the pelvis was being
     * dropped by the whole height of the hop and the Guardian went into the
     * terrain up to the waist. Off the ground, the clip owns the legs.
     */
    this.lift = 0;

    /**
     * How hard the toes are squared to the walk direction, 0 to 1.
     *
     * One for anybody you are meant to read as a person walking, zero for the
     * chaser - the clips are not mirrored and its uneven kick is the one place
     * that reads as character rather than as a rig fault.
     */
    this.squareFeet = 1;

    /** The settled body height from the ground fit, and where it is heading. */
    this.pelvisY = 0;
    this.pelvisWant = 0;

    // The jumpscare needs to know where to point the camera.
    this.sockets = mine.sockets;
    this.headBone = null;
    this.inner.traverse((o) => {
      if (!this.headBone && o.isBone && /^head[_ ]/i.test(o.name)) this.headBone = o;
    });
    // Where the head sits when nothing is driving it, kept so the clip's own
    // head swing can be damped back towards it. See HEAD_CALM.
    this.headRest = this.headBone?.quaternion.clone() ?? null;

    this.mixer = new THREE.AnimationMixer(mine.target);
    this.byState = mine.byState;
    this.current = null;
    this.currentName = null;
    this.spec = spec;
    this.lookYaw = 0;
    this.lookPitch = 0;

    // The hand that can close round a torch. Two finger segments and a thumb -
    // a mitten rather than a full hand, which is all a tubby has.
    this.gripBones = [];
    /** Run after every pose - see update(). Set by whoever hangs a prop on. */
    this.afterPose = null;
    /**
     * How the mitten is posed, or null for an open hand.
     *
     * An array of {x, y, z} in radians, one per grip bone in gripBones order,
     * post-multiplied onto whatever the clip left. It comes from the torch:
     * gripPoseFor() in torch.js holds a pose per prop, dialled at ?torch=1.
     *
     * This replaced a single guessed bend axis with one angle scaled per bone,
     * which spent its whole life switched off because nothing along that axis
     * ever read as a closing hand. The pose that does is different per bone AND
     * different per torch, so it was never going to be derived - only looked at.
     */
    this.gripPose = null;
    this.inner.traverse((o) => {
      if (!o.isBone) return;
      // The _end bones are leaf markers with nothing below them - rotating one
      // moves no vertices and only makes the list longer.
      if (/_end/i.test(o.name)) return;
      // The rest quaternion is snapshotted with each bone, and it is the whole
      // reason this works - see #closeHand.
      // Order matters: it is the order a grip pose is written in.
      if (/^fingers_r1/i.test(o.name)) this.gripBones.push([o, o.quaternion.clone()]);
      else if (/^fingers_r2/i.test(o.name)) this.gripBones.push([o, o.quaternion.clone()]);
      else if (/^thumb_r/i.test(o.name)) this.gripBones.push([o, o.quaternion.clone()]);
    });
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

  /**
   * Point the head somewhere other than straight ahead.
   *
   * Offsets, not absolutes: `yaw` is measured from wherever the body is facing,
   * so a player walking north while looking east is one number rather than two
   * that have to agree. Held rather than applied, because the mixer rewrites
   * every bone it owns on each update and anything written before that is gone.
   */
  look(yaw = 0, pitch = 0) {
    // A neck, not a turret. Past this the head detaches from the shoulders and
    // the whole model reads as broken rather than as somebody looking behind
    // them - and at that point the body is turning anyway.
    this.lookYaw = THREE.MathUtils.clamp(yaw, -1.3, 1.3);
    this.lookPitch = THREE.MathUtils.clamp(pitch, -0.55, 0.55);
  }

  /**
   * Apply the held look, in world space.
   *
   * Not in the bone's own frame: these donors arrive under wrapper rotations
   * and no two joints agree on which local axis is up, so "rotate about local X"
   * means something different on every rig and tilted heads sideways on most of
   * them. A world-space delta pushed back through the parent
   * (L' = P-1 . D . P . L) is immune to all of that - it rotates the head about
   * a world axis whatever the bone thinks it is doing.
   */
  #turnHead() {
    const bone = this.headBone;
    if (!bone) return;

    // Take some of the clip's own head swing out first.
    //
    // These cycles roll the head a long way. On the donor, played at its own
    // rate, that is fine; here they run at up to twice rate and the head starts
    // whipping about, and five of them doing it in a line reads as a row of
    // bobbleheads. Damping towards the rest pose scales the whole motion down
    // rather than clamping it, so its timing and direction survive and only the
    // amount changes.
    if (this.headRest && HEAD_CALM > 0) {
      bone.quaternion.slerp(this.headRest, HEAD_CALM);
    }
    if (!this.lookYaw && !this.lookPitch) return;

    // The model faces +Z at yaw 0, so a body at yaw t faces (sin t, 0, cos t)
    // and its right hand points along (-cos t, 0, sin t).
    const t = this.root.rotation.y;
    _axis.set(-Math.cos(t), 0, Math.sin(t));
    // Pitch in the body's own frame first, then swing the result by the look
    // yaw: D = Qyaw . Qpitch, which applied to a vector is yaw(pitch(v)).
    _dq.setFromAxisAngle(UP, this.lookYaw);
    _dq2.setFromAxisAngle(_axis, this.lookPitch);
    _dq.multiply(_dq2);

    bone.parent.updateWorldMatrix(true, false);
    bone.parent.matrixWorld.decompose(_scr, _pq, _v);
    // decompose, not setFromRotationMatrix: there is scale on these chains and
    // reading a rotation straight off a scaled matrix is nonsense.
    bone.quaternion
      .premultiply(_pq)
      .premultiply(_dq)
      .premultiply(_pq.invert());
  }

  /**
   * Close the hand round something, or let it open again.
   *
   * Takes the pose itself - see gripPoseFor() in torch.js - rather than an
   * amount, because how a hand shuts depends on what it is shutting round.
   *
   * Held like the head twist rather than applied here, because the mixer
   * rewrites every bone it owns on each update and anything written before it
   * runs is gone the same frame.
   */
  grip(pose = null) {
    this.gripPose = pose || null;
  }

  /**
   * Put the fingers back where the clip left them, before the mixer runs.
   *
   * Without this the hand whisks. #closeHand post-multiplies a curl onto the
   * bone, which is right for a bone the mixer rewrites every frame and
   * catastrophic for one it does not: these clips carry no finger tracks at
   * all, so nothing ever put them back and the same rotation compounded sixty
   * times a second until the fingers were spinning.
   *
   * Restoring first fixes both cases at once. A bone the mixer owns has its
   * restore overwritten a moment later and gets the curl applied on top of the
   * animated pose; a bone it does not own gets the curl applied to its rest
   * pose. Neither accumulates.
   */
  #openHand() {
    for (const [bone, rest] of this.gripBones) bone.quaternion.copy(rest);
  }

  /**
   * Curl the fingers, in the bone's OWN frame.
   *
   * Post-multiplied rather than assigned: a finger's bend is a rotation
   * relative to wherever the animation has already put it, so the walk cycle
   * keeps swinging the arm and the hand simply stays shut while it does.
   */
  #closeHand() {
    if (!this.gripPose) return;
    for (let i = 0; i < this.gripBones.length; i++) {
      const a = this.gripPose[i];
      if (!a) continue;
      _dq.setFromEuler(_eul.set(a.x || 0, a.y || 0, a.z || 0));
      this.gripBones[i][0].quaternion.multiply(_dq);
    }
  }

  /**
   * The band of ground speeds a clip can carry, in metres a second.
   *
   * The bake measured what each clip travels at off its own planted foot, so
   * this is a measurement scaled by a limit rather than a guess: the walk
   * carries about 0.34 to 1.03, the run about 1.74 to 5.20, and the gap between
   * them is real - no clip here covers it, and pretending otherwise is what
   * skating is.
   */
  carries(name) {
    const own = this.byState.get(name)?.userData?.groundSpeed ?? 0;
    return own > 0.05 ? [own * RATE.min, own * RATE.max] : [0, 0];
  }

  /** The fastest this body can travel without its feet lying about it. */
  topSpeed() {
    let top = 0;
    for (const name of GAITS) top = Math.max(top, this.carries(name)[1]);
    return top || Infinity;
  }

  /**
   * A speed the clips can actually carry, and the clip that carries it.
   *
   * Snaps a wanted speed to the nearest edge of the nearest band it can be
   * animated at, and hands back the clip to play with it - so a body and its
   * feet always agree. The only cost is that a wanted speed is sometimes a
   * little different from the speed you get, which is the honest trade: the
   * alternative is the speed you asked for and feet that do not match it.
   */
  gaitFor(want) {
    let best = null;
    for (const name of GAITS) {
      const [lo, hi] = this.carries(name);
      if (hi <= 0) continue;
      const speed = THREE.MathUtils.clamp(want, lo, hi);
      const miss = Math.abs(speed - want);
      if (!best || miss < best.miss) best = { clip: name, speed, miss };
    }
    return best ?? { clip: "walk", speed: want, miss: 0 };
  }

  /**
   * Another clip that travels at the same speed as this one, or the same one.
   *
   * For when several of these walk past together and the eye starts reading the
   * shared cycle rather than the characters. Only ever offers a swap gaitFor
   * would have been equally happy with, so taking it cannot reintroduce a
   * mismatch between a body and its feet.
   */
  variantFor(name) {
    if (name !== "walk") return name;
    const alt = this.byState.get("stride");
    if (!alt) return name;
    const own = this.byState.get("walk")?.userData?.groundSpeed ?? 0;
    const other = alt.userData?.groundSpeed ?? 0;
    return own > 0 && Math.abs(other - own) / own < 0.06 ? "stride" : name;
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
    // Play the clip at the rate it was walked at.
    //
    // The old divisor was a guess, and it was wrong in the direction that shows:
    // at patrol speed it ran the walk at 0.62x while the body covered the full
    // distance, so the legs cycled slower than the ground went by and the whole
    // thing read as low gravity. Every clip now carries the speed it actually
    // travels at, measured off its own planted foot during the bake, so this is
    // a ratio rather than an invention.
    const own = this.current?.getClip?.().userData?.groundSpeed ?? 0;
    this.mixer.timeScale = this.currentName === "idle" || own <= 0.05
      ? 1
      // Floor it well short of slow motion, and cap it well short of a blur.
      // A run clip played at much under the floor stops reading as a run at
      // all, and a little foot slide is a cheaper lie than a monster wading
      // towards you through treacle. See RATE.
      : THREE.MathUtils.clamp(speed / own, RATE.min, RATE.max);
    // Before the mixer, always: see #openHand.
    this.#openHand();
    this.#straightenLegs();
    this.mixer.update(dt);
    // One of the two owns the body's height, never both. #standOnGround knows
    // where the soles actually are; #plantFeet is the fallback for a rig with
    // no leg chains to solve, and for anything in mid-air.
    if (this.legs.length && this.lift <= 0.02) this.#standOnGround(dt);
    else this.#plantFeet();
    // After the mixer, always: it owns these bones during every clip and
    // anything written before it runs is overwritten the same frame.
    this.#turnHead();
    this.#closeHand();
    // And anything hung off a bone that has an opinion about the world rather
    // than about the arm - a torch, which should keep pointing where its owner
    // looks however the wrist has rolled. It has to be here, after the mixer,
    // for the same reason the head twist and the grip are.
    this.afterPose?.();
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

  /**
   * The lowest vertex each of these bones drives, in that bone's own space.
   *
   * Bind space, so it is pose-independent, and weight-gated so a vertex only
   * counts for the bone that actually carries it.
   */
  #soleOf(bones) {
    const out = [];
    const v = new THREE.Vector3();
    for (const bone of bones) {
      let best = null;
      this.inner.traverse((skin) => {
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
          if (w < 0.5) continue;
          v.fromBufferAttribute(position, i).applyMatrix4(skin.bindMatrix);
          const y = v.y;
          v.applyMatrix4(inv);
          if (!best || y < best.y) best = { y, local: v.clone() };
        }
      });
      if (best) out.push([bone, best.local]);
    }
    return out;
  }

  /** How high this leg's sole is, in world metres. */
  #soleY(leg) {
    let low = Infinity;
    for (const [bone, local] of leg.soles ?? []) {
      low = Math.min(low, bone.localToWorld(_sole.copy(local)).y);
    }
    return Number.isFinite(low)
      ? low
      : leg.ankle.getWorldPosition(_sole).y - this.soleDrop;
  }

  /** Put the legs back where the clip will find them - see #openHand. */
  #straightenLegs() {
    for (const [bone, rest] of this.legRest) bone.quaternion.copy(rest);
  }

  /**
   * Stand on the ground that is actually there, rather than on a flat floor.
   *
   * #plantFeet has already put the body roughly right, from the clip's own
   * pose. Three things are left, and they have to happen in this order because
   * each one moves what the next one measures.
   *
   * Roll the soles flat FIRST. Levelling an ankle swings the foot about the
   * joint, so it changes where the sole is - by seven centimetres on these
   * clips - and doing it after the body had been settled left the whole cast
   * hovering that far off the stage.
   *
   * Then settle the body to whichever sole has the furthest to go, so no leg is
   * ever asked to reach DOWN. Then each leg takes up the remainder, which is a
   * compression by construction: one knee ends up bent and the other nearly
   * straight, and that is the suspension.
   */
  #standOnGround(dt) {
    const ground = this.groundAt;
    // From zero every frame, exactly as #plantFeet does. The height below is an
    // answer, not a correction to somebody else's answer: measuring the soles
    // against a body that #plantFeet had already moved - by a bind-pose
    // constant that stops being true the moment a foot is levelled - meant the
    // correction chased the walk cycle and the body wallowed by six centimetres
    // rather than settling.
    this.inner.position.y = 0;
    this.inner.updateMatrixWorld(true);
    const base = this.root.position.y;

    // 1. Which foot the clip has down, judged BETWEEN the feet rather than
    //    against a height.
    //
    //    "Is this sole near the ground" needs the body to already be at the
    //    right height to answer, and the body's height is what we are here to
    //    work out. When it was asked that way and the body happened to sit
    //    high, neither foot counted as planted, nothing got a say, and it
    //    stayed high - the cast hovering seven centimetres off the stage with
    //    no way to learn otherwise. Comparing the two feet to each other needs
    //    no reference at all: the lower one is the one taking the weight.
    const feet = [];
    let top = -Infinity;
    for (const leg of this.legs) {
      const at = leg.ankle.getWorldPosition(new THREE.Vector3());
      const gy = ground ? ground(at.x, at.z) : base;
      const foot = {
        leg,
        gy,
        normal: groundNormal(ground, at.x, at.z, new THREE.Vector3()),
        rise: gy - this.#soleY(leg),
      };
      top = Math.max(top, foot.rise);
      feet.push(foot);
    }

    // 2. Soles flat: fully on the foot carrying the weight, half on the one in
    //    the air, which is what takes the exaggeration out of the swing without
    //    flattening the toe-off. And squared to the way they are walking, which
    //    is what makes the two feet mirror each other.
    const heading = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.root.quaternion).normalize();
    for (const foot of feet) {
      const down = 1 - THREE.MathUtils.clamp((top - foot.rise) / STANCE, 0, 1);
      foot.down = down;
      levelFoot(foot.leg.ankle, foot.leg.toe, foot.normal,
        LEVEL_AIR + (LEVEL_DOWN - LEVEL_AIR) * down,
        heading, this.squareFeet * (SQUARE_AIR + (1 - SQUARE_AIR) * down));
    }
    this.inner.updateMatrixWorld(true);

    // 3. The body settles onto the planted feet - the lowest of them, so that
    //    every leg is compressed from here and none is stretched to reach.
    let want = null;
    top = -Infinity;
    for (const foot of feet) {
      foot.rise = foot.gy - this.#soleY(foot.leg);
      top = Math.max(top, foot.rise);
    }
    for (const foot of feet) {
      if (foot.rise < top - STANCE) continue;    // that one is in the air
      want = want === null ? foot.rise : Math.min(want, foot.rise);
    }
    if (want !== null) {
      this.pelvisWant = THREE.MathUtils.clamp(want, -PELVIS_LIMIT, PELVIS_LIMIT);
    }
    // Barely eased. The height is right every frame on its own - the planted
    // foot is whichever sole is lowest, and that changes continuously as the
    // feet cross - so this is only here to take the corner off the swap.
    this.pelvisY += ((this.pelvisWant ?? 0) - this.pelvisY)
      * Math.min(1, dt * PELVIS_EASE);
    let pelvis = this.pelvisY;
    this.inner.position.y = pelvis;
    this.inner.updateMatrixWorld(true);

    // A hard floor under the eased height.
    //
    // Easing is what stops the body stepping when the planted foot swaps, and
    // the price of easing is that it lags - through which a sole can pass into
    // the ground. Every foot gets a veto here, the swinging one included: it is
    // a constraint rather than a preference, so it is applied at once and not
    // eased. This is the guarantee the old plant-the-lowest-bone code gave for
    // free, put back.
    let deepest = Infinity;
    for (const foot of feet) {
      deepest = Math.min(deepest, this.#soleY(foot.leg) - foot.gy);
    }
    if (deepest < -FOOT_SINK) {
      const up = -FOOT_SINK - deepest;
      this.inner.position.y = pelvis + up;
      this.pelvisY += up;       // or the ease would pull it straight back down
      pelvis += up;
      this.inner.updateMatrixWorld(true);
    }

    // 4. And the legs take up what is left. Which way a knee folds, if a leg is
    //    straight enough that its own pose cannot say.
    const pole = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.root.quaternion).normalize();
    for (const foot of feet) {
      const need = foot.rise - pelvis;
      if (need <= 1e-4) continue;
      const at = foot.leg.ankle.getWorldPosition(new THREE.Vector3());
      solveTwoBone(foot.leg.hip, foot.leg.knee, foot.leg.ankle,
        at.setY(at.y + need), pole);
    }
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
    this.lookYaw = 0;
    this.lookPitch = 0;
  }

  play(name) { this.state = name; }

  /**
   * The stand-in's stride is generated from the speed rather than played back,
   * so there is no clip to outrun and every speed is carried exactly.
   */
  carries() { return [0, Infinity]; }
  topSpeed() { return Infinity; }
  gaitFor(want) { return { clip: want > 1.4 ? "chase" : "walk", speed: want, miss: 0 }; }

  /** No fingers on the stand-in, so there is nothing to close. */
  grip() {}

  /** Same contract as the rigged model; the stand-in's head is a bare sphere. */
  look(yaw = 0, pitch = 0) {
    this.lookYaw = THREE.MathUtils.clamp(yaw, -1.3, 1.3);
    this.lookPitch = THREE.MathUtils.clamp(pitch, -0.55, 0.55);
  }

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
    // This head faces +Z with no wrapper rotation, so the offsets go straight
    // on. Pitch is negated: rotating +Z about local +X by a positive angle
    // drops the face, and a positive look pitch means looking up.
    this.head.rotation.y = this.lookYaw ?? 0;
    this.head.rotation.x = -(this.lookPitch ?? 0);
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
