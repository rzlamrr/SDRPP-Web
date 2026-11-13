// SDR++ web monitor: the main window of SDR++ (gui/main_window.cpp) with one waterfall per band.

import "./style.css";
import * as api from "./api";
import type { Menu, State } from "./api";
import { FreqSelect } from "./freqselect";
import { Pane, type PaneSettings } from "./pane";
import { renderMenu } from "./smgui";
import { Stream } from "./stream";
import { buildPalette, loadColorMap, loadTheme } from "./theme";
import { button, checkbox, collapsingHeader, combo, el, inputInt, inputText, latest, leftLabel, radio, row, vslider } from "./widgets";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function stored(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not remembered, the interface still works
  }
}

let state: State;
let selected = stored("sdrpp.selectedBand", 0);
let connected = true;
let actionError = "";
let colorMapAuthor = "";
const panes = new Map<number, Pane>();
const stream = new Stream();

const settings: PaneSettings = {
  min: -120,
  max: 0,
  showWaterfall: true,
  fftHeight: stored("sdrpp.fftHeight", 300),
  palette: buildPalette(["#000020", "#FFFFFF"]),
  running: false,
};

// --- top bar -----------------------------------------------------------------------------

const freqSelect = new FreqSelect($("freqSelect"));
const sendFrequency = latest((v: { id: number; frequency: number }) => run(() => api.updateBand(v.id, { frequency: v.frequency })));

freqSelect.onChange = (frequency) => {
  const pane = panes.get(selected);
  if (!pane) return;
  pane.setBand({ ...pane.band, frequency });
  sendFrequency({ id: selected, frequency });
};

$("menuBtn").addEventListener("click", () => {
  const hidden = document.body.classList.toggle("menu-hidden");
  store("sdrpp.menuHidden", hidden ? 1 : 2);
});
if (stored("sdrpp.menuHidden", 2) === 1) document.body.classList.add("menu-hidden");

$("playBtn").addEventListener("click", () => run(() => (state.running ? api.stop() : api.start())));

function drawSnr() {
  const canvas = $<HTMLCanvasElement>("snrCanvas");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const css = getComputedStyle(document.documentElement);
  const text = css.getPropertyValue("--Text") || "#fff";

  // Same scale as the SNR meter of SDR++: 0 to 100 dB with a mark every 10
  const pane = panes.get(selected);
  const snr = state?.running && pane?.latest && !pane.stale ? pane.latest.snr : 0;
  const scale = (width - 20) / 100;
  ctx.fillStyle = "rgb(0, 136, 255)";
  ctx.fillRect(10, 6, Math.min(Math.max(snr, 0), 100) * scale, 8);
  ctx.strokeStyle = text;
  ctx.fillStyle = text;
  ctx.font = "11px Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.beginPath();
  ctx.moveTo(10, 16.5);
  ctx.lineTo(width - 10, 16.5);
  for (let db = 0; db <= 100; db += 10) {
    const x = Math.round(10 + db * scale) + 0.5;
    ctx.moveTo(x, 16);
    ctx.lineTo(x, 21);
    ctx.fillText(String(db), x, 23);
  }
  ctx.stroke();
}

// --- waterfall controls (right strip) ------------------------------------------------------

const sendLevels = latest((v: { min: number; max: number }) => run(() => api.setDisplay(v), false));

const zoomSlider = vslider($("zoomSlider"), 1, 0, 1, (v) => {
  const pane = panes.get(selected);
  if (!pane) return;
  // Same curve as the Zoom slider in MainWindow::draw
  const bw = pane.band.sampleRate || 1;
  pane.setViewBandwidth(Math.min(1000 + v * v * (bw - 1000), bw));
});
const maxSlider = vslider($("maxSlider"), 0, -160, 0, (v) => {
  settings.max = Math.round(v);
  if (settings.max <= settings.min) {
    settings.min = settings.max - 1;
    minSlider.set(settings.min);
  }
  levelsChanged();
});
const minSlider = vslider($("minSlider"), 0, -160, -120, (v) => {
  settings.min = Math.round(v);
  if (settings.min >= settings.max) {
    settings.max = settings.min + 1;
    maxSlider.set(settings.max);
  }
  levelsChanged();
});

function levelsChanged() {
  state.display.min = settings.min;
  state.display.max = settings.max;
  panes.forEach((p) => p.settingsChanged());
  sendLevels({ min: settings.min, max: settings.max });
}

function syncZoomSlider() {
  const pane = panes.get(selected);
  if (!pane) return;
  const bw = pane.band.sampleRate || 1;
  const view = pane.viewFraction * bw;
  zoomSlider.set(bw <= 1000 ? 1 : Math.sqrt(Math.min(Math.max((view - 1000) / (bw - 1000), 0), 1)));
}

// --- menu ----------------------------------------------------------------------------------

const menuHost = $("menu");
const sourceSection = collapsingHeader("Source");
const bandsSection = collapsingHeader("Bands");
const displaySection = collapsingHeader("Display");
const themeSection = collapsingHeader("Theme", false);
menuHost.append(sourceSection.root, bandsSection.root, displaySection.root, themeSection.root);

const sourceTypeHost = el("div");
const radiosHost = el("div");
sourceSection.body.append(sourceTypeHost, radiosHost);

let menus: Menu[] = [];
const radioHosts: HTMLDivElement[] = [];
let menuPointerDown = false;
let menuPending = false;
radiosHost.addEventListener("pointerdown", () => (menuPointerDown = true));
window.addEventListener("pointerup", () => {
  menuPointerDown = false;
  if (menuPending) renderRadios();
});

function renderSourceType() {
  const names = state.sourceTypes.map((t) => t.name);
  const index = state.sourceTypes.findIndex((t) => t.id === state.sourceType);
  const select = combo(names, index, (i) => run(() => api.setSetup({ sourceType: state.sourceTypes[i].id })));
  select.classList.add("im-fill");
  // Like SDR++, the source can only be changed while stopped
  if (state.running) select.classList.add("im-disabled");
  sourceTypeHost.replaceChildren(row(select));
}

function renderRadios() {
  // Replacing a slider while it is being dragged would drop the drag
  if (menuPointerDown) {
    menuPending = true;
    return;
  }
  menuPending = false;
  radiosHost.replaceChildren();
  radioHosts.length = 0;
  menus.forEach((menu, i) => {
    if (menus.length > 1) {
      const radioState = state.radios[i];
      const names = (radioState?.bands ?? []).map((id) => state.bands.find((b) => b.id === id)?.name ?? `#${id}`);
      radiosHost.append(el("div", "im-separator-text", `Radio ${i + 1}${names.length ? `: ${names.join(", ")}` : " (no band)"}`));
    }
    const host = el("div", "radio-menu");
    renderMenu(host, menu, (action) =>
      sendMenuAction({ radio: i, action }),
    );
    radiosHost.append(host);
    radioHosts.push(host);
  });
  if (menus.length === 0) radiosHost.append(el("div", "im-text im-disabled-text", "No radio available"));
}

const sendMenuAction = latest(async (v: { radio: number; action: api.MenuAction }) => {
  await run(async () => {
    menus[v.radio] = await api.menuAction(v.radio, v.action);
    renderRadios();
    // A device or sample rate change shows up in the state
    return api.getState();
  });
});

async function refreshMenus() {
  try {
    menus = await Promise.all(state.radios.map((r) => api.getMenu(r.id)));
  } catch {
    menus = [];
  }
  renderRadios();
}

function renderBands() {
  const body = bandsSection.body;
  body.replaceChildren();
  body.append(
    leftLabel("Radios", inputInt(state.radioCount, 1, (v) => run(() => api.setSetup({ radioCount: v })))),
    leftLabel("Dwell (ms)", inputInt(state.dwellMs, 10, (v) => run(() => api.setSetup({ dwellMs: v })))),
    leftLabel("Settle (ms)", inputInt(state.settleMs, 5, (v) => run(() => api.setSetup({ settleMs: v })))),
  );
  for (const band of state.bands) {
    const select = radio("", band.id === selected, () => selectBand(band.id));
    const name = inputText(band.name, (v) => run(() => api.updateBand(band.id, { name: v })));
    name.classList.add("im-fill");
    const tag = el("span", "im-text band-radio", band.radio >= 0 ? `R${band.radio + 1}` : "-");
    tag.title = "Radio this band is received with";
    const remove = button("X", () => run(() => api.removeBand(band.id)));
    remove.title = "Remove this band";
    body.append(row(select, name, tag, remove));
  }
  const add = button("Add Band", () => {
    const base = state.bands.find((b) => b.id === selected) ?? state.bands[state.bands.length - 1];
    run(() => api.addBand({ frequency: base ? base.frequency : 100e6 }));
  });
  add.classList.add("im-fill");
  body.append(row(add));
}

function renderDisplay() {
  const d = state.display;
  const body = displaySection.body;
  const set = (display: Partial<api.Display>) => run(() => api.setDisplay(display));
  const windows = ["Rectangular", "Blackman", "Nuttall"];
  body.replaceChildren(
    row(checkbox("Show Waterfall", d.showWaterfall, (v) => set({ showWaterfall: v }))),
    row(checkbox("FFT Hold", d.fftHold, (v) => set({ fftHold: v }))),
    leftLabel("FFT Hold Speed", inputInt(d.fftHoldSpeed, 1, (v) => set({ fftHoldSpeed: v }))),
    row(checkbox("FFT Smoothing", d.fftSmoothing, (v) => set({ fftSmoothing: v }))),
    leftLabel("FFT Smoothing Speed", inputInt(d.fftSmoothingSpeed, 1, (v) => set({ fftSmoothingSpeed: v }))),
    leftLabel("FFT Framerate", inputInt(d.fftRate, 1, (v) => set({ fftRate: v }))),
    leftLabel("FFT Size", combo(state.fftSizes.map(String), state.fftSizes.indexOf(d.fftSize), (i) => set({ fftSize: state.fftSizes[i] }))),
    leftLabel("FFT Window", combo(windows, d.fftWindow, (i) => set({ fftWindow: i }))),
    leftLabel("Color Map", combo(state.colorMaps.map((c) => c.name), state.colorMaps.findIndex((c) => c.name === d.colorMap), (i) => set({ colorMap: state.colorMaps[i].name }))),
    row(el("span", "im-text", `Color map Author: ${colorMapAuthor}`)),
  );
}

function renderTheme() {
  const index = state.themes.findIndex((t) => t.name === state.display.theme);
  const select = combo(state.themes.map((t) => t.name), index, (i) => run(() => api.setDisplay({ theme: state.themes[i].name })));
  themeSection.body.replaceChildren(leftLabel("Theme", select));
}

// Menu width, dragged like the column border in SDR++
(() => {
  const handle = $("menuResize");
  const apply = (w: number) => document.documentElement.style.setProperty("--menu-width", `${Math.min(Math.max(w, 200), 700)}px`);
  apply(stored("sdrpp.menuWidth", 300));
  handle.addEventListener("pointerdown", (ev) => handle.setPointerCapture(ev.pointerId));
  handle.addEventListener("pointermove", (ev) => {
    if (!handle.hasPointerCapture(ev.pointerId)) return;
    apply(ev.clientX);
    store("sdrpp.menuWidth", Math.min(Math.max(ev.clientX, 200), 700));
  });
})();

// --- bands and panes -----------------------------------------------------------------------

function selectBand(id: number) {
  selected = id;
  store("sdrpp.selectedBand", id);
  panes.forEach((p, bandId) => p.setSelected(bandId === id && panes.size > 1));
  const band = state.bands.find((b) => b.id === id);
  if (band) {
    freqSelect.set(band.frequency);
    $("bandLabel").textContent = state.bands.length > 1 ? band.name : "";
  }
  syncZoomSlider();
  renderBands();
}

function syncPanes() {
  const host = $("panes");
  const ids = new Set(state.bands.map((b) => b.id));
  for (const [id, pane] of panes) {
    if (!ids.has(id)) {
      pane.root.remove();
      panes.delete(id);
    }
  }
  for (const band of state.bands) {
    let pane = panes.get(band.id);
    if (!pane) {
      pane = new Pane(band, settings, {
        onSelect: selectBand,
        onView: (id, offset, bandwidth, points) => {
          stream.setView(id, offset, bandwidth, points);
          if (id === selected) syncZoomSlider();
        },
        onTune: (id, frequency) => {
          if (id === selected) freqSelect.set(frequency);
          sendFrequency({ id, frequency });
        },
        onFftHeight: (height) => {
          settings.fftHeight = height;
          store("sdrpp.fftHeight", height);
          panes.forEach((p) => p.settingsChanged());
        },
      });
      panes.set(band.id, pane);
    } else {
      pane.setBand(band);
    }
    host.append(pane.root); // Keeps the panes in band order
  }
  const n = state.bands.length;
  const columns = n <= 2 ? 1 : n <= 6 ? 2 : 3;
  host.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  host.style.gridTemplateRows = `repeat(${Math.max(Math.ceil(n / columns), 1)}, minmax(0, 1fr))`;
  host.classList.toggle("empty", n === 0);

  if (!ids.has(selected) && state.bands.length > 0) selected = state.bands[0].id;
  selectBand(selected);
}

// --- state ---------------------------------------------------------------------------------

function showError() {
  const banner = $("error");
  const message = !connected ? "Lost connection to sdrpp. Retrying..." : actionError || state?.error || "";
  banner.hidden = message === "";
  banner.textContent = message;
}

// Runs an API call that returns the new state and applies it. Errors go to the banner.
async function run(action: () => Promise<State>, clearError = true) {
  try {
    const next = await action();
    if (clearError) actionError = "";
    await applyState(next);
  } catch (e) {
    actionError = e instanceof Error ? e.message : String(e);
    showError();
    // Controls may show a value the server refused
    renderSourceType();
    renderBands();
    renderDisplay();
  }
}

const part = {
  source: (s: State) => JSON.stringify([s.running, s.sourceType, s.radios.map((r) => [r.id, r.name, r.sampleRate, r.bands])]),
  bands: (s: State) => JSON.stringify([s.bands, s.radioCount, s.dwellMs, s.settleMs]),
  display: (s: State) => JSON.stringify([s.display, s.fftSizes, s.colorMaps]),
};

async function applyState(next: State) {
  const prev = state;
  state = next;

  if (!prev || prev.display.theme !== next.display.theme) {
    const theme = next.themes.find((t) => t.name === next.display.theme) ?? next.themes[0];
    if (theme) await loadTheme(theme.file).catch(() => {});
    panes.forEach((p) => p.queueDraw());
    renderTheme();
  }
  if (!prev || prev.display.colorMap !== next.display.colorMap) {
    const map = next.colorMaps.find((c) => c.name === next.display.colorMap) ?? next.colorMaps[0];
    if (map) {
      try {
        const loaded = await loadColorMap(map.file);
        settings.palette = buildPalette(loaded.map);
        colorMapAuthor = loaded.author;
      } catch {
        colorMapAuthor = "";
      }
    }
  }

  const displayChanged = !prev || part.display(prev) !== part.display(next);
  if (displayChanged) {
    settings.min = next.display.min;
    settings.max = next.display.max;
    settings.showWaterfall = next.display.showWaterfall;
    minSlider.set(settings.min);
    maxSlider.set(settings.max);
    panes.forEach((p) => p.settingsChanged());
    renderDisplay();
  }

  if (!prev || part.bands(prev) !== part.bands(next)) syncPanes();

  if (!prev || part.source(prev) !== part.source(next)) {
    renderSourceType();
    await refreshMenus();
  }

  if (settings.running !== next.running) {
    settings.running = next.running;
    panes.forEach((p) => p.queueDraw());
  }

  const icon = $<HTMLImageElement>("playIcon");
  icon.src = next.running ? "res/icons/stop.png" : "res/icons/play.png";
  icon.alt = next.running ? "Stop" : "Start";
  showError();
}

async function poll() {
  try {
    const next = await api.getState();
    connected = true;
    await applyState(next);
  } catch {
    connected = false;
    showError();
  }
  drawSnr();
  setTimeout(poll, 1000);
}

stream.onFrame = (frame) => {
  panes.get(frame.bandId)?.pushFrame(frame);
  if (frame.bandId === selected) drawSnr();
};
stream.onStatus = (up) => {
  if (up) panes.forEach((p) => p.resendView());
};

window.addEventListener("resize", drawSnr);

(async () => {
  // Font used by SDR++
  const font = new FontFace("Roboto", "url(res/fonts/Roboto-Medium.ttf)");
  font.load().then((f) => {
    document.fonts.add(f);
    panes.forEach((p) => p.queueDraw());
  }).catch(() => {});

  await poll();
  stream.connect();
})();
