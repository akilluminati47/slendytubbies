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
import { cp, rm, mkdir, readdir, stat } from "node:fs/promises";
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
];

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

const n = await countFiles(dist);
const mb = (await bytes(dist)) / 1e6;
console.log(`\ndist/: ${n} files, ${mb.toFixed(1)} MB`);
