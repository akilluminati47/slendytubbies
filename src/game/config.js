// Central tuning. Everything a designer would want to poke lives here.
export const CFG = {
  world: {
    size: 220,            // metres, square, wrapped by an impassable treeline
    fogNear: 4,
    fogFar: 46,
    treeCount: 420,
    rockCount: 110,
    // Ground cover. Neither collides with anything and neither casts a shadow,
    // so the only cost is triangles in one draw call apiece - which is why
    // these numbers can be this large.
    branchCount: 260,
    grassCount: 46000,
    custardCount: 10,
  },
  player: {
    // Eye height, and it is the tubby's rather than a person's.
    //
    // Measured on a placed model in a live map: it stands 1.838 m from sole to
    // crown - which does match tubby.height below after all - and its eye
    // sockets sit 1.404 m up, 76% of the way. So 1.7 was a person's eye height
    // on a character 30 cm shorter, and everyone floated above the body the
    // other players could see.
    //
    // It briefly read 0.84 here, which put the camera at chest height on the
    // people you were playing with. That came from measuring a REMOTE's skinned
    // vertices, and a remote's transform chain does not give the numbers a
    // placed model does - it reported the same tubby as 1.27 m tall. Anything
    // measured off this rig has to come off a model standing in the world.
    height: 1.40,
    radius: 0.35,
    walkSpeed: 3.1,
    sprintSpeed: 6.0,
    accel: 22,
    friction: 11,
    mouseSens: 0.0021,
    staminaMax: 6.0,      // seconds of sprint
    staminaRegen: 0.55,   // per second, and only while not sprinting
    batteryMax: 240,      // seconds of torch
    torchIntensity: 420,  // candela - CONSTANT while lit, never scaled
    pickupRadius: 1.3,    // walk this close and the dish is yours
    hintRadius: 5.0,      // and this close before the HUD mentions it
    jumpSpeed: 4.6,       // m/s launch
    gravity: 16.0,        // m/s^2 - snappier than real gravity, like a shooter
    coyoteTime: 0.12,     // grace period to still jump after leaving the ground
    // Stamina refunded per hop. The gauge reads 0-100, so a tenth of the bar -
    // and the bar is six seconds of sprint, hence 0.6. Hopping is therefore a
    // real way to keep running, paid for in noise (CFG.noise.jump) rather than
    // in time.
    jumpStamina: 0.6,
    // --- going over ---------------------------------------------------------
    // Now and then the hop does not happen. A crouch, a shake, no launch, and
    // a bite out of the bar instead of a tenth of it back - so the one thing
    // that makes bunny-hopping free occasionally costs instead, and the rhythm
    // of it can break without you having done anything wrong.
    //
    // Rare on purpose. A jump that failed one time in ten would be a control
    // that does not work; one in thirty is a thing that happens to you.
    stumbleChance: 1 / 30,
    // Sprinting over a fallen branch is far likelier, because that is a reason
    // rather than clumsiness - and it makes the deadwood on the floor something
    // to read rather than scenery. Walking over one is always fine.
    branchTripChance: 0.10,
    // Seconds of sprint lost, and the gauge reads 0-100 over staminaMax, so
    // this is the five points the bar visibly drops by.
    stumbleCost: 0.3,
    stumbleTime: 0.5,     // how long the crouch and the shake take to recover
    // Head bob. Deliberately subtle: it should register as weight underfoot,
    // never as something you notice or have to look past.
    bobWalk: 0.016,       // metres of vertical travel while walking
    bobSprint: 0.024,     // and while sprinting
    bobRoll: 0.0022,      // radians of lean - a hint of it, no more
    // Side to side, as a multiple of the vertical. A head going straight up and
    // down is a lift, not a walk: the weight shifts onto one foot and then the
    // other, so the sway happens ONCE per stride where the bounce happens
    // twice, and the two together trace the figure of eight a real head does.
    // More lateral than vertical, which is the way round people actually walk.
    bobSway: 1.5,
    // How much the torch drifts when you are standing still. A hand does not
    // hold anything perfectly still, and a beam frozen to the pixel is the
    // clearest possible statement that nobody is holding it.
    idleSway: 0.006,
    bobEase: 5.0,         // how fast the amplitude fades in and out
    // Bob cycles per metre travelled, NOT per second. Sprinting is a longer
    // stride, so it must be the LOWER number - fewer, bigger steps over the
    // same ground. Making it higher (as it was) gave a frantic patter that
    // read as running on the spot.
    strideWalk: 6.0,
    strideSprint: 3.6,
  },
  tubby: {
    // Load the ripped meshes and retarget the donors' clips onto them at start
    // up (see tubbyRig.js). Turn this off to play on the procedural stand-ins,
    // which the game falls back to on its own if anything fails to load.
    useBakedRig: true,
    height: 1.85,
    radius: 0.45,
    // Matched to the clips rather than picked. Tinky Winky's own walk carries
    // the body 0.42 m/s and its run 2.11, both short-strided, so these are set
    // where playback lands near 2.1x - a quick cadence on a short stride, which
    // is what the thing looks like, and no skating at either end. See
    // RiggedTubby.update, which does the division.
    // Wandering is not one speed. It picks a stride and keeps it for a while,
    // which is most of what makes a patrol look like something with a mind
    // rather than a unit on rails.
    //
    // The numbers are not free: a clip only carries speed/own inside the
    // 0.82x-2.45x playback clamp, and the walk was measured at 0.429 m/s, so it
    // covers 0.35 to 1.05 before the feet start skating. The brisk stride is
    // deliberately past that and picked up by the run clip instead (2.171 m/s
    // native, good from 1.78), which is why it is 1.9 and not 1.4 - a tubby
    // jogging across a clearing on patrol is a far better thing to catch sight
    // of than one gliding.
    strides: [0.45, 0.8, 1.9],
    strideHold: [5, 13],  // seconds on one stride before rolling another
    investigateSpeed: 2.2,
    // Under the player's sprint of 6, so you can outrun it - and that is a
    // gameplay contract, not a look, which is why it is the one speed here
    // allowed to exceed what the run clip carries. The clip travels 1.40 m/s a
    // cycle and stops at 2.45x playback, so it holds the ground to 3.44; a
    // chase at 4.6 slides the feet about 25%. Accepted deliberately: the
    // alternative is a monster that cannot catch anybody.
    chaseSpeed: 4.6,
    // Bolts when someone takes a dish. This is the ceiling of what a body here
    // can do - the run clip holds the ground to 3.44 m/s - and Tubby.update
    // clamps to whatever that character's own clip measures, so the number can
    // only ever be met, never faked. It was 11, three times over, which did not
    // read as speed: it read as a model being dragged with its legs spinning.
    fleeSpeed: 3.4,
    // Longer, because it is covering ground at a third of the old rate. It used
    // to clear 37 m before settling and now clears 19 - still past the 26 m it
    // can see from where it started, and deep enough into the fog to vanish.
    fleeTime: 5.6,        // seconds of running before it settles back to hunting
    turnRate: 3.2,        // rad/s
    fleeTurnRate: 6.5,    // it whips round to face away much faster than it hunts
    sightRange: 26,
    sightHalfAngle: Math.PI * 0.42,
    hearingBase: 9,       // metres, walking
    killRange: 1.5,
    // It cannot take you while you are running away with your back turned - see
    // Tubby.canTake. Keep moving above this and it stalks instead of killing.
    escapeSpeed: 1.6,
    // Degrees off your view direction that still counts as looking at it. Turn
    // far enough to see what is behind you and it can have you.
    lookAngle: 62,
    loseInterest: 6.0,    // seconds without a fix before giving up
    // --- being startled ---------------------------------------------------
    // Loud enough to make it stop dead and look. A jump is 34 m of noise and a
    // dish is 26, so this catches the jump and nothing else - being startled by
    // every pickup would make the beat wallpaper.
    alertNoise: 30,
    // It does not stop. It swings its head round onto you and keeps coming,
    // which is worse: a thing that pauses gives you a moment, and a thing that
    // simply corrects its course while walking gives you none.
    alignHold: 0.5,       // seconds of fast turning after being startled
    alertTurnRate: 7.0,   // rad/s - it whips round, it does not swing round
    // --- being seen with a torch on ---------------------------------------
    // A beam pointed at it carries far further than it can see you by. The
    // player's torch is a 25 degree cone reaching 40 m, so this is a little
    // past where the light visibly dies and well past the 26 m it can see - the
    // trade being that the one thing letting you find dishes is also the one
    // thing announcing you from across the map.
    torchRange: 48,
    torchBeam: 26,        // degrees off your view that still counts as lit up
  },
  pad: {
    deadzone: 0.18,
    lookSpeed: 2.6,     // rad/s at full right-stick deflection
    invertY: false,
  },
  touch: {
    lookSens: 0.0034,   // radians per CSS pixel dragged
    // The movement stick owns a slab at the lower left; LOOK is everything
    // outside it, not a strict right half - a thumb sweeping the upper left
    // should still turn the camera rather than hit a dead zone.
    stickZone: { width: 0.46, height: 0.68 },
    // Push the stick to its outer edge to sprint, the way a console stick
    // works. A separate RUN button meant a third thumb you do not have.
    sprintAt: 0.88,
  },
  xr: {
    deadzone: 0.22,
    snapDegrees: 30,    // 0 = smooth turning instead (nausea risk)
    smoothTurnSpeed: 2.0,
    torchOnController: true,
  },
  net: {
    // The deployed lobby Worker. Pages serves only static files, so the lobby
    // server lives on its own origin. Override for local development with:
    //   localStorage.setItem("slendytubbies.server", "http://127.0.0.1:8787")
    server: "https://slendytubbies-lobbies.akilluminati47.workers.dev",
  },
  dread: {
    maxOpacity: 0.5,    // how red the screen can ever get
    // How far the colour can drain out of the world. Short of 1 on purpose -
    // the custard glow is the one colour worth keeping, and a fully grey screen
    // is also a screen you cannot spot a dish on.
    drainMax: 0.8,
  },
  noise: {
    idle: 0.15,
    walk: 1.0,
    sprint: 2.4,
    pickup: 26,           // one-shot metres of noise when a tank is taken
    // The loudest signal in the game, louder than taking a dish, and it fires
    // on the launch rather than the landing so the cost lands before the
    // benefit does. Jumping buys stamina back (player.jumpStamina) - this is
    // what it costs: everything within this radius knows exactly where you are.
    jump: 34,
    land: 14,             // one-shot metres of noise on landing a jump
    torchBonus: 4,        // metres added to tubby sight range when your torch is on
  },
};
