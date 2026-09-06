import * as THREE from "three";
import { CFG } from "../game/config.js";
import { Sky } from "./sky.js";
import { makeCustard } from "./custard.js";

/** Deterministic PRNG so a seed always rebuilds the same wasteland. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/** Low, rolling hills. Sampled by everything that needs to sit on the ground. */
export function heightAt(x, z) {
  return Math.sin(x * 0.031) * 1.6
       + Math.cos(z * 0.027) * 1.4
       + Math.sin((x + z) * 0.013) * 2.2;
}

export class World {
  constructor(scene, seed = 20030815) {
    this.scene = scene;
    this.rand = rng(seed);
    this.obstacles = [];    // { x, z, r } for collision
    this.custards = [];     // interactive pickups
    this.grid = new Map();  // spatial hash of every placed footprint
    this.cell = 8;          // metres per hash cell
    this.maxSpace = 0;      // largest footprint placed so far

    scene.fog = new THREE.Fog(0x0a0c0a, CFG.world.fogNear, CFG.world.fogFar);

    // The sky owns the lighting as well as the backdrop: the two have to agree
    // about what time it is, and there is only one answer to that.
    this.sky = new Sky(scene, this.rand);
    // Created once, before any dish exists, and never removed.
    this.custardGlow = new THREE.PointLight(0xf070ee, 0, 9, 2);
    scene.add(this.custardGlow);
    this.#ground();
    this.#scatter();
    this.#custard();
  }

  /**
   * Mark where somebody died, for the rest of the round.
   *
   * A few overlapping discs rather than one, dropped along the terrain so they
   * follow it instead of hovering over a slope, and drawn with a polygon offset
   * so they never fight the ground for depth. Nothing removes them - a restart
   * reloads the page, so "the rest of the round" needs no bookkeeping.
   */
  stain(x, z, size = 1) {
    if (!this.stains) {
      this.stains = new THREE.Group();
      this.scene.add(this.stains);
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3d0508, roughness: 1, metalness: 0,
      transparent: true, opacity: 0.92,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      depthWrite: false,
    });

    const blobs = 5 + Math.floor(this.rand() * 4);
    for (let i = 0; i < blobs; i++) {
      const r = size * (0.35 + this.rand() * 0.75);
      const geo = new THREE.CircleGeometry(r, 14);
      geo.rotateX(-Math.PI / 2);
      // Ride the ground rather than a plane through it.
      const pos = geo.attributes.position;
      const ox = x + (this.rand() - 0.5) * size * 2.4;
      const oz = z + (this.rand() - 0.5) * size * 2.4;
      for (let v = 0; v < pos.count; v++) {
        pos.setY(v, heightAt(ox + pos.getX(v), oz + pos.getZ(v)) + 0.015 + i * 0.002);
      }
      geo.computeVertexNormals();
      const disc = new THREE.Mesh(geo, mat);
      disc.position.set(ox, 0, oz);
      disc.renderOrder = 1;
      this.stains.add(disc);
    }
    return this.stains.children.length;
  }

  #ground() {
    const n = 96, s = CFG.world.size;
    const geo = new THREE.PlaneGeometry(s, s, n, n);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3d4a33, roughness: 1, metalness: 0, flatShading: true,
    });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  /* ------------------------------------------------------------ placement --
   * Every scattered object goes through place(). It keeps a spatial hash of
   * what has already been placed and rejects any candidate whose footprint
   * touches an existing one, so nothing spawns inside anything else.
   *
   * Two radii per object: `space` is the visual footprint used for rejection
   * (a tree's crown is far wider than its trunk), `r` is what the player and
   * the tubbies actually collide with.
   */
  #occupied(x, z, space) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    // Reach far enough that a large neighbour in an adjacent cell still counts.
    const span = Math.ceil((space + this.maxSpace) / this.cell);
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const bucket = this.grid.get((cx + i) + ',' + (cz + j));
        if (!bucket) continue;
        for (const o of bucket) {
          const min = space + o.space;
          if ((x - o.x) ** 2 + (z - o.z) ** 2 < min * min) return true;
        }
      }
    }
    return false;
  }

  /**
   * @param space footprint radius to keep clear of everything already placed
   * @param hit   collision radius (0 = decorative, walk through it)
   * @param pick  () => [x, z] candidate generator
   * @param tries give up after this many rejections
   * @returns the placed record, or null if the map is too full
   */
  place(space, hit, pick, tries = 60) {
    for (let n = 0; n < tries; n++) {
      const [x, z] = pick();
      if (this.#occupied(x, z, space)) continue;
      const rec = { x, z, space, r: hit };
      const key = Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell);
      let bucket = this.grid.get(key);
      if (!bucket) this.grid.set(key, (bucket = []));
      bucket.push(rec);
      this.maxSpace = Math.max(this.maxSpace, space);
      if (hit > 0) this.obstacles.push(rec);
      return rec;
    }
    return null;
  }

  #scatter() {
    const s = CFG.world.size, half = s / 2 - 6;
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 7, 5);
    const crownGeo = new THREE.ConeGeometry(2.3, 6, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x241c14, roughness: 1 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x16240f, roughness: 1, flatShading: true });

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    // Place first, instance second - the real count is only known after rejection.
    const trees = [];
    const edgeCount = Math.floor(CFG.world.treeCount * 0.3);
    for (let i = 0; i < CFG.world.treeCount; i++) {
      const edge = i < edgeCount;
      const k = 0.7 + this.rand() * 0.7;
      // Crowns interlock a little (0.62) or the forest reads as an orchard; the
      // treeline packs tighter still so it stays an unbroken wall.
      const space = 2.3 * k * (edge ? 0.42 : 0.62);
      const spot = this.place(space, 0.5 * k, () => {
        if (edge) {
          const a = this.rand() * Math.PI * 2, r = half - this.rand() * 10;
          return [Math.cos(a) * r, Math.sin(a) * r];
        }
        return [(this.rand() - 0.5) * s * 0.9, (this.rand() - 0.5) * s * 0.9];
      });
      if (spot) trees.push({ x: spot.x, z: spot.z, k, rot: this.rand() * 6.283 });
    }

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length);
    trees.forEach((t, i) => {
      const y = heightAt(t.x, t.z);
      q.setFromAxisAngle(up, t.rot);
      sc.set(t.k, t.k, t.k);
      m.compose(new THREE.Vector3(t.x, y + 3.5 * t.k, t.z), q, sc);
      trunks.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, y + 8.5 * t.k, t.z), q, sc);
      crowns.setMatrixAt(i, m);
    });
    trunks.castShadow = crowns.castShadow = true;
    this.scene.add(trunks, crowns);

    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x3b3b38, roughness: 1, flatShading: true });
    const rocks = [];
    for (let i = 0; i < CFG.world.rockCount; i++) {
      const k = 0.6 + this.rand() * 1.5;
      const spot = this.place(k * 1.05, k * 0.8,
        () => [(this.rand() - 0.5) * s * 0.85, (this.rand() - 0.5) * s * 0.85]);
      if (spot) rocks.push({ x: spot.x, z: spot.z, k, rot: this.rand() * 6.283,
                            ax: [this.rand(), this.rand(), this.rand()] });
    }
    const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length);
    rocks.forEach((r, i) => {
      q.setFromAxisAngle(new THREE.Vector3(...r.ax).normalize(), r.rot);
      m.compose(new THREE.Vector3(r.x, heightAt(r.x, r.z) + r.k * 0.4, r.z), q, sc.set(r.k, r.k * 0.7, r.k));
      rockMesh.setMatrixAt(i, m);
    });
    rockMesh.castShadow = true;
    this.scene.add(rockMesh);

    console.info('[world] ' + trees.length + '/' + CFG.world.treeCount + ' trees, ' +
      rocks.length + '/' + CFG.world.rockCount + ' rocks placed without overlap');
  }

  #custard() {
    const s = CFG.world.size;
    const SPREAD = 26;   // preferred minimum metres between two tanks
    const CLEAR = 1.4;   // reachable pocket kept clear around each tank

    for (let i = 0; i < CFG.world.custardCount; i++) {
      // Relax the spread if the map cannot satisfy it, rather than silently
      // dropping a tank and leaving the objective unwinnable.
      let spot = null;
      for (let spread = SPREAD; spread >= 8 && !spot; spread -= 6) {
        spot = this.place(CLEAR, 0, () => {
          let x, z;
          do {
            x = (this.rand() - 0.5) * s * 0.8;
            z = (this.rand() - 0.5) * s * 0.8;
          } while (Math.hypot(x, z) < 18);   // never in the player's lap
          return [x, z];
        }, 200);
        if (spot && this.custards.some((c) => Math.hypot(c.pos.x - spot.x, c.pos.z - spot.z) < spread)) {
          spot = null;   // too close to a sibling; the stale grid entry is harmless
        }
      }
      if (!spot) {
        console.warn('[world] could only place ' + this.custards.length + ' custard tanks');
        break;
      }

      const { group: g, meshes, halo, height } = makeCustard();
      g.rotation.y = this.rand() * Math.PI * 2;   // hide the shared silhouette
      g.position.set(spot.x, heightAt(spot.x, spot.z) + height / 2, spot.z);
      this.scene.add(g);
      this.custards.push({ group: g, meshes, halo,
        pos: new THREE.Vector3(spot.x, 0, spot.z), taken: false });
    }
  }

  /**
   * One light for every dish in the game, parked on whichever is nearest.
   *
   * The light count a scene renders with is baked into every material's shader,
   * so it must never change at runtime. Keeping exactly one dish light - always
   * present, only moved - means no recompile, ever, and nine fewer lights in
   * every shader besides.
   */
  updateGlow(t, from) {
    let best = null;
    let bestD = Infinity;
    for (const c of this.custards) {
      if (c.taken) continue;
      const d = (c.pos.x - from.x) ** 2 + (c.pos.z - from.z) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) {
      this.custardGlow.intensity = 0;   // intensity, never visibility
      return;
    }
    this.custardGlow.position.set(best.pos.x, heightAt(best.pos.x, best.pos.z) + 0.19, best.pos.z);
    this.custardGlow.intensity = 10 + Math.sin(t * 2 + best.pos.x) * 3;
  }

  /** Take a dish: hide its meshes only. Nothing here touches a light. */
  take(c) {
    if (!c || c.taken) return false;
    c.taken = true;
    for (const m of c.meshes) m.visible = false;
    if (c.halo) c.halo.visible = false;
    return true;
  }

  /** Push a circle of radius r out of every obstacle and the map bounds. */
  resolve(pos, r) {
    const lim = CFG.world.size / 2 - 8;
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
    for (const o of this.obstacles) {
      const dx = pos.x - o.x, dz = pos.z - o.z;
      const min = o.r + r;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2), push = (min - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }
  }
}
