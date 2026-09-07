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
  const grass = new THREE.InstancedMesh(grassGeometry(rand), new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0, flatShading: true,
  }), tufts.length);
  tufts.forEach((g, i) => {
    q.setFromAxisAngle(up, g.rot);
    grass.setMatrixAt(i, m.compose(
      v.set(g.x, heightAt(g.x, g.z) - 0.02, g.z), q, sc.set(g.k, g.k * (0.8 + g.j * 0.5), g.k)));
    grass.setColorAt(i, _c.setHSL(
      0.16 + g.wet * 0.09 + (g.j - 0.5) * 0.03,
      (0.22 + g.wet * 0.24) * sat,
      0.075 + g.j * 0.055));
  });
  grass.name = name;
  // No shadows. Putting this many tufts through the torch's depth pass is the
  // single most expensive thing this file could ask for, and it would buy a
  // pattern of specks nobody would ever identify as grass.
  grass.castShadow = false;
  grass.receiveShadow = true;
  scene.add(grass);
  return tufts.length;
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
  trunks.name = "flora:trunks";
  crowns.name = "flora:crowns";
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
    mesh.name = "flora:rock" + gi;
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
    });
    mesh.name = "flora:deadwood:" + kind;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    limbCount += list.length;
  });
  built.branches = limbCount;

  // --- grass -------------------------------------------------------------
  built.grass = sowGrass(scene, {
    rand, heightAt, count: counts.grass,
    half: { x: size * 0.47, z: size * 0.47 },
    clear,
  });

  return built;
}
