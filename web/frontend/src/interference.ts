// Interference menu: detector settings, status of the selected band, active and ended events.

import type { BandState, Interference, InterferenceEvent, InterferenceSettings, InterferenceType } from "./api";
import { printAndScale } from "./pane";
import { button, checkbox, el, inputInt, leftLabel, row } from "./widgets";

export const TYPES: Record<InterferenceType, { label: string; short: string; color: string; hint: string }> = {
  narrowband: { label: "Narrowband", short: "NB", color: "#ff5a5a", hint: "Narrow carrier (CW, oscillator, spurious)" },
  wideband: { label: "Wideband", short: "WB", color: "#ff9a2e", hint: "Wide occupied block" },
  swept: { label: "Swept", short: "SW", color: "#c77dff", hint: "Frequency moves over time (sweep / chirp)" },
  pulsed: { label: "Pulsed", short: "PL", color: "#ffd23f", hint: "Comes and goes repeatedly (pulse / burst)" },
  noise: { label: "Noise Rise", short: "NF", color: "#ff3d7f", hint: "Noise floor of the whole band raised" },
};

export const typeInfo = (t: string) => TYPES[t as InterferenceType] ?? TYPES.wideband;

export function hz(f: number): string {
  return `${printAndScale(Math.round(f))}Hz`;
}

export function duration(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

// The parameter that tells this type apart, shown after the common ones
function detail(e: InterferenceEvent): string {
  if (e.type === "noise") return `floor +${e.excess.toFixed(1)} dB`;
  if (e.type === "swept") return `${hz(e.minCenter)}..${hz(e.maxCenter)}, ${(e.drift / 1e3).toFixed(1)} kHz/s`;
  if (e.type === "pulsed") return `duty ${e.duty.toFixed(0)}%${e.period > 0 ? `, every ${e.period.toFixed(0)} ms` : ""}`;
  return `SNR ${e.snr.toFixed(1)} dB`;
}

function tooltip(e: InterferenceEvent, bandName: string): string {
  const info = typeInfo(e.type);
  return [
    `${info.label}: ${info.hint}`,
    `Band: ${bandName}`,
    `Center: ${hz(e.center)}  (range ${hz(e.low)} .. ${hz(e.high)})`,
    `Occupied bandwidth: ${hz(e.bandwidth)}`,
    `Peak: ${e.peak === null ? "-" : e.peak.toFixed(1)} dB   Over baseline: ${e.excess.toFixed(1)} dB   SNR: ${e.snr.toFixed(1)} dB`,
    `Duty cycle: ${e.duty.toFixed(0)}%   Appearances: ${e.appearances}${e.period > 0 ? `   Period: ${e.period.toFixed(0)} ms` : ""}`,
    `Drift: ${(e.drift / 1e3).toFixed(2)} kHz/s   Center moved over ${hz(e.maxCenter - e.minCenter)}`,
    `Start: ${clock(e.start)}${e.end ? `   End: ${clock(e.end)}` : ""}   Duration: ${duration(e.duration)}`,
  ].join("\n");
}

export interface InterferenceHandlers {
  set(settings: Partial<InterferenceSettings>): void;
  relearn(band?: number): void;
  clear(): void;
  focus(event: InterferenceEvent): void;
}

export class InterferenceMenu {
  private settingsHost = el("div");
  private statusHost = el("div");
  private activeHost = el("div");
  private historyHost = el("div");
  private settingsKey = "";

  constructor(body: HTMLElement, private handlers: InterferenceHandlers) {
    body.append(this.settingsHost, this.statusHost, this.activeHost, this.historyHost);
  }

  // Rebuild the settings controls on the next render
  invalidate() {
    this.settingsKey = "";
  }

  render(data: Interference, bands: BandState[], selected: number, running: boolean) {
    // The settings are only rebuilt when they change, so typing in them is not interrupted
    const key = JSON.stringify(data.settings);
    if (key !== this.settingsKey) {
      this.settingsKey = key;
      this.renderSettings(data.settings);
    }
    const name = (id: number) => bands.find((b) => b.id === id)?.name ?? `Band ${id}`;
    this.renderStatus(data, bands, selected, running);
    this.renderList(this.activeHost, `Active (${data.active.length})`, data.active, name, bands.length > 1, null);
    const clear = button("Clear", () => this.handlers.clear());
    clear.title = "Clear this list. The log file is kept.";
    this.renderList(this.historyHost, `Ended (${data.history.length})`, data.history.slice(0, 30), name, bands.length > 1, clear);
    const log = el("div", "im-text im-disabled-text ev-log", `Log: ${data.logFile.split(/[\\/]/).pop()}`);
    log.title = data.logFile;
    this.historyHost.append(log);
  }

  private renderSettings(s: InterferenceSettings) {
    const set = this.handlers.set;
    const threshold = leftLabel("Threshold (dB)", inputInt(s.thresholdDb, 1, (v) => set({ thresholdDb: v })));
    threshold.title = "A frequency is occupied when it is this much above its baseline and above the noise floor";
    const rise = leftLabel("Noise Rise (dB)", inputInt(s.noiseRiseDb, 1, (v) => set({ noiseRiseDb: v })));
    rise.title = "Rise of the noise floor over its baseline reported as wideband interference";
    const learn = leftLabel("Learn Time (s)", inputInt(s.learnSeconds, 5, (v) => set({ learnSeconds: v })));
    learn.title = "Data used to learn the normal spectrum of a band";
    this.settingsHost.replaceChildren(row(checkbox("Detect Interference", s.enabled, (v) => set({ enabled: v }))), threshold, rise, learn);
  }

  private renderStatus(data: Interference, bands: BandState[], selected: number, running: boolean) {
    const band = bands.find((b) => b.id === selected);
    const st = data.bands.find((b) => b.id === selected);
    const host = this.statusHost;
    host.replaceChildren(el("div", "im-separator-text", band ? `Baseline: ${band.name}` : "Baseline"));
    let text: string;
    let cls = "im-text";
    if (!data.settings.enabled || !st) {
      text = "Detection is off";
      cls += " im-disabled-text";
    } else if (!running) {
      text = st.learning ? "Learns when the radios run" : "Not receiving";
      cls += " im-disabled-text";
    } else if (st.learning) {
      text = `Learning normal spectrum... ${Math.round(st.learnProgress * 100)}%`;
    } else {
      const delta = st.noiseFloor - st.baselineFloor;
      text = `Noise floor ${st.noiseFloor.toFixed(1)} dB (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} dB)`;
      if (delta > data.settings.noiseRiseDb) cls += " ev-alert";
    }
    const status = el("div", cls, text);
    status.title = "Noise floor now, and its change from the learned baseline";
    host.append(row(status));
    if (st?.learning && running && data.settings.enabled) {
      const bar = el("div", "ev-progress");
      const fill = el("div");
      fill.style.width = `${Math.round(st.learnProgress * 100)}%`;
      bar.append(fill);
      host.append(bar);
    }
    const learnBand = button("Learn Band", () => this.handlers.relearn(selected));
    learnBand.title = "Take the current spectrum of the selected band as normal";
    const learnAll = button("Learn All", () => this.handlers.relearn());
    learnAll.title = "Take the current spectrum of every band as normal";
    learnBand.classList.add("im-fill");
    learnAll.classList.add("im-fill");
    if (!data.settings.enabled) {
      learnBand.classList.add("im-disabled");
      learnAll.classList.add("im-disabled");
    }
    host.append(row(learnBand, learnAll));
  }

  private renderList(host: HTMLElement, title: string, events: InterferenceEvent[], name: (id: number) => string, showBand: boolean, action: HTMLElement | null) {
    const header = el("div", "im-separator-text ev-header");
    header.append(el("span", "im-fill", title));
    if (action) header.append(action);
    host.replaceChildren(header);
    if (events.length === 0) {
      host.append(el("div", "im-text im-disabled-text", "None"));
      return;
    }
    for (const e of events) {
      const info = typeInfo(e.type);
      const item = el("div", `ev-item${e.active ? " ev-active" : ""}`);
      const tag = el("span", "ev-tag", info.short);
      tag.style.background = info.color;
      const lines = el("div", "ev-lines");
      const first = el("div", "im-text");
      first.textContent = `${e.type === "noise" ? "Whole band" : hz(e.center)}  ${info.label}${showBand ? ` · ${name(e.band)}` : ""}`;
      const second = el("div", "im-text im-disabled-text");
      const bw = e.type === "noise" ? "" : `BW ${hz(e.bandwidth)} · `;
      const over = e.type === "noise" ? "" : `+${e.excess.toFixed(1)} dB · `;
      const when = e.active ? duration(e.duration) : `${clock(e.start)}, ${duration(e.duration)}`;
      second.textContent = `${bw}${over}${detail(e)} · ${when}`;
      lines.append(first, second);
      item.append(tag, lines);
      item.title = `${tooltip(e, name(e.band))}\n\nClick to show it in the spectrum`;
      // On press: the list is rebuilt every second, which would swallow a click whose release lands on the new item
      item.addEventListener("pointerdown", (ev) => {
        if (ev.button === 0) this.handlers.focus(e);
      });
      host.append(item);
    }
  }
}
