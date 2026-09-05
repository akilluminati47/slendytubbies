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
    // clipping the surface to paper white; the ground pool comes from the
    // PointLight below, which is unaffected by this.
    matFill: new THREE.MeshStandardMaterial({
      color: 0xb843c8, emissive: 0xa32ebb, emissiveIntensity: 1.15,
      roughness: 0.42, flatShading: true,
    }),
  };
  return shared;
}

/** One pickup. Returns the group plus the light so the game can pulse it. */
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
  const glow = new THREE.PointLight(0xf070ee, 11, 7, 2);
  glow.position.y = H / 2 + 0.1;
  g.add(glow);

  return { group: g, glow, height: H };
}
