// Appearance of RF Sentinel (dark or light, from the CSS tokens in style.css) and the waterfall color maps
// (root/res/colormaps/*.json).

import { getJson } from "./api";

export interface ColorMap {
  name: string;
  author: string;
  map: string[];
}

export type Appearance = "dark" | "light";

const APPEARANCE_KEY = "sentinel.appearance";

// Colors the canvases need, read from the CSS tokens whenever the appearance changes
export const chart = {
  bg: "#0a0e14",
  grid: "#1c2430",
  axis: "#5b6b80",
  text: "#c9d4e3",
  trace: "#4da3ff",
  hold: "#f5d142",
  threshold: "#3ccf91",
  muted: "#6b778a",
};

function readChartColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  chart.bg = get("--chart-bg", chart.bg);
  chart.grid = get("--chart-grid", chart.grid);
  chart.axis = get("--chart-axis", chart.axis);
  chart.text = get("--chart-text", chart.text);
  chart.trace = get("--chart-trace", chart.trace);
  chart.hold = get("--chart-hold", chart.hold);
  chart.threshold = get("--chart-threshold", chart.threshold);
  chart.muted = get("--chart-muted", chart.muted);
}

export function getAppearance(): Appearance {
  try {
    return localStorage.getItem(APPEARANCE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function setAppearance(appearance: Appearance) {
  document.documentElement.dataset.theme = appearance;
  try {
    localStorage.setItem(APPEARANCE_KEY, appearance);
  } catch {
    // Not remembered, the page still switches
  }
  readChartColors();
}

export function loadColorMap(file: string): Promise<ColorMap> {
  return getJson<ColorMap>(`res/colormaps/${encodeURIComponent(file)}`);
}

function parseHex(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

export const PALETTE_SIZE = 1024;

// Interpolated palette as RGBA words ready for ImageData
export function buildPalette(map: string[]): Uint32Array {
  const colors = map.map(parseHex);
  const palette = new Uint32Array(PALETTE_SIZE);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const pos = (i / (PALETTE_SIZE - 1)) * (colors.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, colors.length - 1);
    const t = pos - lo;
    const r = Math.round(colors[lo][0] + (colors[hi][0] - colors[lo][0]) * t);
    const g = Math.round(colors[lo][1] + (colors[hi][1] - colors[lo][1]) * t);
    const b = Math.round(colors[lo][2] + (colors[hi][2] - colors[lo][2]) * t);
    palette[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  return palette;
}
