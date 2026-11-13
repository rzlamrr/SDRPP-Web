// One band tile of the wall: a header with the band's health, the spectrum with its dB and frequency
// scales and the waterfall underneath, and a footer with the noise floor figures.

import type { BandState, InterferenceEvent, InterferenceSettings } from "./api";
import type { FftFrame } from "./stream";
import { PALETTE_SIZE, chart } from "./theme";
import { typeInfo } from "./interference";
import { STATUS, type BandHealth } from "./status";
import { el, setIcon } from "./widgets";

const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';

// Settings shared by all panes
export interface PaneSettings {
  min: number;
  max: number;
  showWaterfall: boolean;
  fftRatio: number; // Share of the plot height given to the spectrum when the waterfall is shown
  palette: Uint32Array;
  running: boolean;
  dwellMs: number; // Time a hopping radio stays on one band
  fftRate: number; // FFT lines per second, used to tell a pause in the frames from the normal spacing
  fftMode: "line" | "persistence";
  persistenceSpeed: number; // 1 (slow fade) to 100 (fast fade)
}

export interface PaneCallbacks {
  onSelect(band: number): void;
  onView(band: number, offset: number, bandwidth: number, points: number): void;
  onTune(band: number, frequency: number): void;
  onFftRatio(ratio: number): void;
  onExpand(band: number): void;
}

interface Row {
  data: Float32Array;
  lower: number; // Absolute frequency of the first point
  width: number; // Frequency span of the row
  gap?: boolean; // First line after the radio came back from other bands
}

// Geometry of the plot in CSS pixels. Small tiles drop the dB scale and shrink the frequency scale.
interface Geometry {
  left: number;
  right: number;
  top: number;
  freqArea: number;
  minFft: number;
  small: boolean;
}
const NORMAL: Geometry = { left: 46, right: 10, top: 8, freqArea: 26, minFft: 50, small: false };
const SMALL: Geometry = { left: 4, right: 4, top: 4, freqArea: 16, minFft: 24, small: true };
const MIN_VIEW_BANDWIDTH = 1000;
const MAX_ROWS = 2000;

// Level axis of the persistence histogram. Fixed in dB, so changing Min/Max only changes what is drawn.
const P_DB_MIN = -170;
const P_DB_STEP = 0.25;
const P_ROWS = Math.round((10 - P_DB_MIN) / P_DB_STEP); // Up to +10 dB

// Persistence histogram: hits per (frequency column, dB row), faded every line.
// The columns cover an absolute frequency range, so zooming or panning maps them instead of starting over.
interface Persistence {
  hist: Float32Array; // P_ROWS x cols, row major
  cols: number;
  lower: number; // Hz of the left edge of column 0
  width: number; // Hz covered by all columns
  // Hits are added with this weight, which grows every line instead of fading every cell; values are hist / weight
  weight: number;
}

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
  private away = false;
  // True when the band's radio shares its time with other bands
  hopping = false;
  private dotLive: boolean | null = null;
  // Active interference on this band, marked on the spectrum
  private events: InterferenceEvent[] = [];

  // Persistence: how often each level was hit, one cell per CSS pixel of the FFT area, faded every line
  private persist: Persistence | null = null;
  private persistDirty = false;
  private persistCanvas = document.createElement("canvas");
  private persistCtx = this.persistCanvas.getContext("2d")!;

  private g: Geometry = NORMAL;
  private body: HTMLDivElement;
  private head = {
    dot: el("span", "tile-dot"),
    name: el("span", "tile-name"),
    range: el("span", "tile-range"),
    radio: el("span", "tile-radio"),
    status: el("span", "tile-status"),
    count: el("span", "tile-count"),
    expand: el("button", "btn ghost small icon tile-expand"),
  };
  private foot = el("div", "tile-foot");
  private health: BandHealth | null = null;
  // Level the detector reports a frequency as occupied at: baseline noise floor plus the threshold
  private detectLevel: number | null = null;

  constructor(band: BandState, private settings: PaneSettings, private cb: PaneCallbacks) {
    this.band = band;
    this.root = el("div", "tile");
    const head = el("div", "tile-head");
    head.title = "Click to make this the main band";
    const h = this.head;
    h.radio.title = "Radio that receives this band";
    h.expand.type = "button";
    setIcon(h.expand, "expand");
    h.expand.title = "Make this the main band";
    h.count.hidden = true;
    head.append(h.dot, h.name, h.range, el("span", "spacer"), h.radio, h.status, h.count, h.expand);
    head.addEventListener("click", () => this.cb.onExpand(this.band.id));

    this.body = el("div", "pane");
    this.canvas = el("canvas", "pane-canvas");
    this.wfCanvas = el("canvas", "pane-waterfall");
    this.body.append(this.wfCanvas, this.canvas);
    this.root.append(head, this.body, this.foot);
    this.ctx = this.canvas.getContext("2d")!;
    this.wfCtx = this.wfCanvas.getContext("2d", { willReadFrequently: false })!;
    new ResizeObserver(() => this.layout()).observe(this.body);
    this.bindPointer();
    this.renderHead();
    this.renderFoot();
  }

  // --- tile header and footer ------------------------------------------------------------

  private renderHead() {
    const h = this.head;
    h.name.textContent = this.band.name;
    const bw = this.band.sampleRate;
    h.range.textContent = bw > 0 ? `${printAndScale(this.band.frequency - bw / 2)}–${printAndScale(this.band.frequency + bw / 2)}Hz` : printAndScale(this.band.frequency) + "Hz";
    h.radio.textContent = this.band.radio >= 0 ? `R${this.band.radio + 1}` : "–";
    h.radio.hidden = this.band.radio < 0;
    const health = this.health;
    const status = health?.status ?? "idle";
    const info = STATUS[status];
    const n = health?.active.length ?? 0;
    h.count.hidden = n === 0;
    h.count.textContent = String(n);
    h.count.title = `${n} active interference${n > 1 ? "s" : ""}`;
    h.status.hidden = n > 0;
    h.status.style.color = info.color;
    h.status.textContent = status === "learning" && health?.detector ? `Learning ${Math.round(health.detector.learnProgress * 100)}%` : info.label;
    for (const s of Object.keys(STATUS)) this.root.classList.toggle(`st-${s}`, s === status);
  }

  private renderFoot() {
    const parts: string[] = [];
    const health = this.health;
    const d = health?.detector;
    if (d && health?.status === "learning") {
      parts.push(`<span>Learning baseline</span><span class="learn-bar"><div style="width:${Math.round(d.learnProgress * 100)}%"></div></span>`);
    } else if (d && health?.status !== "idle" && health?.status !== "offline") {
      parts.push(`<span>Floor <b>${d.noiseFloor.toFixed(1)} dB</b></span>`);
      if (health.delta !== null) {
        const cls = health.delta > 3 ? "up" : health.delta > 1 ? "mid" : "flat";
        parts.push(`<span class="${cls}">${health.delta >= 0 ? "+" : ""}${health.delta.toFixed(1)} dB vs baseline</span>`);
      }
    } else if (health?.status === "offline") {
      parts.push("<span>No device connected for this band's radio</span>");
    } else {
      parts.push("<span>Stopped</span>");
    }
    if (this.latest && this.settings.running && !this.stale) {
      parts.push(`<span class="extra">SNR <b>${this.latest.snr.toFixed(1)} dB</b></span>`);
      const occ = this.occupancy();
      if (occ !== null) parts.push(`<span class="extra">Occupied <b>${Math.round(occ * 100)}%</b></span>`);
    }
    if (this.hopping) parts.push(`<span class="extra">Radio shared with other bands</span>`);
    this.foot.innerHTML = parts.join("");
  }

  // Health of the band and the detector settings, given once a second by the wall
  setHealth(health: BandHealth, settings: InterferenceSettings | undefined) {
    this.health = health;
    const d = health.detector;
    this.detectLevel = d && !d.learning && settings?.enabled ? d.baselineFloor + settings.thresholdDb : null;
    this.renderHead();
    this.renderFoot();
    this.queueDraw();
  }

  // The main band of the grid: shown large at the top. It is already main, so it has no enlarge button.
  setBig(big: boolean) {
    this.root.classList.toggle("big", big);
    this.head.expand.hidden = big;
    this.root.querySelector(".tile-head")!.setAttribute("title", big ? "Main band" : "Click to make this the main band");
  }

  // Share of the latest spectrum above the detection level, null when there is no level yet
  occupancy(): number | null {
    const row = this.rows[0];
    if (!row || this.detectLevel === null || row.gap) return null;
    let n = 0;
    for (let i = 0; i < row.data.length; i++) if (row.data[i] > this.detectLevel) n++;
    return row.data.length ? n / row.data.length : null;
  }

  // Levels of the latest line, for Auto level
  latestLevels(): Float32Array | null {
    return this.rows[0] && !this.rows[0].gap ? this.rows[0].data : null;
  }

  // --- geometry -------------------------------------------------------------------------

  private get dataWidth() {
    return Math.max(Math.floor(this.width - this.g.left - this.g.right), 16);
  }

  private get fftHeight() {
    const available = this.height - this.g.top - this.g.freqArea;
    if (!this.settings.showWaterfall) return Math.max(available - 2, this.g.minFft);
    const ratio = Math.min(Math.max(this.settings.fftRatio, 0.2), 0.8);
    return Math.max(Math.floor(available * ratio), this.g.minFft);
  }

  private get wfTop() {
    return this.g.top + this.fftHeight + this.g.freqArea + 1;
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
    this.renderHead();
    if (rateChanged) {
      this.viewOffset = 0;
      this.viewBandwidth = 0;
      this.cb.onView(this.band.id, 0, 0, this.dataWidth);
    }
    // The persistence is kept: it is stored by absolute frequency
    if (changed) this.wfDirty = true;
    this.queueDraw();
  }

  setEvents(events: InterferenceEvent[]) {
    if (events.length === 0 && this.events.length === 0) return;
    this.events = events;
    this.queueDraw();
  }

  // Zoom onto an interference event, or show the whole band for one that covers it
  focusRange(low: number, high: number, wholeBand: boolean) {
    if (wholeBand) {
      this.viewOffset = 0;
      this.setViewBandwidth(this.bandwidth);
      return;
    }
    this.viewOffset = (low + high) / 2 - this.band.frequency;
    this.setViewBandwidth(Math.max((high - low) * 8, 20000));
  }

  setSelected(selected: boolean) {
    // Shown with the accent border
    this.root.classList.toggle("selected", selected);
  }

  settingsChanged() {
    if (this.settings.fftMode !== "persistence") this.persist = null; // Starts fresh when switched on again
    this.layout();
  }

  // --- data ------------------------------------------------------------------------------

  pushFrame(frame: FftFrame) {
    const now = performance.now();
    // A frame after a pause starts a new visit of the radio
    const newVisit = !this.live;
    this.away = false;
    this.latest = frame;
    this.lastFrameAt = now;
    this.updateLive();
    const row: Row = {
      data: frame.fft,
      lower: frame.centerFreq + frame.viewOffset - frame.viewBandwidth / 2,
      width: frame.viewBandwidth,
      gap: newVisit && this.hopping && this.rows.length > 0,
    };
    this.rows.unshift(row);
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS;
    if (this.settings.fftMode === "persistence") this.accumulate(row);

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

  // True while frames arrive at the FFT rate, i.e. the radio is on this band now
  get live() {
    if (this.away) return false;
    const limit = Math.max((3 * 1000) / Math.max(this.settings.fftRate, 1), 150);
    return this.lastFrameAt > 0 && performance.now() - this.lastFrameAt < limit;
  }

  // The radio of this band moved on: another band of the same radio sent a frame.
  // This catches short dwells, where the radio is back before frames look late.
  markAway() {
    this.away = true;
  }

  // Fraction kept per line. The speed sets the time constant: 50 / speed seconds at the FFT rate.
  // Counted per received line, so a band that shares its radio does not fade while the radio is away.
  private get persistDecay() {
    const tau = 50 / Math.min(Math.max(this.settings.persistenceSpeed, 1), 100);
    return Math.exp(-1 / (tau * Math.max(this.settings.fftRate, 1)));
  }

  // Persistence covering the current view at one column per pixel. An existing one is mapped onto the
  // new view: zooming in stretches what was seen (it sharpens as new lines arrive), zooming out keeps it
  // in the middle with nothing yet around it.
  private persistence(): Persistence {
    const cols = this.dataWidth;
    const lower = this.lower;
    const width = this.viewWidth;
    const old = this.persist;
    if (old && old.cols === cols && old.lower === lower && old.width === width) return old;

    const hist = new Float32Array(P_ROWS * cols);
    if (old) {
      // Old columns under each new column; the strongest of them is kept
      const from = new Int32Array(cols);
      const to = new Int32Array(cols);
      for (let c = 0; c < cols; c++) {
        const f0 = lower + (c / cols) * width;
        const f1 = lower + ((c + 1) / cols) * width;
        let a = Math.floor(((f0 - old.lower) / old.width) * old.cols);
        let b = Math.ceil(((f1 - old.lower) / old.width) * old.cols) - 1;
        if (b < 0 || a >= old.cols) {
          from[c] = 1;
          to[c] = 0; // Outside what was seen
          continue;
        }
        a = Math.max(a, 0);
        b = Math.min(Math.max(b, a), old.cols - 1);
        from[c] = a;
        to[c] = b;
      }
      for (let r = 0; r < P_ROWS; r++) {
        const src = r * old.cols;
        const dst = r * cols;
        for (let c = 0; c < cols; c++) {
          let m = 0;
          for (let k = from[c]; k <= to[c]; k++) if (old.hist[src + k] > m) m = old.hist[src + k];
          hist[dst + c] = m;
        }
      }
    }
    this.persist = { hist, cols, lower, width, weight: old ? old.weight : 1 };
    this.persistDirty = true;
    return this.persist;
  }

  private accumulate(row: Row) {
    const p = this.persistence();
    const hist = p.hist;
    const cols = p.cols;

    // Only lines made for this view: lines still in flight after a zoom, or sent before the pane had its
    // size, have another resolution and their max-hold levels would smear the picture
    const pixel = p.width / cols;
    if (row.data.length !== cols || Math.abs(row.width - p.width) > pixel || Math.abs(row.lower - p.lower) > pixel) return;

    // Fading every cell by `decay` is the same as adding new hits with a weight that grows by 1 / decay
    p.weight /= this.persistDecay;
    if (p.weight > 1e20) {
      const k = 1 / p.weight;
      for (let i = 0; i < hist.length; i++) hist[i] *= k;
      p.weight = 1;
    }
    const w = p.weight;

    const n = row.data.length;
    const toIndex = n / row.width;
    let prev = -1;
    for (let c = 0; c < cols; c++) {
      const freq = p.lower + ((c + 0.5) / cols) * p.width;
      const i = Math.floor((freq - row.lower) * toIndex);
      if (i < 0 || i >= n || !Number.isFinite(row.data[i])) {
        prev = -1;
        continue;
      }
      const r = Math.min(Math.max(Math.round((row.data[i] - P_DB_MIN) / P_DB_STEP), 0), P_ROWS - 1);
      // Join to the previous column like the line trace does, so steep edges stay continuous
      const lo = prev < 0 ? r : Math.min(prev, r);
      const hi = prev < 0 ? r : Math.max(prev, r);
      for (let k = lo; k <= hi; k++) hist[k * cols + c] += w;
      prev = r;
    }
    this.persistDirty = true;
  }

  private renderPersistence(): Persistence {
    const p = this.persistence();
    const cols = p.cols;
    const h = this.fftHeight;
    if (this.persistCanvas.width !== cols || this.persistCanvas.height !== h) {
      this.persistCanvas.width = cols;
      this.persistCanvas.height = h;
    }
    const image = this.persistCtx.createImageData(cols, h);
    const out = new Uint32Array(image.data.buffer);
    const { palette, min, max } = this.settings;
    // A level present in every line settles at 1 / (1 - decay); log scale so rare hits still show
    const full = 1 / (1 - this.persistDecay);
    const k = (PALETTE_SIZE - 1) / Math.log1p(full);
    const inv = 1 / p.weight;
    const dbPerPixel = (max - min) / h;
    for (let y = 0; y < h; y++) {
      // dB rows under this pixel row; the strongest is shown
      const top = max - y * dbPerPixel;
      let r1 = Math.floor((top - P_DB_MIN) / P_DB_STEP);
      let r0 = Math.ceil((top - dbPerPixel - P_DB_MIN) / P_DB_STEP);
      if (r1 < 0 || r0 >= P_ROWS) continue;
      r0 = Math.max(r0, 0);
      r1 = Math.min(Math.max(r1, r0), P_ROWS - 1);
      const line = y * cols;
      for (let c = 0; c < cols; c++) {
        let v = 0;
        for (let r = r0; r <= r1; r++) {
          const x = p.hist[r * cols + c];
          if (x > v) v = x;
        }
        v *= inv;
        if (v < 0.02) continue; // Transparent
        out[line + c] = palette[Math.min(Math.round(Math.log1p(v) * k), PALETTE_SIZE - 1)];
      }
    }
    this.persistCtx.putImageData(image, 0, 0);
    this.persistDirty = false;
    return p;
  }

  private renderRow(row: Row, out: Uint32Array, start: number, width: number) {
    if (row.gap) {
      // Separator where time passed while the radio was on other bands (ABGR, little endian)
      out.fill(0xff7f7f7f, start, start + width);
      return;
    }
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
    const rect = this.body.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width <= 0 || height <= 0) return;
    const sizeChanged = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;
    // Small tiles keep the plot and drop the dB scale
    this.g = width < 380 || height < 170 ? SMALL : NORMAL;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    // One waterfall pixel per FFT point and per line
    const wfHeight = this.wfHeight;
    this.wfCanvas.width = this.dataWidth;
    this.wfCanvas.height = wfHeight;
    this.wfCanvas.style.left = `${this.g.left}px`;
    this.wfCanvas.style.top = `${this.wfTop}px`;
    this.wfCanvas.style.width = `${this.dataWidth}px`;
    this.wfCanvas.style.height = `${wfHeight}px`;
    this.wfCanvas.hidden = wfHeight <= 0;
    this.wfDirty = true;
    this.persistDirty = true; // Size, level range or colors changed

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

    const text = chart.text;
    const trace = chart.trace;
    const holdColor = chart.hold;
    const grid = chart.grid;
    const small = this.g.small;
    const { min, max } = this.settings;
    const dataWidth = this.dataWidth;
    const fftHeight = this.fftHeight;
    const fftBottom = this.g.top + fftHeight;
    const lower = this.lower;
    const viewWidth = this.viewWidth;
    const upper = lower + viewWidth;

    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;

    // Vertical scale: grid lines always, labels only on tiles large enough for them
    const textHeight = small ? 22 : 16;
    const vRange = findBestRange(max - min, Math.max(Math.floor(fftHeight / textHeight), 1));
    const vScale = fftHeight / Math.max(max - min, 1e-6);
    ctx.textAlign = "right";
    for (let line = Math.floor(max / vRange) * vRange; line > min; line -= vRange) {
      const y = Math.round(fftBottom - (line - min) * vScale) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(this.g.left, y);
      ctx.lineTo(this.g.left + dataWidth, y);
      ctx.stroke();
      if (!small) {
        ctx.fillStyle = text;
        ctx.fillText(String(Math.round(line)), this.g.left - 8, y);
      }
    }

    // Horizontal scale
    const labelWidth = ctx.measureText("000.000").width + 10;
    const hRange = findBestRange(viewWidth, Math.max(Math.floor(dataWidth / labelWidth), 1));
    const hScale = dataWidth / viewWidth;
    ctx.textAlign = "center";
    for (let freq = Math.ceil(lower / hRange) * hRange; freq < upper; freq += hRange) {
      const x = Math.round(this.g.left + (freq - lower) * hScale) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(x, this.g.top + 1);
      ctx.lineTo(x, fftBottom);
      ctx.stroke();
      ctx.strokeStyle = chart.axis;
      ctx.beginPath();
      ctx.moveTo(x, fftBottom);
      ctx.lineTo(x, fftBottom + (small ? 3 : 5));
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.fillText(printAndScale(freq), x, fftBottom + (small ? 10 : 15));
    }

    // FFT trace with its shadow, then the hold trace
    const row = this.rows[0];
    if (row && this.latest) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.g.left, this.g.top, dataWidth, fftHeight + 1);
      ctx.clip();
      const path = (data: Float32Array) => {
        const n = data.length;
        const xStep = (row.width / n) * hScale;
        const x0 = this.g.left + (row.lower - lower) * hScale + xStep / 2;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const y = Math.min(Math.max(fftBottom - (data[i] - min) * vScale, this.g.top + 1), fftBottom);
          if (i === 0) ctx.moveTo(x0, y);
          else ctx.lineTo(x0 + i * xStep, y);
        }
        return { x0, x1: x0 + (n - 1) * xStep };
      };
      if (this.settings.fftMode === "persistence") {
        const stale = !this.persist || this.persistDirty || this.persist.cols !== dataWidth || this.persist.lower !== lower || this.persist.width !== viewWidth;
        if (stale) this.renderPersistence();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.persistCanvas, this.g.left, this.g.top, this.persistCanvas.width, this.persistCanvas.height);
        // The latest line, faint, so the current state is still readable
        path(row.data);
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = trace;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
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
      }
      if (this.latest.hold) {
        path(this.latest.hold);
        ctx.strokeStyle = holdColor;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Detection level: what rises above this line is reported as interference
    if (this.detectLevel !== null && this.detectLevel > min && this.detectLevel < max) {
      const y = Math.round(fftBottom - (this.detectLevel - min) * vScale) + 0.5;
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = chart.threshold;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(this.g.left, y);
      ctx.lineTo(this.g.left + dataWidth, y);
      ctx.stroke();
      if (!small) {
        ctx.setLineDash([]);
        ctx.fillStyle = chart.threshold;
        ctx.textAlign = "right";
        ctx.font = `11px ${FONT}`;
        ctx.fillText("detection level", this.g.left + dataWidth - 6, y - 8);
      }
      ctx.restore();
    }

    this.drawEvents(ctx, lower, hScale, fftBottom);

    // Axes and the separator under the frequency scale
    ctx.strokeStyle = chart.axis;
    ctx.beginPath();
    ctx.moveTo(this.g.left, fftBottom + 0.5);
    ctx.lineTo(this.g.left + dataWidth, fftBottom + 0.5);
    ctx.moveTo(this.g.left + 0.5, this.g.top);
    ctx.lineTo(this.g.left + 0.5, fftBottom);
    ctx.stroke();
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(0, fftBottom + this.g.freqArea + 0.5);
    ctx.lineTo(this.width, fftBottom + this.g.freqArea + 0.5);
    ctx.stroke();

    // Why there is no picture when there is none
    if (!this.latest) {
      ctx.fillStyle = chart.muted;
      ctx.textAlign = "center";
      ctx.font = `12px ${FONT}`;
      const message = this.settings.running ? "Waiting for data from the radio…" : small ? "Stopped" : "No data. Press Start to run the radios.";
      ctx.fillText(message, this.g.left + dataWidth / 2, this.g.top + fftHeight / 2);
    }

    // Frequency and level under the cursor
    if (this.hover && this.hover.x >= this.g.left && this.hover.x <= this.g.left + dataWidth) {
      const freq = lower + ((this.hover.x - this.g.left) / dataWidth) * viewWidth;
      let label = `${printAndScale(Math.round(freq))}Hz`;
      if (this.hover.y >= this.g.top && this.hover.y <= fftBottom) {
        const db = max - ((this.hover.y - this.g.top) / fftHeight) * (max - min);
        label += `  ${db.toFixed(1)} dB`;
      }
      ctx.font = `12px ${FONT}`;
      const w = ctx.measureText(label).width + 10;
      const lx = Math.min(Math.max(this.hover.x + 8, this.g.left + 2), this.g.left + dataWidth - w - 2);
      ctx.fillStyle = "rgba(8, 11, 16, 0.85)";
      ctx.fillRect(lx, this.g.top + 4, w, 18);
      ctx.textAlign = "left";
      ctx.fillStyle = "#e3e9f2";
      ctx.fillText(label, lx + 5, this.g.top + 13);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.beginPath();
      ctx.moveTo(Math.round(this.hover.x) + 0.5, this.g.top);
      ctx.lineTo(Math.round(this.hover.x) + 0.5, this.height);
      ctx.stroke();
    }
  }

  // Shaded range over the spectrum and a bar on the frequency scale for every active event
  private drawEvents(ctx: CanvasRenderingContext2D, lower: number, hScale: number, fftBottom: number) {
    if (this.events.length === 0) return;
    const dataWidth = this.dataWidth;
    ctx.save();
    ctx.font = `bold 11px ${FONT}`;
    ctx.textBaseline = "middle";
    let noiseLine = 0;
    for (const e of this.events) {
      const info = typeInfo(e.type);
      if (e.type === "noise") {
        // Covers the whole band: a frame around the spectrum and a label
        ctx.strokeStyle = info.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(this.g.left + 1, this.g.top + 1, dataWidth - 2, fftBottom - this.g.top - 1);
        ctx.fillStyle = info.color;
        ctx.textAlign = "left";
        ctx.fillText(`Noise floor +${e.excess.toFixed(1)} dB`, this.g.left + 8, this.g.top + (this.g.small ? 12 : 32) + noiseLine * 14);
        noiseLine++;
        continue;
      }
      let x0 = this.g.left + (e.low - lower) * hScale;
      let x1 = this.g.left + (e.high - lower) * hScale;
      if (x1 - x0 < 4) {
        const mid = (x0 + x1) / 2;
        x0 = mid - 2;
        x1 = mid + 2;
      }
      if (x1 < this.g.left || x0 > this.g.left + dataWidth) continue;
      x0 = Math.max(x0, this.g.left + 1);
      x1 = Math.min(x1, this.g.left + dataWidth);
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = info.color;
      ctx.fillRect(x0, this.g.top + 1, x1 - x0, fftBottom - this.g.top - 1);
      ctx.globalAlpha = 1;
      ctx.fillRect(x0, fftBottom + 1, x1 - x0, 4);
      ctx.strokeStyle = info.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, this.g.top + 1);
      ctx.lineTo(x0 + 0.5, fftBottom);
      ctx.moveTo(x1 - 0.5, this.g.top + 1);
      ctx.lineTo(x1 - 0.5, fftBottom);
      ctx.stroke();
      // Tag above the range
      const w = ctx.measureText(info.short).width + 8;
      const tx = Math.min(Math.max((x0 + x1) / 2 - w / 2, this.g.left + 1), this.g.left + dataWidth - w);
      const ty = this.g.small ? this.g.top + 2 : this.g.top + 26;
      ctx.fillRect(tx, ty, w, 15);
      ctx.fillStyle = "#000";
      ctx.textAlign = "center";
      ctx.fillText(info.short, tx + w / 2, ty + 8);
    }
    ctx.restore();
  }

  // Title dot: green while this band is being received, grey while its radio is on another band or stopped
  updateLive() {
    const live = this.settings.running && this.live;
    if (live === this.dotLive) return;
    this.dotLive = live;
    this.head.dot.classList.toggle("live", live);
    this.head.dot.title = live ? "Receiving this band now" : this.settings.running ? (this.hopping ? "Radio is on another band, back shortly" : "No data from the radio") : "Stopped";
  }

  // --- interaction -----------------------------------------------------------------------

  private bindPointer() {
    const c = this.canvas;
    let drag: { mode: "pan" | "resize"; x: number; y: number; moved: boolean; startHeight: number } | null = null;

    const local = (ev: PointerEvent | WheelEvent) => {
      const rect = c.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const onDivider = (y: number) => this.settings.showWaterfall && Math.abs(y - (this.g.top + this.fftHeight + this.g.freqArea)) <= 4;

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
          const available = Math.max(this.height - this.g.top - this.g.freqArea, 1);
          this.cb.onFftRatio((drag.startHeight + (p.y - drag.y)) / available);
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
        const anchor = this.lower + (Math.min(Math.max(p.x - this.g.left, 0), this.dataWidth) / this.dataWidth) * this.viewWidth;
        this.setViewBandwidth(this.viewWidth * (ev.deltaY > 0 ? 1.25 : 0.8), anchor);
      },
      { passive: false },
    );
  }
}
