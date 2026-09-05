/**
 * Lobby server for Slendytubbies.
 *
 * Cloudflare Pages serves the game itself as static files; it cannot hold state
 * or WebSockets, so lobbies live here. Each lobby is one Durable Object, and the
 * object's id is derived from the lobby password - so "everyone who typed the
 * same password" resolves to the same single-threaded actor with no registry,
 * no lookup table, and no way to enumerate lobbies you do not know the password
 * for. That is what makes them private and hidden rather than merely unlisted.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

/**
 * The password never leaves the browser in the clear and is never stored: the
 * client sends only a SHA-256 hash, and we use that hash as the object name.
 */
function validKey(key) {
  return typeof key === "string" && /^[a-f0-9]{64}$/.test(key);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const key = url.searchParams.get("k");
    if (!validKey(key)) {
      return json({ error: "bad or missing lobby key" }, 400);
    }

    // Same key -> same object, on every edge location.
    const id = env.LOBBY.idFromName(key);
    const stub = env.LOBBY.get(id);

    if (url.pathname === "/api/lobby" || url.pathname === "/api/ws") {
      return stub.fetch(request);
    }
    return json({ error: "not found" }, 404);
  },
};

/** Roles are fixed by the design: whoever creates the lobby hosts as Guardian. */
const GUEST_ROLES = ["laalaa", "po", "dipsy"];
const CAPACITY = 1 + GUEST_ROLES.length;

export class Lobby {
  constructor(state) {
    this.state = state;
    this.players = new Map();   // id -> { ws, name, role, isHost, pos, yaw, anim }
    this.nextId = 1;
    this.hostId = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/lobby") {
      // Peek before joining: this is what fills in "N/N in lobby".
      return json({
        exists: this.players.size > 0,
        players: this.players.size,
        capacity: CAPACITY,
        names: [...this.players.values()].map((p) => p.name),
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }

    const create = url.searchParams.get("create") === "1";
    if (this.players.size === 0 && !create) {
      return json({ error: "no lobby here yet - create it instead" }, 404);
    }
    if (this.players.size >= CAPACITY) {
      return json({ error: "lobby full" }, 409);
    }

    const name = (url.searchParams.get("name") || "Tubby").slice(0, 16);
    const pair = new WebSocketPair();
    this.#accept(pair[1], name);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  #freeRole() {
    // First in hosts as the Guardian; the rest take Laa-Laa, Po, Dipsy in order.
    if (this.players.size === 0) return { role: "guardian", isHost: true };
    const taken = new Set([...this.players.values()].map((p) => p.role));
    const role = GUEST_ROLES.find((r) => !taken.has(r)) ?? "dipsy";
    return { role, isHost: false };
  }

  #accept(ws, name) {
    ws.accept();
    const id = this.nextId++;
    const { role, isHost } = this.#freeRole();
    const me = { ws, id, name, role, isHost, pos: [0, 0, 0], yaw: 0, anim: "idle" };
    this.players.set(id, me);
    if (isHost) this.hostId = id;

    this.#send(ws, {
      t: "welcome",
      id,
      role,
      isHost,
      capacity: CAPACITY,
      peers: this.#roster(id),
    });
    this.#broadcast({ t: "join", id, name, role, isHost }, id);

    ws.addEventListener("message", (event) => this.#onMessage(me, event));
    const bye = () => this.#drop(me);
    ws.addEventListener("close", bye);
    ws.addEventListener("error", bye);
  }

  #roster(exceptId) {
    return [...this.players.values()]
      .filter((p) => p.id !== exceptId)
      .map((p) => ({ id: p.id, name: p.name, role: p.role, isHost: p.isHost,
                     pos: p.pos, yaw: p.yaw, anim: p.anim }));
  }

  #onMessage(me, event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;   // a peer sending junk is not worth tearing the lobby down for
    }

    switch (msg.t) {
      case "state":
        // Trust each client only for its OWN transform. Cheating your position
        // in a co-op fan game is not worth an authoritative simulation here, but
        // letting a client move *other* players would be absurd.
        if (Array.isArray(msg.pos) && msg.pos.length === 3) me.pos = msg.pos;
        if (typeof msg.yaw === "number") me.yaw = msg.yaw;
        if (typeof msg.anim === "string") me.anim = msg.anim.slice(0, 16);
        this.#broadcast({ t: "state", id: me.id, pos: me.pos, yaw: me.yaw, anim: me.anim }, me.id);
        break;

      case "world":
        // Only the host simulates the CPU Tinky Winky and the dishes, so only
        // the host may broadcast them. Otherwise every client fights over the
        // monster's position.
        if (me.id !== this.hostId) return;
        this.#broadcast({ t: "world", tubby: msg.tubby, custards: msg.custards }, me.id);
        break;

      case "took":
        this.#broadcast({ t: "took", i: msg.i, by: me.id }, null);
        break;

      case "ping":
        this.#send(me.ws, { t: "pong", at: msg.at });
        break;
    }
  }

  #drop(me) {
    if (!this.players.has(me.id)) return;
    this.players.delete(me.id);
    this.#broadcast({ t: "leave", id: me.id }, me.id);

    if (this.hostId === me.id) {
      // Promote the longest-standing survivor rather than collapsing the lobby.
      const next = [...this.players.values()][0];
      if (next) {
        next.isHost = true;
        next.role = "guardian";
        this.hostId = next.id;
        this.#broadcast({ t: "host", id: next.id, role: "guardian" }, null);
      } else {
        this.hostId = null;
      }
    }
  }

  #send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { /* closing */ }
  }

  #broadcast(obj, exceptId) {
    const data = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      try { p.ws.send(data); } catch { /* closing */ }
    }
  }
}
