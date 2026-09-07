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

const COMMON = /* glsl */`
  varying vec3 vSurfWorld;
  varying vec3 vSurfObj;
`;

const NOISE = /* glsl */`
  float sHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  // Value noise with smooth interpolation. Cheap, and the only quality that
  // matters here is that it has no visible grid.
  float sNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(sHash(i + vec3(0,0,0)), sHash(i + vec3(1,0,0)), f.x),
                   mix(sHash(i + vec3(0,1,0)), sHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(sHash(i + vec3(0,0,1)), sHash(i + vec3(1,0,1)), f.x),
                   mix(sHash(i + vec3(0,1,1)), sHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  float sFbm(vec3 p, int octaves) {
    float v = 0.0, amp = 0.5;
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
  float sRidge(vec3 p, int octaves) {
    float v = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++) {
      if (i >= octaves) break;
      float n = 1.0 - abs(sNoise(p) * 2.0 - 1.0);
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
  float sHeight(int kind, vec3 w, vec3 o) {
    if (kind == 0) {
      // Two scales: broad damp patches, and a fine tread underfoot.
      return sFbm(w * 0.55, 3) * 0.7 + sFbm(w * 4.3, 2) * 0.3;
    }
    if (kind == 1) {
      // Furrows up the trunk. The angular term is what makes them run
      // vertically; the noise added to it is what stops them being a barcode.
      float wander = sFbm(o * vec3(3.0, 0.55, 3.0), 3);
      float around = atan(o.z, o.x) * 2.6 + wander * 5.0;
      float furrow = sin(around) * 0.5 + 0.5;
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
export function carve(mat, kind, { bump = 0.6, mottle = 0.35, tint = 0x000000 } = {}) {
  const tintCol = new THREE.Color(tint);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSurfBump = { value: bump };
    shader.uniforms.uSurfMottle = { value: mottle };
    shader.uniforms.uSurfTint = { value: tintCol };

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
        vSurfObj = position;`);

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
        float sH = sHeight(${kind}, vSurfWorld, vSurfObj);
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
          vec3 dPdx = dFdx(vSurfWorld), dPdy = dFdy(vSurfWorld);
          float dHdx = dFdx(sH), dHdy = dFdy(sH);
          vec3 r1 = cross(dPdy, normal), r2 = cross(normal, dPdx);
          float det = dot(dPdx, r1);
          vec3 grad = (r1 * dHdx + r2 * dHdy) / max(abs(det), 1e-7);
          normal = normalize(normal - uSurfBump * grad);
        }`);
  };
  // A material that changes its program needs to say so, and two materials
  // carved differently must not share a compiled program.
  mat.customProgramCacheKey = () => `carve:${kind}:${bump}:${mottle}:${tintCol.getHex()}`;
  mat.needsUpdate = true;
  return mat;
}
