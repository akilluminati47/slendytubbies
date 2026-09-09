import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { carve, BARK, ROCK } from "./surface.js";

/**
 * What grows on the wasteland.
 *
 * Everything here is one geometry drawn many times, and all of the variety is
 * per-instance: a matrix and a colour. That is the whole trick. Modelling five
 * kinds of tree costs five draw calls and five sets of vertices and still gives
 * you five kinds of tree; deriving height, girth, taper and colour from a seeded
 * hash gives you as many as you have instances, out of one.
 *
 * The numbers are real ones. A Norway spruce is 12 to 25 metres with a trunk
 * somewhere between a fifth and a thirtieth of its height, and it holds a
 * roughly conical crown in whorls of branches that get shorter toward the top.
 * Bark is the giveaway for age: young trunks are thin, smooth and red-brown,
 * old ones are thick, grey and deeply furrowed. So girth, bark colour and how
 * ragged the crown is all come off the same one number, and a stand of these
 * reads as trees of different ages rather than as one tree at different sizes.
 */

/* --------------------------------------------------------------- evergreen -- */

/**
 * A trunk with bark on it.
 *
 * Eight sides, not five, and the radius of each one jittered so the silhouette
 * has flats and ridges rather than being a clean prism. Flat-shaded, so those
 * ridges catch the light separately and read as furrows from a distance - which
 * is the only distance any of this is ever seen from.
 */
function trunkGeometry(rand) {
  const SIDES = 8, RINGS = 5, H = 1, R_BOT = 0.055, R_TOP = 0.022;
  const pos = [], idx = [];
  for (let ring = 0; ring <= RINGS; ring++) {
    const t = ring / RINGS;
    // Taper is not linear. A real trunk flares at the base and then runs
    // nearly straight, which a straight cone does not do.
    const r = R_BOT + (R_TOP - R_BOT) * Math.pow(t, 0.62);
    const y = t * H;
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      // The furrow. Fixed per side per ring, so it runs UP the trunk as a
      // ridge instead of being noise that changes every course.
      const bump = 1 + (rand() - 0.5) * 0.22;
      pos.push(Math.cos(a) * r * bump, y, Math.sin(a) * r * bump);
    }
  }
  for (let ring = 0; ring < RINGS; ring++) {
    for (let s = 0; s < SIDES; s++) {
      const a = ring * SIDES + s, b = ring * SIDES + (s + 1) % SIDES;
      const c = a + SIDES, d = b + SIDES;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * The crown, as whorls.
 *
 * Three stacked cones rather than one, because a single cone is a party hat and
 * an evergreen is a stack of shorter and shorter skirts. The overlap is what
 * gives the silhouette its steps.
 */
function crownGeometry() {
  // Radii as fractions of the tree's HEIGHT, and small ones. A spruce twenty
  // metres tall carries a crown about two and a half metres across the widest
  // whorl - roughly an eighth of its height, not half of it. Getting this wrong
  // is not just a look: the crown radius is what the placement grid keeps clear,
  // so a fat crown thins the whole forest out by rejecting its own neighbours.
  const tiers = [
    { y: 0.30, r: 0.155, h: 0.42, seg: 7 },
    { y: 0.55, r: 0.115, h: 0.36, seg: 7 },
    { y: 0.76, r: 0.070, h: 0.30, seg: 6 },
  ];
  const parts = tiers.map((t) => {
    const g = new THREE.ConeGeometry(t.r, t.h, t.seg);
    g.translate(0, t.y + t.h * 0.5, 0);
    return g;
  });
  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/* ---------------------------------------------------------------- branches -- */

/**
 * Deadwood, in six shapes.
 *
 * One geometry meant every stick on the map was the same stick at different
 * sizes, and its two stubs were planted straight through the middle of the main
 * limb - so they met inside it and read as one lump rather than as a branch with
 * branches. Both problems are the same problem: a fallen limb is a shape, and
 * shapes have to differ.
 *
 * So there are six of them, and the offshoots are seated ON the surface at
 * angles round the limb rather than driven through its axis, spaced apart down
 * its length and separated in azimuth so no two ever meet. Six geometries is
 * six draw calls for the whole map's worth of deadwood, which at this count is
 * cheaper than one of the trees.
 */
const BRANCH_KINDS = ["whole", "snapped", "forked", "bare", "splintered", "twin"];

/**
 * One offshoot, seated on the surface of a limb lying along +X.
 *
 * @param px    where along the limb, in its own units
 * @param phi   which way round the limb it points
 * @param splay how far it is swept toward the limb's tip rather than straight out
 */
function offshoot(px, r, phi, splay, len, thick, toward) {
  const g = new THREE.CylinderGeometry(thick * 0.5, thick, len, 4);
  // Base at the origin, so the rotation below pivots about where it joins.
  g.translate(0, len * 0.5, 0);
  // Radial, then swept along the limb. A real branch leaves its parent leaning
  // toward the tip, not square to it.
  const radial = new THREE.Vector3(0, Math.cos(phi), Math.sin(phi));
  const dir = radial.clone().multiplyScalar(Math.cos(splay))
    .addScaledVector(new THREE.Vector3(toward, 0, 0), Math.sin(splay)).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  // Seated a hair inside the surface so there is no gap, and no further: driven
  // to the axis is what made them collide with each other in the middle.
  g.translate(px + dir.x * -0.004,
              radial.y * r * 0.85, radial.z * r * 0.85);
  return g;
}

/** A splintered end: a few slivers running on past where the wood gave way. */
function splinters(atX, r, rand, n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = r * (1.6 + rand() * 3.4);
    const g = new THREE.CylinderGeometry(0.0006, r * (0.20 + rand() * 0.22), len, 3);
    g.translate(0, len * 0.5, 0);
    const a = rand() * Math.PI * 2, tilt = 0.10 + rand() * 0.24;
    const dir = new THREE.Vector3(
      Math.sign(atX), Math.cos(a) * tilt, Math.sin(a) * tilt).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    g.translate(atX, Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4);
    out.push(g);
  }
  return out;
}

function branchGeometry(rand, kind) {
  const parts = [];
  // The limb itself. Length and girth are independent, so a stout log and a
  // long whip are both reachable before the per-instance scale touches it.
  const L = kind === "splintered" ? 0.42 + rand() * 0.3
          : kind === "twin" ? 0.7 + rand() * 0.35
          : 0.85 + rand() * 0.45;
  const r = (kind === "bare" ? 0.05 : 0.032) * (0.7 + rand() * 0.85);
  const seg = 5;

  // A snapped limb tapers to nothing at one end; an intact one keeps its tip.
  const tipR = kind === "snapped" || kind === "splintered" ? r * 0.32 : r * 0.6;
  const main = new THREE.CylinderGeometry(tipR, r, L, seg);
  main.rotateZ(Math.PI / 2);   // lie it along +X, tip toward -X
  parts.push(main);

  // Offshoots, spaced down the limb and around it so no two can ever meet.
  // Positions are drawn from separate bands and the azimuths are pushed a third
  // of a turn apart, which is what stops them growing into one another.
  const count = { whole: 3, snapped: 2, forked: 1, bare: 0, splintered: 1, twin: 2 }[kind];
  let phi = rand() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const band = (i + 0.25 + rand() * 0.5) / (count + 0.4);
    const px = (band - 0.5) * L * 0.86;
    // At least a third of a turn on from the last one, plus a little slop.
    phi += 2.09 + rand() * 1.2;
    const splay = 0.55 + rand() * 0.55;
    const len = kind === "forked" ? L * (0.42 + rand() * 0.22)
                                  : L * (0.16 + rand() * 0.22);
    const thick = (kind === "forked" ? r * 0.75 : r * (0.4 + rand() * 0.28));
    parts.push(offshoot(px, r * 0.92, phi, splay, len, thick, rand() < 0.72 ? -1 : 1));
  }

  if (kind === "splintered") parts.push(...splinters(-L * 0.5, tipR, rand, 3));
  if (kind === "snapped") parts.push(...splinters(-L * 0.5, tipR, rand, 2));
  if (kind === "twin") {
    // A second limb fallen alongside the first, not touching it.
    const l2 = L * (0.5 + rand() * 0.35), r2 = r * (0.55 + rand() * 0.4);
    const g = new THREE.CylinderGeometry(r2 * 0.5, r2, l2, 4);
    g.rotateZ(Math.PI / 2);
    g.rotateY(0.3 + rand() * 0.7);
    // Clear of the first by more than both radii, so they lie side by side.
    g.translate((rand() - 0.5) * L * 0.3, -r * 0.35 + r2 * 0.35,
                (r + r2) * (1.6 + rand() * 1.4));
    parts.push(g);
  }

  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/* ------------------------------------------------------------------- grass -- */

/**
 * A clump of blades.
 *
 * Solid tapered strips, not alpha-cut cards. Transparency in a scene with this
 * much fog costs a sort and buys nothing at the size these are drawn: a blade
 * of grass is two or three pixels, and two or three pixels of cut-out alpha is
 * just a shimmering dot.
 */
function grassGeometry(rand) {
  const parts = [];
  // Four, not five. The count of tufts on the map matters far more to how the
  // ground reads than the count of blades in one of them, and dropping one
  // blade pays for a fifth more tufts at the same triangle budget.
  const blades = 4;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rand() * 0.8;
    const lean = 0.22 + rand() * 0.4;
    const h = 0.22 + rand() * 0.2;
    const w = 0.016 + rand() * 0.012;
    // Base pair, a mid pair leaning over, and a tip. Two triangles, one bend.
    const tipX = Math.cos(a) * lean * h, tipZ = Math.sin(a) * lean * h;
    const pos = [
      -w, 0, 0, w, 0, 0,
      tipX * 0.45 - w * 0.5, h * 0.55, tipZ * 0.45,
      tipX * 0.45 + w * 0.5, h * 0.55, tipZ * 0.45,
      tipX, h, tipZ,
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex([0, 2, 1, 1, 2, 3, 2, 4, 3]);
    g.computeVertexNormals();
    // Spread wider than before, so one tuft covers ground rather than being a
    // spike. Clumps that touch read as cover; clumps that do not read as spikes.
    g.translate((rand() - 0.5) * 0.26, 0, (rand() - 0.5) * 0.26);
    parts.push(g);
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/* ------------------------------------------------------------------- rocks -- */

/** Three boulders that are not the same boulder. */
function rockGeometries() {
  return [
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.OctahedronGeometry(1, 1),
  ];
}

/* ------------------------------------------------------------------ colour -- */

const _c = new THREE.Color();

/**
 * Bark, by age.
 *
 * Young wood is thin, smooth and red-brown; old wood is thick, grey and cracked
 * open. `age` runs 0 to 1 across the stand, and it is the same number that sets
 * how big the tree is - so the big ones really are the old ones.
 */
function barkColor(age, rand) {
  return _c.setHSL(
    0.075 - age * 0.02,                       // red-brown cooling toward grey
    0.34 - age * 0.26 + (rand() - 0.5) * 0.05,
    0.085 + age * 0.075 + (rand() - 0.5) * 0.02);
}

/** Needles, from dark blue-green to a tired yellow-green. */
function needleColor(rand) {
  return _c.setHSL(
    0.245 + (rand() - 0.5) * 0.075,
    0.35 + rand() * 0.3,
    0.055 + rand() * 0.07);
}

/**
 * Sow grass over a patch of ground.
 *
 * Pulled out of plantWorld because the menu stage wants grass and nothing else -
 * no trees, no rocks, no collision grid to consult - and the alternative was a
 * second copy of the same twenty lines that would drift from this one.
 *
 * @param half   half-extents of the patch, around `at`
 * @param clear  optional (x,z) => is this spot free of anything solid
 * @param sat    multiplier on how much colour the blades keep, for callers that
 *               want the drained look rather than a living field
 */
/**
 * How wide a chunk of scatter is, in metres.
 *
 * Small enough that most of what is in one is inside the fog together, large
 * enough that there are not so many that walking the scene graph costs more
 * than the drawing saved. At 20 m over a 220 m map that is 121 cells, of which
 * about five are ever in front of you.
 */
const CHUNK = 20;

/**
 * Scatter as one InstancedMesh PER CELL rather than one for the whole map.
 *
 * A single instanced mesh is one draw call, which is why everything here was
 * built that way - but one draw call is not the same as cheap. Its bounding
 * sphere covers the entire map, so the frustum can never reject it, and every
 * instance in it is transformed and shaded every frame whether it is behind you
 * or two hundred metres into fog that ends at thirty-four. The grass alone was
 * 44,298 instances and 531,576 triangles, which is 81% of everything drawn, to
 * show the two percent of the map you can actually see.
 *
 * Split into cells, each mesh gets a bounding sphere twenty metres across, and
 * three throws away the ones outside the view for free. Nothing about what
 * reaches the screen changes - the same tufts stand in the same places - only
 * the ones that were never going to be visible stop being sent.
 *
 * The cost is draw calls, and it is small: five or six instead of one, against
 * a budget where the whole frame is thirty-seven.
 */
function sowChunked(scene, items, name, build, write, cell = CHUNK) {
  const cells = new Map();
  for (const it of items) {
    const key = Math.floor(it.x / cell) + "," + Math.floor(it.z / cell);
    let bin = cells.get(key);
    if (!bin) cells.set(key, bin = []);
    bin.push(it);
  }
  const meshes = [], chunks = [];
  for (const bin of cells.values()) {
    const mesh = build(bin.length);
    bin.forEach((it, i) => write(mesh, i, it));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = name;
    // Off the instances, not the geometry: this is the sphere the frustum test
    // uses, and the whole point is that it is now small.
    mesh.computeBoundingSphere();
    scene.add(mesh);
    meshes.push(mesh);
    const b = mesh.boundingSphere;
    chunks.push({ mesh, cx: b.center.x, cz: b.center.z, r: b.radius });
  }
  return { meshes, chunks };
}

export function sowGrass(scene, { rand, heightAt, count, half, at = { x: 0, z: 0 },
                                  clear = null, sat = 1, name = "flora:grass" }) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const v = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  // Dense enough that neighbouring clumps touch, which is the difference
  // between ground cover and a scattering of spikes. It is the single biggest
  // line item on the map - about two thirds of every triangle drawn - which is
  // affordable only because it is one draw call and casts no shadows.
  const tufts = [];
  for (let i = 0; i < count; i++) {
    const x = at.x + (rand() - 0.5) * half.x * 2;
    const z = at.z + (rand() - 0.5) * half.z * 2;
    if (clear && !clear(x, z)) continue;
    tufts.push({ x, z, k: 0.7 + rand() * 0.9, rot: rand() * 6.283,
                 // Greener in the hollows, where the water is.
                 wet: THREE.MathUtils.clamp(0.5 - heightAt(x, z) * 0.1, 0, 1),
                 j: rand() });
  }
  // One geometry and one material for every cell, so splitting the scatter up
  // costs no extra uploads and no extra shader programs - only the per-cell
  // instance buffers, which hold the same instances they always did.
  const geo = grassGeometry(rand);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0, flatShading: true,
  });
  const out = sowChunked(scene, tufts, name,
    (n) => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      // No shadows. Putting this many tufts through the torch's depth pass is
      // the single most expensive thing this file could ask for, and it would
      // buy a pattern of specks nobody would ever identify as grass.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      return mesh;
    },
    (mesh, i, g) => {
      q.setFromAxisAngle(up, g.rot);
      mesh.setMatrixAt(i, m.compose(
        v.set(g.x, heightAt(g.x, g.z) - 0.02, g.z), q,
        sc.set(g.k, g.k * (0.8 + g.j * 0.5), g.k)));
      mesh.setColorAt(i, _c.setHSL(
        0.16 + g.wet * 0.09 + (g.j - 0.5) * 0.03,
        (0.22 + g.wet * 0.24) * sat,
        0.075 + g.j * 0.055));
    });
  return { ...out, count: tufts.length };
}

/**
 * Everything scattered on the ground, built into `scene`.
 *
 * @param place  World.place, so trees and rocks still go through the same
 *               rejection grid everything else does
 * @param clear  (x, z) => is this spot free of anything solid
 */
export function plantWorld(scene, { rand, heightAt, size, place, clear, counts }) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const v = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const half = size / 2 - 6;
  // Every mesh this puts in the scene, handed back so the caller can take the
  // whole round out again. A restart used to be a page reload, so nothing ever
  // needed removing; now that it is not, anything added has to be returnable.
  const built = { meshes: [] };

  // --- trees -------------------------------------------------------------
  // Height first, everything else derived from it. 9 m saplings to 23 m
  // veterans, which is the real range for a spruce stand of mixed age.
  const trees = [];
  const edgeCount = Math.floor(counts.tree * 0.3);
  for (let i = 0; i < counts.tree; i++) {
    const edge = i < edgeCount;
    const age = rand();
    const stout = rand();
    const h = 9 + age * 14;
    // The widest whorl, which is what has to be kept clear. Crowns interlock a
    // little (0.62) or the forest reads as an orchard; the treeline packs
    // tighter still so it stays an unbroken wall.
    const spread = h * 0.155 * 0.62;
    // Trunk radius, in metres, for a collision the player can feel. About a
    // third of a metre on a big one.
    const trunkR = h * 0.055 * (0.19 + age * 0.10) * (0.82 + stout * stout * 1.05);
    const spot = place(spread * (edge ? 0.68 : 1), Math.max(trunkR * 1.6, 0.3), () => {
      if (edge) {
        const a = rand() * Math.PI * 2, r = half - rand() * 10;
        return [Math.cos(a) * r, Math.sin(a) * r];
      }
      return [(rand() - 0.5) * size * 0.9, (rand() - 0.5) * size * 0.9];
    });
    if (spot) trees.push({ x: spot.x, z: spot.z, h, age, rot: rand() * 6.283,
                           lean: (rand() - 0.5) * 0.06,
                           // Girth is not a fixed fraction of height: old trees
                           // are stout, young ones are whips. The trunk
                           // geometry is a unit-height stick of radius 0.055,
                           // so this is a multiplier on that, not a radius.
                           //
                           // The squared term is an independent stoutness on
                           // top of age, and squared so that most trees sit near
                           // the slim end with a long tail out to the fat ones -
                           // which is what a stand looks like. Tying girth to
                           // height alone made every big tree the same big tree.
                           girth: h * (0.19 + age * 0.10) * (0.82 + stout * stout * 1.05),
                           bark: barkColor(age, rand).getHex(),
                           needle: needleColor(rand).getHex() });
  }

  const white = () => new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0, flatShading: true,
  });

  // Bark, carved rather than painted. Furrows run up the trunk from its own
  // object space, so they climb the tree they are on instead of sliding as the
  // instance moves - and one material still covers all 420 of them.
  // Set on the bench. Almost no relief and all the colour: bark reads through
  // its grain and its patchiness far more than through raised ridges, which at
  // any strength worth seeing turned the trunks corrugated.
  const barkMat = carve(white(), BARK, { bump: 0.05, mottle: 0.5, tint: 0x14100b });
  // NOT chunked, unlike the grass, and the measurement is why.
  //
  // Cell size trades triangles submitted against draw calls made, and which way
  // that trade falls depends entirely on how many things are in the scatter.
  // Grass is 44,298 instances and fine cells throw away enormous numbers of them
  // for a handful of calls. Trees are 420 and they cast shadows, so their cull
  // has to reach far past the fog - a 23 m spruce with the sun low lays a shadow
  // forty metres in front of itself, across ground you are standing on. At that
  // reach, sampling 400 eye positions across the map, not one tree cell was ever
  // culled: thirty extra meshes and thirty extra draw calls to hide nothing.
  //
  // One mesh each, as before.
  const trunks = new THREE.InstancedMesh(trunkGeometry(rand), barkMat, trees.length);
  const crowns = new THREE.InstancedMesh(crownGeometry(), white(), trees.length);
  trees.forEach((t, i) => {
    const y = heightAt(t.x, t.z);
    // A tilt off vertical, so a stand does not look like a bar chart.
    q.setFromAxisAngle(up, t.rot);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), t.lean));
    trunks.setMatrixAt(i, m.compose(v.set(t.x, y, t.z), q, sc.set(t.girth, t.h, t.girth)));
    crowns.setMatrixAt(i, m.compose(v.set(t.x, y, t.z), q, sc.set(t.h, t.h, t.h)));
    trunks.setColorAt(i, _c.setHex(t.bark));
    crowns.setColorAt(i, _c.setHex(t.needle));
  });
  trunks.name = "flora:trunks";
  crowns.name = "flora:crowns";
  trunks.castShadow = crowns.castShadow = true;
  trunks.receiveShadow = crowns.receiveShadow = true;
  scene.add(trunks, crowns);
  built.meshes.push(trunks, crowns);
  built.trees = trees.length;
  // Where the roof is, for the rain to break on. A disc per tree at the widest
  // whorl, with its underside at the bottom of the lowest one - the same
  // numbers crownGeometry lays the cones out from, so the rain stops where the
  // needles actually start and not at some second guess at a tree's shape.
  built.canopy = trees.map((t) => ({
    x: t.x, z: t.z,
    r: t.h * 0.155,
    y: heightAt(t.x, t.z) + t.h * 0.30,
  }));

  // --- rocks -------------------------------------------------------------
  // Three shapes, squashed differently and half buried, so no two read as the
  // same object even before the colour varies.
  const shapes = rockGeometries();
  const buckets = shapes.map(() => []);
  for (let i = 0; i < counts.rock; i++) {
    const k = 0.5 + rand() * 1.7;
    const spot = place(k * 1.05, k * 0.75,
      () => [(rand() - 0.5) * size * 0.85, (rand() - 0.5) * size * 0.85]);
    if (!spot) continue;
    buckets[Math.floor(rand() * shapes.length)].push({
      x: spot.x, z: spot.z, k,
      // Non-uniform, so they are boulders rather than balls.
      sx: k * (0.8 + rand() * 0.5), sy: k * (0.42 + rand() * 0.4), sz: k * (0.8 + rand() * 0.5),
      sink: 0.15 + rand() * 0.4,
      ax: [rand() - 0.5, rand() - 0.5, rand() - 0.5], rot: rand() * 6.283,
      // Weathered granite through to wet slate, plus a little lichen green.
      color: _c.setHSL(0.09 + rand() * 0.12, 0.03 + rand() * 0.09,
                       0.055 + rand() * 0.075).getHex(),
    });
  }
  // Boulders catch rain too - a wet rock in a shower is one of the few things
  // in a wood that looks like it is being rained on rather than near. The base
  // shapes are radius 1, so the crown of one sits sy above a centre already
  // lifted by sy * (0.5 - sink). Nothing shelters under a rock, but the same
  // disc that decides where a splash lands decides that, and the cost of it
  // sheltering a patch of ground it is standing on is nothing at all.
  for (const list of buckets) {
    for (const r of list) {
      built.canopy.push({
        x: r.x, z: r.z,
        r: Math.max(r.sx, r.sz),
        y: heightAt(r.x, r.z) + r.sy * (1.5 - r.sink),
      });
    }
  }

  let rocksPlaced = 0;
  shapes.forEach((geo, gi) => {
    const list = buckets[gi];
    if (!list.length) { geo.dispose(); return; }
    // Stone breaks rather than wearing, so its field is ridged and sharper than
    // the ground's. Object space again: the grain belongs to the boulder.
    const mesh = new THREE.InstancedMesh(
      geo, carve(white(), ROCK, { bump: 0.05, mottle: 1, tint: 0x1a1a18 }), list.length);
    list.forEach((r, i) => {
      q.setFromAxisAngle(v.set(...r.ax).normalize(), r.rot);
      mesh.setMatrixAt(i, m.compose(
        v.set(r.x, heightAt(r.x, r.z) + r.sy * (0.5 - r.sink), r.z), q,
        sc.set(r.sx, r.sy, r.sz)));
      mesh.setColorAt(i, _c.setHex(r.color));
    });
    mesh.name = "flora:rock" + gi;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    built.meshes.push(mesh);
    rocksPlaced += list.length;
  });
  built.rocks = rocksPlaced;

  // --- fallen branches ---------------------------------------------------
  // Not placed through the grid. They are ankle height and decorative, so
  // rejecting them against every trunk on the map would cost a great deal of
  // work to prevent something nobody would notice; a cheap "is this spot solid"
  // test is enough to keep them out of the middle of a rock.
  //
  // Six shapes, each its own instanced mesh, and each stick additionally
  // stretched and fattened independently by its instance - so length and girth
  // vary on top of the shape rather than only with it, and a short thick log
  // and a long thin whip are both reachable from the same geometry.
  const limbBuckets = BRANCH_KINDS.map(() => []);
  for (let i = 0; i < counts.branch; i++) {
    const x = (rand() - 0.5) * size * 0.88, z = (rand() - 0.5) * size * 0.88;
    if (!clear(x, z)) continue;
    limbBuckets[Math.floor(rand() * BRANCH_KINDS.length)].push({
      x, z,
      len: 0.55 + rand() * 1.25,
      girth: 0.6 + rand() * 1.1,
      rot: rand() * 6.283,
      roll: rand() * 6.283,
      age: rand(),
    });
  }
  // Where they ended up, in one flat array of [x, z, reach] triples.
  //
  // The instanced meshes keep their own matrices and nothing can read a
  // position back out of them cheaply, so the only record of where a stick
  // lies would otherwise be discarded the moment it is drawn - and something
  // does want to know: sprinting over one is a chance to go down. Reach is the
  // stick's half-length plus a little, in metres, so the test is against the
  // wood rather than against a point in the middle of it.
  const spots = [];
  let limbCount = 0;
  BRANCH_KINDS.forEach((kind, ki) => {
    const list = limbBuckets[ki];
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(branchGeometry(rand, kind), white(), list.length);
    list.forEach((b, i) => {
      q.setFromAxisAngle(up, b.rot);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), b.roll));
      mesh.setMatrixAt(i, m.compose(
        v.set(b.x, heightAt(b.x, b.z) + 0.03 * b.girth, b.z), q,
        sc.set(b.len, b.girth, b.girth)));
      // Deadwood: greyer than the tree it fell off, and greyer the longer it
      // has been lying there.
      mesh.setColorAt(i, _c.setHSL(0.08, 0.12 - b.age * 0.08, 0.07 + b.age * 0.05));
      spots.push(b.x, b.z, b.len * 0.5 + 0.22);
    });
    mesh.name = "flora:deadwood:" + kind;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    built.meshes.push(mesh);
    limbCount += list.length;
  });
  built.branches = limbCount;
  built.branchSpots = new Float32Array(spots);

  // --- grass -------------------------------------------------------------
  const grass = sowGrass(scene, {
    rand, heightAt, count: counts.grass,
    half: { x: size * 0.47, z: size * 0.47 },
    clear,
  });
  built.grass = grass.count;
  built.meshes.push(...grass.meshes);
  built.chunks = grass.chunks;

  return built;
}
