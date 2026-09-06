#!/usr/bin/env node
/**
 * Assemble dist/ - exactly what the game needs at runtime, nothing else.
 *
 * Cloudflare Pages uploads whatever directory you point it at and does NOT
 * honour .assetsignore (that is a Workers-static-assets feature), so deploying
 * the repo root publishes node_modules and the whole raw assets/models rip
 * cache. Building an explicit output directory is the only reliable way to
 * control what ships.
 */
import { cp, rm, mkdir, readdir, stat, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// Everything here is loaded by the browser. If it is not in this list, it is
// tooling or a source asset and has no business on the CDN.
const INCLUDE = [
  "index.html",
  "src",
  "vendor",
  "assets/game/face_tinkywinky.png",
  "assets/game/fonts",
  // The rigged models. assets/game/rig/chaser is deliberately absent: it is the
  // static TinkyWinkyNPC rip, which has no skeleton and so cannot be animated,
  // and the only thing we take from it is its face - already shipped above as
  // face_tinkywinky.png, byte for byte the same file.
  "assets/game/rig/skin",
  "assets/game/rig/donor",
];

/**
 * The donors are never drawn, only read for their animation curves, so their
 * materials and textures are dead weight on the wire - 5.4MB of chainsaw and axe
 * that no player will ever see. Strip the material side of each donor after
 * copying and drop the texture folder with it. The meshes stay, because that is
 * where GLTFLoader finds the skeleton.
 */
async function stripDonorTextures(dir) {
  let saved = 0;
  for (const name of await readdir(dir)) {
    const gltfPath = join(dir, name, "scene.gltf");
    const texDir = join(dir, name, "textures");
    let gltf;
    try {
      gltf = JSON.parse(await readFile(gltfPath, "utf8"));
    } catch {
      continue;
    }
    try {
      saved += await bytes(texDir);
      await rm(texDir, { recursive: true, force: true });
    } catch { /* no textures to begin with */ }

    delete gltf.materials;
    delete gltf.textures;
    delete gltf.images;
    delete gltf.samplers;
    for (const mesh of gltf.meshes ?? []) {
      for (const prim of mesh.primitives ?? []) delete prim.material;
    }
    await writeFile(gltfPath, JSON.stringify(gltf));
    console.log(`  - ${name}: materials and textures stripped`);
  }
  return saved;
}

async function countFiles(dir) {
  let n = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    n += entry.isDirectory() ? await countFiles(full) : 1;
  }
  return n;
}

async function bytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? await bytes(full) : (await stat(full)).size;
  }
  return total;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const rel of INCLUDE) {
  const from = join(root, rel);
  const to = join(dist, rel);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`  + ${rel}`);
}

const saved = await stripDonorTextures(join(dist, "assets/game/rig/donor"));
console.log(`  ${(saved / 1e6).toFixed(1)} MB of donor textures dropped`);

const n = await countFiles(dist);
const mb = (await bytes(dist)) / 1e6;
console.log(`\ndist/: ${n} files, ${mb.toFixed(1)} MB`);
