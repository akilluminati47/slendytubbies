import * as THREE from "three";
import { setMist, setMistFlat, MIST, MIST_COLOR } from "../world/groundFog.js";
import { sowGrass } from "../world/flora.js";
import { makeTorch, makeTorchLight, torchFor, holdInHand, aimInHand, dropFromHand,
  gripPoseFor } from "../entities/torch.js";
import { rng } from "../world/world.js";
import { makeTubby, ARM_CALM } from "../entities/tubbyModel.js";

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
  end: 2.0,          // past the camera, out of frame
  // How far apart they walk, and the extra space left after the chaser.
  //
  // The whole cast is on the lane at once now, strung back into the fog, rather
  // than one at a time spawned at its edge. Spawning at the edge is what made
  // them pop: a tubby appearing at the exact distance the fog stops hiding
  // things is a tubby appearing. Starting them far enough back that they are
  // genuinely invisible costs nothing when there are four more in front, and
  // the procession is the thing you see instead of the arrival.
  spacing: 6.4,
  // Room for the chaser to close in, and MORE of it the faster it rolled. The
  // fast laps are the ones where it should start out of sight behind the group
  // and be visibly gaining by the time it reaches the lens; giving it the same
  // head start whatever its pace threw away the only thing the roll was for.
  chaserSpacing: [17.0, 36.0],
  // And the beat after it, which is long enough that the Guardian is still
  // beyond the fog when the chaser's face goes past the lens. The procession
  // has to actually END - an empty stage for a moment - before it can read as
  // having begun again, and at thirteen metres the Guardian was already walking
  // out of the dark while the chaser was still in frame.
  gap: 25.0,
  // Nobody walks through anybody. Only the chaser moves at a different speed,
  // so in practice this is the leash that stops it overtaking the group - and
  // a monster that closes on them and then follows them past is a better thing
  // to watch than one that keeps its distance politely.
  clear: 3.4,
  // The chaser does not amble. It comes past at its own pace, rolled each time,
  // so the one appearance in five that is the monster is also the one you
  // cannot set your watch by - and fast enough that the run clip picks it up
  // rather than the walk.
  // Two ways it can come: an amble barely quicker than the group, or a run.
  // Nothing in between, because nothing in between can be ANIMATED - see
  // #carry. A prowl that is secretly a run played at half rate is a monster
  // gliding, which is the thing this was supposed to stop.
  // The prowl sits near the top of what the walk clip carries and the party
  // walks at 0.98, so an ambling lap is one it spends slowly gaining - enough
  // to be inside their panic distance by the time it reaches the lens.
  chaserProwl: [1.10, 1.34],
  // And the run sits above anything the party can run at, so a fast lap closes
  // on them even once they break.
  chaserRun: [3.6, 4.4],
  chaserRuns: 0.45,        // how often it picks the run
  // Half-extents of the patch worth sowing. Only what the 40 degree lens can
  // see from z=0 through 19 m of fog is ever drawn, so sowing the whole 60 m
  // plane would be triangles nobody looks at.
  grassArea: { x: 13, z: 15 },
  // What a walk actually is.
  //
  // Every number in this block is a speed one of the two clips can carry. With
  // the retarget's lost stride handed back (STRIDE_GAIN) the walk covers 0.59
  // m/s of ground per cycle and the run 2.06, and neither plays outside 0.82x to
  // 2.45x - so the walk carries 0.48 to 1.43 and the run 1.69 to 5.04, and the
  // two overlap. Nothing here may outrun its own feet; see #carry.
  //
  // The distances did NOT go up with the speeds. Scaling them together keeps the
  // arrival rate identical, which sounds right and is not: the fog still ends at
  // 27 m however fast anybody walks, so a longer lane just means fewer of them
  // inside it and a screen with one body on it. Held roughly where they were,
  // the faster cast simply arrives more often - about four in view at a time
  // rather than three.
  speed: 0.98,
  // How much of that speed each walker is allowed to differ by, and how far
  // off their own lane they drift, per lap. The stagger, in other words.
  pace: 0.16,
  wander: 0.7,
  // Running, once the thing behind them is close enough to be a reason.
  //
  // Three and a half to four times the walking pace, which lands the run clip at
  // 1.6x to 1.9x - fast, and still short of the ceiling, where the legs blur and
  // the head starts whipping about.
  runSpeed: [3.2, 3.9],
  // How near the chaser has to get before they run. There is no matching number
  // for stopping: see the panic pass, which only goes one way.
  panic: 13.0,
  // Panic travels forward up the line as well. Somebody sprinting up behind you
  // is its own reason to move, and without this the front of the queue keeps
  // strolling while the back piles into it at four metres a second - which is
  // a traffic jam, not a parade.
  contagion: 12.0,
  // Beyond this the fog has them completely, which is where two of them can
  // change places without anybody seeing it happen.
  hidden: -28.0,
  // Where the front of the queue starts, so the Guardian is already in view
  // when the title appears and nobody has to wait for the show to begin.
  firstStart: -8.5,
};

/** How many carried torches light the ground at once - the nearest few. */
const LIT = 3;

// Each walks its own line so the loop does not read as a conveyor belt, and so
// nobody spends the whole walk directly behind the title.
const OFFSET = { guardian: -1.15, laalaa: 1.25, po: -0.85, dipsy: 1.5, tinkywinky: 0 };

const FRONT_SCREENS = new Set(["title", "mode", "lobby"]);

/**
 * The stage's own mist, about three times the map's.
 *
 * deep   how far the layer stands above the floor
 * max    the most of the view it can take
 * build  how fast it thickens with distance, per metre
 */
/**
 * How far the stage's floor falls away with distance, per metre squared.
 *
 * A globe's worth of curve, scaled down until it is barely a curve at all.
 * Two things it buys. The far edge of a sixty-metre plane is a dead straight
 * line across the screen with nothing behind it; bending it down puts that edge
 * below the horizon where it cannot be seen. And the cast now RISES as it comes
 * up the lane rather than only growing, which is what walking towards somebody
 * over open ground actually looks like and is most of why the far end used to
 * read as a backdrop rather than as distance.
 */
const CURVE = 0.0038;

/**
 * How far the curve may ever fall, in metres.
 *
 * A parabola is only a horizon near its top. The queue now forms up 130 m back -
 * it has to, because the cast walks faster and is spaced further apart - and
 * unchecked this drops that end 66 m into the floor, so the far half of the
 * parade was standing in a pit with no ground under it. Flat past the point the
 * fog has closed anyway, which is 46 m out against a fog that ends at 27.
 */
const MAX_DROP = 8;

/** Where the stage's floor is at a point down the lane. */
const stageY = (z) => -Math.min(CURVE * z * z, MAX_DROP);

/** How far back the floor has to reach: past where anybody ever forms up. */
const STAGE_BACK = 160;

const STAGE_MIST = {
  // The map's own strength, not more of it.
  //
  // Three times the density over a thirty-metre lane saturates within a few
  // steps, and a layer that is fully opaque everywhere you can see is not fog,
  // it is a wall with a line along the top.
  deep: 1.5,      // waist high on a tubby, so heads stay clear of it
  max: 0.85,
  build: 0.10,
  // Its own colour, and only just above the stage's night.
  //
  // At the map's value it is a good deal brighter than this scene's near-black
  // background, so instead of reading as depth it read as a flat grey wall
  // standing behind the cast with a hard line along the top. Mist is only
  // visible because it catches light; on a stage with almost none, it should
  // barely be lighter than what is behind it.
  color: [0.115, 0.125, 0.155],
};

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

    // A few torch lights for the whole stage, lent to whoever is nearest.
    //
    // Made here rather than hung off each torch as it is built: the parade
    // builds torches as they come round, and a light arriving in a scene
    // recompiles every material in it. Three rather than one per carrier
    // because three of the five always carry, and rather than one because a
    // single lit beam among three unlit ones is worse than none.
    this.lamps = [];
    for (let i = 0; i < LIT; i++) {
      const lamp = makeTorchLight("handheld");
      this.scene.add(lamp.light, lamp.aim);
      this.lamps.push(lamp);
    }

    const night = new THREE.Color(0x0a0b0f);
    this.scene.background = night;
    // Near is set past the walker's closest approach so it never fogs while it
    // is the thing you are looking at.
    // Pushed back from 19, so the queue behind the one you are looking at is
    // visible as shapes receding rather than as an empty stage that things
    // walk out of.
    this.scene.fog = new THREE.Fog(night, 9, 27);

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
    // Segmented down the lane, because a plane with one quad in it cannot bend -
    // and long enough down it to reach where the queue forms up, which is a good
    // deal further than the sixty metres this used to be. The back of the line
    // stands 130 m out; it was walking on nothing from 30 m, so its torches lit
    // empty space.
    const floor = new THREE.PlaneGeometry(60, STAGE_BACK + 30, 1, 96);
    floor.rotateX(-Math.PI / 2);
    floor.translate(0, 0, (30 - STAGE_BACK) / 2);
    const fp = floor.attributes.position;
    for (let i = 0; i < fp.count; i++) fp.setY(i, stageY(fp.getZ(i)));
    floor.computeVertexNormals();
    const ground = new THREE.Mesh(
      floor,
      new THREE.MeshStandardMaterial({ color: 0x1b1d1a, roughness: 1 }));
    this.scene.add(ground);

    // Grass, and only grass: no trees and no rocks, because anything with a
    // silhouette competes with the one silhouette this screen exists to show.
    // Three times the density the map uses - the cast walks through a strip a
    // few metres wide and it wants to look like a field, not a verge - and
    // drained of colour to match the floor.
    sowGrass(this.scene, {
      rand: rng(0x5ee1),          // its own stream, so it never moves
      heightAt: (x, z) => stageY(z),   // the stage's own gentle curve
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
  #castTorches() {
    // Nearest first, because those are the beams whose pool on the ground you
    // can actually see - the ones further back are behind the fog.
    const lit = this.frozen
      ? (this.torch ? [this.torch] : [])
      : [...this.walkers].filter((w) => w.torch).sort((a, b) => b.z - a.z)
        .slice(0, LIT).map((w) => w.torch);

    for (let i = 0; i < this.lamps.length; i++) {
      const lamp = this.lamps[i];
      const torch = lit[i];
      if (!torch) {
        lamp.light.intensity = 0;
        continue;
      }
      torch.group.updateWorldMatrix(true, true);
      torch.glow.getWorldPosition(_lampAt);
      torch.group.getWorldQuaternion(_lampQ);
      _lampDir.set(0, 0, -1).applyQuaternion(_lampQ).normalize();
      lamp.light.position.copy(_lampAt);
      lamp.aim.position.copy(_lampAt).addScaledVector(_lampDir, 9);
      lamp.light.angle = torch.angle;
      lamp.light.intensity = TORCH_CANDELA;
    }
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
    // Everybody else off the stage, and their torches with them - the bench
    // hangs its own and lights only that.
    for (const w of this.walkers) {
      w.model.root.visible = w.model === model;
      if (w.model !== model) {
        dropFromHand(w.hand);
        w.torch = null;
        w.model.afterPose = null;
        w.model.grip?.(null);
      }
    }
    this.current = model;
    this.current.root.position.x = 0;
    this.torch = null;
    this.z = z;
    this.frozen = true;
    return model;
  }

  #build() {
    this.models = new Map();
    this.walkers = [];
    let z = LANE.firstStart;
    for (const kind of CAST) {
      const model = makeTubby(kind);
      model.play("walk", 0);
      model.root.position.x = OFFSET[kind] ?? 0;
      this.scene.add(model.root);
      this.models.set(kind, model);
      // Strung back from the front of the queue, the chaser furthest away.
      const walker = { kind, model, z, torch: null, hand: null, speed: LANE.speed };
      this.walkers.push(walker);
      this.#enter(walker);
      z -= this.#lead(this.walkers[this.walkers.length - 1], true);
    }
    this.current = this.walkers[0].model;
  }

  /**
   * A walker joins the back of the queue: new pace, new roll for a torch.
   *
   * Called when one is first placed and every time it comes round again, which
   * is what makes the Guardian's searchlight a thing you might or might not see
   * on any given lap rather than a fixture.
   */
  /**
   * Swap two party members that are both hidden in the fog.
   *
   * Only the three colours, and only when neither can be seen: the Guardian
   * leads every lap and the chaser closes every lap, which are the two things
   * the procession is built around, and the middle is the part that is allowed
   * to be different each time round.
   */
  #shuffleUnseen() {
    const hidden = this.walkers.filter((w) =>
      w.z < LANE.hidden && w.kind !== "guardian" && w.kind !== "tinkywinky");
    if (hidden.length < 2 || Math.random() > 0.02) return;
    const a = hidden[Math.floor(Math.random() * hidden.length)];
    let b = hidden[Math.floor(Math.random() * hidden.length)];
    if (a === b) return;
    // Positions ONLY.
    //
    // It used to swap the pace and the running flag along with the place in the
    // line, which hands a body playing a walk somebody else's run speed - the
    // clip then wants seven times its own rate and the feet go back to sliding.
    // A walker's gait belongs to the walker; only where it is standing is being
    // exchanged here.
    const z = a.z; a.z = b.z; b.z = z;
  }

  /**
   * A speed the clips can actually carry, and the clip that carries it.
   *
   * The parade and the game have to agree about this or the menu is animating
   * by different rules from the thing it advertises, so the answer lives on the
   * model - see TubbyModel.gaitFor - and this is only the local name for it.
   */
  #carry(model, want) {
    return model.gaitFor(want);
  }

  /**
   * Put a walker into a gait, with the two things that go with it.
   *
   * Feet are squared to the direction of travel for everybody EXCEPT the chaser
   * walking, which keeps the uneven kick its walk cycle was animated with: that
   * limp is most of what makes it read as the wrong one from a distance. Its
   * RUN was getting the same exemption and should not have been. At speed the
   * unsquared feet flare out sideways on every stride, which is not a limp, it
   * is a model coming apart.
   *
   * And where two clips travel at the same speed, walkers take one each, so a
   * line of five is not one cycle drawn five times.
   */
  #wear(walker, clip, fade) {
    walker.model.squareFeet = walker.kind === "tinkywinky" && clip === "walk" ? 0 : 1;
    walker.model.play(walker.varied ? walker.model.variantFor(clip) : clip, fade);
  }

  /**
   * How much room to leave in front of a walker as it joins the back.
   *
   * @param next  measuring the space for whoever comes AFTER this one, during
   *              the initial line-up, rather than for this one
   */
  #lead(walker, next = false) {
    const kind = next ? CAST[CAST.indexOf(walker.kind) + 1] : walker.kind;
    if (kind === "guardian") return LANE.gap;
    if (kind !== "tinkywinky") return LANE.spacing;
    // The chaser's own roll decides how far back it starts, so a fast lap is
    // one it spends closing rather than one it spends arriving early. Measured
    // across both bands it can roll in, prowl floor to run ceiling.
    const lo = LANE.chaserProwl[0], hi = LANE.chaserRun[1];
    const pace = next ? 1 : (walker.speed - lo) / Math.max(hi - lo, 1e-6);
    const [near, far] = LANE.chaserSpacing;
    return near + (far - near) * THREE.MathUtils.clamp(pace, 0, 1);
  }

  #enter(walker) {
    walker.model.root.visible = true;
    // Rolled here and nowhere else. The chaser is left out of the panic pass
    // entirely, so whichever of the two ways it decided to come, it comes that
    // way for the whole lap - a monster that breaks into a run halfway is a
    // moment, and one that gives up halfway and strolls is a joke.
    walker.running = false;
    // Half the party takes the second walk cycle, rolled per lap.
    walker.varied = Math.random() < 0.5;

    let want;
    if (walker.kind === "tinkywinky") {
      // It either ambles up behind them or runs them down. Rolled per lap, so
      // the one appearance in five that is the monster is also the one you
      // cannot set your watch by.
      const band = Math.random() < LANE.chaserRuns ? LANE.chaserRun : LANE.chaserProwl;
      want = band[0] + Math.random() * (band[1] - band[0]);
    } else {
      // A little off the pace, per lap, per walker. Five bodies moving at
      // exactly one speed with exactly one clip at exactly one phase is a row
      // of clockwork, and the eye finds it immediately.
      want = LANE.speed * (1 + (Math.random() - 0.5) * LANE.pace);
    }
    const gait = this.#carry(walker.model, want);
    walker.speed = gait.speed;
    this.#wear(walker, gait.clip, 0);
    // Somewhere else in the cycle, so nobody is in step with anybody.
    walker.model.mixer.setTime(Math.random() * 4);
    // And not walking a perfectly straight line down their own lane - except
    // the chaser, which comes straight down the middle every time. It is the
    // one of the five you are meant to get a proper look at, and the lens is
    // pointed at the centre, so wandering it off to one side means the pass
    // where you would have seen the mask is the pass where you did not.
    walker.model.root.position.x = walker.kind === "tinkywinky"
      ? 0
      : (OFFSET[walker.kind] ?? 0) + (Math.random() - 0.5) * LANE.wander;
    this.#maybeTorch(walker);
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
  #maybeTorch(walker) {
    const { kind, model } = walker;
    // The Guardian brings the searchlight out the first time and rolls for it
    // after that. A one-in-ten prop nobody has seen yet is not a rarity, it is
    // an absence: most players watch the parade once, on their way into their
    // first game, and would simply never learn the lamp exists.
    const first = kind === "guardian" && !this.seenGuardian;
    if (kind === "guardian") this.seenGuardian = true;

    let hand = walker.hand;
    if (!hand) {
      model.root.traverse((o) => {
        if (!hand && o.isBone && /^hand[_ ]?r([_ ]|$)/i.test(o.name)) hand = o;
      });
      walker.hand = hand;
    }
    // Clear THIS character's hand, not whichever one was filled last.
    dropFromHand(hand);
    walker.torch = null;
    model.grip?.(null);
    model.afterPose = null;
    // Empty-handed, so nothing to hold still for - the walk gets its arms back.
    model.armCalm = 0;
    if (!hand || (!first && Math.random() >= (TORCH_CHANCE[kind] ?? 0))) return;
    // And with a torch in it, the same rule the lobby runs: the Guardian swings
    // its lamp, everybody else carries theirs. See ARM_CALM.
    model.armCalm = kind === "guardian" ? 0 : ARM_CALM;
    const t = makeTorch(torchFor(kind));
    if (holdInHand(t, hand, model.root)) {
      walker.torch = t;
      // And shut the hand round it, or it reads as balanced on an open palm.
      model.grip?.(gripPoseFor(torchFor(kind)));
      // Re-aimed after every pose, so the lamp hangs from its handle instead of
      // rolling over with the arm.
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

    // No ground mist on the stage. The lid is partly an absolute world height
    // and this scene stands its cast at y=0 on a flat plane, which is a place
    // the mist has an opinion about and no business having one. Switched off
    // for the draw rather than worked around, since only one scene is ever
    // rendered per frame.
    // Mist on the stage, laid on thick.
    //
    // It used to be switched off here, because the lid is partly an absolute
    // world height and this scene stands its cast at y=0 on a flat plane -
    // which is a place the map's heightfield has an opinion about and no
    // business having one. setMistFlat says the floor is level and the lid
    // stops asking.
    //
    // At the map's own strength - see STAGE_MIST.
    setMistFlat(true);
    MIST[0] = -40;              // no absolute lid; the hug below is the whole of it
    MIST[1] = STAGE_MIST.deep;
    MIST[3] = STAGE_MIST.build;
    MIST_COLOR[0] = STAGE_MIST.color[0];
    MIST_COLOR[1] = STAGE_MIST.color[1];
    MIST_COLOR[2] = STAGE_MIST.color[2];
    setMist(STAGE_MIST.max);

    if (this.frozen) {
      // Bench: one character, standing still, everybody else off stage.
      const model = this.current;
      model.root.position.set(0, stageY(this.z), this.z);
      model.root.rotation.y = this.turn ?? 0;
      model.update(dt, this.clipSpeed ?? 0);
      this.#castTorches();
      renderer.render(this.scene, this.camera);
      return true;
    }

    for (const w of this.walkers) {
      w.z += w.speed * dt;
      if (w.z > LANE.end) {
        // Round to the back of the queue. The gap goes in front of the
        // Guardian, which by then means behind the chaser - the last one in
        // line when the Guardian is the one leaving.
        let back = Infinity;
        for (const other of this.walkers) back = Math.min(back, other.z);
        this.#enter(w);          // rolls its pace first: the chaser's sets its own start
        w.z = back - this.#lead(w);
      }
    }

    // Nobody walks through anybody. Only the chaser and the runner move at
    // their own pace, so this is the leash on them: the chaser closes the
    // distance its roll bought it and then follows the group past the lens
    // rather than through the back of it.
    const order = [...this.walkers].sort((a, b) => b.z - a.z);
    for (let i = 1; i < order.length; i++) {
      order[i].z = Math.min(order[i].z, order[i - 1].z - LANE.clear);
    }

    // Who is running, and it is the chaser that decides.
    //
    // Not a fixed member and not a fixed number: whoever it has got close to
    // breaks into a run, and on a lap where it rolled fast that is two or three
    // of them by the time it reaches the lens. Four walking and one hurrying is
    // the shape of the game; the party finding out at different moments is what
    // stops the parade being a walk cycle with extra bodies.
    //
    // Hysteresis on the way out, or somebody sitting exactly at the threshold
    // flickers between the two clips forever.
    // Walked from the BACK of the line forward, so a body that starts running
    // this frame is already running when the one ahead of it is asked whether
    // anybody behind it is. That is what lets a panic travel up the queue in
    // one pass instead of one walker a frame.
    // And it only ever goes one way. Nobody drops back to a walk having started
    // to run, because there is nothing in front of them to be reassured by - the
    // thing is still behind them and still coming, and a party strolling again
    // twenty metres after bolting reads as five people who have forgotten what
    // they are in. A lap is the unit: they run until they leave the lane, and
    // #enter puts the next one back on its feet at the far end.
    //
    // Which also means the hysteresis is gone. It was only ever there to stop a
    // body sitting on the threshold flickering between clips, and a switch that
    // cannot go back cannot flicker.
    const chaser = this.walkers.find((w) => w.kind === "tinkywinky");
    const line = this.walkers.filter((w) => w !== chaser).sort((a, b) => a.z - b.z);
    let behind = null;
    for (const w of line) {
      if (w.running) { behind = w; continue; }
      const ahead = chaser ? w.z - chaser.z : Infinity;
      // Two reasons to run: the thing itself is close, or the one behind you is
      // running and closing on your heels.
      const scared = (chaser && ahead > 0 && ahead < LANE.panic)
        || (!!behind?.running && w.z - behind.z < LANE.contagion);
      behind = w;
      if (!scared) continue;
      w.running = true;
      const want = LANE.runSpeed[0]
        + Math.random() * (LANE.runSpeed[1] - LANE.runSpeed[0]);
      // Speed and clip decided together, always. Breaking into a run is the one
      // moment a body is most likely to outrun its own feet.
      const gait = this.#carry(w.model, want);
      w.speed = gait.speed;
      this.#wear(w, gait.clip, 0.3);
    }

    // And two of the party change places, out where the fog has them.
    //
    // The rotation is otherwise fixed forever - the same three colours in the
    // same order every lap - and shuffling anything visible would teleport a
    // character. Swapping two that are both past the fog's far edge is the
    // same reordering with nobody to see it.
    this.#shuffleUnseen();

    for (const w of this.walkers) {
      w.model.root.position.z = w.z;
      // On the curve, so they come up over it rather than sliding along a plane.
      w.model.root.position.y = stageY(w.z);
      w.model.root.rotation.y = 0;      // walking towards the camera
      w.model.update(dt, w.speed);
    }
    // The one nearest the lens, for anything that wants "the character on
    // screen" - the bench, mostly.
    this.current = order[0].model;
    this.torch = order.find((w) => w.torch)?.torch ?? null;
    this.#castTorches();

    renderer.render(this.scene, this.camera);
    return true;
  }
}
