/**
 * Lobby client.
 *
 * The password is never sent anywhere. It is hashed with SHA-256 in the browser
 * and only the hash travels, which is also what the server uses as the Durable
 * Object name — so a lobby is discoverable only by someone who already knows the
 * password, and the server never learns it either.
 *
 * The same hash seeds the world generator, so every player in a lobby walks the
 * same wasteland with the same trees and the same dishes without anyone having
 * to transmit a map.
 */

import { CFG } from "../game/config.js";

export const ROLE_LABEL = {
  guardian: "The Guardian",
  laalaa: "Laa-Laa",
  po: "Po",
  dipsy: "Dipsy",
  tinkywinky: "Tinky Winky",
};

/**
 * A key for a public lobby. Public lobbies have a NAME but no password, so
 * there is nothing to hash - the key is just a random address that the registry
 * hands out with the listing.
 */
export function randomKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function hashKey(password) {
  const bytes = new TextEncoder().encode(`slendytubbies:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A 32-bit world seed derived from the same hash, so the map matches for all. */
export function seedFromKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export class NetClient extends EventTarget {
  constructor(base) {
    super();
    // A localStorage override wins (local `wrangler dev`), then the deployed
    // Worker, then same-origin for anyone routing /api themselves.
    this.base = base || localStorage.getItem("slendytubbies.server") ||
      CFG.net.server || "";
    this.ws = null;
    this.id = null;
    this.role = null;
    this.isHost = false;
    this.peers = new Map();
    this.pollTimer = null;
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** One-shot look at a lobby without joining it. */
  async probe(key, signal) {
    const res = await fetch(`${this.base}/api/lobby?k=${key}`, { signal });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    return res.json();
  }

  /**
   * Poll a lobby while the player is looking at the password screen, so
   * "someone is hosting right now" is visible before they commit to joining.
   * Returns a stop function.
   */
  watch(key, onUpdate, intervalMs = 4000) {
    let stopped = false;
    let controller = null;

    const tick = async () => {
      if (stopped) return;
      controller?.abort();
      controller = new AbortController();
      try {
        onUpdate(await this.probe(key, controller.signal), null);
      } catch (err) {
        if (!stopped && err.name !== "AbortError") onUpdate(null, err);
      }
      if (!stopped) this.pollTimer = setTimeout(tick, intervalMs);
    };
    tick();

    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(this.pollTimer);
    };
  }

  /** Public lobbies only. Private ones are deliberately absent from this list. */
  async listPublic(signal) {
    const res = await fetch(`${this.base}/api/public`, { signal });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const data = await res.json();
    return data.lobbies ?? [];
  }

  /** Poll the public list while the player is looking at it. */
  watchPublic(onUpdate, intervalMs = 5000) {
    let stopped = false;
    let controller = null;
    const tick = async () => {
      if (stopped) return;
      controller?.abort();
      controller = new AbortController();
      try {
        onUpdate(await this.listPublic(controller.signal), null);
      } catch (err) {
        if (!stopped && err.name !== "AbortError") onUpdate(null, err);
      }
      if (!stopped) this.publicTimer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(this.publicTimer);
    };
  }

  async connect(key, name, create, opts = {}) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const host = this.base
      ? this.base.replace(/^https?:/, scheme)
      : `${scheme}//${location.host}`;
    let url = `${host}/api/ws?k=${key}&name=${encodeURIComponent(name)}` +
      `&create=${create ? 1 : 0}`;
    if (opts.public) {
      url += `&public=1&title=${encodeURIComponent(opts.title || "")}`;
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const failed = () => reject(new Error(
        create ? "could not create the lobby" : "no lobby on that password yet"));

      ws.addEventListener("open", () => { this.ws = ws; resolve(); }, { once: true });
      ws.addEventListener("error", failed, { once: true });
      ws.addEventListener("close", (e) => {
        if (this.ws !== ws) { failed(); return; }
        this.ws = null;
        this.#emit("closed", { code: e.code });
      });
      ws.addEventListener("message", (e) => this.#onMessage(e));
    });
  }

  #onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.t) {
      case "welcome":
        this.id = msg.id;
        this.role = msg.role;
        this.isHost = msg.isHost;
        this.peers.clear();
        for (const p of msg.peers) this.peers.set(p.id, p);
        this.#emit("welcome", msg);
        break;
      case "join":
        this.peers.set(msg.id, msg);
        this.#emit("join", msg);
        break;
      case "leave":
        this.peers.delete(msg.id);
        this.#emit("leave", msg);
        break;
      case "host":
        if (msg.id === this.id) { this.isHost = true; this.role = msg.role; }
        this.#emit("host", msg);
        break;
      case "state": {
        const p = this.peers.get(msg.id);
        if (p) { p.pos = msg.pos; p.yaw = msg.yaw; p.anim = msg.anim; }
        this.#emit("state", msg);
        break;
      }
      case "world": this.#emit("world", msg); break;
      case "took": this.#emit("took", msg); break;
      case "dead": {
        const p = this.peers.get(msg.id);
        if (p) p.dead = true;
        this.#emit("dead", msg);
        break;
      }
      case "over": this.#emit("over", msg); break;
      case "restart": this.#emit("restart", msg); break;
    }
  }

  #send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Called on a timer, not every frame - 15 Hz is plenty for walking speed. */
  sendState(pos, yaw, anim) {
    this.#send({ t: "state", pos: [+pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2)],
                 yaw: +yaw.toFixed(3), anim });
  }

  /** Host only; the server drops these from anyone else. */
  sendWorld(tubby, custards) { this.#send({ t: "world", tubby, custards }); }
  sendTook(i) { this.#send({ t: "took", i }); }
  sendDead() { this.#send({ t: "dead" }); }
  /** Host only; the server ignores it from anyone else. */
  sendRestart() { this.#send({ t: "restart" }); }

  close() {
    clearTimeout(this.pollTimer);
    clearTimeout(this.publicTimer);
    this.ws?.close();
    this.ws = null;
  }
}
