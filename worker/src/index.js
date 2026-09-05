/**
 * Lobby server for Slendytubbies.
 *
 * Cloudflare Pages serves the game itself as static files; it cannot hold state
 * or WebSockets, so lobbies live here. Each lobby is one Durable Object whose id
 * is derived from a key - so "everyone with the same key" resolves to the same
 * single-threaded actor, on every edge location, with no lookup table.
 *
 * Two flavours, one mechanism:
 *
 *   PRIVATE - the key is a SHA-256 hash of the password. Nothing indexes it, so
 *             a lobby is reachable only by someone who already knows the word.
 *   PUBLIC  - the key is random, and the lobby additionally announces itself to
 *             a single Registry object so it can be listed and joined by anyone.
 *
 * The difference is purely whether the lobby opts into the registry. A private
 * lobby is not "hidden" by a flag we check - it is genuinely unlistable.
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

const validKey = (key) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Public listing does not belong to any one lobby.
    if (url.pathname === "/api/public") {
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("public"));
      return reg.fetch(new Request("https://do/list"));
    }

    const key = url.searchParams.get("k");
    if (!validKey(key)) return json({ error: "bad or missing lobby key" }, 400);

    if (url.pathname === "/api/lobby" || url.pathname === "/api/ws") {
      return env.LOBBY.get(env.LOBBY.idFromName(key)).fetch(request);
    }
    return json({ error: "not found" }, 404);
  },
};

/** Roles are fixed by the design: whoever creates the lobby hosts as Guardian. */
const GUEST_ROLES = ["laalaa", "po", "dipsy"];
const CAPACITY = 1 + GUEST_ROLES.length;

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map();   // id -> { ws, name, role, isHost, pos, yaw, anim }
    this.nextId = 1;
    this.hostId = null;
    this.public = false;
    this.title = "";
    this.key = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.key = url.searchParams.get("k");

    if (url.pathname === "/api/lobby") {
      // Peek before joining: this is what fills in "N/N in lobby".
      return json({
        exists: this.players.size > 0,
        players: this.players.size,
        capacity: CAPACITY,
        names: [...this.players.values()].map((p) => p.name),
        public: this.public,
        title: this.title,
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }

    const create = url.searchParams.get("create") === "1";
    if (this.players.size === 0 && !create) {
      return json({ error: "no lobby here yet - create it instead" }, 404);
    }
    if (this.players.size >= CAPACITY) return json({ error: "lobby full" }, 409);

    if (create && this.players.size === 0) {
      this.public = url.searchParams.get("public") === "1";
      this.title = (url.searchParams.get("title") || "").slice(0, 32);
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
    return { role: GUEST_ROLES.find((r) => !taken.has(r)) ?? "dipsy", isHost: false };
  }

  #accept(ws, name) {
    ws.accept();
    const id = this.nextId++;
    const { role, isHost } = this.#freeRole();
    const me = { ws, id, name, role, isHost, pos: [0, 0, 0], yaw: 0, anim: "idle" };
    this.players.set(id, me);
    if (isHost) this.hostId = id;

    this.#send(ws, {
      t: "welcome", id, role, isHost, capacity: CAPACITY,
      public: this.public, title: this.title,
      peers: this.#roster(id),
    });
    this.#broadcast({ t: "join", id, name, role, isHost }, id);
    this.#announce();

    ws.addEventListener("message", (event) => this.#onMessage(me, event));
    const bye = () => this.#drop(me);
    ws.addEventListener("close", bye);
    ws.addEventListener("error", bye);
  }

  /** Keep the public index in step. No-op for private lobbies. */
  #announce(removed = false) {
    if (!this.public || !this.key) return;
    const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("public"));
    const host = [...this.players.values()].find((p) => p.isHost);
    const body = {
      key: this.key,
      title: this.title || (host ? `${host.name}'s lobby` : "Open lobby"),
      players: this.players.size,
      capacity: CAPACITY,
      host: host?.name ?? "",
    };
    const gone = removed || this.players.size === 0;
    // Fire-and-forget: a registry hiccup must never break an in-progress game.
    this.env.REGISTRY && reg.fetch(new Request(
      gone ? "https://do/remove" : "https://do/upsert",
      { method: "POST", body: JSON.stringify(body) },
    )).catch(() => {});
  }

  #roster(exceptId) {
    return [...this.players.values()]
      .filter((p) => p.id !== exceptId)
      .map((p) => ({ id: p.id, name: p.name, role: p.role, isHost: p.isHost,
                     pos: p.pos, yaw: p.yaw, anim: p.anim }));
  }

  #onMessage(me, event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    switch (msg.t) {
      case "state":
        // Trust each client only for its OWN transform. Letting a client move
        // other players would be absurd; policing its own position is not worth
        // an authoritative simulation in a co-op fan game.
        if (Array.isArray(msg.pos) && msg.pos.length === 3) me.pos = msg.pos;
        if (typeof msg.yaw === "number") me.yaw = msg.yaw;
        if (typeof msg.anim === "string") me.anim = msg.anim.slice(0, 16);
        this.#broadcast({ t: "state", id: me.id, pos: me.pos, yaw: me.yaw, anim: me.anim }, me.id);
        break;

      case "world":
        // Only the host simulates the CPU Tinky Winky, so only the host may
        // broadcast it. Otherwise every client fights over where the monster is.
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
    this.#announce(this.players.size === 0);
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

/**
 * The public lobby index. One object for the whole game, which is fine: it only
 * sees a write when someone joins or leaves a public lobby.
 */
export class Registry {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/list") {
      const all = await this.state.storage.list({ prefix: "l:" });
      const now = Date.now();
      const lobbies = [];
      for (const [k, v] of all) {
        // A Worker can vanish without running cleanup, so entries expire rather
        // than being trusted forever. Two minutes is well past any real churn.
        if (now - v.updated > 120000) {
          await this.state.storage.delete(k);
          continue;
        }
        lobbies.push(v);
      }
      lobbies.sort((a, b) => b.players - a.players || a.title.localeCompare(b.title));
      return json({ lobbies: lobbies.slice(0, 40) });
    }

    if (url.pathname === "/upsert") {
      const body = await request.json();
      if (!validKey(body.key)) return json({ error: "bad key" }, 400);
      await this.state.storage.put(`l:${body.key}`, {
        key: body.key,
        title: String(body.title ?? "").slice(0, 32),
        host: String(body.host ?? "").slice(0, 16),
        players: body.players | 0,
        capacity: body.capacity | 0,
        updated: Date.now(),
      });
      return json({ ok: true });
    }

    if (url.pathname === "/remove") {
      const body = await request.json();
      if (validKey(body.key)) await this.state.storage.delete(`l:${body.key}`);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  }
}
