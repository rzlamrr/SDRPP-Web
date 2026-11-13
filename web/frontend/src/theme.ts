// SDR++ themes (root/res/themes/*.json) and color maps (root/res/colormaps/*.json), used unchanged.

import { getJson } from "./api";

export interface Theme {
  [key: string]: string;
}

export interface ColorMap {
  name: string;
  author: string;
  map: string[];
}

// ImGui colors the interface uses, exposed as CSS variables of the same name
const THEME_KEYS = [
  "Text", "TextDisabled", "WindowBg", "ChildBg", "PopupBg", "Border", "FrameBg", "FrameBgHovered", "FrameBgActive",
  "Button", "ButtonHovered", "ButtonActive", "Header", "HeaderHovered", "HeaderActive", "CheckMark", "SliderGrab",
  "SliderGrabActive", "Separator", "PlotLines", "PlotHistogram", "ScrollbarBg", "ScrollbarGrab", "MenuBarBg",
  "FFTHoldColor", "ClearColor", "WaterfallBackground", "TextSelectedBg",
];

export let currentTheme: Theme = {};

export async function loadTheme(file: string): Promise<Theme> {
  const theme = await getJson<Theme>(`res/themes/${encodeURIComponent(file)}`);
  const root = document.documentElement;
  for (const key of THEME_KEYS) {
    if (typeof theme[key] === "string") root.style.setProperty(`--${key}`, theme[key]);
  }
  // The SDR++ icons are white, which disappears on light themes
  root.classList.toggle("light-icons", luminance(theme.Text ?? "#FFFFFFFF") < 0.5);
  currentTheme = theme;
  return theme;
}

export function loadColorMap(file: string): Promise<ColorMap> {
  return getJson<ColorMap>(`res/colormaps/${encodeURIComponent(file)}`);
}

function parseHex(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function luminance(color: string): number {
  const [r, g, b] = parseHex(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export const PALETTE_SIZE = 1024;

// Interpolated palette as RGBA words ready for ImageData (same resolution as WaterFall::updatePallette)
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
