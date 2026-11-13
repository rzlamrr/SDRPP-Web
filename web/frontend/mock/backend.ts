// Simulated `sdrpp --web` for working on the interface without a radio (npm run dev).
// It speaks the same REST API and WebSocket frames as web/src, with a made-up spectrum.
// Nothing here is used by the real program.

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { WebSocketServer, type WebSocket } from "ws";

const RES_DIR = path.resolve(__dirname, "../../../root/res");

const STEP = { FILL: 0x00, SAME_LINE: 0x01, BEGIN_DISABLED: 0x02, END_DISABLED: 0x03, COMBO: 0x80, BUTTON: 0x81, LEFT_LABEL: 0x87, SLIDER_INT: 0x88, INPUT_INT: 0x8a, CHECKBOX: 0x8b };

interface Band {
  id: number;
  name: string;
  frequency: number;
  radioSetting: number;
  view: { offset: number; bandwidth: number; points: number };
  hold: Float32Array | null;
}

interface Radio {
  srId: number;
  gainMode: number;
  gain: number;
  biasT: boolean;
  bwId: number;
  clkId: number;
  ppm: number;
  device: string; // Empty when the radio has no device
}

const SOURCE_TYPES = [
  { id: "bladerf", name: "BladeRF", rates: [1e6, 2e6, 4e6, 8e6, 10e6, 20e6, 30.72e6, 40e6, 56e6, 61.44e6], defRate: 5, settleMs: 15 },
  { id: "rtlsdr", name: "RTL-SDR", rates: [0.25e6, 1.024e6, 1.536e6, 1.792e6, 1.92e6, 2.048e6, 2.16e6, 2.4e6, 2.56e6, 2.88e6, 3.2e6], defRate: 7, settleMs: 60 },
];

const rateText = (r: number) => (r >= 1e6 ? `${+(r / 1e6).toFixed(3)}MHz` : `${+(r / 1e3).toFixed(1)}KHz`);

function listNames(dir: string) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((file) => ({ name: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).name ?? file, file }));
  } catch {
    return [];
  }
}

// Stable pseudo random number in [0, 1) for an integer
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Power (linear, relative to full scale) of the pretend signals at a frequency
function signalPower(freq: number, t: number): number {
  let p = 0;
  // FM broadcast: a station every 400 kHz, 180 kHz wide
  if (freq > 87.4e6 && freq < 108.1e6) {
    const k = Math.round((freq - 87.6e6) / 0.4e6);
    const d = Math.abs(freq - (87.6e6 + k * 0.4e6));
    const level = -75 + hash(k) * 45;
    if (hash(k + 99) > 0.25) p += 10 ** ((level - 30 * Math.max(0, d / 90e3 - 1) ** 1.5 - (d / 90e3) * 3) / 10);
  }
  // GSM 900 downlink: 200 kHz carriers
  if (freq > 925e6 && freq < 960e6) {
    const k = Math.floor((freq - 925e6) / 0.2e6);
    if (hash(k + 500) > 0.55) p += 10 ** ((-70 + hash(k + 700) * 25) / 10);
  }
  // LTE 1800 downlink: wide flat blocks
  if (freq > 1805e6 && freq < 1880e6) {
    const k = Math.floor((freq - 1805e6) / 15e6);
    const inBlock = (freq - 1805e6) % 15e6 < 13.5e6;
    if (inBlock) p += 10 ** ((-72 + hash(k + 900) * 14) / 10);
  }
  // WiFi 2.4 GHz: channels 1, 6 and 11 in bursts
  for (const [i, c] of [2412e6, 2437e6, 2462e6].entries()) {
    if (Math.abs(freq - c) < 9e6 && hash(Math.floor(t * 12) * 7 + i) > 0.5) p += 10 ** ((-68 + i * 4) / 10);
  }
  return p;
}

export function mockBackend(): Plugin {
  const config = {
    running: false,
    sourceType: "bladerf",
    radioCount: 1,
    dwellMs: 100,
    settleMs: null as number | null,
    display: { fftSize: 65536, fftRate: 20, fftWindow: 2, showWaterfall: true, fftHold: false, fftHoldSpeed: 60, fftSmoothing: false, fftSmoothingSpeed: 100, colorMap: "Classic", theme: "Dark", min: -120, max: 0 },
  };
  let bands: Band[] = [];
  let radios: Radio[] = [];
  // Simulated devices plugged in. Change them with PUT /api/mock/devices { devices: ["SIM1", ...] }.
  let connected = ["SIM00000000000001", "SIM00000000000002"];
  let lastSeen = new Set(connected);
  const notices: { id: number; text: string }[] = [];
  let noticeId = 0;
  const notify = (text: string) => {
    notices.push({ id: ++noticeId, text });
    if (notices.length > 10) notices.shift();
  };
  const clients = new Set<WebSocket>();
  let timer: NodeJS.Timeout | null = null;

  const type = () => SOURCE_TYPES.find((t) => t.id === config.sourceType)!;
  const settle = () => config.settleMs ?? type().settleMs;
  const newBand = (id: number, name: string, frequency: number): Band => ({ id, name, frequency, radioSetting: -1, view: { offset: 0, bandwidth: 0, points: 1024 }, hold: null });
  const newRadio = (): Radio => ({ srId: type().defRate, gainMode: 1, gain: 30, biasT: false, bwId: 0, clkId: 0, ppm: 0, device: "" });
  const online = (r: Radio | undefined) => !!r && r.device !== "";
  const isTied = (b: Band) => b.radioSetting >= 0 && b.radioSetting < radios.length && online(radios[b.radioSetting]);
  // Same rule as assignBands in web/src/engine.cpp: radio of each band, in band order
  function assignment(): number[] {
    const counts = radios.map((r) => (online(r) ? 0 : Infinity));
    const result = bands.map((b) => (isTied(b) ? b.radioSetting : -1));
    for (const r of result) if (r >= 0) counts[r]++;
    bands.forEach((b, i) => {
      if (isTied(b) || !radios.some(online)) return;
      result[i] = counts.indexOf(Math.min(...counts));
      counts[result[i]]++;
    });
    return result;
  }
  // Same rule as assignDevices in web/src/engine.cpp
  function assignDevices(preferred = -1) {
    const used = new Set<string>();
    const order = [...radios.keys()].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a - b));
    const unbound: number[] = [];
    for (const i of order) {
      const d = radios[i].device;
      if (d && connected.includes(d) && !used.has(d)) used.add(d);
      else unbound.push(i);
    }
    for (const i of unbound.sort((a, b) => a - b)) {
      radios[i].device = connected.find((d) => !used.has(d)) ?? "";
      if (radios[i].device) used.add(radios[i].device);
    }
  }
  function autoConfigure() {
    lastSeen = new Set(connected);
    if (connected.length === 0) {
      buildRadios();
      notify(`No ${type().name} found. Plug one in, it is picked up automatically.`);
      return;
    }
    config.radioCount = Math.min(connected.length, 8);
    buildRadios();
    const n = config.radioCount;
    notify(`${n} ${type().name} ${n > 1 ? "devices" : "device"} found, ${n} ${n > 1 ? "radios" : "radio"} set up`);
  }
  // The watcher of web/src/engine.cpp
  function checkNewDevices() {
    const fresh = connected.filter((d) => !lastSeen.has(d) && !radios.some((r) => r.device === d));
    lastSeen = new Set(connected);
    if (fresh.length === 0) return;
    const offline = radios.filter((r) => !online(r)).length;
    const count = Math.min(radios.length + Math.max(0, fresh.length - offline), 8);
    if (count !== radios.length) {
      config.radioCount = count;
      buildRadios();
    } else {
      assignDevices();
    }
    for (const d of fresh) {
      const i = radios.findIndex((r) => r.device === d);
      notify(i >= 0 ? `New ${type().name} connected (${d}), used as Radio ${i + 1}` : `New ${type().name} connected (${d}), but it could not be used`);
    }
  }
  const radioOf = (index: number) => assignment()[index] ?? -1;
  const bandsOf = (radio: number) => bands.filter((_, i) => radioOf(i) === radio);
  const rate = (radio: number) => type().rates[radios[radio]?.srId ?? 0];

  function buildRadios() {
    radios = Array.from({ length: config.radioCount }, (_, i) => radios[i] ?? newRadio());
    assignDevices();
  }
  bands = [newBand(1, "Band 1", 100e6)];
  autoConfigure();

  function state() {
    return {
      running: config.running,
      sourceType: config.sourceType,
      sourceTypes: SOURCE_TYPES.map(({ id, name }) => ({ id, name })),
      radioCount: config.radioCount,
      dwellMs: config.dwellMs,
      settleMs: settle(),
      bands: bands.map((b, i) => ({ id: b.id, name: b.name, frequency: b.frequency, radio: radioOf(i), radioSetting: b.radioSetting < radios.length ? b.radioSetting : -1, sampleRate: rate(radioOf(i)) })),
      radios: radios.map((_, i) => ({ id: i, name: i === 0 ? type().name : `${type().name} Source #${i + 1}`, sampleRate: rate(i), bands: bandsOf(i).map((b) => b.id), receiving: config.running && bandsOf(i).length > 0, device: radios[i].device, online: online(radios[i]) })),
      error: "",
      notices,
      display: config.display,
      fftSizes: [524288, 262144, 131072, 65536, 32768, 16384, 8192, 4096, 2048, 1024],
      colorMaps: listNames(path.join(RES_DIR, "colormaps")),
      themes: listNames(path.join(RES_DIR, "themes")),
    };
  }

  // The menu the real module records, see source_modules/*/src/main.cpp
  function menu(index: number, action: { id?: string; value?: unknown } | null) {
    const r = radios[index];
    if (!r) throw new Error("Radio not found");
    const t = type();
    const sfx = index === 0 ? `${t.name} Source` : `${t.name} Source #${index + 1}`;
    const e: unknown[] = [];
    const step = (s: number, ...args: unknown[]) => {
      e.push({ step: s, sync: false });
      for (const v of args) e.push({ v });
    };
    const hit = (id: string) => action?.id === id;
    const combo = (id: string, key: keyof Radio, items: string[]) => {
      if (hit(id)) (r[key] as number) = Number(action!.value);
      step(STEP.COMBO, id, r[key], items.join("\0") + "\0", -1);
    };
    const check = (id: string, key: keyof Radio) => {
      if (hit(id)) (r[key] as boolean) = Boolean(action!.value);
      step(STEP.CHECKBOX, id, r[key]);
    };

    if (config.running) step(STEP.BEGIN_DISABLED);
    step(STEP.FILL);
    if (hit(`##_dev_sel_${sfx}`)) {
      r.device = connected[Number(action!.value)] ?? r.device;
      assignDevices(index);
    }
    if (hit(`Refresh##_refr_${sfx}`)) assignDevices(index);
    step(STEP.COMBO, `##_dev_sel_${sfx}`, connected.indexOf(r.device), connected.join("\0") + "\0", -1);
    combo(`##_sr_sel_${sfx}`, "srId", t.rates.map(rateText));
    step(STEP.SAME_LINE);
    step(STEP.FILL);
    step(STEP.BUTTON, `Refresh##_refr_${sfx}`, 0, 0);
    if (config.running) step(STEP.END_DISABLED);

    if (t.id === "bladerf") {
      step(STEP.LEFT_LABEL, "Bandwidth");
      step(STEP.FILL);
      combo(`##_bw_sel_${sfx}`, "bwId", ["Auto", "1.5MHz", "5MHz", "10MHz", "20MHz", "28MHz", "56MHz"]);
      step(STEP.LEFT_LABEL, "Clock Source");
      step(STEP.FILL);
      combo(`##_clk_sel_${sfx}`, "clkId", ["On-Board", "External"]);
      step(STEP.LEFT_LABEL, "Gain control mode");
      step(STEP.FILL);
      combo(`##_gm_sel_${sfx}`, "gainMode", ["Default", "Manual", "Fast", "Slow", "Hybrid"]);
      if (r.gainMode !== 1) step(STEP.BEGIN_DISABLED);
      step(STEP.LEFT_LABEL, "Gain");
      step(STEP.FILL);
      if (hit("##_oag_sel_")) r.gain = Number(action!.value);
      step(STEP.SLIDER_INT, "##_oag_sel_", r.gain, -15, 60, 1, 0);
      if (r.gainMode !== 1) step(STEP.END_DISABLED);
      check("Bias-T##_biast_", "biasT");
    } else {
      step(STEP.LEFT_LABEL, "PPM Correction");
      step(STEP.FILL);
      if (hit(`##_ppm_${sfx}`)) r.ppm = Number(action!.value);
      step(STEP.INPUT_INT, `##_ppm_${sfx}`, r.ppm, 1, 10, 0);
      step(STEP.LEFT_LABEL, "Gain");
      step(STEP.FILL);
      if (hit(`##_gain_${sfx}`)) r.gain = Number(action!.value);
      step(STEP.SLIDER_INT, `##_gain_${sfx}`, Math.min(r.gain, 28), 0, 28, 0, 0);
      check(`Bias T##_biast_${sfx}`, "biasT");
    }
    return { radio: index, name: sfx, running: config.running, elements: e };
  }

  function frame(band: Band, radio: number, t: number): Buffer {
    const bw = rate(radio);
    const vbw = band.view.bandwidth <= 0 || band.view.bandwidth > bw ? bw : band.view.bandwidth;
    const limit = (bw - vbw) / 2;
    const voff = Math.min(Math.max(band.view.offset, -limit), limit);
    const n = band.view.points;
    const hold = config.display.fftHold;
    const buf = Buffer.alloc(56 + n * 2 * (hold ? 2 : 1));
    const gain = radios[radio].gain;
    const floor = 10 ** ((-112 + gain * 0.35) / 10);
    const lower = band.frequency + voff - vbw / 2;
    if (hold && (!band.hold || band.hold.length !== n)) band.hold = new Float32Array(n).fill(-200);
    const holdSpeed = config.display.fftHoldSpeed / (config.display.fftRate * 10);

    let peak = -200;
    for (let i = 0; i < n; i++) {
      const freq = lower + ((i + 0.5) / n) * vbw;
      const edge = Math.abs(freq - band.frequency) / (bw / 2);
      const rolloff = edge > 0.9 ? 10 ** (-(edge - 0.9) * 30) : 1; // Anti-alias filter
      const power = (signalPower(freq, t) * 10 ** ((gain - 30) / 10) * rolloff + floor) * -Math.log(1 - Math.random() * 0.999);
      const db = Math.max(10 * Math.log10(power), -160);
      if (db > peak) peak = db;
      buf.writeInt16LE(Math.round(db * 100), 56 + i * 2);
      if (hold && band.hold) {
        band.hold[i] = Math.max(db, band.hold[i] - holdSpeed);
        buf.writeInt16LE(Math.round(band.hold[i] * 100), 56 + (n + i) * 2);
      }
    }
    buf.writeUInt32LE(0x31465053, 0);
    buf.writeInt32LE(band.id, 4);
    buf.writeDoubleLE(band.frequency, 8);
    buf.writeDoubleLE(bw, 16);
    buf.writeDoubleLE(voff, 24);
    buf.writeDoubleLE(vbw, 32);
    buf.writeUInt32LE(n, 40);
    buf.writeUInt32LE(hold ? 1 : 0, 44);
    buf.writeFloatLE(Math.max(peak - 10 * Math.log10(floor), 0), 48);
    return buf;
  }

  function tick() {
    if (!config.running || clients.size === 0) return;
    const now = Date.now();
    radios.forEach((_, r) => {
      const mine = bandsOf(r);
      if (mine.length === 0) return;
      let band = mine[0];
      if (mine.length > 1) {
        // Visit the bands in turn, nothing is received while the tuner settles
        const slot = config.dwellMs + settle();
        if (now % slot < settle()) return;
        band = mine[Math.floor(now / slot) % mine.length];
      }
      const data = frame(band, r, now / 1000);
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
    });
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000 / config.display.fftRate);
  }

  function handle(method: string, url: string, body: any): unknown {
    const band = (id: number) => {
      const b = bands.find((x) => x.id === id);
      if (!b) throw new Error("Band not found");
      return b;
    };
    let m: RegExpMatchArray | null;
    if (url === "/api/state") return state();
    if (url === "/api/start" && method === "POST") {
      if (bands.length === 0) throw new Error("Add a band first");
      lastSeen = new Set(connected);
      assignDevices();
      if (!radios.some(online)) throw new Error(`No ${type().name} connected. Plug one in, it is picked up automatically.`);
      config.running = true;
    } else if (url === "/api/stop" && method === "POST") {
      config.running = false;
    } else if (url === "/api/setup" && method === "PUT") {
      if (body.sourceType !== undefined && body.sourceType !== config.sourceType) {
        if (!SOURCE_TYPES.some((t) => t.id === body.sourceType)) throw new Error("Unknown source type");
        config.sourceType = body.sourceType;
        config.settleMs = null;
        autoConfigure();
      }
      if (body.radioCount !== undefined) {
        if (body.radioCount < 1 || body.radioCount > 8) throw new Error("Radio count must be between 1 and 8");
        config.radioCount = body.radioCount;
        buildRadios();
      }
      if (body.dwellMs !== undefined) {
        if (body.dwellMs < 10 || body.dwellMs > 10000) throw new Error("Dwell time must be between 10 and 10000 ms");
        config.dwellMs = body.dwellMs;
      }
      if (body.settleMs !== undefined) {
        if (body.settleMs < 0 || body.settleMs > 1000) throw new Error("Settle time must be between 0 and 1000 ms");
        config.settleMs = body.settleMs;
      }
    } else if (url === "/api/display" && method === "PUT") {
      Object.assign(config.display, body);
      restartTimer();
    } else if (url === "/api/bands" && method === "POST") {
      if (bands.length >= 16) throw new Error("No more than 16 bands");
      const id = bands.reduce((max, b) => Math.max(max, b.id + 1), 1);
      bands.push(newBand(id, body.name ?? `Band ${id}`, body.frequency ?? 100e6));
    } else if ((m = url.match(/^\/api\/bands\/(\d+)$/))) {
      const b = band(Number(m[1]));
      if (method === "DELETE") bands = bands.filter((x) => x !== b);
      else {
        if (body.radioSetting !== undefined && (body.radioSetting < -1 || body.radioSetting >= radios.length)) throw new Error("Radio not found");
        for (const key of ["name", "frequency", "radioSetting"] as const) {
          if (body[key] !== undefined) Object.assign(b, { [key]: body[key] });
        }
      }
    } else if (url === "/api/mock/devices" && method === "PUT") {
      connected = body.devices;
    } else if ((m = url.match(/^\/api\/radios\/(\d+)\/menu$/))) {
      return menu(Number(m[1]), method === "POST" ? body : null);
    } else {
      throw new Error("Not found");
    }
    return state();
  }

  return {
    name: "sdrpp-mock-backend",
    configureServer(server) {
      restartTimer();
      setInterval(checkNewDevices, 3000);

      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = (req.url ?? "").split("?")[0];
        if (url.startsWith("/res/")) {
          const file = path.join(RES_DIR, decodeURIComponent(url.slice(5)));
          if (!file.startsWith(RES_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const types: Record<string, string> = { ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".ico": "image/x-icon" };
          res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
          fs.createReadStream(file).pipe(res);
          return;
        }
        if (!url.startsWith("/api/")) return next();
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          res.setHeader("Content-Type", "application/json");
          try {
            res.end(JSON.stringify(handle(req.method ?? "GET", url, raw ? JSON.parse(raw) : {})));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });
      });

      const wss = new WebSocketServer({ noServer: true });
      server.httpServer?.on("upgrade", (req, socket, head) => {
        if ((req.url ?? "").split("?")[0] !== "/ws") return; // Vite's own socket
        wss.handleUpgrade(req, socket, head, (ws) => {
          clients.add(ws);
          ws.on("close", () => clients.delete(ws));
          ws.on("message", (data, isBinary) => {
            if (isBinary) return;
            try {
              const msg = JSON.parse(String(data));
              const b = bands.find((x) => x.id === msg.band);
              if (msg.type === "view" && b) {
                b.view = { offset: msg.offset, bandwidth: msg.bandwidth, points: Math.min(Math.max(msg.points | 0, 64), 4096) };
                b.hold = null;
              }
            } catch {
              // Ignore anything that is not a view request
            }
          });
        });
      });
    },
  };
}
