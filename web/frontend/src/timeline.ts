// Event timeline: the last 60 minutes, one lane per band, a bar per event colored by its severity.

import type { BandState, Interference, InterferenceEvent } from "./api";
import { clock, duration, hz, typeInfo } from "./interference";
import { SEVERITY, severity } from "./status";
import { setIcon, storedFlag, storeFlag } from "./widgets";

const COLLAPSED_KEY = "sentinel.timelineCollapsed";

const WINDOW_MS = 60 * 60 * 1000;
const LABEL_W = 110;
const LANE_H = 14;
const LANE_GAP = 4;
const AXIS_H = 14;

interface Hit {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  event: InterferenceEvent;
}

export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private hits: Hit[] = [];
  private data: Interference | null = null;
  private bands: BandState[] = [];

  constructor(
    private box: HTMLElement,
    private canvas: HTMLCanvasElement,
    private chevron: HTMLElement,
    private summary: HTMLElement,
    toggleButton: HTMLElement,
    private onFocus: (e: InterferenceEvent) => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    toggleButton.addEventListener("click", () => this.toggle());
    this.setCollapsed(storedFlag(COLLAPSED_KEY, false));
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointerdown", (ev) => {
      const hit = this.hitAt(ev);
      if (hit) this.onFocus(hit.event);
    });
    canvas.addEventListener("pointermove", (ev) => {
      const hit = this.hitAt(ev);
      canvas.style.cursor = hit ? "pointer" : "default";
      if (hit) {
        const e = hit.event;
        const band = this.bands.find((b) => b.id === e.band)?.name ?? "";
        canvas.title = `${typeInfo(e.type).label} · ${band}\n${e.type === "noise" ? "Whole band" : hz(e.center)}\n${clock(e.start)}, ${duration(e.duration)}${e.active ? " (still active)" : ""}\nClick to show it`;
      } else {
        canvas.title = "";
      }
    });
  }

  private hitAt(ev: PointerEvent): Hit | undefined {
    const r = this.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    // Later bars are drawn on top, so they are found first
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x0 - 2 && x <= h.x1 + 2 && y >= h.y0 && y <= h.y1) return h;
    }
    return undefined;
  }

  get collapsed() {
    return this.box.classList.contains("collapsed");
  }

  setCollapsed(collapsed: boolean) {
    this.box.classList.toggle("collapsed", collapsed);
    setIcon(this.chevron, collapsed ? "chevronUp" : "chevronDown");
    storeFlag(COLLAPSED_KEY, collapsed);
    if (!collapsed) this.draw();
  }

  toggle() {
    this.setCollapsed(!this.collapsed);
  }

  update(data: Interference, bands: BandState[]) {
    this.data = data;
    this.bands = bands;
    // While collapsed the header still says whether anything happened
    const t0 = Date.now() - WINDOW_MS;
    const recent = [...data.history, ...data.active].filter((e) => e.active || (e.end || e.last) >= t0);
    const active = data.active.length;
    this.summary.textContent = recent.length === 0 ? "no events" : `${recent.length} event${recent.length > 1 ? "s" : ""}${active ? ` · ${active} active` : ""}`;
    this.summary.classList.toggle("bad-text", active > 0);
    const height = Math.max(bands.length, 1) * (LANE_H + LANE_GAP) + AXIS_H;
    this.canvas.style.height = `${Math.min(height, 6 * (LANE_H + LANE_GAP) + AXIS_H)}px`;
    this.draw();
  }

  draw() {
    if (this.collapsed) return;
    const canvas = this.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    this.hits = [];

    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue("--text-2").trim() || "#9aa7b8";
    const lane = css.getPropertyValue("--surface-2").trim() || "#18202b";
    const grid = css.getPropertyValue("--border").trim() || "#263241";
    const font = 'Inter, "Segoe UI", system-ui, sans-serif';

    const now = Date.now();
    const t0 = now - WINDOW_MS;
    const plotW = Math.max(width - LABEL_W, 10);
    const xOf = (t: number) => LABEL_W + ((Math.max(t, t0) - t0) / WINDOW_MS) * plotW;

    // Ten minute marks
    ctx.font = `11px ${font}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const lanesBottom = height - AXIS_H;
    for (let m = 60; m >= 0; m -= 10) {
      const x = Math.round(LABEL_W + ((60 - m) / 60) * plotW) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, lanesBottom);
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.textAlign = m === 0 ? "right" : "center";
      ctx.fillText(m === 0 ? "now" : `−${m} min`, m === 0 ? x - 1 : x, lanesBottom + AXIS_H / 2 + 1);
    }

    const visibleLanes = Math.floor(lanesBottom / (LANE_H + LANE_GAP));
    const events = this.data ? [...this.data.history, ...this.data.active] : [];
    this.bands.slice(0, Math.max(visibleLanes, 1)).forEach((band, i) => {
      const y = i * (LANE_H + LANE_GAP);
      ctx.fillStyle = text;
      ctx.textAlign = "left";
      ctx.fillText(band.name.length > 16 ? band.name.slice(0, 15) + "…" : band.name, 0, y + LANE_H / 2);
      ctx.fillStyle = lane;
      ctx.fillRect(LABEL_W, y, plotW, LANE_H);
      for (const e of events) {
        if (e.band !== band.id) continue;
        const end = e.active ? now : e.end || e.last;
        if (end < t0) continue;
        const x0 = xOf(e.start);
        const x1 = Math.max(xOf(end), x0 + 3);
        ctx.fillStyle = this.data ? SEVERITY[severity(e, this.data.settings)].color : "#888";
        ctx.fillRect(x0, y + 2, x1 - x0, LANE_H - 4);
        if (e.active) {
          // Still going: a bright edge at "now"
          ctx.fillStyle = "#fff";
          ctx.fillRect(x1 - 2, y + 2, 2, LANE_H - 4);
        }
        this.hits.push({ x0, x1, y0: y, y1: y + LANE_H, event: e });
      }
    });
  }
}
