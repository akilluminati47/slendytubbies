/**
 * A keyboard you can use with a thumb.
 *
 * Every screen in this game is navigable with a pad except the two that matter
 * most for playing with anybody else: a lobby needs a name and a private lobby
 * needs a password, and neither can be typed with a stick. A controller player
 * could reach the Public list and nothing else. Focusing the field did happen -
 * MenuNav called .focus() on it - it just did not help, because focus without a
 * keyboard is an insertion point you cannot put anything into.
 *
 * So the field opens this instead. It is deliberately its own grid rather than
 * a reuse of the menu cursor: a keyboard is a two-dimensional thing where left
 * and right and up and down all mean position, and the menu's list walk has no
 * way to express that.
 */

/**
 * Rows, laid out as a real keyboard is.
 *
 * Digits on top rather than hidden behind a shift, because half of what anybody
 * types into these fields is a password with a number in it, and a layer you
 * have to discover is a layer most people will not find.
 */
const ROWS = [
  [..."1234567890"],
  [..."qwertyuiop"],
  [..."asdfghjkl-"],
  [..."zxcvbnm_."],
  [
    { key: "caps", label: "Caps", wide: 2 },
    { key: "space", label: "Space", wide: 4 },
    { key: "del", label: "Del", wide: 2 },
    { key: "done", label: "Done", wide: 2 },
  ],
];

export class Osk {
  constructor(root) {
    this.root = root;
    this.target = null;
    this.open = false;
    this.row = 1;
    this.col = 0;
    this.caps = false;
    this.cells = [];
    this.#build();
  }

  #build() {
    this.root.innerHTML = "";
    const preview = document.createElement("div");
    preview.className = "osk-preview";
    this.root.appendChild(preview);
    this.preview = preview;

    ROWS.forEach((row, r) => {
      const line = document.createElement("div");
      line.className = "osk-row";
      this.cells[r] = [];
      row.forEach((cell, c) => {
        const spec = typeof cell === "string" ? { key: cell, label: cell } : cell;
        const b = document.createElement("button");
        b.className = "osk-key" + (spec.wide ? " wide-" + spec.wide : "");
        b.textContent = spec.label;
        b.dataset.key = spec.key;
        // Clickable too. A pad player is the reason this exists, but a touch
        // player has one of these already and a mouse player might still reach
        // for it, and neither should find a keyboard that ignores them.
        b.addEventListener("click", () => { this.#press(spec.key); this.#paint(); });
        line.appendChild(b);
        this.cells[r][c] = b;
      });
      this.root.appendChild(line);
    });

    const hint = document.createElement("div");
    hint.className = "osk-hint";
    hint.innerHTML = "<b>A</b> type &nbsp;·&nbsp; <b>B</b> delete &nbsp;·&nbsp; " +
      "<b>Start</b> done";
    this.root.appendChild(hint);
  }

  /** Point it at a field and show it. */
  show(input) {
    this.target = input;
    this.open = true;
    this.caps = false;
    this.row = 1;
    this.col = 0;
    this.root.classList.remove("hide");
    this.#paint();
  }

  hide() {
    this.open = false;
    this.target = null;
    this.root.classList.add("hide");
  }

  #move(dr, dc) {
    if (dr) {
      this.row = (this.row + dr + ROWS.length) % ROWS.length;
      // Rows are different lengths, so hold the position across the jump rather
      // than snapping to the start - moving down a keyboard should keep your
      // thumb roughly where it was.
      this.col = Math.min(this.col, this.cells[this.row].length - 1);
    }
    if (dc) {
      const w = this.cells[this.row].length;
      this.col = (this.col + dc + w) % w;
    }
  }

  #paint() {
    for (const row of this.cells) for (const b of row) b.classList.remove("on");
    this.cells[this.row]?.[this.col]?.classList.add("on");
    for (const row of this.cells) {
      for (const b of row) {
        if (b.dataset.key.length === 1 && /[a-z]/.test(b.dataset.key)) {
          b.textContent = this.caps ? b.dataset.key.toUpperCase() : b.dataset.key;
        }
      }
    }
    this.cells[0][0].parentElement.parentElement
      .querySelector(".osk-key[data-key='caps']")?.classList.toggle("live", this.caps);
    const v = this.target?.value ?? "";
    // Never show a password back as plain text on a screen somebody else may be
    // looking at - the field itself is what the typist reads.
    this.preview.textContent = this.target?.type === "password"
      ? "•".repeat(v.length) : (v || this.target?.placeholder || "");
  }

  #type(ch) {
    const el = this.target;
    if (!el) return;
    const max = el.maxLength > 0 ? el.maxLength : 64;
    if (el.value.length >= max) return;
    el.value += ch;
    // The lobby watches this field to poll for a game on that password, so the
    // event matters as much as the character does.
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  #backspace() {
    const el = this.target;
    if (!el || !el.value) return;
    el.value = el.value.slice(0, -1);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  #press(key) {
    if (key === "caps") { this.caps = !this.caps; return; }
    if (key === "space") { this.#type(" "); return; }
    if (key === "del") { this.#backspace(); return; }
    if (key === "done") { this.hide(); return; }
    this.#type(this.caps ? key.toUpperCase() : key);
  }

  /**
   * One frame of pad input. Returns true while it is holding the controls, so
   * the caller knows not to move the menu cursor underneath it.
   */
  handle(nav) {
    if (!this.open) return false;
    if (nav.up) this.#move(-1, 0);
    if (nav.down) this.#move(1, 0);
    if (nav.left) this.#move(0, -1);
    if (nav.right) this.#move(0, 1);
    if (nav.accept) this.#press(this.cells[this.row][this.col].dataset.key);
    // B deletes rather than closing. Backspace is the key you reach for most
    // and the hardest to get to on a grid; closing has its own key on the row.
    if (nav.back) this.#backspace();
    if (nav.start) this.hide();
    this.#paint();
    return this.open;
  }
}
