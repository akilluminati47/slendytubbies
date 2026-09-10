import { CFG } from "./config.js";

const KEY = "slendytubbies.settings";

/**
 * Player-facing settings, persisted per browser.
 *
 * These write straight through into CFG so nothing else in the game has to know
 * settings exist - the input sources keep reading CFG.player.mouseSens and so
 * on, exactly as they did before.
 */
export const DEFAULTS = {
  volume: 0.7,
  mouseSens: 2.1,        // shown as a friendly number; scaled to radians below
  padLookSpeed: 2.6,
  // On by default. The browser's own chrome is the single biggest thing between
  // a phone and this game - address bar, tab strip, gesture bar - and it costs
  // a fifth of the screen on the device that can least spare it.
  fullscreen: true,
  snapDegrees: 30,
  brightness: 1.15,
};

/**
 * `fmt` renders a stored value for display; `parse` turns typed text back into
 * one. They must be inverses - volume is stored 0..1 but shown as a percentage,
 * so typing "80" has to mean 0.8 and not 80.
 */
const num = (t) => parseFloat(String(t).replace(/[^0-9.+-]/g, ""));

export const SCHEMA = [
  { key: "volume", label: "Volume", min: 0, max: 1, step: 0.05,
    fmt: (v) => `${Math.round(v * 100)}%`, parse: (t) => num(t) / 100 },
  { key: "mouseSens", label: "Mouse sensitivity", min: 0.4, max: 6, step: 0.1,
    fmt: (v) => v.toFixed(1), parse: num },
  { key: "padLookSpeed", label: "Stick sensitivity", min: 0.8, max: 6, step: 0.1,
    fmt: (v) => v.toFixed(1), parse: num },
  { key: "brightness", label: "Brightness", min: 0.6, max: 2, step: 0.05,
    fmt: (v) => v.toFixed(2), parse: num },
  // Where "Invert look Y" used to be. Nothing in this game asks you to hold a
  // pitch for long enough to care which way it goes, and the pad's own invert
  // is still there in CFG for anybody who edits it - whereas whether the game
  // takes the whole screen is a choice every player has an opinion about the
  // first time they load it.
  { key: "fullscreen", label: "Full screen", type: "toggle" },
  { key: "snapDegrees", label: "VR turning", type: "choice",
    choices: [[0, "Smooth"], [15, "Snap 15°"], [30, "Snap 30°"], [45, "Snap 45°"]] },
];

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...load() };
    this.listeners = new Set();
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    this.values[key] = value;
    save(this.values);
    this.apply();
    for (const fn of this.listeners) fn(key, value);
  }

  onChange(fn) { this.listeners.add(fn); }

  reset() {
    this.values = { ...DEFAULTS };
    save(this.values);
    this.apply();
    for (const fn of this.listeners) fn(null, null);
  }

  /** Push current values into the places the engine actually reads. */
  apply(renderer, audio) {
    const v = this.values;
    // The slider is a human-friendly 0.4..6; the engine wants radians per pixel.
    CFG.player.mouseSens = v.mouseSens * 0.001;
    CFG.pad.lookSpeed = v.padLookSpeed;
    CFG.xr.snapDegrees = v.snapDegrees;
    this.renderer = renderer ?? this.renderer;
    this.audio = audio ?? this.audio;
    if (this.renderer) this.renderer.toneMappingExposure = v.brightness;
    if (this.audio) this.audio.setVolume(v.volume);
  }
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};   // private mode, blocked storage, corrupt value - defaults are fine
  }
}

function save(values) {
  try {
    localStorage.setItem(KEY, JSON.stringify(values));
  } catch {
    /* not worth telling the player about */
  }
}
