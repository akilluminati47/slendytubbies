import * as THREE from "three";

/**
 * Tubby custard, modelled from the Slendytubbies dish: a shallow 12-sided bowl
 * that tapers inward toward its base, slate blue outside with a paler rim, and
 * filled level with bright magenta custard.
 *
 * The faceting is the point - twelve segments and flat shading, matching the
 * source. A smooth 32-segment bowl would read as the wrong object entirely.
 *
 * Geometry and materials are built once and shared across all ten pickups;
 * only the group and its light are per-instance.
 */
const SEG = 12;
const R_TOP = 0.22;
const R_BOT = 0.155;
const H = 0.18;

let shared = null;

function build() {
  if (shared) return shared;

  const bowl = new THREE.CylinderGeometry(R_TOP, R_BOT, H, SEG, 1, true);
  const rim = new THREE.TorusGeometry(R_TOP, 0.012, 4, SEG);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, H / 2, 0);
  const base = new THREE.CircleGeometry(R_BOT, SEG);
  base.rotateX(Math.PI / 2);
  base.translate(0, -H / 2, 0);
  // Custard sits just under the rim, so you see a sliver of bowl wall above it.
  const fill = new THREE.CircleGeometry(R_TOP * 0.955, SEG);
  fill.rotateX(-Math.PI / 2);
  fill.translate(0, H / 2 - 0.022, 0);

  shared = {
    bowl,
    rim,
    base,
    fill,
    matBowl: new THREE.MeshStandardMaterial({
      color: 0x5c76a0, roughness: 0.55, metalness: 0.05,
      flatShading: true, side: THREE.DoubleSide,
    }),
    matRim: new THREE.MeshStandardMaterial({
      color: 0x7fa3d8, roughness: 0.5, flatShading: true,
    }),
    // The custard is the only thing in the game the player is hunting for, and
    // it has to read through 46 m of fog at the edge of a torch beam. It is lit
    // almost entirely by its own emission rather than by the scene.
    // Bright enough to spot, dim enough to still read as purple goop rather
    // than a white disc. toneMapped stays on so ACES can roll it off instead of
    // clipping the surface to paper white; the pool of light on the ground is a
    // separate thing entirely, owned by World.
    // fog:false on the goop alone. Every dish exists from the moment the map is
    // built, but fog reaches about 34m at night on a 220m map with the dishes
    // 26m apart, so nine of the ten were being erased by distance and they
    // seemed to arrive one at a time as you walked into them. A light source is
    // the one thing that does carry through haze, so the goop now ignores fog
    // while its bowl and rim do not: far away you see a purple ember with no
    // dish around it, which is exactly what a lamp looks like across a field.
    matFill: new THREE.MeshStandardMaterial({
      color: 0xb843c8, emissive: 0xa32ebb, emissiveIntensity: 1.15,
      roughness: 0.42, flatShading: true, fog: false,
    }),
    halo: haloTexture(),
  };
  return shared;
}

/**
 * A soft round glow, drawn once into a canvas and shared by every dish.
 *
 * The goop already ignores fog, which is what lets a dish exist at 100m instead
 * of being erased by haze - but existing is not the same as being findable. The
 * dish is 30cm across, so at fifty metres it covers about five pixels: present,
 * and no use to anybody looking for it. A halo holds a readable size long after
 * the object making it has stopped being one, which is exactly how a distant
 * light behaves and why it is the right cheat.
 */
function haloTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, "rgba(255,190,255,0.95)");
  g.addColorStop(0.25, "rgba(206,86,224,0.55)");
  g.addColorStop(0.6, "rgba(150,40,180,0.16)");
  g.addColorStop(1.0, "rgba(120,20,150,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** One pickup. The glow comes from World, not from here. */
export function makeCustard() {
  const s = build();
  const g = new THREE.Group();

  const body = new THREE.Mesh(s.bowl, s.matBowl);
  const lip = new THREE.Mesh(s.rim, s.matRim);
  const bottom = new THREE.Mesh(s.base, s.matBowl);
  const custard = new THREE.Mesh(s.fill, s.matFill);
  body.castShadow = lip.castShadow = true;
  g.add(body, lip, bottom, custard);

  // The dish is small and the fog is thick; this glow is what makes a tank
  // findable at the edge of the torch instead of by luck.
  // Far enough to spot through fog, weak enough that standing over the dish
  // does not flood the whole frame. Decay 2 (inverse-square) keeps the falloff
  // honest instead of dumping a flat pool of light on everything nearby.
  // NO per-dish light. Ten PointLights meant ten lights in every shader, and
  // hiding one on pickup changed the scene's light count - which makes three.js
  // recompile every material in the scene and drops a fat frame right at the
  // moment the player is being chased. World owns a single light that follows
  // the nearest dish instead; see World#updateGlow.
  // Additive and depth-tested but not depth-writing, so it reads as light
  // sitting on the dish rather than a card standing in front of it.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: s.halo, color: 0xffffff, transparent: true, fog: false,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95,
  }));
  // Big enough that the dishes across the map still read. A sprite keeps its
  // world size, so this is what decides whether the far ones are findable.
  halo.scale.setScalar(2.4);
  halo.position.y = H * 0.15;
  halo.renderOrder = 2;
  g.add(halo);

  return { group: g, meshes: [body, lip, bottom, custard], halo, height: H };
}
