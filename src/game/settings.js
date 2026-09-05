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
  invertY: false,
  snapDegrees: 30,
  brightness: 1.15,
};

export const SCHEMA = [
  { key: "volume", label: "Volume", min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "mouseSens", label: "Mouse sensitivity", min: 0.4, max: 6, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: "padLookSpeed", label: "Stick sensitivity", min: 0.8, max: 6, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: "brightness", label: "Brightness", min: 0.6, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: "invertY", label: "Invert look Y", type: "toggle" },
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
    CFG.pad.invertY = v.invertY;
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
