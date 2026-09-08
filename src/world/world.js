import * as THREE from "three";
import { CFG } from "../game/config.js";
import { Sky } from "./sky.js";
import { makeCustard, HALO_SIZE, HALO_PEAK } from "./custard.js";
import { Rain } from "./rain.js";
import { plantWorld } from "./flora.js";
import { carve, GROUND } from "./surface.js";

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
    // Built dry and left in the scene. It costs nothing while it is not
    // raining - the mesh is simply hidden - and building it on demand would
    // mean a stall at the exact moment the weather turns.
    this.rain = new Rain(scene);
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
    // Ninety-six squares across two hundred metres is a facet every two metres,
    // and a single flat green over it reads as felt. The relief is generated in
    // the shader instead - see surface.js - which costs no texture, no UVs and
    // no extra draw, and unlike a colour variation it answers to the torch as
    // you sweep it about.
    // Set on the bench (?tune=1) rather than guessed. Every number I picked for
    // this by eye in a file was wrong - 0.45 was invisible, 5.5 was a mass of
    // dark blotches, 2.2 was still busier than it wanted to be. Dialled live it
    // came out gentler than any of them: the ground should read as ground when
    // the torch crosses it and disappear the rest of the time.
    carve(mat, GROUND, { bump: 0.15, mottle: 1, tint: 0x27301d });
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

  /**
   * Is this spot free of anything solid?
   *
   * A cheap read of the same hash place() uses, for the things that are only
   * decoration. Grass and fallen branches do not need a slot reserved for them
   * and running sixteen thousand of them through the rejection grid would cost
   * a great deal of work to prevent something nobody would ever notice - but
   * one growing out of the middle of a boulder is noticeable, and this is two
   * bucket lookups.
   */
  #clear(x, z) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bucket = this.grid.get((cx + i) + ',' + (cz + j));
        if (!bucket) continue;
        for (const o of bucket) {
          if (o.r <= 0) continue;
          const keep = o.r + 0.35;
          if ((x - o.x) ** 2 + (z - o.z) ** 2 < keep * keep) return false;
        }
      }
    }
    return true;
  }

  #scatter() {
    const built = this.flora = plantWorld(this.scene, {
      rand: this.rand,
      heightAt,
      size: CFG.world.size,
      place: (space, hit, pick) => this.place(space, hit, pick),
      clear: (x, z) => this.#clear(x, z),
      counts: {
        tree: CFG.world.treeCount,
        rock: CFG.world.rockCount,
        branch: CFG.world.branchCount,
        grass: CFG.world.grassCount,
      },
    });
    console.info('[world] ' + built.trees + '/' + CFG.world.treeCount + ' trees, ' +
      built.rocks + ' rocks, ' + built.branches + ' branches, ' +
      built.grass + ' grass tufts');
  }

  #custard() {
    const s = CFG.world.size;
    const SPREAD = 26;   // preferred minimum metres between two tanks
    const CLEAR = 1.4;   // reachable pocket kept clear around each tank

    for (let i = 0; i < CFG.world.custardCount; i++) {
      // Relax the spread if the map cannot satisfy it, rather than silently
      // dropping a tank and leaving the objective unwinnable.
      const pick = () => {
        let x, z;
        do {
          x = (this.rand() - 0.5) * s * 0.8;
          z = (this.rand() - 0.5) * s * 0.8;
        } while (Math.hypot(x, z) < 18);   // never in the player's lap
        return [x, z];
      };

      let spot = null;
      for (let spread = SPREAD; spread >= 6 && !spot; spread -= 5) {
        spot = this.place(CLEAR, 0, pick, 200);
        if (spot && this.custards.some((c) => Math.hypot(c.pos.x - spot.x, c.pos.z - spot.z) < spread)) {
          spot = null;   // too close to a sibling; the stale grid entry is harmless
        }
      }
      // Last resort: any free pocket at all, however close to a sibling.
      //
      // Ten dishes IS the objective, so a map that comes up nine is not a
      // cosmetic shortfall - it is a run that cannot be finished, and the
      // counter says so in the corner the whole time. It went from ten to nine
      // the moment the map got busier (more rocks, and bigger ones), which is
      // exactly the sort of thing that should not be able to reach the player
      // through a scenery change. Spacing is a preference; the count is not.
      if (!spot) spot = this.place(CLEAR, 0, pick, 900);
      // And if even that fails the map is genuinely full, so take the pocket
      // without reserving it rather than shipping an unwinnable round.
      if (!spot) {
        const [x, z] = pick();
        spot = { x, z };
        console.warn('[world] custard ' + (i + 1) + ' placed without a clear pocket');
      }

      const { group: g, meshes, halo, goop, height } = makeCustard();
      g.rotation.y = this.rand() * Math.PI * 2;   // hide the shared silhouette
      g.position.set(spot.x, heightAt(spot.x, spot.z) + height / 2, spot.z);
      this.scene.add(g);
      this.custards.push({ group: g, meshes, halo, goop,
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
      this.#dim(c, Math.sqrt(d));
    }
    if (!best) {
      this.custardGlow.intensity = 0;   // intensity, never visibility
      return;
    }
    this.custardGlow.position.set(best.pos.x, heightAt(best.pos.x, best.pos.z) + 0.19, best.pos.z);
    // The one the whole effect now rests on, so it gets a little more room to
    // breathe: the swell is what makes it read as something burning rather than
    // a lamp somebody left on, and it is the only part of this that puts light
    // on the ground and shows you what shape the ground is.
    this.custardGlow.intensity = 12 + Math.sin(t * 2 + best.pos.x) * 4.5;
  }

  /**
   * How brightly a dish burns from where you are standing.
   *
   * The goop and its halo both ignore fog - that is deliberate, and it is the
   * only reason a dish sixty metres away exists at all rather than being erased
   * by haze. But ignoring fog also meant the far ones burned exactly as hard as
   * the one at your feet, so a map of ten read as ten equal lamps hanging in the
   * dark with no sense of which was near. They are dimmed by distance instead:
   * still findable, no longer shouting.
   *
   * It never reaches zero. Fading a dish out completely would put us back to
   * dishes that seem to arrive one at a time as you walk into them, which is
   * the thing the fog exemption was introduced to fix.
   */
  #dim(c, dist) {
    if (c.taken) return;
    // Full strength only where you could reach out and take it, and most of the
    // way to nothing by the edge of the torch.
    //
    // This used to hold 18% of full brightness right across the map, which is
    // what made ten dishes read as ten lamps hanging in the dark - and being
    // able to see every objective from anywhere is not a lighting problem, it is
    // the map solved. The curve is steep now and the floor is a tenth of what it
    // was: a dish across the clearing is a hint, not a marker.
    const k = THREE.MathUtils.clamp((dist - 6) / 30, 0, 1);
    const fall = 1 - k * k * 0.98;          // 1.0 near, 0.02 past 36 m
    if (c.halo) {
      c.halo.material.opacity = HALO_PEAK * fall;
      // Shrunk as well as dimmed. A halo that keeps its world size while losing
      // its brightness turns into a large soft smudge; pulling both back keeps
      // it reading as a point of light.
      c.halo.scale.setScalar(HALO_SIZE * (0.6 + fall * 0.4));
    }
    // The custard itself is on a far gentler curve than its halo, and the two
    // are separate on purpose. The sprite is the cheat - a flat card pretending
    // to be light - and it is the thing that should be gone by mid-range. The
    // goop is the actual surface of an actual object glowing, which is the part
    // worth keeping: a dish across a clearing stays a dim violet smudge you
    // might walk towards, rather than either a beacon or nothing at all.
    const gk = THREE.MathUtils.clamp((dist - 10) / 70, 0, 1);
    if (c.goop) c.goop.material.emissiveIntensity = 1.15 * (1 - gk * gk * 0.7);
  }

  /**
   * Take the whole round back out of the scene.
   *
   * Nothing ever needed this while a restart was a page reload - the browser
   * threw the lot away for us. It is not a reload any more, because that also
   * threw away the WebSocket, the lobby, and everybody's name with it, so a
   * round now has to be dismantled properly or a second one is built on top of
   * the first: two forests, two skies, and two of every light.
   */
  dispose() {
    // Chunked scatter shares one geometry and one material across every cell,
    // so the same pair arrives here a hundred times. Disposing twice is not
    // harmful but it is not free either, and a set says what is going on.
    const gone = new Set();
    const once = (x) => { if (!x || gone.has(x)) return false; gone.add(x); return true; };
    const drop = (o) => {
      if (!o) return;
      this.scene.remove(o);
      if (once(o.geometry)) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (once(m)) m.dispose();
    };
    for (const m of this.flora?.meshes ?? []) drop(m);
    drop(this.ground);
    for (const c of this.custards) {
      this.scene.remove(c.group);
      for (const m of c.meshes) drop(m);
      if (c.halo) { this.scene.remove(c.halo); c.halo.material.dispose(); }
    }
    if (this.stains) {
      for (const d of [...this.stains.children]) drop(d);
      this.scene.remove(this.stains);
    }
    this.scene.remove(this.custardGlow);
    this.custardGlow.dispose();
    this.rain.dispose(this.scene);
    this.sky.dispose(this.scene);
    this.scene.fog = null;
    this.custards.length = 0;
    this.obstacles.length = 0;
    this.grid.clear();
  }

  /**
   * The weather, from where the camera happens to be standing.
   *
   * Separate from updateGlow because it wants the eye rather than the feet: the
   * shower is a box hung on the camera and hanging it on the ground would put
   * the player's head through the lid of it.
   */
  tickWeather(dt, eye) {
    this.rain.setColor(this.scene.fog ? this.scene.fog.color : this.sky.uniforms.uHorizon.value);
    this.rain.update(dt, eye, this.sky.rainfall);
  }

  /** Take a dish: hide its meshes only. Nothing here touches a light. */
  take(c) {
    if (!c || c.taken) return false;
    c.taken = true;
    for (const m of c.meshes) m.visible = false;
    if (c.halo) c.halo.visible = false;
    return true;
  }

  /**
   * Which fallen branch is underfoot at (x, z), as an index, or -1.
   *
   * A flat scan of a couple of hundred triples, which is a few microseconds and
   * happens for one body - the local player - rather than for everything on the
   * map. Putting these in the collision hash would be the wrong shape: branches
   * are not solid, nothing is ever pushed out of one, and the question asked
   * here is "which one" rather than "is anything".
   *
   * The index is the point of it: stepping across a stick has to fire once, on
   * the crossing, so the caller compares this frame's answer with last frame's.
   */
  branchUnder(x, z) {
    const b = this.flora?.branchSpots;
    if (!b) return -1;
    for (let i = 0; i < b.length; i += 3) {
      const dx = x - b[i], dz = z - b[i + 1], r = b[i + 2];
      if (dx * dx + dz * dz < r * r) return i / 3;
    }
    return -1;
  }

  /**
   * Hide the scatter that is further away than the fog can see.
   *
   * The frustum culls what is behind and beside you; this culls what is in
   * front and too far. Both are needed: the camera's far plane is 400 m because
   * the sky is out there, so without this a cell two hundred metres down the
   * view direction is still "visible" and still drawn, into fog that ended at
   * thirty-four.
   *
   * A distance test per cell, about a hundred and twenty of them, which is a
   * few microseconds against the hundreds of thousands of triangles it saves.
   */
  cullFlora(eye) {
    const far = this.scene.fog?.far ?? 60;
    for (const c of this.flora?.chunks ?? []) {
      const dx = eye.x - c.cx, dz = eye.z - c.cz;
      const reach = far + c.r;
      c.mesh.visible = dx * dx + dz * dz < reach * reach;
    }
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
