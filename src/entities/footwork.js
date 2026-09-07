import * as THREE from "three";

/**
 * Feet that know what they are standing on.
 *
 * The clips were baked on a flat floor, so on the wasteland's rolling ground a
 * tubby walks with both soles at the same height whatever the hill is doing -
 * one foot through the slope, the other in the air - and with the ankle pitch
 * the animator gave it, which on the chase clip points the toes at the sky.
 *
 * Three corrections, all applied after the mixer has posed the skeleton, in the
 * order they depend on each other:
 *
 *   1. the pelvis drops to whichever foot has the lowest ground under it, so no
 *      leg is ever asked to reach further than it has;
 *   2. each ankle is lifted to its own ground and the leg is solved for it,
 *      which is what bends one knee and not the other on a slope - the
 *      suspension;
 *   3. the sole is rolled onto the ground plane, hard when the foot is planted
 *      and softly while it swings.
 *
 * None of it needs the clips changed, and all of it survives them being
 * rebaked.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _wq = new THREE.Quaternion();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Turn a bone by a rotation expressed in WORLD space.
 *
 * A bone's own quaternion is relative to its parent, and every joint in these
 * chains has a different parent orientation, so "rotate this foot to lie flat"
 * cannot be written as a local rotation without knowing the rig. Going through
 * the parent's world rotation means it never has to.
 */
function rotateWorld(bone, q) {
  if (!bone.parent) return;
  bone.parent.getWorldQuaternion(_pq);
  bone.getWorldQuaternion(_wq);
  bone.quaternion.copy(_pq.invert().multiply(_wq.premultiply(q)));
  bone.updateMatrixWorld(true);
}

/**
 * Bend a two-bone chain so its end lands on `target`.
 *
 * The usual analytic solve: the triangle hip-knee-ankle has three known sides,
 * so once the limb is pointed at the target the two joint angles fall out of
 * the law of cosines. It is exact, it never iterates, and the only judgement in
 * it is which way the knee should go when the leg is dead straight - that is
 * what `pole` is for.
 *
 * The reach is clamped just short of the leg's actual length. Asking a leg to
 * span exactly its own length is the one input where the arccosines go
 * degenerate, and a locked knee snapping straight is worse than a foot a
 * millimetre short of the ground.
 */
export function solveTwoBone(hip, knee, ankle, target, pole) {
  hip.updateWorldMatrix(true, false);
  _a.setFromMatrixPosition(hip.matrixWorld);
  _b.setFromMatrixPosition(knee.matrixWorld);
  _c.setFromMatrixPosition(ankle.matrixWorld);

  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);
  if (l1 < 1e-5 || l2 < 1e-5) return false;

  _d.subVectors(target, _a);
  let reach = _d.length();
  if (reach < 1e-5) return false;
  reach = clamp(reach, Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.999);
  _d.normalize();

  // 1. Swing the whole leg round until the ankle is on the line to the target.
  _n.subVectors(_c, _a).normalize();
  rotateWorld(hip, _q.setFromUnitVectors(_n, _d));

  // 2. Open or close the hip to the angle the triangle asks for.
  _b.setFromMatrixPosition(knee.matrixWorld);
  _n.subVectors(_b, _a).normalize();
  const wantHip = Math.acos(clamp((l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach), -1, 1));
  const hasHip = Math.acos(clamp(_n.dot(_d), -1, 1));
  let axis = _c.crossVectors(_n, _d);
  // A straight leg has no bend plane to read, so the pole says which way the
  // knee goes. Without it the solve is free to fold the knee backwards.
  if (axis.lengthSq() < 1e-9) axis.crossVectors(_d, pole);
  if (axis.lengthSq() < 1e-9) return false;
  rotateWorld(hip, _q.setFromAxisAngle(axis.normalize(), hasHip - wantHip));

  // 3. And close the knee itself.
  _a.setFromMatrixPosition(hip.matrixWorld);
  _b.setFromMatrixPosition(knee.matrixWorld);
  _c.setFromMatrixPosition(ankle.matrixWorld);
  const toHip = _n.subVectors(_a, _b).normalize();
  const toAnkle = _d.subVectors(_c, _b).normalize();
  const wantKnee = Math.acos(clamp((l1 * l1 + l2 * l2 - reach * reach) / (2 * l1 * l2), -1, 1));
  const hasKnee = Math.acos(clamp(toHip.dot(toAnkle), -1, 1));
  axis = _a.crossVectors(toAnkle, toHip);
  if (axis.lengthSq() < 1e-9) return false;
  rotateWorld(knee, _q.setFromAxisAngle(axis.normalize(), hasKnee - wantKnee));
  return true;
}

/**
 * Roll a foot until its sole lies along the ground.
 *
 * The sole's direction is the ankle-to-toe line, which every rig has whatever
 * it calls things, so this needs no measured foot plane. Flattening it means
 * taking out whatever part of that line points along the ground's normal - on
 * the level that is simply "stop pointing the toes up", and on a hill it is
 * "lie along the hill".
 *
 * @param weight 0 leaves the clip alone, 1 puts the sole flat.
 */
export function levelFoot(ankle, toe, normal, weight) {
  if (weight <= 0.001) return;
  ankle.updateWorldMatrix(true, false);
  _a.setFromMatrixPosition(ankle.matrixWorld);
  _b.setFromMatrixPosition(toe.matrixWorld);
  _c.subVectors(_b, _a);
  if (_c.lengthSq() < 1e-8) return;
  _c.normalize();

  _d.copy(_c).addScaledVector(normal, -_c.dot(normal));
  if (_d.lengthSq() < 1e-8) return;   // sole straight up the normal: nothing sane to do
  _d.normalize();

  // Part of the way, so a foot in mid-swing keeps some of its shape: the whole
  // correction slerped back toward doing nothing.
  _q.setFromUnitVectors(_c, _d).slerp(_pq.identity(), 1 - weight);
  rotateWorld(ankle, _q);
}

/**
 * The ground's normal, from four height samples around a point.
 *
 * A metre-ish apart rather than a hair: this is a foot deciding what surface it
 * is on, and sampling tight enough to feel every pebble in the heightfield gives
 * an ankle that twitches on flat ground.
 */
export function groundNormal(groundAt, x, z, out = new THREE.Vector3(), e = 0.45) {
  if (!groundAt) return out.set(0, 1, 0);
  const west = groundAt(x - e, z), east = groundAt(x + e, z);
  const south = groundAt(x, z - e), north = groundAt(x, z + e);
  return out.set(west - east, 2 * e, south - north).normalize();
}
