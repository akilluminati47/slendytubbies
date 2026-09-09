import * as THREE from "three";

/**
 * Procedural relief, carved into materials that already exist.
 *
 * The wasteland is built from a handful of flat colours on low-poly shapes, and
 * at the scale you actually see them - a trunk two metres away under a torch,
 * a rock you walk round, the ground under your feet - a flat colour reads as
 * plastic. The honest fix would be texture maps, which is megabytes of art per
 * surface and a UV unwrap for geometry that has none.
 *
 * So the detail is generated instead. Every material here keeps its own colour,
 * its own draw call and its own instancing; what gets added is a few dozen
 * instructions in its fragment shader that break the colour up and, more
 * importantly, bend the normal. Bending the normal is what makes it look
 * sculpted rather than painted: the relief then answers to the torch as you
 * move, which no amount of albedo variation can fake.
 *
 * The bump comes from the height field's screen-space derivative rather than
 * from a tangent frame. There are no tangents on any of this geometry - the
 * rocks are solids, the trunks are generated, the ground is a heightfield - and
 * deriving the gradient from dFdx/dFdy needs none.
 */

/** The three things this knows how to look like. */
export const GROUND = 0;
export const BARK = 1;
export const ROCK = 2;

/*
 * highp, said out loud, on everything this file touches.
 *
 * three emits a default precision based on what the device reports, and on a
 * phone that can come back mediump - which for ordinary shading is fine and for
 * hash noise is fatal. A mediump float carries about eleven bits of mantissa, so
 * by the time a world coordinate has been scaled to 4.3x and pushed through
 * three octaves it is a number near a thousand with no fractional part left.
 * floor() and fract() then return the same values across whole bands of the
 * surface, and the lattice the noise is built on becomes visible as a grid.
 *
 * That is the bug: not a missing height map, the height map quantised into
 * steps. WebGL2 guarantees highp is AVAILABLE in fragment shaders; it does not
 * guarantee it is the default. Asking for it per declaration does.
 */
const COMMON = /* glsl */`
  varying highp vec3 vSurfWorld;
  varying highp vec3 vSurfObj;
`;

const NOISE = /* glsl */`
  highp float sHash(highp vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  // Value noise with smooth interpolation. Cheap, and the only quality that
  // matters here is that it has no visible grid.
  highp float sNoise(highp vec3 x) {
    highp vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(sHash(i + vec3(0,0,0)), sHash(i + vec3(1,0,0)), f.x),
                   mix(sHash(i + vec3(0,1,0)), sHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(sHash(i + vec3(0,0,1)), sHash(i + vec3(1,0,1)), f.x),
                   mix(sHash(i + vec3(0,1,1)), sHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  highp float sFbm(highp vec3 p, int octaves) {
    highp float v = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++) {
      if (i >= octaves) break;
      v += sNoise(p) * amp;
      p = p * 2.02 + 31.7;
      amp *= 0.5;
    }
    return v;
  }

  // Ridged noise: folding the field about its midpoint turns smooth blobs into
  // creases, which is what stone and bark both actually are.
  highp float sRidge(highp vec3 p, int octaves) {
    highp float v = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++) {
      if (i >= octaves) break;
      highp float n = 1.0 - abs(sNoise(p) * 2.0 - 1.0);
      v += n * n * amp;
      p = p * 2.11 + 19.3;
      amp *= 0.5;
    }
    return v;
  }
`;

/**
 * The height field each surface is carved from.
 *
 * Ground is mottled and soft - soil, moss, the odd bare patch. Bark runs in
 * vertical furrows, warped so they wander rather than striping the trunk like a
 * barcode, and it is generated from OBJECT space so it climbs the trunk it is
 * on rather than sliding as the instance moves. Rock is ridged and much
 * sharper, because stone breaks rather than wearing.
 */
const HEIGHT = /* glsl */`
  highp float sHeight(int kind, highp vec3 w, highp vec3 o) {
    if (kind == 0) {
      // Two scales: broad damp patches, and a fine tread underfoot.
      return sFbm(w * 0.55, 3) * 0.7 + sFbm(w * 4.3, 2) * 0.3;
    }
    if (kind == 1) {
      // Furrows up the trunk. The angular term is what makes them run
      // vertically; the noise added to it is what stops them being a barcode.
      highp float wander = sFbm(o * vec3(3.0, 0.55, 3.0), 3);
      highp float around = atan(o.z, o.x) * 2.6 + wander * 5.0;
      highp float furrow = sin(around) * 0.5 + 0.5;
      return furrow * 0.55 + sRidge(o * vec3(6.0, 1.1, 6.0), 3) * 0.45;
    }
    // Rock.
    return sRidge(o * 2.6, 4) * 0.75 + sFbm(o * 9.0, 2) * 0.25;
  }
`;

/**
 * Add procedural relief and colour break-up to a material.
 *
 * @param mat    the MeshStandardMaterial to carve
 * @param kind   GROUND, BARK or ROCK
 * @param bump   how hard the normal is bent - the whole effect, really
 * @param mottle how much the albedo varies with the same field
 * @param tint   what the low parts of the surface are tinted toward
 */
/**
 * Everything carved so far, so a tuner can reach the live uniforms.
 *
 * The uniform objects do not exist until the material first compiles, which is
 * the first frame it is drawn - so they are collected here as that happens
 * rather than looked up through the renderer's private property map.
 */
/**
 * How each kind reads its object-space sample.
 *
 * Bark and ground take the raw local position. Bark HAS to: a trunk instance is
 * scaled (girth, height, girth) - a fifth of a metre across and twenty tall -
 * and the furrow field is hand-anisotropic to match, running one period every
 * five centimetres round the trunk and every thirty metres up it. Correcting
 * that for the instance scale would undo the very thing that makes furrows
 * furrows.
 *
 * Rock cannot. Boulders are instanced from a unit solid at 0.5 to 2.2 metres
 * and squashed about half as tall as they are wide, so a field sampled in the
 * raw local space arrives stretched by whatever that instance happens to be:
 * grain four times coarser on the big ones than the small, flattened into
 * horizontal bands on every one of them. Multiplying the sample by the
 * instance's own scale puts it back into metres, so a boulder's grain is the
 * size stone grain is, whatever size the boulder is.
 *
 * Scale is read off the instance matrix's columns rather than passed in, so
 * nothing outside the shader has to know or stay in step.
 */
const OBJ_SPACE = {
  [ROCK]: /* glsl */`
        #ifdef USE_INSTANCING
          vSurfObj = position * vec3( length( instanceMatrix[0].xyz ),
                                      length( instanceMatrix[1].xyz ),
                                      length( instanceMatrix[2].xyz ) );
        #else
          vSurfObj = position;
        #endif`,
};

export const CARVED = [];

export function carve(mat, kind, { bump = 0.6, mottle = 0.35, tint = 0x000000 } = {}) {
  const tintCol = new THREE.Color(tint);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSurfBump = { value: bump };
    shader.uniforms.uSurfMottle = { value: mottle };
    shader.uniforms.uSurfTint = { value: tintCol };
    CARVED.push({ mat, kind, u: shader.uniforms });

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${COMMON}`)
      .replace("#include <project_vertex>", `#include <project_vertex>
        // The world position, recovered from the view-space one. Instanced
        // meshes carry an extra matrix and these trunks and rocks are all
        // instanced, so rebuilding it from the local position would be wrong for
        // every one of them; undoing the view transform is right for all.
        vSurfWorld = cameraPosition + vec3(
          dot( mvPosition.xyz, viewMatrix[0].xyz ),
          dot( mvPosition.xyz, viewMatrix[1].xyz ),
          dot( mvPosition.xyz, viewMatrix[2].xyz ) );
        // And the object-space one, so bark climbs its own trunk and stone
        // keeps its own grain wherever the instance is put.
        ${OBJ_SPACE[kind] ?? "vSurfObj = position;"}`);

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        ${COMMON}
        uniform float uSurfBump;
        uniform float uSurfMottle;
        uniform vec3 uSurfTint;
        ${NOISE}
        ${HEIGHT}`)
      // Albedo first: the same field that will bend the normal also decides
      // what colour the low ground is, so the two agree instead of fighting.
      .replace("#include <color_fragment>", `#include <color_fragment>
        highp float sH = sHeight(${kind}, vSurfWorld, vSurfObj);
        diffuseColor.rgb = mix(diffuseColor.rgb,
          mix(uSurfTint, diffuseColor.rgb * 1.35, sH),
          uSurfMottle);`)
      // Then the relief. Taken after three has settled on a normal, so flat
      // shading still decides the facets and this only adds the grain on top.
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
        {
          // Gradient of the height field, from its screen-space derivatives.
          // None of this geometry has tangents - the rocks are solids, the
          // trunks are generated and the ground is a heightfield - and this
          // needs none.
          highp vec3 dPdx = dFdx(vSurfWorld), dPdy = dFdy(vSurfWorld);
          highp float dHdx = dFdx(sH), dHdy = dFdy(sH);
          highp vec3 r1 = cross(dPdy, normal), r2 = cross(normal, dPdx);
          highp float det = dot(dPdx, r1);
          highp vec3 grad = (r1 * dHdx + r2 * dHdy) / max(abs(det), 1e-7);
          normal = normalize(normal - uSurfBump * grad);
        }`);
  };
  // A material that changes its program needs to say so, and two materials
  // carved differently must not share a compiled program.
  mat.customProgramCacheKey = () => `carve:${kind}:${bump}:${mottle}:${tintCol.getHex()}`;
  mat.needsUpdate = true;
  return mat;
}
