// One band drawn like the SDR++ waterfall widget (gui/widgets/waterfall.cpp):
// FFT on top with dB and frequency scales, waterfall underneath.

import type { BandState } from "./api";
import type { FftFrame } from "./stream";
import { PALETTE_SIZE, currentTheme } from "./theme";
import { el } from "./widgets";

// Settings shared by all panes, the equivalent of the single waterfall state in desktop SDR++
export interface PaneSettings {
  min: number;
  max: number;
  showWaterfall: boolean;
  fftHeight: number;
  palette: Uint32Array;
  running: boolean;
}

export interface PaneCallbacks {
  onSelect(band: number): void;
  onView(band: number, offset: number, bandwidth: number, points: number): void;
  onTune(band: number, frequency: number): void;
  onFftHeight(height: number): void;
}

interface Row {
  data: Float32Array;
  lower: number; // Absolute frequency of the first point
  width: number; // Frequency span of the row
}

// Geometry of the widget in CSS pixels, taken from WaterFall::updateWaterfallFb / onPositionChange
const LEFT = 50;
const RIGHT = 10;
const TOP = 9;
const FREQ_AREA = 40;
const MIN_FFT_HEIGHT = 50;
const MIN_VIEW_BANDWIDTH = 1000;
const MAX_ROWS = 2000;
const GRID = "rgb(50, 50, 50)";

const RANGES = (() => {
  const out: number[] = [];
  for (let exp = 9; exp >= 0; exp--) for (const m of [5, 2, 1]) out.push(m * 10 ** exp);
  return out;
})();

// Largest step that keeps the number of grid lines under maxSteps (findBestRange)
function findBestRange(span: number, maxSteps: number): number {
  for (let i = 0; i < RANGES.length; i++) {
    if (span / RANGES[i] >= maxSteps) return RANGES[Math.max(i - 1, 0)];
  }
  return RANGES[RANGES.length - 1];
}

// Frequency label with a unit and no trailing zeros (printAndScale)
export function printAndScale(freq: number): string {
  const abs = Math.abs(freq);
  let value = freq;
  let unit = "";
  if (abs >= 1e9) [value, unit] = [freq / 1e9, "G"];
  else if (abs >= 1e6) [value, unit] = [freq / 1e6, "M"];
  else if (abs >= 1e3) [value, unit] = [freq / 1e3, "K"];
  let text = value.toFixed(6).replace(/0+$/, "");
  if (text.endsWith(".")) text = text.slice(0, -1);
  return text + unit;
}

export class Pane {
  readonly root: HTMLDivElement;
  band: BandState;
  latest: FftFrame | null = null;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wfCanvas: HTMLCanvasElement;
  private wfCtx: CanvasRenderingContext2D;
  private rows: Row[] = [];
  private viewOffset = 0;
  private viewBandwidth = 0; // 0 shows the whole band
  private width = 0;
  private height = 0;
  private drawQueued = false;
  private wfDirty = true;
  private hover: { x: number; y: number } | null = null;
  private lastFrameAt = 0;

  constructor(band: BandState, private settings: PaneSettings, private cb: PaneCallbacks) {
    this.band = band;
    this.root = el("div", "pane");
    this.canvas = el("canvas", "pane-canvas");
    this.wfCanvas = el("canvas", "pane-waterfall");
    this.root.append(this.wfCanvas, this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.wfCtx = this.wfCanvas.getContext("2d", { willReadFrequently: false })!;
    new ResizeObserver(() => this.layout()).observe(this.root);
    this.bindPointer();
  }

  // --- geometry -------------------------------------------------------------------------

  private get dataWidth() {
    return Math.max(Math.floor(this.width - LEFT - RIGHT), 16);
  }

  private get fftHeight() {
    const available = this.height - TOP - FREQ_AREA;
    if (!this.settings.showWaterfall) return Math.max(available - 2, MIN_FFT_HEIGHT);
    // With several panes on screen the waterfall always keeps at least 40% of the height
    return Math.min(Math.max(this.settings.fftHeight, MIN_FFT_HEIGHT), Math.max(Math.floor(available * 0.6), MIN_FFT_HEIGHT));
  }

  private get wfTop() {
    return TOP + this.fftHeight + FREQ_AREA + 1;
  }

  private get wfHeight() {
    return this.settings.showWaterfall ? Math.max(Math.floor(this.height - this.wfTop - 1), 0) : 0;
  }

  // --- view ------------------------------------------------------------------------------

  private get bandwidth() {
    return this.latest?.bandwidth || this.band.sampleRate || 1;
  }

  private get viewWidth() {
    const bw = this.bandwidth;
    return this.viewBandwidth <= 0 || this.viewBandwidth > bw ? bw : this.viewBandwidth;
  }

  private get lower() {
    return this.band.frequency + this.viewOffset - this.viewWidth / 2;
  }

  get zoomed() {
    return this.viewWidth < this.bandwidth;
  }

  // Fraction of the band that is shown, for the Zoom slider
  get viewFraction() {
    return this.viewWidth / this.bandwidth;
  }

  setViewBandwidth(bandwidth: number, anchor?: number) {
    const bw = this.bandwidth;
    const next = Math.min(Math.max(bandwidth, Math.min(MIN_VIEW_BANDWIDTH, bw)), bw);
    if (anchor !== undefined) {
      // Keep the frequency under the cursor where it is
      const t = (anchor - this.lower) / this.viewWidth;
      this.viewOffset = anchor - t * next + next / 2 - this.band.frequency;
    }
    this.viewBandwidth = next >= bw ? 0 : next;
    this.clampOffset();
    this.viewChanged();
  }

  private clampOffset(): number {
    const limit = (this.bandwidth - this.viewWidth) / 2;
    const wanted = this.viewOffset;
    this.viewOffset = Math.min(Math.max(wanted, -limit), limit);
    return wanted - this.viewOffset;
  }

  private viewChanged() {
    this.cb.onView(this.band.id, this.viewOffset, this.viewBandwidth, this.dataWidth);
    this.wfDirty = true;
    this.queueDraw();
  }

  // Send the current view again, after the server lost it or the stream reconnected
  resendView() {
    this.cb.onView(this.band.id, this.viewOffset, this.viewBandwidth, this.dataWidth);
  }

  setBand(band: BandState) {
    const changed = band.frequency !== this.band.frequency || band.sampleRate !== this.band.sampleRate;
    const rateChanged = band.sampleRate !== this.band.sampleRate;
    this.band = band;
    if (rateChanged) {
      this.viewOffset = 0;
      this.viewBandwidth = 0;
      this.cb.onView(this.band.id, 0, 0, this.dataWidth);
    }
    if (changed) this.wfDirty = true;
    this.queueDraw();
  }

  setSelected(selected: boolean) {
    this.root.classList.toggle("selected", selected);
  }

  settingsChanged() {
    this.layout();
  }

  // --- data ------------------------------------------------------------------------------

  pushFrame(frame: FftFrame) {
    this.latest = frame;
    this.lastFrameAt = performance.now();
    const row: Row = {
      data: frame.fft,
      lower: frame.centerFreq + frame.viewOffset - frame.viewBandwidth / 2,
      width: frame.viewBandwidth,
    };
    this.rows.unshift(row);
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS;

    if (this.settings.showWaterfall && !this.wfDirty && this.wfHeight > 1) {
      // Scroll by one line and draw the new one on top, like the waterfall framebuffer in SDR++
      const w = this.wfCanvas.width;
      this.wfCtx.drawImage(this.wfCanvas, 0, 0, w, this.wfCanvas.height - 1, 0, 1, w, this.wfCanvas.height - 1);
      const line = this.wfCtx.createImageData(w, 1);
      this.renderRow(row, new Uint32Array(line.data.buffer), 0, w);
      this.wfCtx.putImageData(line, 0, 0);
    }
    this.queueDraw();
  }

  // True when frames stopped arriving although the band should be received
  get stale() {
    return performance.now() - this.lastFrameAt > 1500;
  }

  private renderRow(row: Row, out: Uint32Array, start: number, width: number) {
    const { min, max, palette } = this.settings;
    const scale = (PALETTE_SIZE - 1) / Math.max(max - min, 1e-6);
    const lower = this.lower;
    const step = this.viewWidth / width;
    const n = row.data.length;
    const toIndex = n / row.width;
    for (let x = 0; x < width; x++) {
      const freq = lower + (x + 0.5) * step;
      const idx = Math.floor((freq - row.lower) * toIndex);
      if (idx < 0 || idx >= n) {
        out[start + x] = 0; // Outside what was received at the time
        continue;
      }
      let p = Math.round((row.data[idx] - min) * scale);
      if (p < 0) p = 0;
      else if (p >= PALETTE_SIZE) p = PALETTE_SIZE - 1;
      out[start + x] = palette[p];
    }
  }

  private redrawWaterfall() {
    this.wfDirty = false;
    const w = this.wfCanvas.width;
    const h = this.wfCanvas.height;
    if (w === 0 || h === 0) return;
    const image = this.wfCtx.createImageData(w, h);
    const out = new Uint32Array(image.data.buffer);
    const count = Math.min(h, this.rows.length);
    for (let y = 0; y < count; y++) this.renderRow(this.rows[y], out, y * w, w);
    this.wfCtx.putImageData(image, 0, 0);
  }

  // --- drawing ---------------------------------------------------------------------------

  private layout() {
    const rect = this.root.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width <= 0 || height <= 0) return;
    const sizeChanged = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    // One waterfall pixel per FFT point and per line
    const wfHeight = this.wfHeight;
    this.wfCanvas.width = this.dataWidth;
    this.wfCanvas.height = wfHeight;
    this.wfCanvas.style.left = `${LEFT}px`;
    this.wfCanvas.style.top = `${this.wfTop}px`;
    this.wfCanvas.style.width = `${this.dataWidth}px`;
    this.wfCanvas.style.height = `${wfHeight}px`;
    this.wfCanvas.hidden = wfHeight <= 0;
    this.wfDirty = true;

    if (sizeChanged) this.cb.onView(this.band.id, this.viewOffset, this.viewBandwidth, this.dataWidth);
    this.queueDraw();
  }

  queueDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private draw() {
    if (this.width === 0) return;
    if (this.wfDirty && this.settings.showWaterfall) this.redrawWaterfall();

    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const text = currentTheme.Text ?? "#FFFFFFFF";
    const trace = currentTheme.PlotLines ?? "#66E5FFFF";
    const holdColor = currentTheme.FFTHoldColor ?? "#FFFF00FF";
    const { min, max } = this.settings;
    const dataWidth = this.dataWidth;
    const fftHeight = this.fftHeight;
    const fftBottom = TOP + fftHeight;
    const lower = this.lower;
    const viewWidth = this.viewWidth;
    const upper = lower + viewWidth;

    ctx.font = "13px Roboto, sans-serif";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;

    // Vertical scale
    const textHeight = 16;
    const vRange = findBestRange(max - min, Math.max(Math.floor(fftHeight / textHeight), 1));
    const vScale = fftHeight / Math.max(max - min, 1e-6);
    ctx.textAlign = "right";
    for (let line = Math.floor(max / vRange) * vRange; line > min; line -= vRange) {
      const y = Math.round(fftBottom - (line - min) * vScale) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(LEFT, y);
      ctx.lineTo(LEFT + dataWidth, y);
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.fillText(String(Math.round(line)), LEFT - 10, y);
    }

    // Horizontal scale
    const labelWidth = ctx.measureText("000.000").width + 10;
    const hRange = findBestRange(viewWidth, Math.max(Math.floor(dataWidth / labelWidth), 1));
    const hScale = dataWidth / viewWidth;
    ctx.textAlign = "center";
    for (let freq = Math.ceil(lower / hRange) * hRange; freq < upper; freq += hRange) {
      const x = Math.round(LEFT + (freq - lower) * hScale) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(x, TOP + 1);
      ctx.lineTo(x, fftBottom);
      ctx.stroke();
      ctx.strokeStyle = text;
      ctx.beginPath();
      ctx.moveTo(x, fftBottom);
      ctx.lineTo(x, fftBottom + 7);
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.fillText(printAndScale(freq), x, fftBottom + 22);
    }

    // FFT trace with its shadow, then the hold trace
    const row = this.rows[0];
    if (row && this.latest) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(LEFT, TOP, dataWidth, fftHeight + 1);
      ctx.clip();
      const path = (data: Float32Array) => {
        const n = data.length;
        const xStep = (row.width / n) * hScale;
        const x0 = LEFT + (row.lower - lower) * hScale + xStep / 2;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const y = Math.min(Math.max(fftBottom - (data[i] - min) * vScale, TOP + 1), fftBottom);
          if (i === 0) ctx.moveTo(x0, y);
          else ctx.lineTo(x0 + i * xStep, y);
        }
        return { x0, x1: x0 + (n - 1) * xStep };
      };
      const ends = path(row.data);
      ctx.strokeStyle = trace;
      ctx.stroke();
      ctx.lineTo(ends.x1, fftBottom);
      ctx.lineTo(ends.x0, fftBottom);
      ctx.closePath();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = trace;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (this.latest.hold) {
        path(this.latest.hold);
        ctx.strokeStyle = holdColor;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Axes, separator under the frequency scale and the widget outline
    ctx.strokeStyle = text;
    ctx.beginPath();
    ctx.moveTo(LEFT, fftBottom + 0.5);
    ctx.lineTo(LEFT + dataWidth, fftBottom + 0.5);
    ctx.moveTo(LEFT + 0.5, TOP);
    ctx.lineTo(LEFT + 0.5, fftBottom);
    ctx.stroke();
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(0, fftBottom + FREQ_AREA + 0.5);
    ctx.lineTo(this.width, fftBottom + FREQ_AREA + 0.5);
    ctx.stroke();

    // Band name, and why there is no picture when there is none
    ctx.textAlign = "left";
    ctx.fillStyle = text;
    ctx.font = "14px Roboto, sans-serif";
    ctx.fillText(this.band.name, LEFT + 8, TOP + 12);
    if (!this.latest) {
      ctx.fillStyle = currentTheme.TextDisabled ?? "#7F7F7FFF";
      ctx.textAlign = "center";
      const message = this.settings.running ? "Waiting for data from the radio..." : "No data. Press play to start the radios.";
      ctx.fillText(message, LEFT + dataWidth / 2, TOP + fftHeight / 2);
    }

    // Frequency and level under the cursor
    if (this.hover && this.hover.x >= LEFT && this.hover.x <= LEFT + dataWidth) {
      const freq = lower + ((this.hover.x - LEFT) / dataWidth) * viewWidth;
      let label = `${printAndScale(Math.round(freq))}Hz`;
      if (this.hover.y >= TOP && this.hover.y <= fftBottom) {
        const db = max - ((this.hover.y - TOP) / fftHeight) * (max - min);
        label += `  ${db.toFixed(1)} dB`;
      }
      ctx.font = "13px Roboto, sans-serif";
      ctx.textAlign = "right";
      ctx.fillStyle = text;
      ctx.fillText(label, LEFT + dataWidth - 6, TOP + 12);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.beginPath();
      ctx.moveTo(Math.round(this.hover.x) + 0.5, TOP);
      ctx.lineTo(Math.round(this.hover.x) + 0.5, this.height);
      ctx.stroke();
    }
  }

  // --- interaction -----------------------------------------------------------------------

  private bindPointer() {
    const c = this.canvas;
    let drag: { mode: "pan" | "resize"; x: number; y: number; moved: boolean; startHeight: number } | null = null;

    const local = (ev: PointerEvent | WheelEvent) => {
      const rect = c.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const onDivider = (y: number) => this.settings.showWaterfall && Math.abs(y - (TOP + this.fftHeight + FREQ_AREA)) <= 4;

    c.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const p = local(ev);
      c.setPointerCapture(ev.pointerId);
      drag = { mode: onDivider(p.y) ? "resize" : "pan", x: p.x, y: p.y, moved: false, startHeight: this.fftHeight };
    });

    c.addEventListener("pointermove", (ev) => {
      const p = local(ev);
      this.hover = p;
      c.style.cursor = onDivider(p.y) || drag?.mode === "resize" ? "ns-resize" : "crosshair";
      if (drag) {
        const dx = p.x - drag.x;
        if (Math.abs(dx) > 2 || Math.abs(p.y - drag.y) > 2) drag.moved = true;
        if (drag.mode === "resize") {
          this.cb.onFftHeight(Math.max(drag.startHeight + (p.y - drag.y), MIN_FFT_HEIGHT));
        } else if (drag.moved && dx !== 0) {
          // Dragging moves the view; past the edge of the band it moves the center frequency instead
          this.viewOffset -= (dx / this.dataWidth) * this.viewWidth;
          const excess = this.clampOffset();
          drag.x = p.x;
          if (excess !== 0) {
            this.band = { ...this.band, frequency: Math.max(Math.round(this.band.frequency + excess), 0) };
            this.cb.onTune(this.band.id, this.band.frequency);
          }
          this.viewChanged();
        }
      }
      this.queueDraw();
    });

    c.addEventListener("pointerup", (ev) => {
      if (drag && !drag.moved) this.cb.onSelect(this.band.id);
      drag = null;
      c.releasePointerCapture(ev.pointerId);
    });

    c.addEventListener("pointerleave", () => {
      this.hover = null;
      this.queueDraw();
    });

    c.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const p = local(ev);
        const anchor = this.lower + (Math.min(Math.max(p.x - LEFT, 0), this.dataWidth) / this.dataWidth) * this.viewWidth;
        this.setViewBandwidth(this.viewWidth * (ev.deltaY > 0 ? 1.25 : 0.8), anchor);
      },
      { passive: false },
    );
  }
}
