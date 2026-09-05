#!/usr/bin/env node
/**
 * Dump the structure of a GLB: node transforms, skins, inverse bind matrices,
 * and the raw extent of each mesh's POSITION accessor.
 *
 * Written because the rig kept binding "correctly" by every runtime check while
 * still rendering nowhere. Guessing at Blender's export conventions was not
 * converging; reading what actually landed in the file settles it in one pass.
 */
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "assets/game/tubbies.glb";
const buf = readFileSync(path);

// --- GLB container: 12-byte header, then chunks -----------------------------
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
let off = 12;
let json = null;
let bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  else if (type === 0x004e4942) bin = data;
  off += 8 + len + ((4 - (len % 4)) % 4);
}

const g = json;
const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function read(accessorIndex) {
  const a = g.accessors[accessorIndex];
  const bv = g.bufferViews[a.bufferView];
  const Type = COMPONENT[a.componentType];
  const n = COUNT[a.type];
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return new Type(bin.buffer, bin.byteOffset + start, a.count * n);
}

const f = (x) => (Math.abs(x) < 1e-6 ? 0 : +x.toFixed(3));

console.log(`${path}`);
console.log(`  nodes ${g.nodes.length}  meshes ${g.meshes.length}  ` +
  `skins ${(g.skins ?? []).length}  animations ${(g.animations ?? []).length}`);

// --- which nodes carry a skin, and what transform do they have? -------------
console.log("\nSKINNED MESH NODES (glTF says their transform MUST be ignored):");
let flagged = 0;
g.nodes.forEach((n, i) => {
  if (n.skin === undefined) return;
  const t = n.translation ?? [0, 0, 0];
  const s = n.scale ?? [1, 1, 1];
  const r = n.rotation ?? [0, 0, 0, 1];
  const identity = t.every((v) => Math.abs(v) < 1e-6) &&
    s.every((v) => Math.abs(v - 1) < 1e-6) &&
    Math.abs(r[3] - 1) < 1e-6;
  if (!identity && flagged++ < 6) {
    console.log(`  node ${i} "${n.name}" NOT identity: ` +
      `t=[${t.map(f)}] s=[${s.map(f)}] r=[${r.map(f)}]`);
  }
});
console.log(`  ${flagged} skinned node(s) carry a transform`);

// --- the skin itself --------------------------------------------------------
for (const [si, skin] of (g.skins ?? []).entries()) {
  console.log(`\nSKIN ${si}: ${skin.joints.length} joints` +
    `${skin.skeleton !== undefined ? `, skeleton root node ${skin.skeleton}` : ""}`);
  const ibm = read(skin.inverseBindMatrices);
  // Column-major; translation is elements 12,13,14 of each mat4.
  for (const j of [0, 1, 2]) {
    const m = ibm.subarray(j * 16, j * 16 + 16);
    const jointNode = g.nodes[skin.joints[j]];
    console.log(`  joint ${j} "${jointNode.name}" IBM translation ` +
      `[${f(m[12])}, ${f(m[13])}, ${f(m[14])}]  scale-ish [${f(m[0])}, ${f(m[5])}, ${f(m[10])}]`);
  }
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < skin.joints.length; j++) {
    const y = -ibm[j * 16 + 13];   // rough: inverse-bind translation negated
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  console.log(`  joints span y ~${f(minY)} .. ${f(maxY)} (from inverse binds)`);
}

// --- where the vertices actually live ---------------------------------------
console.log("\nMESH POSITION EXTENTS (object space, as written to the file):");
const seen = new Set();
g.meshes.forEach((m, i) => {
  const node = g.nodes.find((n) => n.mesh === i);
  const name = node?.name ?? m.name ?? `mesh${i}`;
  const key = name.replace(/_\d+$/, "");
  if (seen.has(key) && seen.size > 6) return;
  seen.add(key);
  for (const prim of m.primitives) {
    const a = g.accessors[prim.attributes.POSITION];
    if (!a.min) continue;
    console.log(`  ${name}: y ${f(a.min[1])} .. ${f(a.max[1])}` +
      `   (x ${f(a.min[0])}..${f(a.max[0])}, z ${f(a.min[2])}..${f(a.max[2])})` +
      `${prim.attributes.JOINTS_0 !== undefined ? "  [skinned]" : "  [static]"}`);
    break;
  }
});

// --- node hierarchy above the joints ----------------------------------------
const parentOf = new Map();
g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
const skin = g.skins?.[0];
if (skin) {
  let node = skin.joints[0];
  const chain = [];
  while (node !== undefined) {
    const n = g.nodes[node];
    const t = n.translation ?? [0, 0, 0];
    const s = n.scale ?? [1, 1, 1];
    chain.push(`${n.name} t=[${t.map(f)}] s=[${s.map(f)}]`);
    node = parentOf.get(node);
  }
  console.log("\nANCESTRY OF JOINT 0 (root last):");
  chain.forEach((c) => console.log(`  ${c}`));
}
