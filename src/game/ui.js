import { SCHEMA } from "./settings.js";
import { hashKey, ROLE_LABEL } from "../net/client.js";

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
      $("lobby-name").value =
        localStorage.getItem("slendytubbies.name") || "";
      $("lobby-pass").focus();
      this.#refreshLobby();
    };
    $("vr").onclick = (e) => { e.stopPropagation(); this.hooks.onEnterVR(); };
  }

  /* ------------------------------------------------------------------ lobby */

  #wireLobby() {
    const pass = $("lobby-pass");
    const name = $("lobby-name");

    // Debounced: hash + probe on every keystroke would hammer the Worker and
    // flicker the status line while someone is still typing.
    let debounce;
    const onType = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.#refreshLobby(), 350);
    };
    pass.addEventListener("input", onType);
    name.addEventListener("input", () => {
      localStorage.setItem("slendytubbies.name", name.value.trim());
    });
    pass.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      // Enter does the obvious thing: join if someone is hosting, else create.
      const btn = this.lobby.info?.exists ? $("lobby-join") : $("lobby-create");
      if (!btn.disabled) btn.click();
    });

    $("lobby-join").onclick = () => this.#enter(false);
    $("lobby-create").onclick = () => this.#enter(true);
    $("lobby-back").onclick = () => {
      this.#stopWatching();
      this.show("mode");
    };
  }

  #stopWatching() {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  /**
   * Watch the lobby behind the typed password and keep the status line live, so
   * "a friend is on right now" is visible before you commit to joining.
   */
  async #refreshLobby() {
    this.#stopWatching();
    const password = $("lobby-pass").value.trim();
    const status = $("lobby-status");

    if (password.length < 3) {
      this.lobby = { key: null, info: null };
      this.#setStatus("Enter a password to see who is in there.", "");
      this.#setLobbyButtons(false, false);
      return;
    }

    const key = await hashKey(password);
    this.lobby.key = key;
    this.#setStatus("Looking…", "");

    this.stopWatch = this.net.watch(key, (info, err) => {
      // A late response for a password the player has already changed must not
      // overwrite the current one.
      if (this.lobby.key !== key || this.screen !== "lobby") return;
      this.lobby.info = info;

      if (err) {
        this.#setStatus(
          "Cannot reach the lobby server.<br>Check it is deployed, or play singleplayer.",
          "error");
        this.#setLobbyButtons(false, false);
        return;
      }

      if (!info.exists) {
        this.#setStatus(
          "No lobby on this password.<br><b>Create</b> one and you host as the Guardian.",
          "empty");
        this.#setLobbyButtons(false, true);
        return;
      }

      const full = info.players >= info.capacity;
      const host = info.names?.[0];
      this.#setStatus(
        `<b>${info.players}/${info.capacity}</b> in the lobby` +
        (host ? ` · hosted by <b>${escapeHtml(host)}</b>` : "") +
        (full ? "<br>Lobby is full." : "<br>Ready when you are."),
        "live");
      this.#setLobbyButtons(!full, false);
    });
  }

  #setStatus(html, cls) {
    const el = $("lobby-status");
    el.innerHTML = html;
    el.className = `status ${cls}`;
  }

  #setLobbyButtons(canJoin, canCreate) {
    $("lobby-join").disabled = !canJoin;
    $("lobby-create").disabled = !canCreate;
  }

  async #enter(create) {
    const name = ($("lobby-name").value.trim() || "Tubby").slice(0, 16);
    localStorage.setItem("slendytubbies.name", name);
    this.#setLobbyButtons(false, false);
    this.#setStatus(create ? "Creating…" : "Joining…", "");
    this.#stopWatching();
    try {
      await this.hooks.onMultiplayer(this.lobby.key, name, create);
    } catch (err) {
      this.#setStatus(`Could not ${create ? "create" : "join"}: ${escapeHtml(err.message)}`, "error");
      this.#refreshLobby();
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
