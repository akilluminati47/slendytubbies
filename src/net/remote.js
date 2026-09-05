import * as THREE from "three";
import { makeTubby } from "../entities/tubbyModel.js";
import { heightAt } from "../world/world.js";

/**
 * Another player, drawn with the same tubby model the AI uses.
 *
 * State arrives at ~15 Hz, so positions are interpolated rather than snapped.
 * We deliberately lag one update behind the newest packet: rendering toward a
 * position we have already received is smooth, whereas extrapolating ahead of
 * the network guesses wrong every time someone changes direction and produces
 * the rubber-banding that makes cheap netcode obvious.
 */
export class RemotePlayer {
  constructor(scene, { id, name, role, isHost }) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.isHost = isHost;

    this.model = makeTubby(role === "guardian" ? "guardian" : role);
    this.root = this.model.root;
    this.root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.castShadow = true; });
    scene.add(this.root);

    this.target = new THREE.Vector3();
    this.current = new THREE.Vector3();
    this.targetYaw = 0;
    this.yaw = 0;
    this.anim = "idle";
    this.speed = 0;
    this.seen = false;

    this.label = makeLabel(name, isHost);
    this.label.position.y = 2.25;
    this.root.add(this.label);
  }

  apply({ pos, yaw, anim }) {
    if (pos) {
      this.target.set(pos[0], pos[1], pos[2]);
      if (!this.seen) {
        // First packet: place them, do not slide in from the origin.
        this.current.copy(this.target);
        this.seen = true;
      }
    }
    if (typeof yaw === "number") this.targetYaw = yaw;
    if (anim) this.anim = anim;
  }

  update(dt, camera) {
    const prevX = this.current.x, prevZ = this.current.z;
    // 12/s converges in well under one network tick without visible stepping.
    this.current.lerp(this.target, Math.min(1, dt * 12));
    this.speed = Math.hypot(this.current.x - prevX, this.current.z - prevZ) /
      Math.max(dt, 1e-4);

    let d = this.targetYaw - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 10);

    this.root.position.set(this.current.x, heightAt(this.current.x, this.current.z), this.current.z);
    this.root.rotation.y = this.yaw;
    this.model.play(this.anim);
    this.model.update(dt, this.speed);

    // Name tags face the viewer, and only the viewer.
    if (camera) this.label.quaternion.copy(camera.quaternion);
  }

  dispose(scene) {
    scene.remove(this.root);
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.label.geometry.dispose();
  }
}

function makeLabel(name, isHost) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d");
  ctx.font = "600 30px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = isHost ? "#c9e0cd" : "#d8d2c4";
  ctx.fillText(isHost ? `${name} ★` : name, 128, 34);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false,
    // Visible through trees on purpose: losing a team-mate behind scenery in a
    // fog this thick is frustrating, not tense.
    depthTest: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.28), mat);
  mesh.renderOrder = 900;
  return mesh;
}
