// Alert feed: active interference, most severe first, then what ended today, with a CSV export.

import type { BandState, Interference, InterferenceEvent } from "./api";
import { clock, detail, duration, hz, tooltip, typeInfo } from "./interference";
import { ICONS } from "./icons";
import { SEVERITY, severity, sortEvents } from "./status";
import { el, setIcon, storedFlag, storeFlag } from "./widgets";

const COLLAPSED_KEY = "sentinel.alertsCollapsed";

export interface AlertFeedHandlers {
  focus(event: InterferenceEvent): void;
  clear(): void;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export class AlertFeed {
  private body = el("div", "feed-body");
  private foot = el("div", "feed-foot");
  private data: Interference | null = null;
  private bands: BandState[] = [];
  // Shown instead of the feed while it is collapsed: an icon, the active count and a vertical label
  private rail = el("button", "feed-rail");
  private railCount = el("span", "feed-rail-count", "0");

  constructor(private host: HTMLElement, private handlers: AlertFeedHandlers) {
    this.rail.type = "button";
    this.rail.title = "Show the alerts (L)";
    this.rail.innerHTML = ICONS.chevronLeft;
    this.rail.append(this.railCount, el("span", "feed-rail-label", "Alerts"));
    this.rail.addEventListener("click", () => this.setCollapsed(false));
    const collapse = el("button", "btn small icon ghost");
    collapse.type = "button";
    setIcon(collapse, "chevronRight");
    collapse.title = "Collapse the alerts (L)";
    collapse.addEventListener("click", () => this.setCollapsed(true));
    const head = el("div", "feed-head");
    const csv = el("button", "btn small");
    csv.type = "button";
    setIcon(csv, "download", "CSV");
    csv.title = "Download the active and ended events shown here as a CSV file";
    csv.addEventListener("click", () => this.exportCsv());
    const clear = el("button", "btn small icon ghost");
    clear.type = "button";
    setIcon(clear, "trash");
    clear.title = "Clear the ended list. The log file on the monitor is kept.";
    clear.addEventListener("click", () => this.handlers.clear());
    head.append(el("span", "feed-title", "Alerts"), el("span", "spacer"), csv, clear, collapse);
    host.append(this.rail, head, this.body, this.foot);
    this.setCollapsed(storedFlag(COLLAPSED_KEY, false));
  }

  get collapsed() {
    return this.host.classList.contains("collapsed");
  }

  setCollapsed(collapsed: boolean) {
    this.host.classList.toggle("collapsed", collapsed);
    storeFlag(COLLAPSED_KEY, collapsed);
  }

  toggle() {
    this.setCollapsed(!this.collapsed);
  }

  render(data: Interference, bands: BandState[], running: boolean) {
    this.data = data;
    this.bands = bands;
    const n = data.active.length;
    this.railCount.textContent = String(n);
    this.rail.classList.toggle("bad", n > 0);
    this.rail.title = n > 0 ? `${n} active interference${n > 1 ? "s" : ""}. Show the alerts (L)` : "No active alerts. Show the alerts (L)";
    const name = (id: number) => bands.find((b) => b.id === id)?.name ?? `Band ${id}`;
    const s = data.settings;
    const children: HTMLElement[] = [];

    children.push(el("div", "feed-section", `Active · ${data.active.length}`));
    if (data.active.length === 0) {
      const text = !s.enabled ? "Detection is off. Turn it on in Settings › Detection." : !running ? "Not monitoring. Press Start." : "No interference right now";
      children.push(el("div", "feed-empty", text));
    }
    for (const e of sortEvents(data.active, s)) children.push(this.card(e, name(e.band), false));

    const today = startOfToday();
    const ended = data.history.filter((e) => e.start >= today);
    children.push(el("div", "feed-section", `Ended today · ${ended.length}`));
    if (ended.length === 0) children.push(el("div", "feed-empty", "Nothing ended today"));
    for (const e of ended.slice(0, 40)) children.push(this.card(e, name(e.band), true));

    this.body.replaceChildren(...children);
    this.foot.textContent = `Log on the monitor: ${data.logFile.split(/[\\/]/).pop()}`;
    this.foot.title = data.logFile;
  }

  private card(e: InterferenceEvent, bandName: string, ended: boolean): HTMLElement {
    const info = typeInfo(e.type);
    const sev = SEVERITY[severity(e, this.data!.settings)];
    const card = el("button", `ev${ended ? " ended" : ""}`);
    card.type = "button";
    card.style.borderLeftColor = info.color;
    const top = el("div", "ev-top");
    const badge = el("span", "ev-sev", sev.label);
    badge.style.background = sev.color;
    top.append(el("span", "ev-type", info.label), badge, el("span", "ev-time", ended ? `${clock(e.start)} · ${duration(e.duration)}` : duration(e.duration)));
    const freq = el("div", "ev-freq", e.type === "noise" ? "Whole band" : e.type === "swept" ? `${hz(e.minCenter)} – ${hz(e.maxCenter)}` : hz(e.center));
    const meta = el("div", "ev-meta", `${bandName} · ${detail(e)}${e.type === "noise" ? "" : ` · +${e.excess.toFixed(1)} dB`}`);
    card.append(top, freq, meta);
    card.title = `${tooltip(e, bandName)}\n\nClick to show it in the spectrum`;
    // On press: the list is rebuilt every second, which would swallow a click released on the new card
    card.addEventListener("pointerdown", (ev) => {
      if (ev.button === 0) this.handlers.focus(e);
    });
    return card;
  }

  private exportCsv() {
    if (!this.data) return;
    const name = (id: number) => this.bands.find((b) => b.id === id)?.name ?? `Band ${id}`;
    const s = this.data.settings;
    const header = ["id", "band", "type", "severity", "active", "start", "end", "duration_s", "center_hz", "low_hz", "high_hz", "bandwidth_hz", "peak_db", "excess_db", "snr_db", "duty_pct", "drift_hz_s", "period_ms", "appearances"];
    const iso = (ms: number) => (ms ? new Date(ms).toISOString() : "");
    const rows = [...this.data.active, ...this.data.history].map((e) =>
      [e.id, name(e.band), e.type, severity(e, s), e.active, iso(e.start), iso(e.end), e.duration.toFixed(1), Math.round(e.center), Math.round(e.low), Math.round(e.high), Math.round(e.bandwidth), e.peak?.toFixed(1) ?? "", e.excess.toFixed(1), e.snr.toFixed(1), e.duty.toFixed(0), e.drift.toFixed(0), e.period.toFixed(0), e.appearances].map(csvCell).join(","),
    );
    const blob = new Blob([[header.join(","), ...rows].join("\n") + "\n"], { type: "text/csv" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `rf-sentinel-events-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
