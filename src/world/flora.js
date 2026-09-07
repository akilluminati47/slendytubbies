import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

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

/** A fallen limb: a length of wood with two stubs off it. */
function branchGeometry() {
  const parts = [];
  const main = new THREE.CylinderGeometry(0.028, 0.045, 1.0, 5);
  main.rotateZ(Math.PI / 2);
  parts.push(main);
  for (const [at, ang, len] of [[0.12, 0.7, 0.34], [-0.2, -0.95, 0.26]]) {
    const s = new THREE.CylinderGeometry(0.014, 0.024, len, 4);
    s.translate(0, len * 0.5, 0);
    s.rotateZ(ang);
    s.translate(at, 0.01, 0);
    parts.push(s);
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
  const blades = 5;
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
    g.translate((rand() - 0.5) * 0.12, 0, (rand() - 0.5) * 0.12);
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
  const built = {};

  // --- trees -------------------------------------------------------------
  // Height first, everything else derived from it. 9 m saplings to 23 m
  // veterans, which is the real range for a spruce stand of mixed age.
  const trees = [];
  const edgeCount = Math.floor(counts.tree * 0.3);
  for (let i = 0; i < counts.tree; i++) {
    const edge = i < edgeCount;
    const age = rand();
    const h = 9 + age * 14;
    // The widest whorl, which is what has to be kept clear. Crowns interlock a
    // little (0.62) or the forest reads as an orchard; the treeline packs
    // tighter still so it stays an unbroken wall.
    const spread = h * 0.155 * 0.62;
    // Trunk radius, in metres, for a collision the player can feel. About a
    // third of a metre on a big one.
    const trunkR = h * 0.055 * (0.19 + age * 0.10);
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
                           girth: h * (0.19 + age * 0.10),
                           bark: barkColor(age, rand).getHex(),
                           needle: needleColor(rand).getHex() });
  }

  const white = () => new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0, flatShading: true,
  });

  const trunks = new THREE.InstancedMesh(trunkGeometry(rand), white(), trees.length);
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
  trunks.castShadow = crowns.castShadow = true;
  trunks.receiveShadow = crowns.receiveShadow = true;
  scene.add(trunks, crowns);
  built.trees = trees.length;

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
  let rocksPlaced = 0;
  shapes.forEach((geo, gi) => {
    const list = buckets[gi];
    if (!list.length) { geo.dispose(); return; }
    const mesh = new THREE.InstancedMesh(geo, white(), list.length);
    list.forEach((r, i) => {
      q.setFromAxisAngle(v.set(...r.ax).normalize(), r.rot);
      mesh.setMatrixAt(i, m.compose(
        v.set(r.x, heightAt(r.x, r.z) + r.sy * (0.5 - r.sink), r.z), q,
        sc.set(r.sx, r.sy, r.sz)));
      mesh.setColorAt(i, _c.setHex(r.color));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    rocksPlaced += list.length;
  });
  built.rocks = rocksPlaced;

  // --- fallen branches ---------------------------------------------------
  // Not placed through the grid. They are ankle height and decorative, so
  // rejecting them against every trunk on the map would cost a great deal of
  // work to prevent something nobody would notice; a cheap "is this spot solid"
  // test is enough to keep them out of the middle of a rock.
  const limbs = [];
  for (let i = 0; i < counts.branch; i++) {
    const x = (rand() - 0.5) * size * 0.88, z = (rand() - 0.5) * size * 0.88;
    if (!clear(x, z)) continue;
    limbs.push({ x, z, k: 0.5 + rand() * 1.1, rot: rand() * 6.283,
                 roll: rand() * 6.283, age: rand() });
  }
  const branches = new THREE.InstancedMesh(branchGeometry(), white(), limbs.length);
  limbs.forEach((b, i) => {
    q.setFromAxisAngle(up, b.rot);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), b.roll));
    branches.setMatrixAt(i, m.compose(
      v.set(b.x, heightAt(b.x, b.z) + 0.03 * b.k, b.z), q, sc.set(b.k, b.k, b.k)));
    // Deadwood: greyer than the tree it fell off.
    branches.setColorAt(i, _c.setHSL(0.08, 0.12 - b.age * 0.08, 0.07 + b.age * 0.05));
  });
  branches.castShadow = true;
  branches.receiveShadow = true;
  scene.add(branches);
  built.branches = limbs.length;

  // --- grass -------------------------------------------------------------
  // Clumps, not a lawn. A tuft every metre and a half over a dead heath is what
  // the place is; a continuous sward would be a golf course, and would also be
  // invisible past the fog for ten times the triangles.
  const tufts = [];
  for (let i = 0; i < counts.grass; i++) {
    const x = (rand() - 0.5) * size * 0.94, z = (rand() - 0.5) * size * 0.94;
    if (!clear(x, z)) continue;
    tufts.push({ x, z, k: 0.7 + rand() * 0.9, rot: rand() * 6.283,
                 // Greener in the hollows, where the water is.
                 wet: THREE.MathUtils.clamp(0.5 - heightAt(x, z) * 0.1, 0, 1),
                 j: rand() });
  }
  const grass = new THREE.InstancedMesh(grassGeometry(rand), white(), tufts.length);
  tufts.forEach((g, i) => {
    q.setFromAxisAngle(up, g.rot);
    grass.setMatrixAt(i, m.compose(
      v.set(g.x, heightAt(g.x, g.z) - 0.02, g.z), q, sc.set(g.k, g.k * (0.8 + g.j * 0.5), g.k)));
    grass.setColorAt(i, _c.setHSL(
      0.16 + g.wet * 0.09 + (g.j - 0.5) * 0.03,
      0.22 + g.wet * 0.24,
      0.075 + g.j * 0.055));
  });
  // No shadows. Eighteen thousand tufts through the torch's depth pass is the
  // single most expensive thing this file could ask for, and it would buy a
  // pattern of specks nobody would ever identify as grass.
  grass.castShadow = false;
  grass.receiveShadow = true;
  scene.add(grass);
  built.grass = tufts.length;

  return built;
}
