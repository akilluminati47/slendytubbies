import * as THREE from "three";
import { makeTubby } from "../entities/tubbyModel.js";

/**
 * The menu backdrop: the cast walks past you, one at a time, on a loop.
 *
 * This is the only place a player ever gets a good look at these models - in
 * game they are a shape at the edge of a torch beam, which is the point - so the
 * front screens put them on a slow procession out of the fog and past the
 * camera. The guardian leads, then the three you can play as, then Tinky Winky
 * last, which gives the loop a beat rather than a list.
 *
 * It draws with the game's own renderer into a scene of its own. Sharing the
 * renderer keeps it to one WebGL context, and a separate scene means nothing
 * here can disturb the world the game is holding on to.
 *
 * Transitions are done with fog rather than by fading materials. SkeletonUtils
 * shares materials between clones, so fading one here would fade the same tubby
 * mid-chase; walking out of a fog bank costs nothing and cannot leak.
 */

/** Guardian first, the playable three next, the chaser last. */
const CAST = ["guardian", "laalaa", "po", "dipsy", "tinkywinky"];

const LANE = {
  // Spawned at the fog's edge, not behind it. Starting further back left four
  // seconds of empty stage every cycle while the next one walked out of the
  // dark; from here they fade up almost immediately.
  start: -16.5,
  end: 2.0,          // past the camera, out of frame
  speed: 1.9,        // m/s; walking at the lens hides what skating there is
  firstStart: -7.5,  // the first one is already in view when the title appears
};

// Each walks its own line so the loop does not read as a conveyor belt, and so
// nobody spends the whole walk directly behind the title.
const OFFSET = { guardian: -1.15, laalaa: 1.25, po: -0.85, dipsy: 1.5, tinkywinky: 0 };

const FRONT_SCREENS = new Set(["title", "mode", "lobby"]);

export class Showcase {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
    this.camera.position.set(0, 1.5, 0);
    this.camera.lookAt(0, 1.05, -8);

    const night = new THREE.Color(0x0a0b0f);
    this.scene.background = night;
    // Near is set past the walker's closest approach so it never fogs while it
    // is the thing you are looking at.
    this.scene.fog = new THREE.Fog(night, 7.5, 19);

    this.scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x241f16, 2.0));

    const key = new THREE.DirectionalLight(0xffeede, 3.1);
    key.position.set(2.6, 5.5, 2.2);
    this.scene.add(key);

    // Cold rim from behind, so a dark silhouette still separates from the fog.
    const rim = new THREE.DirectionalLight(0x8fb0ff, 2.3);
    rim.position.set(-3.5, 2.6, -7);
    this.scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x14170f, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    this.models = null;      // built on first draw, once the rigs exist
    this.index = 0;
    this.z = LANE.firstStart;
    this.current = null;
  }

  resize(w, h) {
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Whether the backdrop belongs on screen right now.
   *
   * body.dataset.screen is already how the byline and the rest of the chrome
   * decide what they are part of, so it is the one source of truth here too.
   * Pause and the end card are deliberately not on the list: a real world is
   * sitting behind those two, and it should stay visible.
   */
  wanted(running) {
    return !running && FRONT_SCREENS.has(document.body.dataset.screen);
  }

  #build() {
    this.models = new Map();
    for (const kind of CAST) {
      const model = makeTubby(kind);
      model.root.visible = false;
      model.play("walk", 0);
      this.scene.add(model.root);
      this.models.set(kind, model);
    }
    this.#take(0, LANE.firstStart);
  }

  #take(index, z) {
    if (this.current) this.current.root.visible = false;
    this.index = index % CAST.length;
    this.z = z;
    this.current = this.models.get(CAST[this.index]);
    if (!this.current) return;
    this.current.root.visible = true;
    this.current.root.position.x = OFFSET[CAST[this.index]] ?? 0;
    this.current.play("walk", 0);
  }

  /**
   * Advance and draw. Returns false when the caller should draw the game world
   * instead, so main.js never has to know the rules twice.
   */
  draw(dt, renderer, running) {
    if (!this.wanted(running)) return false;
    if (!this.models) this.#build();
    if (!this.current) return false;

    this.z += LANE.speed * dt;
    if (this.z > LANE.end) this.#take(this.index + 1, LANE.start);

    const model = this.current;
    model.root.position.z = this.z;
    model.root.position.y = 0;          // flat stage; plantFeet does the rest
    model.root.rotation.y = 0;          // walking towards the camera
    model.update(dt, LANE.speed);

    renderer.render(this.scene, this.camera);
    return true;
  }
}
