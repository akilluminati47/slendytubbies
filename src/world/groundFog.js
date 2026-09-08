import * as THREE from "three";

/**
 * Mist lying in the low ground.
 *
 * The scene fog is a sphere around the camera: everything at forty metres is
 * equally lost whether it is stood on a rise or at the bottom of a hollow. That
 * reads as weather happening to the camera rather than to the place. Real mist
 * pools - it sits in the dips, it thins over the rises, and walking down into
 * it is a thing you can watch happen.
 *
 * Done by patching three's own fog chunks rather than by adding geometry. Two
 * reasons. Every fogged material already computes a fog term, so this is a
 * dozen instructions on a number that is being worked out anyway - no overdraw,
 * no transparency sorting, no fog card slicing through a tree trunk. And it
 * reaches every fogged material at once, which is the part that matters: mist
 * that swallowed the ground but not the tubby stood in it would look worse than
 * no mist at all.
 *
 * The lid is the higher of an absolute height and a fixed hug above the ground,
 * so it behaves as two things at once - a lake that fills the hollows, and a
 * shallow layer that follows you everywhere else.
 */

/**
 * The controls, shared by every material in the scene.
 *
 * A Float32Array rather than a Vector4 on purpose. three clones each material's
 * uniforms when it builds the program, and its cloner deep-copies anything with
 * a .clone() method - which is every THREE type - but copies a typed array by
 * reference. So this one buffer really is the same buffer in all of them, and
 * writing to it here changes the mist everywhere in a single assignment rather
 * than in a walk over every material in the world.
 *
 *   x  lid, as an absolute world height - what makes it pool
 *   y  hug, metres above the ground the lid can never fall below
 *   z  the most of the view it can ever take, 0 to switch it off
 *   w  how fast it builds with distance, per metre
 */
export const MIST = new Float32Array([-1.1, 0.55, 0.85, 0.045]);

/**
 * What colour the mist is, which is NOT the fog's colour.
 *
 * Folding the mist into the fog factor was the obvious thing and it made the
 * effect invisible exactly where it matters. At night the fog is tuned nearly
 * to black so the treeline dissolves into the dark, and mist painted in that
 * colour is black laid over black - the shader ran perfectly and did nothing
 * you could see. Real night mist is visible for the opposite reason: it is the
 * one thing out there catching what little light there is. So it keeps a colour
 * of its own, above the fog's, and is composited after the fog rather than
 * into it.
 */
export const MIST_COLOR = new Float32Array([0.15, 0.17, 0.21]);

/**
 * How far the banks have drifted, and how far round they have turned.
 *
 * A Float32Array for the same reason MIST is - see above - so one write here
 * moves the fog in every material at once.
 *
 *   x, y  where the bank field has slid to
 *   z     how far it has rotated, which is what makes it swirl rather than
 *         merely slide: a field that only translates reads as a curtain being
 *         pulled past, and one that turns as it goes reads as air moving
 *   w     1 to treat the ground as a flat plane at y=0 rather than as the
 *         world's heightfield - which is what the menu stage is, and sampling
 *         the map's terrain at the stage's coordinates would pool the mist at
 *         whatever height some hill fifty metres into the wasteland happens to
 *         be, on a floor that is dead level
 */
export const MIST_DRIFT = new Float32Array([0, 0, 0, 0]);

/**
 * Banks of it, standing higher than the layer, in the low ground.
 *
 * The layer above is a lid: it fills hollows and hugs rises, and it is the same
 * depth everywhere it lies. What it never does is stand up - and a wood at
 * night is not evenly misty, it has PATCHES, waist to head high, that you walk
 * into and out of and that are somewhere else an hour later.
 *
 * Where they are is two conditions multiplied. Low ground, because that is
 * where cold air collects and it is the reason they are anywhere at all. And a
 * slowly turning noise field, thresholded hard so it is patches rather than a
 * wash - most of the map has none, and the ones it has are worth walking round.
 */
const BANK_SCALE = 0.013;    // how big a bank is - about eighty metres across
const BANK_LIFT = 2.3;       // how far above the layer one stands, in metres
const BANK_LOW = 0.55;       // ground below this much of the map's dip is "low"
const BANK_EDGE = 0.62;      // how much of the field becomes a bank at all
const BANK_DRIFT = 0.6;      // metres a second the field slides
const BANK_TURN = 0.035;     // radians a second it turns as it goes

/**
 * The softest the top of the layer is allowed to be.
 *
 * The ramp used to be a fixed 2.6 m, which quietly capped the whole effect: on
 * a clear night the layer is under a metre thick, so the ground itself sat only
 * a third of the way down a ramp that needed nearly three metres to reach full
 * density, and the mist could never be more than a suggestion no matter what it
 * was told. It is scaled by the layer's own thickness now - the deeper the mist,
 * the softer its top - and this is only the floor under that, so a very thin
 * layer still has an edge rather than a line.
 */
const SOFT_MIN = 0.4;
/** How far the lid wanders, and over what size of feature. */
const ROLL = 0.62;
const ROLL_SCALE = 0.021;

/**
 * And how ragged its top edge is, at a much finer scale.
 *
 * ROLL above moves the whole layer over fifty-metre features - it decides where
 * the mist is deep and where it is shallow. This is the other end of the same
 * idea: metre-scale noise on the lid, drifting, so the SURFACE of the layer is
 * torn rather than level. Without it the top of the mist is a line - a plane
 * seen edge-on is a line however soft the ramp under it is - and a straight
 * horizontal edge across a wood is the one thing fog never does.
 */
const WISP = 0.55;
const WISP_SCALE = 0.085;

let installed = false;

/** Turn the mist off, or back on, for whatever is about to be drawn. */
export function setMist(max) { MIST[2] = max; }

/**
 * Whether the ground under the mist is the world's terrain or a flat floor.
 *
 * The menu stage is a level plane at y=0 and shares these shaders with the map,
 * so without this the mist on it pools at the height of whatever the wasteland's
 * heightfield says about the stage's coordinates - which is a hill nobody can
 * see, on a floor that has none.
 */
export function setMistFlat(on) { MIST_DRIFT[3] = on ? 1 : 0; }

/** Move the banks on. Call once a frame with the frame's own delta. */
export function driftMist(dt) {
  MIST_DRIFT[0] += dt * BANK_DRIFT * 0.61;
  MIST_DRIFT[1] -= dt * BANK_DRIFT * 0.37;
  MIST_DRIFT[2] += dt * BANK_TURN;
}

/**
 * Patch the fog chunks and register the uniform.
 *
 * Must run before anything draws: three bakes the chunks into a program the
 * first time it renders with a material, and it reads the uniform list off
 * ShaderLib at the same moment. Anything compiled before this call keeps the
 * stock fog forever, which shows up as a world where half the trees have mist
 * around them and half do not.
 */
export function installGroundFog() {
  if (installed) return false;
  installed = true;

  // Every built-in shader gets the uniform. Ones whose programs never declare
  // it simply ignore it - three uploads only the uniforms a compiled program
  // actually has, so this cannot cost or break anything it does not apply to.
  for (const lib of Object.values(THREE.ShaderLib)) {
    if (!lib?.uniforms) continue;
    lib.uniforms.uMist = { value: MIST };
    lib.uniforms.uMistColor = { value: MIST_COLOR };
    lib.uniforms.uMistDrift = { value: MIST_DRIFT };
  }

  const C = THREE.ShaderChunk;

  C.fog_pars_vertex = `#ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogWorld;
  #endif`;

  // The world position, recovered from the view-space one.
  //
  // Not built from `transformed` and modelMatrix, which is the obvious way and
  // is wrong in three places: an instanced mesh carries an extra instanceMatrix,
  // a skinned one has already moved, and the sprite shader never declares
  // `transformed` at all - so that version fails to compile the moment anything
  // draws a sprite with fog on. Every shader that reaches this line does have
  // mvPosition, and undoing the view transform is nearly free: its rotation is
  // orthonormal, so the inverse rotation is three dot products against the
  // matrix's own columns and the inverse translation is cameraPosition.
  C.fog_vertex = `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogWorld = cameraPosition + vec3(
      dot( mvPosition.xyz, viewMatrix[0].xyz ),
      dot( mvPosition.xyz, viewMatrix[1].xyz ),
      dot( mvPosition.xyz, viewMatrix[2].xyz ) );
  #endif`;

  C.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec4 uMistDrift;
    uniform vec3 fogColor;
    uniform vec4 uMist;
    uniform vec3 uMistColor;
    varying float vFogDepth;
    varying vec3 vFogWorld;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif

    // The heightfield, exactly as World.heightAt computes it. Cheaper to
    // evaluate here than to sample: it is three sines, and the alternative is a
    // texture lookup and a texture to keep in step with the CPU copy.
    float mistGround( vec2 p ) {
      return sin( p.x * 0.031 ) * 1.6
           + cos( p.y * 0.027 ) * 1.4
           + sin( ( p.x + p.y ) * 0.013 ) * 2.2;
    }

    // Value noise, two octaves. Only ever asked for the shape of a horizon, so
    // quality is beside the point; what matters is that it is fixed in world
    // space. Mist has to stay where it is when you walk past it, and anything
    // driven by screen position or by time would swim.
    float mistHash( vec2 p ) {
      return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
    }
    float mistNoise( vec2 p ) {
      vec2 i = floor( p ), f = fract( p );
      f = f * f * ( 3.0 - 2.0 * f );
      return mix( mix( mistHash( i ), mistHash( i + vec2( 1.0, 0.0 ) ), f.x ),
                  mix( mistHash( i + vec2( 0.0, 1.0 ) ), mistHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
    }
  #endif`;

  C.fog_fragment = `#ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif

    // Ordinary distance fog first.
    vec3 fogged = mix( gl_FragColor.rgb, fogColor, fogFactor );

    // --- then the mist lying under it, in its own colour, over the top ------
    if ( uMist.z > 0.001 ) {
      float roll = ( mistNoise( vFogWorld.xz * ${ROLL_SCALE} ) * 2.0 - 1.0 ) * ${ROLL.toFixed(2)}
                 + ( mistNoise( vFogWorld.xz * ${(ROLL_SCALE * 3.7).toFixed(4)} ) * 2.0 - 1.0 ) * ${(ROLL * 0.4).toFixed(2)};
      // Two lids, whichever is higher: an absolute one that fills the hollows
      // like water, and one that follows the ground so the rises still have
      // something round their ankles.
      float ground = mix( mistGround( vFogWorld.xz ), 0.0, uMistDrift.w );
      float lid = max( uMist.x + roll, ground + uMist.y );

      // Banks standing in the low ground, turning as they drift.
      //
      // Rotating the sample as well as sliding it is what makes them swirl:
      // slide alone is a curtain being pulled past the camera, and nobody
      // believes weather that only travels in a straight line.
      float ca = cos( uMistDrift.z ), sa = sin( uMistDrift.z );
      vec2 turned = mat2( ca, -sa, sa, ca ) * vFogWorld.xz;
      float field = mistNoise( turned * ${BANK_SCALE} + uMistDrift.xy )
        * 0.65 + mistNoise( turned * ${(BANK_SCALE * 2.6).toFixed(5)} - uMistDrift.xy * 1.7 ) * 0.35;
      // Low ground only, and only the top of the field: most of the map has
      // none of this, and what it has is worth walking round rather than a
      // haze laid over everything.
      float low = 1.0 - smoothstep( uMist.x - ${BANK_LOW.toFixed(2)}, uMist.x + ${BANK_LOW.toFixed(2)}, ground );
      float bank = low * smoothstep( ${BANK_EDGE.toFixed(2)}, ${(BANK_EDGE + 0.22).toFixed(2)}, field );
      lid = max( lid, ground + uMist.y + bank * ${BANK_LIFT.toFixed(2)} );
      // Tear the top of it up, and let the tears drift.
      lid += ( mistNoise( vFogWorld.xz * ${WISP_SCALE} + uMistDrift.xy * 0.6 ) * 2.0 - 1.0 ) * ${WISP.toFixed(2)}
           + ( mistNoise( vFogWorld.xz * ${(WISP_SCALE * 2.7).toFixed(4)} - uMistDrift.xy ) * 2.0 - 1.0 ) * ${(WISP * 0.5).toFixed(2)};

      // Thickening downward from the lid rather than upward from the ground is
      // what makes it collect rather than blanket. Smoothstepped rather than
      // clamped, so the surface eases out instead of arriving at full density
      // the moment you drop under it.
      float sink = smoothstep( 0.0, 1.0,
        ( lid - vFogWorld.y ) / max( uMist.y, ${SOFT_MIN.toFixed(2)} ) );
      // It has to build with distance, or you are stood inside a solid wall of
      // it with your own boots fogged out.
      // Building with distance, and then gone again once the ordinary fog has
      // taken everything anyway.
      //
      // Without the second half the mist keeps painting its own colour onto
      // ground the fog has already faded out completely - so the far edge of
      // the world stays lighter than the sky above it and the two meet in a
      // dead straight horizontal line. Which is the "solid line of fog mass":
      // not the top of the layer at all, but the end of the ground. Fading the
      // mist back out as the fog closes leaves a band that thickens through the
      // middle distance and lets go of the horizon, which is what mist does.
      float mist = sink * ( 1.0 - exp( - vFogDepth * uMist.w ) )
        * ( 1.0 - fogFactor ) * uMist.z;
      fogged = mix( fogged, uMistColor, mist );
    }

    gl_FragColor.rgb = fogged;
  #endif`;

  return true;
}

/** Where the mist tops out at a point, on the CPU. Matches the shader exactly. */
export function mistLid(x, z, groundY) {
  const hash = (px, pz) => {
    const s = Math.sin(px * 127.1 + pz * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  };
  const noise = (px, pz) => {
    const ix = Math.floor(px), iz = Math.floor(pz);
    let fx = px - ix, fz = pz - iz;
    fx = fx * fx * (3 - 2 * fx);
    fz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz), b = hash(ix + 1, iz);
    const c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
    const top = a + (b - a) * fx;
    return top + ((c + (d - c) * fx) - top) * fz;
  };
  const roll = (noise(x * ROLL_SCALE, z * ROLL_SCALE) * 2 - 1) * ROLL
    + (noise(x * ROLL_SCALE * 3.7, z * ROLL_SCALE * 3.7) * 2 - 1) * ROLL * 0.4;
  return Math.max(MIST[0] + roll, groundY + MIST[1]);
}
