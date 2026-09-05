// Central tuning. Everything a designer would want to poke lives here.
export const CFG = {
  world: {
    size: 220,            // metres, square, wrapped by an impassable treeline
    fogNear: 4,
    fogFar: 46,
    treeCount: 420,
    rockCount: 90,
    custardCount: 10,
  },
  player: {
    height: 1.7,
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
    // Head bob. Deliberately subtle: it should register as weight underfoot,
    // never as something you notice or have to look past.
    bobWalk: 0.016,       // metres of vertical travel while walking
    bobSprint: 0.024,     // and while sprinting
    bobRoll: 0.0022,      // radians of lean - a hint of it, no more
    bobEase: 5.0,         // how fast the amplitude fades in and out
    // Bob cycles per metre travelled, NOT per second. Sprinting is a longer
    // stride, so it must be the LOWER number - fewer, bigger steps over the
    // same ground. Making it higher (as it was) gave a frantic patter that
    // read as running on the spot.
    strideWalk: 6.0,
    strideSprint: 3.6,
  },
  tubby: {
    // The baked GLB (tools/rig_transfer.py) still binds wrong - see README
    // "Known issue". Flip this to true to test a fixed bake; the game plays on
    // the procedural stand-ins meanwhile.
    useBakedRig: false,
    height: 1.85,
    radius: 0.45,
    patrolSpeed: 1.5,
    investigateSpeed: 2.9,
    chaseSpeed: 5.4,      // just under player sprint - you can outrun it, briefly
    fleeSpeed: 11.0,      // bolts when someone takes a dish - far faster than you
    fleeTime: 3.4,        // seconds of running before it settles back to hunting
    turnRate: 3.2,        // rad/s
    fleeTurnRate: 6.5,    // it whips round to face away much faster than it hunts
    sightRange: 26,
    sightHalfAngle: Math.PI * 0.42,
    hearingBase: 9,       // metres, walking
    killRange: 1.5,
    loseInterest: 6.0,    // seconds without a fix before giving up
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
  },
  noise: {
    idle: 0.15,
    walk: 1.0,
    sprint: 2.4,
    pickup: 26,           // one-shot metres of noise when a tank is taken
    land: 14,             // one-shot metres of noise on landing a jump
    torchBonus: 4,        // metres added to tubby sight range when your torch is on
  },
};
