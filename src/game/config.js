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
    turnRate: 3.2,        // rad/s
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
  },
  xr: {
    deadzone: 0.22,
    snapDegrees: 30,    // 0 = smooth turning instead (nausea risk)
    smoothTurnSpeed: 2.0,
    torchOnController: true,
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
