import * as THREE from "three";
import { setMist } from "../world/groundFog.js";
import { sowGrass } from "../world/flora.js";
import { makeTorch, makeTorchLight, torchFor, holdInHand, aimInHand, dropFromHand,
  gripPoseFor } from "../entities/torch.js";
import { rng } from "../world/world.js";
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
/** How often each of them comes past with a torch in hand. */
const TORCH_CHANCE = {
  laalaa: 1,
  po: 1,
  dipsy: 1,
  guardian: 0.10,
  tinkywinky: 0,
};

const CAST = ["guardian", "laalaa", "po", "dipsy", "tinkywinky"];

const LANE = {
  // Spawned at the fog's edge, not behind it. Starting further back left four
  // seconds of empty stage every cycle while the next one walked out of the
  // dark; from here they fade up almost immediately.
  start: -16.5,
  end: 2.0,          // past the camera, out of frame
  // The chaser does not amble. It comes past at its own pace, rolled each time,
  // so the one appearance in five that is the monster is also the one you
  // cannot set your watch by - and fast enough that the run clip picks it up
  // rather than the walk.
  chaserSpeed: [2.6, 5.4],
  // Half-extents of the patch worth sowing. Only what the 40 degree lens can
  // see from z=0 through 19 m of fog is ever drawn, so sowing the whole 60 m
  // plane would be triangles nobody looks at.
  grassArea: { x: 13, z: 15 },
  speed: 1.9,        // m/s; walking at the lens hides what skating there is
  firstStart: -7.5,  // the first one is already in view when the title appears
};

// Each walks its own line so the loop does not read as a conveyor belt, and so
// nobody spends the whole walk directly behind the title.
const OFFSET = { guardian: -1.15, laalaa: 1.25, po: -0.85, dipsy: 1.5, tinkywinky: 0 };

const FRONT_SCREENS = new Set(["title", "mode", "lobby"]);

/** As bright as the one you carry yourself - see CFG.player.torchIntensity. */
const TORCH_CANDELA = 420;

const _lampAt = new THREE.Vector3();
const _lampDir = new THREE.Vector3();
const _lampQ = new THREE.Quaternion();

export class Showcase {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
    this.camera.position.set(0, 1.5, 0);
    this.camera.lookAt(0, 1.05, -8);

    // One torch light for the whole stage, moved to whoever is carrying.
    //
    // Made here rather than hung off each torch as it is built: the parade
    // builds a new torch every few seconds, and a light arriving in the scene
    // recompiles every material in it.
    const lamp = makeTorchLight("handheld");
    this.torchLight = lamp.light;
    this.torchAim = lamp.aim;
    this.scene.add(this.torchLight, this.torchAim);

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

    // The stage floor, in the drained palette rather than the wasteland's own.
    // The menu is the game with the colour taken out of it - the same thing the
    // dread overlay does when something is close - so the ground under the cast
    // is a grey with barely any green left in it rather than the field green
    // the map uses.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x1b1d1a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Grass, and only grass: no trees and no rocks, because anything with a
    // silhouette competes with the one silhouette this screen exists to show.
    // Three times the density the map uses - the cast walks through a strip a
    // few metres wide and it wants to look like a field, not a verge - and
    // drained of colour to match the floor.
    sowGrass(this.scene, {
      rand: rng(0x5ee1),          // its own stream, so it never moves
      heightAt: () => 0,          // a flat stage
      count: Math.round(LANE.grassArea.x * 2 * LANE.grassArea.z * 2 * 3.2),
      half: LANE.grassArea,
      at: { x: 0, z: -8 },
      sat: 0.14,
      name: "showcase:grass",
    });

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

  /**
   * Put the stage's torch light on the lens of whoever is carrying one.
   *
   * After the model has been posed, because the torch hangs off a hand and the
   * hand has only just finished moving - reading it before would light where
   * the arm was a frame ago.
   */
  #castTorch() {
    const torch = this.torch;
    if (!torch) {
      this.torchLight.intensity = 0;
      return;
    }
    torch.group.updateWorldMatrix(true, true);
    torch.glow.getWorldPosition(_lampAt);
    torch.group.getWorldQuaternion(_lampQ);
    _lampDir.set(0, 0, -1).applyQuaternion(_lampQ).normalize();
    this.torchLight.position.copy(_lampAt);
    this.torchAim.position.copy(_lampAt).addScaledVector(_lampDir, 9);
    this.torchLight.angle = torch.angle;
    this.torchLight.intensity = TORCH_CANDELA;
  }

  /**
   * Stop the parade and hold one character still, for the torch bench.
   *
   * The stage is already lit, grassed and pointed at a lens; standing somebody
   * on it and stopping the clock is a great deal less machinery than a second
   * scene that would then have to be kept in step with this one.
   *
   * Returns the model, or null if the cast is not built yet.
   */
  hold(kind, z = -2.6) {
    if (!this.models) this.#build();
    const model = this.models?.get(kind);
    if (!model) return null;
    if (this.current && this.current !== model) this.current.root.visible = false;
    this.current = model;
    this.current.root.visible = true;
    this.current.root.position.x = 0;
    this.torch = null;                 // the bench hangs its own
    this.z = z;
    this.frozen = true;
    return model;
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
    const kind = CAST[this.index];
    this.current = this.models.get(kind);
    if (!this.current) return;
    this.current.root.visible = true;
    this.current.root.position.x = OFFSET[kind] ?? 0;
    this.current.play("walk", 0);
    this.speed = kind === "tinkywinky"
      ? LANE.chaserSpeed[0] + Math.random() * (LANE.chaserSpeed[1] - LANE.chaserSpeed[0])
      : LANE.speed;
    this.#maybeTorch(kind);
  }

  /**
   * Who walks past carrying their torch.
   *
   * The three colour players always do - they are the ones you play as, and a
   * torch is the thing you spend the whole game holding. The Guardian only
   * occasionally brings the searchlight out, which is what makes it worth
   * seeing when it does. The chaser never carries anything: it is the reason
   * everyone else needs a light.
   *
   * Hung off the hand bone, so it moves with the walk cycle instead of floating
   * alongside the model.
   */
  #maybeTorch(kind) {
    // The Guardian brings the searchlight out the first time and rolls for it
    // after that. A one-in-ten prop nobody has seen yet is not a rarity, it is
    // an absence: most players watch the parade once, on their way into their
    // first game, and would simply never learn the lamp exists.
    const first = kind === "guardian" && !this.seenGuardian;
    if (kind === "guardian") this.seenGuardian = true;

    let hand = null;
    this.current.root.traverse((o) => {
      if (!hand && o.isBone && /^hand[_ ]?r([_ ]|$)/i.test(o.name)) hand = o;
    });
    // Clear THIS character's hand, not whichever one was filled last.
    dropFromHand(hand);
    this.torch = null;
    this.current.grip?.(null);
    this.current.afterPose = null;
    if (!hand || (!first && Math.random() >= (TORCH_CHANCE[kind] ?? 0))) return;
    const t = makeTorch(torchFor(kind));
    if (holdInHand(t, hand, this.current.root)) {
      this.torch = t;
      // And shut the hand round it, or it reads as balanced on an open palm.
      this.current.grip?.(gripPoseFor(torchFor(kind)));
      // Re-aimed after every pose, so the lamp hangs from its handle instead of
      // rolling over with the arm.
      const model = this.current;
      model.afterPose = () => aimInHand(t, hand, model.root);
    }
  }

  /**
   * Advance and draw. Returns false when the caller should draw the game world
   * instead, so main.js never has to know the rules twice.
   */
  draw(dt, renderer, running) {
    if (!this.wanted(running)) return false;
    if (!this.models) this.#build();
    if (!this.current) return false;

    const speed = this.frozen ? 0 : (this.speed ?? LANE.speed);
    if (!this.frozen) {
      this.z += speed * dt;
      if (this.z > LANE.end) this.#take(this.index + 1, LANE.start);
    }

    // No ground mist on the stage. The lid is partly an absolute world height
    // and this scene stands its cast at y=0 on a flat plane, which is a place
    // the mist has an opinion about and no business having one. Switched off
    // for the draw rather than worked around, since only one scene is ever
    // rendered per frame.
    setMist(0);

    const model = this.current;
    model.root.position.z = this.z;
    model.root.position.y = 0;          // flat stage; plantFeet does the rest
    model.root.rotation.y = this.turn ?? 0;   // walking towards the camera
    model.update(dt, this.frozen ? (this.clipSpeed ?? 0) : speed);
    this.#castTorch();

    renderer.render(this.scene, this.camera);
    return true;
  }
}
