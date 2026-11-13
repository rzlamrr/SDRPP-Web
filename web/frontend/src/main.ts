// RF Sentinel: multi-band RF interference monitor. Every band is shown live on the band wall, with the
// alert feed beside it and the event timeline underneath. Data comes from `sdrpp --web` (web/src).

import "./style.css";
import * as api from "./api";
import type { Interference, InterferenceEvent, Menu, State } from "./api";
import { AlertFeed } from "./alertfeed";
import { FreqSelect } from "./freqselect";
import { ICONS } from "./icons";
import { typeInfo, hz } from "./interference";
import type { PaneSettings } from "./pane";
import { SettingsDrawer } from "./settings";
import { bandHealth, sortEvents } from "./status";
import { Stream } from "./stream";
import { buildPalette, getAppearance, loadColorMap, setAppearance } from "./theme";
import { Timeline } from "./timeline";
import { LAYOUTS, Wall } from "./wall";
import { el, latest, leftLabel, segmented, setIcon, slider, toggle } from "./widgets";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function stored(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
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

setAppearance(getAppearance());

let state: State;
let interference: Interference | null = null;
let menus: Menu[] = [];
let selected = stored("sentinel.selectedBand", -1);
let connected = true;
let actionError = "";
let colorMapAuthor = "";
let runningSince = 0;
const stream = new Stream();

const settings: PaneSettings = {
  min: -120,
  max: 0,
  showWaterfall: true,
  fftRatio: stored("sentinel.fftRatio", 0.5),
  palette: buildPalette(["#000020", "#FFFFFF"]),
  running: false,
  dwellMs: 100,
  fftRate: 20,
  fftMode: "line",
  persistenceSpeed: 20,
};

// --- band wall ------------------------------------------------------------------------------

const sendFrequency = latest((v: { id: number; frequency: number }) => run(() => api.updateBand(v.id, { frequency: v.frequency })));

const wall = new Wall($("wall"), settings, {
  onSelect: selectBand,
  onView: (id, offset, bandwidth, points) => stream.setView(id, offset, bandwidth, points),
  onTune: (id, frequency) => {
    if (id === selected) freqSelect.set(frequency);
    sendFrequency({ id, frequency });
  },
  onFftRatio: (ratio) => {
    settings.fftRatio = Math.min(Math.max(ratio, 0.2), 0.8);
    store("sentinel.fftRatio", settings.fftRatio);
    wall.panes.forEach((p) => p.settingsChanged());
  },
  onLayout: (layout) => layoutSeg.set(LAYOUTS.indexOf(layout)),
  onAddBand: addBand,
  onOpenSettings: () => drawer.open("Radios"),
});

function selectBand(id: number) {
  selected = id;
  store("sentinel.selectedBand", id);
  wall.panes.forEach((p, bandId) => p.root.classList.toggle("selected", bandId === id && wall.panes.size > 1));
  const band = state?.bands.find((b) => b.id === id);
  freqSelect.set(band ? band.frequency : 0);
  $("freqSelect").classList.toggle("disabled", !band);
  $("centerLabel").textContent = band ? `${band.name} center` : "Center";
}

function addBand() {
  const base = state?.bands.find((b) => b.id === selected) ?? state?.bands[state.bands.length - 1];
  run(() => api.addBand({ frequency: base ? base.frequency : 100e6 }));
}

// --- top bar ----------------------------------------------------------------------------------

$("brandIcon").innerHTML = ICONS.logo;
setIcon($("settingsBtn"), "settings");
$("runBtn").addEventListener("click", toggleRunning);
$("settingsBtn").addEventListener("click", () => (drawer.isOpen ? drawer.close() : drawer.open()));
$("themeBtn").addEventListener("click", () => {
  applyAppearance(getAppearance() === "dark" ? "light" : "dark");
});
$("alertBtn").addEventListener("click", showWorstAlert);

function toggleRunning() {
  if (state) run(() => (state.running ? api.stop() : api.start()));
}

function applyAppearance(a: "dark" | "light") {
  setAppearance(a);
  renderThemeButton();
  wall.panes.forEach((p) => p.queueDraw());
  timeline.draw();
  drawer.refresh();
}

function renderThemeButton() {
  const dark = getAppearance() === "dark";
  setIcon($("themeBtn"), dark ? "sun" : "moon");
  $("themeBtn").title = dark ? "Switch to the light appearance" : "Switch to the dark appearance";
}
renderThemeButton();

function clockText(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function renderTopBar() {
  const pill = $("statusPill");
  const learning = !!interference?.settings.enabled && !!interference?.bands.some((b) => b.learning) && state?.running;
  let cls: string;
  let text: string;
  if (!connected) [cls, text] = ["bad", "Monitor offline"];
  else if (!state) [cls, text] = ["idle", "Connecting…"];
  else if (!state.running) [cls, text] = ["idle", "Stopped"];
  else if (!state.radios.some((r) => r.online)) [cls, text] = ["bad", "No radio"];
  else if (learning) [cls, text] = ["learn", "Learning baseline"];
  else [cls, text] = ["ok", "Monitoring"];
  pill.className = `pill ${cls}`;
  pill.textContent = text;

  if (state) {
    const online = state.radios.filter((r) => r.online).length;
    const parts = [`${online}/${state.radios.length} radio${state.radios.length === 1 ? "" : "s"}`, `${state.bands.length} band${state.bands.length === 1 ? "" : "s"}`];
    if (state.running && runningSince) parts.push(`running ${clockText(Date.now() - runningSince)}`);
    $("summary").textContent = parts.join(" · ");
  }

  const alertBtn = $("alertBtn");
  const n = interference?.active.length ?? 0;
  if (n > 0 && interference) {
    alertBtn.className = "pill-btn bad";
    const worst = sortEvents(interference.active, interference.settings)[0];
    setIcon(alertBtn, "alert", `${n} active · ${typeInfo(worst.type).label}${worst.type === "noise" ? "" : ` ${hz(worst.center)}`}`);
    alertBtn.title = "Show the most severe interference (A)";
  } else {
    alertBtn.className = "pill-btn ok";
    setIcon(alertBtn, "check", "No active alerts");
    alertBtn.title = "";
  }

  const runBtn = $("runBtn");
  const running = !!state?.running;
  runBtn.className = `btn primary${running ? " stop" : ""}`;
  setIcon(runBtn, running ? "stop" : "play", running ? "Stop" : "Start");
}

// --- toolbar --------------------------------------------------------------------------------

const layoutSeg = segmented(["Grid", "Stack"], LAYOUTS.indexOf(wall.layout), (i) => wall.setLayout(LAYOUTS[i]), [
  "Main band on top, the others two per row below it (G)",
  "One full-width row per band (S)",
]);
$("layoutSeg").append(layoutSeg.root);

const modeSeg = segmented(["Line", "Persistence"], 0, (i) => run(() => api.setDisplay({ fftMode: i === 1 ? "persistence" : "line" })), [
  "Latest spectrum as a line",
  "How often each level occurs: shows signals that come and go",
]);
$("modeSeg").append(modeSeg.root);

const waterfallToggle = toggle("Waterfall", true, (v) => run(() => api.setDisplay({ showWaterfall: v })));
$("waterfallTool").append(waterfallToggle.root);

const sendLevels = latest((v: { min: number; max: number }) => run(() => api.setDisplay(v), false));

function setLevels(min: number, max: number) {
  settings.min = Math.round(min);
  settings.max = Math.round(max);
  if (state) {
    state.display.min = settings.min;
    state.display.max = settings.max;
  }
  wall.panes.forEach((p) => p.settingsChanged());
  sendLevels({ min: settings.min, max: settings.max });
  renderLevels();
}

// Fits the level range to the spectra on screen: noise floor near the bottom, strongest signal near the top
$("autoLevelBtn").addEventListener("click", () => {
  const values: number[] = [];
  wall.panes.forEach((p) => {
    const data = p.latestLevels();
    if (!data) return;
    const step = Math.max(1, Math.floor(data.length / 512));
    for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i])) values.push(data[i]);
  });
  if (values.length < 10) {
    actionError = "Auto level needs a spectrum. Press Start first.";
    showError();
    return;
  }
  values.sort((a, b) => a - b);
  const floor = values[Math.floor(values.length * 0.05)];
  const peak = values[values.length - 1];
  const min = Math.max(Math.floor((floor - 10) / 5) * 5, -160);
  const max = Math.min(Math.max(Math.ceil((peak + 10) / 5) * 5, min + 20), 0);
  setLevels(min, max);
});

setIcon($("levelsBtn"), "levels");
$("levelsBtn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const pop = $("levelsPop");
  pop.hidden = !pop.hidden;
  if (!pop.hidden) renderLevels();
});
document.addEventListener("pointerdown", (ev) => {
  const pop = $("levelsPop");
  if (!pop.hidden && !pop.contains(ev.target as Node) && ev.target !== $("levelsBtn")) pop.hidden = true;
});

function renderLevels() {
  const pop = $("levelsPop");
  if (pop.hidden) return;
  const max = slider({ min: -150, max: 0, value: settings.max, step: 1, format: (v) => `${Math.round(v)} dB`, onChange: (v) => setLevels(Math.min(settings.min, v - 1), v) });
  const min = slider({ min: -160, max: -10, value: settings.min, step: 1, format: (v) => `${Math.round(v)} dB`, onChange: (v) => setLevels(v, Math.max(settings.max, v + 1)) });
  pop.replaceChildren(el("div", "tool-label", "Level range of every spectrum and waterfall"), leftLabel("Top", max), leftLabel("Bottom", min));
  pop.querySelectorAll<HTMLElement>(".im-left-label").forEach((l) => (l.style.width = "60px"));
}

const freqSelect = new FreqSelect($("freqSelect"));
freqSelect.onChange = (frequency) => {
  const pane = wall.panes.get(selected);
  if (!pane) return;
  pane.setBand({ ...pane.band, frequency });
  sendFrequency({ id: selected, frequency });
};

setIcon($("addBandBtn"), "plus", "Add band");
$("addBandBtn").addEventListener("click", addBand);

// --- alerts and timeline --------------------------------------------------------------------

function focusEvent(e: InterferenceEvent) {
  const pane = wall.panes.get(e.band);
  if (!pane) return;
  selectBand(e.band);
  wall.reveal(e.band);
  pane.focusRange(e.low, e.high, e.type === "noise");
}

function showWorstAlert() {
  if (!interference || interference.active.length === 0) return;
  if (feed.collapsed) feed.setCollapsed(false);
  focusEvent(sortEvents(interference.active, interference.settings)[0]);
}

async function runInterference(action: () => Promise<Interference>) {
  try {
    applyInterference(await action());
    actionError = "";
  } catch (e) {
    actionError = e instanceof Error ? e.message : String(e);
    drawer.refresh();
  }
  showError();
}

const feed = new AlertFeed($("alerts"), {
  focus: focusEvent,
  clear: () => runInterference(() => api.clearHistory()),
});

const timeline = new Timeline($("timelineBox"), $<HTMLCanvasElement>("timeline"), $("timelineChevron"), $("timelineSummary"), $("timelineToggle"), focusEvent);

function applyInterference(next: Interference) {
  interference = next;
  wall.panes.forEach((p, id) => p.setEvents(next.active.filter((e) => e.band === id)));
  updateHealth();
  if (state) {
    feed.render(next, state.bands, state.running);
    timeline.update(next, state.bands);
    drawer.update(state, menus, next);
  }
  renderTopBar();
}

function updateHealth() {
  if (!state) return;
  const now = Date.now();
  for (const band of state.bands) {
    const pane = wall.panes.get(band.id);
    if (!pane) continue;
    const det = interference?.bands.find((b) => b.id === band.id);
    pane.setHealth(
      bandHealth(band, state.radios, state.running, det, interference?.active ?? [], interference?.history ?? [], interference?.settings, now),
      interference?.settings,
    );
  }
}

// --- settings drawer --------------------------------------------------------------------------

const sendMenuAction = latest(async (v: { radio: number; action: api.MenuAction }) => {
  await run(async () => {
    menus[v.radio] = await api.menuAction(v.radio, v.action);
    // A device or sample rate change shows up in the state
    return api.getState();
  });
});

const drawer = new SettingsDrawer($("drawer"), $("drawerScrim"), {
  run,
  runInterference,
  menuAction: (radio, action) => sendMenuAction({ radio, action }),
  appearance: getAppearance,
  setAppearance: applyAppearance,
  colorMapAuthor: () => colorMapAuthor,
  selectedBand: () => selected,
});

async function refreshMenus() {
  try {
    menus = await Promise.all(state.radios.map((r) => api.getMenu(r.id)));
  } catch {
    menus = [];
  }
}

// --- keyboard ---------------------------------------------------------------------------------

window.addEventListener("keydown", (ev) => {
  const target = ev.target instanceof Element ? ev.target : null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || target?.closest("input, select, textarea")) return;
  // Space on a focused button presses that button, not Start/Stop
  if (ev.key === " " && target?.closest("button")) return;
  if (ev.key === "Escape") {
    if (drawer.isOpen) drawer.close();
    else if (!$("levelsPop").hidden) $("levelsPop").hidden = true;
    return;
  }
  if (drawer.isOpen) return;
  if (ev.key === " ") {
    ev.preventDefault();
    toggleRunning();
  } else if (/^[1-9]$/.test(ev.key)) {
    const band = state?.bands[Number(ev.key) - 1];
    if (band) {
      selectBand(band.id);
      wall.setMain(band.id);
    }
  } else if (ev.key === "g" || ev.key === "s") {
    wall.setLayout(ev.key === "g" ? "grid" : "stack");
  } else if (ev.key === "a") {
    showWorstAlert();
  } else if (ev.key === "l") {
    feed.toggle();
  } else if (ev.key === "t") {
    timeline.toggle();
  }
});

// --- state ------------------------------------------------------------------------------------

// Messages of the monitor, such as a newly plugged device. Those from before the page was opened are not shown.
let lastNotice = 0;
function showNotices(s: State, first: boolean) {
  const notices = s.notices ?? [];
  const latestId = notices.length ? notices[notices.length - 1].id : 0;
  // A restarted monitor counts from 1 again
  if (first || latestId < lastNotice) {
    lastNotice = latestId;
    return;
  }
  for (const n of notices) {
    if (n.id <= lastNotice) continue;
    const toast = el("div", "notice", n.text);
    const close = () => toast.remove();
    toast.title = "Click to close";
    toast.addEventListener("click", close);
    $("notices").append(toast);
    setTimeout(close, 10000);
  }
  lastNotice = latestId;
}

function showError() {
  const banner = $("error");
  const message = !connected ? "Lost connection to the monitor. Retrying…" : actionError || state?.error || "";
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
    drawer.refresh();
    if (state) syncToolbar(state);
  }
}

function syncToolbar(s: State) {
  modeSeg.set(s.display.fftMode === "persistence" ? 1 : 0);
  waterfallToggle.set(s.display.showWaterfall);
}

const part = {
  source: (s: State) => JSON.stringify([s.running, s.sourceType, s.radioCount, s.radios.map((r) => [r.id, r.name, r.sampleRate, r.bands, r.device, r.online])]),
  bands: (s: State) => JSON.stringify([s.bands, s.radios.map((r) => [r.online, r.bands])]),
  display: (s: State) => JSON.stringify([s.display, s.fftSizes, s.colorMaps]),
};

async function applyState(next: State) {
  const prev = state;
  state = next;
  settings.dwellMs = next.dwellMs;
  settings.fftRate = next.display.fftRate;

  if (next.running && (!prev || !prev.running)) runningSince = Date.now();
  if (!next.running) runningSince = 0;

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

  if (!prev || part.display(prev) !== part.display(next)) {
    settings.min = next.display.min;
    settings.max = next.display.max;
    settings.showWaterfall = next.display.showWaterfall;
    settings.fftMode = next.display.fftMode ?? "line";
    settings.persistenceSpeed = next.display.persistenceSpeed ?? 20;
    wall.panes.forEach((p) => p.settingsChanged());
    syncToolbar(next);
    renderLevels();
  }

  if (!prev || part.bands(prev) !== part.bands(next) || prev.running !== next.running) {
    wall.sync(next.bands, next.radios.some((r) => r.online), next.running);
    // The radio of a band also visits other bands
    for (const band of next.bands) {
      const pane = wall.panes.get(band.id);
      if (pane) pane.hopping = (next.radios.find((r) => r.id === band.radio)?.bands.length ?? 0) > 1;
    }
    if (!next.bands.some((b) => b.id === selected) && next.bands.length > 0) selected = next.bands[0].id;
    selectBand(selected);
  }

  if (!prev || part.source(prev) !== part.source(next)) await refreshMenus();

  if (settings.running !== next.running) {
    settings.running = next.running;
    wall.panes.forEach((p) => p.queueDraw());
  }

  showNotices(next, !prev);
  updateHealth();
  drawer.update(next, menus, interference);
  renderTopBar();
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
    renderTopBar();
  }
  if (connected) {
    try {
      applyInterference(await api.getInterference());
    } catch {
      // Shown again with the next poll
    }
  }
  setTimeout(poll, 1000);
}

stream.onFrame = (frame) => {
  const pane = wall.panes.get(frame.bandId);
  if (pane?.hopping && !pane.live) {
    // The radio arrived on this band, so it left the others it shares time with
    const radio = state?.radios.find((r) => r.id === pane.band.radio);
    radio?.bands.forEach((id) => id !== frame.bandId && wall.panes.get(id)?.markAway());
  }
  pane?.pushFrame(frame);
};
stream.onStatus = (up) => {
  if (up) wall.panes.forEach((p) => p.resendView());
};

// Title dots: green while a band is received, grey as soon as its frames stop
setInterval(() => wall.panes.forEach((p) => p.updateLive()), 100);

(async () => {
  renderTopBar();
  await poll();
  stream.connect();
})();
