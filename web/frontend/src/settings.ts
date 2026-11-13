// Settings drawer: everything that is set once and rarely touched, grouped in tabs.

import * as api from "./api";
import type { Interference, Menu, MenuAction, State } from "./api";
import { renderMenu } from "./smgui";
import type { Appearance } from "./theme";
import { button, checkbox, combo, el, hint, inputInt, inputText, leftLabel, row, section, segmented, setIcon } from "./widgets";

export interface SettingsContext {
  run(action: () => Promise<State>): Promise<void>;
  runInterference(action: () => Promise<Interference>): Promise<void>;
  menuAction(radio: number, action: MenuAction): void;
  appearance(): Appearance;
  setAppearance(a: Appearance): void;
  colorMapAuthor(): string;
  selectedBand(): number;
}

const TABS = ["Radios", "Bands", "Detection", "Display", "Appearance"] as const;
type Tab = (typeof TABS)[number];

export class SettingsDrawer {
  private tab: Tab = "Radios";
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private body = el("div", "drawer-body");
  private state: State | null = null;
  private menus: Menu[] = [];
  private interference: Interference | null = null;
  private keys = new Map<string, string>();
  // Replacing a radio menu while one of its sliders is dragged would drop the drag
  private pointerDown = false;
  private pending = false;
  private detectionSettings = el("div");
  private detectionStatus = el("div");

  constructor(private root: HTMLElement, private scrim: HTMLElement, private ctx: SettingsContext) {
    const head = el("div", "drawer-head");
    const close = el("button", "btn icon ghost");
    close.type = "button";
    close.title = "Close (Esc)";
    setIcon(close, "close");
    close.addEventListener("click", () => this.close());
    head.append(el("h2", undefined, "Settings"), close);
    const tabs = el("div", "tabs");
    for (const t of TABS) {
      const b = el("button", undefined, t);
      b.type = "button";
      b.addEventListener("click", () => this.show(t));
      tabs.append(b);
      this.tabButtons.set(t, b);
    }
    root.append(head, tabs, this.body);
    scrim.addEventListener("click", () => this.close());
    this.body.addEventListener("pointerdown", () => (this.pointerDown = true));
    window.addEventListener("pointerup", () => {
      this.pointerDown = false;
      if (this.pending) {
        this.pending = false;
        this.render(true);
      }
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open(tab?: Tab) {
    this.root.hidden = false;
    this.scrim.hidden = false;
    this.show(tab ?? this.tab);
  }

  close() {
    this.root.hidden = true;
    this.scrim.hidden = true;
  }

  show(tab: Tab) {
    this.tab = tab;
    this.tabButtons.forEach((b, t) => b.classList.toggle("on", t === tab));
    this.keys.clear();
    this.body.replaceChildren();
    this.render(true);
  }

  update(state: State, menus: Menu[], interference: Interference | null) {
    this.state = state;
    this.menus = menus;
    this.interference = interference;
    if (this.isOpen) this.render(false);
  }

  // Values refused by the server: draw the stored ones again
  refresh() {
    this.keys.clear();
    if (this.isOpen) this.render(true);
  }

  // Rebuilds a part only when what it shows changed, so typing in a field is not interrupted
  private changed(part: string, value: unknown): boolean {
    const key = JSON.stringify(value);
    if (this.keys.get(part) === key) return false;
    this.keys.set(part, key);
    return true;
  }

  private render(force: boolean) {
    const s = this.state;
    if (!s) return;
    if (this.pointerDown) {
      this.pending = true;
      return;
    }
    if (force) this.keys.clear();
    switch (this.tab) {
      case "Radios":
        if (this.changed("radios", [s.running, s.sourceType, s.radioCount, s.radios, this.menus])) this.renderRadios(s);
        break;
      case "Bands":
        if (this.changed("bands", [s.bands, s.radios.map((r) => r.online), s.dwellMs, s.settleMs])) this.renderBands(s);
        break;
      case "Detection":
        if (this.body.firstChild !== this.detectionSettings) this.body.replaceChildren(this.detectionSettings, this.detectionStatus);
        if (this.interference) {
          if (this.changed("detection", this.interference.settings)) this.renderDetectionSettings(this.interference);
          this.renderDetectionStatus(this.interference, s);
        }
        break;
      case "Display":
        if (this.changed("display", [s.display, s.fftSizes, s.colorMaps, this.ctx.colorMapAuthor()])) this.renderDisplay(s);
        break;
      case "Appearance":
        if (this.changed("appearance", this.ctx.appearance())) this.renderAppearance();
        break;
    }
  }

  private renderRadios(s: State) {
    const run = this.ctx.run;
    const out: HTMLElement[] = [section("Radio type")];
    const type = combo(s.sourceTypes.map((t) => t.name), s.sourceTypes.findIndex((t) => t.id === s.sourceType), (i) => run(() => api.setSetup({ sourceType: s.sourceTypes[i].id })));
    if (s.running) type.classList.add("im-disabled");
    out.push(leftLabel("Type", type));
    if (s.running) out.push(hint("Stop monitoring to change the radio type."));
    else out.push(hint("All radios of a session are of one type. Bands are shared out between them automatically."));

    out.push(section(`Radios · ${s.radios.length}`));
    const add = button("Add radio", () => run(() => api.setSetup({ radioCount: s.radioCount + 1 })));
    const remove = button("Remove last", () => run(() => api.setSetup({ radioCount: s.radioCount - 1 })));
    add.classList.add("im-fill");
    remove.classList.add("im-fill");
    if (s.radioCount <= 1) remove.classList.add("im-disabled");
    out.push(row(add, remove));

    this.menus.forEach((menu, i) => {
      const r = s.radios[i];
      const names = (r?.bands ?? []).map((id) => s.bands.find((b) => b.id === id)?.name ?? `#${id}`);
      const what = r && !r.online ? "no device connected" : names.length ? names.join(", ") : "no band";
      out.push(el("div", "im-separator-text", `Radio ${i + 1} · ${what}`));
      const host = el("div");
      renderMenu(host, menu, (action) => this.ctx.menuAction(i, action));
      out.push(host);
    });
    if (this.menus.length === 0) out.push(el("div", "im-text im-disabled-text", "No radio available"));
    this.body.replaceChildren(...out);
  }

  private renderBands(s: State) {
    const run = this.ctx.run;
    const out: HTMLElement[] = [section(`Bands · ${s.bands.length}`)];
    out.push(hint("Each band is received at its center frequency with the radio's sample rate as its width."));
    for (const band of s.bands) {
      const r = el("div", "im-row band-row");
      const name = inputText(band.name, (v) => run(() => api.updateBand(band.id, { name: v })));
      name.title = "Band name";
      const freq = inputText((band.frequency / 1e6).toFixed(4).replace(/\.?0+$/, ""), (v) => {
        const mhz = Number(v.replace(",", "."));
        if (Number.isFinite(mhz) && mhz > 0) run(() => api.updateBand(band.id, { frequency: Math.round(mhz * 1e6) }));
        else this.refresh();
      });
      freq.classList.add("freq-input");
      freq.title = "Center frequency in MHz";
      r.append(name, freq, el("span", "muted", "MHz"));
      if (s.radios.length > 1) {
        const tied = band.radioSetting >= 0;
        const picked = band.radio >= 0 ? `R${band.radio + 1}` : "–";
        const items = [tied ? "Auto" : `Auto (${picked})`, ...s.radios.map((x) => `R${x.id + 1}${x.online ? "" : " (offline)"}`)];
        const sel = combo(items, tied ? band.radioSetting + 1 : 0, (i) => run(() => api.updateBand(band.id, { radioSetting: i - 1 })));
        sel.classList.add("band-radio-select");
        sel.title = "Radio this band is received with";
        r.append(sel);
      }
      const remove = el("button", "btn small icon ghost");
      remove.type = "button";
      setIcon(remove, "trash");
      remove.title = `Remove ${band.name}`;
      remove.addEventListener("click", () => run(() => api.removeBand(band.id)));
      r.append(remove);
      out.push(r);
    }
    const add = button("Add band", () => {
      const base = s.bands.find((b) => b.id === this.ctx.selectedBand()) ?? s.bands[s.bands.length - 1];
      run(() => api.addBand({ frequency: base ? base.frequency : 100e6 }));
    });
    add.classList.add("im-fill");
    out.push(row(add));

    out.push(section("Sharing a radio"));
    out.push(hint("When a radio serves several bands it visits them in turn: it stays Dwell ms on each and waits Settle ms after tuning."));
    out.push(leftLabel("Dwell (ms)", inputInt(s.dwellMs, 10, (v) => run(() => api.setSetup({ dwellMs: v })))));
    out.push(leftLabel("Settle (ms)", inputInt(s.settleMs, 5, (v) => run(() => api.setSetup({ settleMs: v })))));
    this.body.replaceChildren(...out);
  }

  private renderDetectionSettings(data: Interference) {
    const set = (v: Partial<api.InterferenceSettings>) => this.ctx.runInterference(() => api.setInterference(v));
    const st = data.settings;
    const threshold = leftLabel("Threshold (dB)", inputInt(st.thresholdDb, 1, (v) => set({ thresholdDb: v })));
    threshold.title = "A frequency is occupied when it is this much above its baseline and above the noise floor";
    const rise = leftLabel("Noise rise (dB)", inputInt(st.noiseRiseDb, 1, (v) => set({ noiseRiseDb: v })));
    rise.title = "Rise of the noise floor over its baseline reported as interference";
    const learn = leftLabel("Learn time (s)", inputInt(st.learnSeconds, 5, (v) => set({ learnSeconds: v })));
    learn.title = "Data used to learn the normal spectrum of a band";
    this.detectionSettings.replaceChildren(
      section("Detection"),
      row(checkbox("Detect interference", st.enabled, (v) => set({ enabled: v }))),
      hint("Each band first learns its normal spectrum (its baseline). Anything that rises above it by the threshold is reported."),
      threshold,
      rise,
      learn,
    );
  }

  private renderDetectionStatus(data: Interference, s: State) {
    const out: HTMLElement[] = [section("Baselines")];
    for (const band of s.bands) {
      const st = data.bands.find((b) => b.id === band.id);
      let text: string;
      let cls = "im-text im-fill";
      if (!data.settings.enabled || !st) {
        text = "Detection is off";
        cls += " im-disabled-text";
      } else if (!s.running) {
        text = st.learning ? "Learns when monitoring runs" : "Not receiving";
        cls += " im-disabled-text";
      } else if (st.learning) {
        text = `Learning… ${Math.round(st.learnProgress * 100)}%`;
      } else {
        const delta = st.noiseFloor - st.baselineFloor;
        text = `Floor ${st.noiseFloor.toFixed(1)} dB (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} dB)`;
        if (delta > data.settings.noiseRiseDb) cls += " ev-alert";
      }
      const learn = button("Relearn", () => this.ctx.runInterference(() => api.relearn(band.id)));
      learn.title = `Take the current spectrum of ${band.name} as normal`;
      if (!data.settings.enabled) learn.classList.add("im-disabled");
      const name = el("span", "im-left-label", band.name);
      out.push(row(name, el("span", cls, text), learn));
    }
    const all = button("Relearn all bands", () => this.ctx.runInterference(() => api.relearn()));
    all.classList.add("im-fill");
    if (!data.settings.enabled) all.classList.add("im-disabled");
    out.push(row(all));
    out.push(hint("Relearn after moving the antenna or changing gain, or when a signal that is normal at this site was flagged."));
    this.detectionStatus.replaceChildren(...out);
  }

  private renderDisplay(s: State) {
    const d = s.display;
    const set = (v: Partial<api.Display>) => this.ctx.run(() => api.setDisplay(v));
    const windows = ["Rectangular", "Blackman", "Nuttall"];
    this.body.replaceChildren(
      section("Spectrum"),
      leftLabel("FFT size", combo(s.fftSizes.map(String), s.fftSizes.indexOf(d.fftSize), (i) => set({ fftSize: s.fftSizes[i] }))),
      leftLabel("FFT window", combo(windows, d.fftWindow, (i) => set({ fftWindow: i }))),
      leftLabel("Frame rate (fps)", inputInt(d.fftRate, 1, (v) => set({ fftRate: v }))),
      row(checkbox("Smoothing", d.fftSmoothing, (v) => set({ fftSmoothing: v }))),
      leftLabel("Smoothing speed", inputInt(d.fftSmoothingSpeed, 1, (v) => set({ fftSmoothingSpeed: v }))),
      row(checkbox("Peak hold", d.fftHold, (v) => set({ fftHold: v }))),
      leftLabel("Hold decay speed", inputInt(d.fftHoldSpeed, 1, (v) => set({ fftHoldSpeed: v }))),
      leftLabel("Persistence fade", inputInt(d.persistenceSpeed, 5, (v) => set({ persistenceSpeed: v }))),
      hint("Persistence fade: 1 keeps what was seen for long, 100 fades it quickly."),
      section("Waterfall"),
      row(checkbox("Show waterfall", d.showWaterfall, (v) => set({ showWaterfall: v }))),
      leftLabel("Color map", combo(s.colorMaps.map((c) => c.name), s.colorMaps.findIndex((c) => c.name === d.colorMap), (i) => set({ colorMap: s.colorMaps[i].name }))),
      ...(this.ctx.colorMapAuthor() ? [hint(`Color map by ${this.ctx.colorMapAuthor()}`)] : []),
    );
  }

  private renderAppearance() {
    const current = this.ctx.appearance();
    const seg = segmented(["Dark", "Light"], current === "light" ? 1 : 0, (i) => {
      this.ctx.setAppearance(i === 1 ? "light" : "dark");
      this.keys.delete("appearance");
    });
    const keys = el("div");
    for (const [k, v] of [
      ["Space", "Start or stop monitoring"],
      ["1 – 9", "Make that band the main band"],
      ["G / S", "Grid or Stack layout"],
      ["A", "Show the most severe alert"],
      ["L", "Collapse or expand the alerts"],
      ["T", "Collapse or expand the event timeline"],
      ["Esc", "Close settings"],
    ]) {
      const r = row(el("span", "im-left-label", k), el("span", "im-text muted", v));
      keys.append(r);
    }
    this.body.replaceChildren(section("Theme"), leftLabel("Appearance", seg.root), hint("Saved in this browser. The spectrum stays dark in both, so weak signals remain visible."), section("Keyboard shortcuts"), keys);
  }
}
