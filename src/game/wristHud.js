import * as THREE from "three";

/**
 * A DOM HUD does not exist inside an immersive session - the headset composites
 * the WebGL layer and nothing else. So in VR the readouts move onto a small
 * panel angled off the left controller, the way a real wrist device would sit.
 * You have to glance at your hand to check your battery, which is a fair trade
 * and better horror than a number floating in your eye.
 */
export class WristHUD {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 320;
    this.canvas.height = 200;
    this.ctx = this.canvas.getContext("2d");

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.1), mat);
    this.mesh.renderOrder = 999;
    // Sat above the controller and tilted back toward the face.
    this.mesh.position.set(0, 0.05, -0.06);
    this.mesh.rotation.set(-Math.PI / 3, 0, 0);
    this.mesh.visible = false;

    this.last = "";
  }

  attach(node) {
    if (!node) return;
    node.add(this.mesh);
    this.mesh.visible = true;
  }

  detach() {
    this.mesh.visible = false;
    this.mesh.parent?.remove(this.mesh);
  }

  draw(found, total, battery, stamina, collectProgress = 0) {
    // Repainting a canvas every frame uploads a texture every frame; only redraw
    // when something a player could actually notice has changed.
    const key = `${found}|${battery.toFixed(2)}|${stamina.toFixed(2)}|${collectProgress.toFixed(2)}`;
    if (key === this.last || !this.mesh.visible) return;
    this.last = key;

    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(6,6,6,0.82)";
    c.strokeStyle = "rgba(216,210,196,0.35)";
    c.lineWidth = 2;
    roundRect(c, 4, 4, W - 8, H - 8, 12);
    c.fill();
    c.stroke();

    c.fillStyle = "#d8d2c4";
    c.font = "20px 'Courier New', monospace";
    c.fillText("CUSTARD", 24, 44);
    c.font = "54px 'Courier New', monospace";
    c.fillText(`${found} / ${total}`, 24, 98);

    bar(c, 24, 122, W - 48, 10, battery, "#c9b071", "BATTERY");
    bar(c, 24, 158, W - 48, 10, stamina, "#7e9b86", "STAMINA");

    if (collectProgress > 0) {
      c.fillStyle = "rgba(242,226,168,0.9)";
      c.fillRect(4, H - 12, (W - 8) * Math.min(1, collectProgress), 8);
    }

    this.texture.needsUpdate = true;
  }
}

function bar(c, x, y, w, h, v, color, label) {
  c.font = "13px 'Courier New', monospace";
  c.fillStyle = "rgba(216,210,196,0.5)";
  c.fillText(label, x, y - 5);
  c.fillStyle = "#241f18";
  c.fillRect(x, y, w, h);
  c.fillStyle = color;
  c.fillRect(x, y, w * Math.max(0, Math.min(1, v)), h);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
