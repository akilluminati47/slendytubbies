import { SCHEMA } from "./settings.js";
import { hashKey, randomKey, ROLE_LABEL } from "../net/client.js";

const $ = (id) => document.getElementById(id);

/**
 * Screen flow: title -> mode -> (lobby) -> game -> (pause) -> end.
 *
 * The title screen earns its place: browsers will not start an AudioContext
 * outside a user gesture, so the game needs one deliberate press before it
 * begins. Rather than a button nobody reads, ANY input dismisses it — key,
 * click, tap, or gamepad face button — and that same gesture unlocks the sound.
 */
export class UI {
  constructor(settings, net, hooks) {
    this.settings = settings;
    this.net = net;
    this.hooks = hooks;
    this.screen = "title";
    this.stopWatch = null;
    this.tab = "public";
    this.lobby = { key: null, info: null };

    this.#buildSettings();
    this.#wireTitle();
    this.#wireMode();
    this.#wireLobby();

    $("resume").onclick = () => this.hooks.onResume();
    $("restart").onclick = () => this.hooks.onRestart();
    $("reset-settings").onclick = () => { this.settings.reset(); this.#syncSettings(); };
    $("retry").onclick = () => this.hooks.onRestart();
  }

  /* ------------------------------------------------------------------ title */

  #wireTitle() {
    this.anyInput = (e) => {
      if (this.screen !== "title") return;
      if (e.type === "keydown" && (e.key === "F12" || e.key === "F5")) return;
      this.#dismissTitle();
    };
    for (const ev of ["keydown", "pointerdown", "touchstart"]) {
      addEventListener(ev, this.anyInput, { passive: true });
    }
  }

  /** Gamepad face buttons fire no DOM events, so main polls and calls this. */
  padPressed() {
    if (this.screen === "title") this.#dismissTitle();
  }

  #dismissTitle() {
    for (const ev of ["keydown", "pointerdown", "touchstart"]) {
      removeEventListener(ev, this.anyInput);
    }
    this.hooks.onUnlockAudio();
    this.show("mode");
  }

  /* ------------------------------------------------------------------- mode */

  #wireMode() {
    $("play-solo").onclick = () => this.hooks.onSolo();
    $("play-multi").onclick = () => {
      this.show("lobby");
      $("lobby-name").value = localStorage.getItem("slendytubbies.name") || "";
      this.#showTab("public");
    };
    $("vr").onclick = (e) => { e.stopPropagation(); this.hooks.onEnterVR(); };
  }

  /* ------------------------------------------------------------------ lobby */

  #wireLobby() {
    for (const tab of document.querySelectorAll(".tab")) {
      tab.onclick = () => this.#showTab(tab.dataset.tab);
    }

    const pass = $("lobby-pass");
    $("lobby-name").addEventListener("input", (e) => {
      localStorage.setItem("slendytubbies.name", e.target.value.trim());
    });

    // Debounced: hashing and probing on every keystroke would hammer the Worker
    // and flicker the status line while someone is still typing.
    let debounce;
    pass.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.#refreshPrivate(), 350);
    });
    pass.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      // Enter does the obvious thing: join if someone is hosting, else create.
      const btn = this.lobby.info?.exists ? $("lobby-join") : $("lobby-create");
      if (!btn.disabled) btn.click();
    });

    $("lobby-join").onclick = () => this.#enter(this.lobby.key, false, {});
    $("lobby-create").onclick = () => this.#enter(this.lobby.key, true, {});
    $("public-host").onclick = () => {
      const title = $("lobby-title").value.trim();
      this.#enter(randomKey(), true, { public: true, title });
    };
    for (const id of ["lobby-back", "lobby-back2"]) {
      $(id).onclick = () => { this.#stopWatching(); this.show("mode"); };
    }
  }

  #showTab(name) {
    this.tab = name;
    for (const t of document.querySelectorAll(".tab")) {
      t.classList.toggle("on", t.dataset.tab === name);
    }
    $("pane-public").classList.toggle("hide", name !== "public");
    $("pane-private").classList.toggle("hide", name !== "private");
    this.#stopWatching();
    if (name === "public") this.#refreshPublic();
    else this.#refreshPrivate();
  }

  #stopWatching() {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  /** Live list of public lobbies - name, host and headcount. */
  #refreshPublic() {
    const list = $("public-list");
    this.stopWatch = this.net.watchPublic((lobbies, err) => {
      if (this.screen !== "lobby" || this.tab !== "public") return;

      if (err) {
        list.textContent = "Cannot reach the lobby server. Play singleplayer, or host one yourself once it is deployed.";
        return;
      }
      if (!lobbies.length) {
        list.textContent = "No public lobbies right now. Host one and it appears here for everyone.";
        return;
      }

      list.textContent = "";
      for (const l of lobbies) {
        const full = l.players >= l.capacity;
        const row = document.createElement("button");
        row.className = "lobby-row";
        row.disabled = full;
        row.innerHTML =
          `<span class="name">${escapeHtml(l.title || "Open lobby")}</span>` +
          `<span class="who">${l.host ? escapeHtml(l.host) : "—"}</span>` +
          `<span class="count">${l.players}/${l.capacity}${full ? " full" : ""}</span>`;
        row.onclick = () => this.#enter(l.key, false, {});
        list.appendChild(row);
      }
    });
  }

  /**
   * Watch the lobby behind the typed password and keep the status line live, so
   * "a friend is on right now" is visible before committing to joining.
   */
  async #refreshPrivate() {
    this.#stopWatching();
    const password = $("lobby-pass").value.trim();

    if (password.length < 3) {
      this.lobby = { key: null, info: null };
      this.#setStatus("Enter a password to see who is in there.", "");
      this.#setPrivateButtons(false, false);
      return;
    }

    const key = await hashKey(password);
    this.lobby.key = key;
    this.#setStatus("Looking…", "");

    this.stopWatch = this.net.watch(key, (info, err) => {
      // A late response for a password the player has already changed must not
      // overwrite the current one.
      if (this.lobby.key !== key || this.screen !== "lobby" || this.tab !== "private") return;
      this.lobby.info = info;

      if (err) {
        this.#setStatus("Cannot reach the lobby server.<br>Check it is deployed, or play singleplayer.", "error");
        this.#setPrivateButtons(false, false);
        return;
      }
      if (!info.exists) {
        this.#setStatus("Nobody is on this password yet.<br>Create the lobby and you host as the Guardian.", "empty");
        this.#setPrivateButtons(false, true);
        return;
      }

      const full = info.players >= info.capacity;
      const host = info.names?.[0];
      this.#setStatus(
        `<b>${info.players} of ${info.capacity}</b> already inside` +
        (host ? `, hosted by <b>${escapeHtml(host)}</b>.` : ".") +
        (full ? "<br>The lobby is full." : "<br>Ready when you are."),
        "live");
      this.#setPrivateButtons(!full, false);
    });
  }

  #setStatus(html, cls) {
    const el = $("lobby-status");
    el.innerHTML = html;
    el.className = `status ${cls}`;
  }

  #setPrivateButtons(canJoin, canCreate) {
    $("lobby-join").disabled = !canJoin;
    $("lobby-create").disabled = !canCreate;
  }

  async #enter(key, create, opts) {
    if (!key) return;
    const name = ($("lobby-name").value.trim() || "Tubby").slice(0, 16);
    localStorage.setItem("slendytubbies.name", name);
    this.#setPrivateButtons(false, false);
    this.#stopWatching();
    if (this.tab === "private") this.#setStatus(create ? "Creating…" : "Joining…", "");
    else $("public-list").textContent = create ? "Creating…" : "Joining…";

    try {
      await this.hooks.onMultiplayer(key, name, create, opts);
    } catch (err) {
      const msg = `Could not ${create ? "create" : "join"}: ${escapeHtml(err.message)}`;
      if (this.tab === "private") this.#setStatus(msg, "error");
      this.#showTab(this.tab);
    }
  }

  /** Shown once in-game so a player knows which tubby they are. */
  announceRole(role, isHost) {
    const p = $("prompt");
    p.textContent = isHost
      ? `You are ${ROLE_LABEL[role]} — you host`
      : `You are ${ROLE_LABEL[role]}`;
    p.classList.add("on");
    clearTimeout(this.roleTimer);
    this.roleTimer = setTimeout(() => p.classList.remove("on"), 4000);
  }

  /* ---------------------------------------------------------------- screens */

  show(screen) {
    this.screen = screen;
    for (const id of ["title", "mode", "lobby", "pause", "end"]) {
      $(id).classList.toggle("hide", id !== screen);
    }
    document.body.classList.toggle("menu-open", screen !== "game");
    if (screen !== "lobby") this.#stopWatching();
  }

  showEnd(headline, detail) {
    $("end-title").textContent = headline;
    $("end-detail").innerHTML = detail;
    this.show("end");
  }

  setHints(html) { $("hints").innerHTML = html; }
  setNote(text) { $("note").textContent = text; }
  showVR(on) { $("vr").hidden = !on; }

  /* --------------------------------------------------------------- settings */

  #buildSettings() {
    const host = $("settings");
    host.innerHTML = "";
    for (const item of SCHEMA) {
      const row = document.createElement("label");
      row.className = "set-row";
      row.innerHTML = `<span class="set-label">${item.label}</span>`;

      if (item.type === "toggle") {
        const b = document.createElement("button");
        b.className = "set-toggle";
        b.dataset.key = item.key;
        b.onclick = () => {
          this.settings.set(item.key, !this.settings.get(item.key));
          this.#syncSettings();
        };
        row.appendChild(b);
      } else if (item.type === "choice") {
        const wrap = document.createElement("div");
        wrap.className = "set-choices";
        for (const [value, label] of item.choices) {
          const b = document.createElement("button");
          b.textContent = label;
          b.dataset.key = item.key;
          b.dataset.value = value;
          b.onclick = () => { this.settings.set(item.key, value); this.#syncSettings(); };
          wrap.appendChild(b);
        }
        row.appendChild(wrap);
      } else {
        const input = document.createElement("input");
        input.type = "range";
        input.min = item.min;
        input.max = item.max;
        input.step = item.step;
        input.dataset.key = item.key;
        input.oninput = () => {
          this.settings.set(item.key, parseFloat(input.value));
          this.#syncSettings();
        };
        const out = document.createElement("span");
        out.className = "set-value";
        out.dataset.out = item.key;
        row.append(input, out);
      }
      host.appendChild(row);
    }
    this.#syncSettings();
  }

  #syncSettings() {
    for (const item of SCHEMA) {
      const v = this.settings.get(item.key);
      if (item.type === "toggle") {
        const b = document.querySelector(`.set-toggle[data-key="${item.key}"]`);
        if (b) { b.textContent = v ? "On" : "Off"; b.classList.toggle("on", !!v); }
      } else if (item.type === "choice") {
        for (const b of document.querySelectorAll(`[data-key="${item.key}"][data-value]`)) {
          b.classList.toggle("on", Number(b.dataset.value) === v);
        }
      } else {
        const input = document.querySelector(`input[data-key="${item.key}"]`);
        const out = document.querySelector(`[data-out="${item.key}"]`);
        if (input) input.value = v;
        if (out) out.textContent = item.fmt ? item.fmt(v) : v;
      }
    }
  }
}

/** Names come from other players, so they are untrusted text. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
