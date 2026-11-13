// REST API of `sdrpp --web` (web/src/http_server.cpp)

export interface BandState {
  id: number;
  name: string;
  frequency: number;
  radio: number; // Radio that receives the band
  radioSetting: number; // Radio the band is tied to, -1 when the monitor picks
  sampleRate: number;
}

export interface RadioState {
  id: number;
  name: string;
  sampleRate: number;
  bands: number[];
  receiving: boolean;
  device: string; // Device the radio uses, empty when none is connected for it
  online: boolean;
}

export interface Display {
  fftSize: number;
  fftRate: number;
  fftWindow: number;
  showWaterfall: boolean;
  fftHold: boolean;
  fftHoldSpeed: number;
  fftSmoothing: boolean;
  fftSmoothingSpeed: number;
  fftMode: "line" | "persistence"; // Persistence draws how often each level occurs instead of one line
  persistenceSpeed: number; // How fast the persistence fades, 1 to 100
  colorMap: string;
  theme: string;
  min: number;
  max: number;
}

export interface NamedFile {
  name: string;
  file: string;
}

export interface State {
  running: boolean;
  sourceType: string;
  sourceTypes: { id: string; name: string }[];
  radioCount: number;
  dwellMs: number;
  settleMs: number;
  bands: BandState[];
  radios: RadioState[];
  error: string;
  notices: { id: number; text: string }[]; // Latest messages for the operator, in order
  display: Display;
  fftSizes: number[];
  colorMaps: NamedFile[];
  themes: NamedFile[];
}

// One element of an SmGui draw list: either a draw step or one of its arguments
export type MenuElement = { step: number; sync: boolean } | { v: boolean | number | string };

export interface Menu {
  radio: number;
  name: string;
  running: boolean;
  elements: MenuElement[];
}

export interface MenuAction {
  id: string;
  type: "void" | "bool" | "int" | "float" | "string";
  value?: boolean | number | string;
}

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const getState = () => request<State>("api/state");
export const start = () => request<State>("api/start", "POST");
export const stop = () => request<State>("api/stop", "POST");
export const setSetup = (setup: Partial<Pick<State, "sourceType" | "radioCount" | "dwellMs" | "settleMs">>) =>
  request<State>("api/setup", "PUT", setup);
export const setDisplay = (display: Partial<Display>) => request<State>("api/display", "PUT", display);
export const addBand = (band: { name?: string; frequency: number }) => request<State>("api/bands", "POST", band);
export const updateBand = (id: number, band: { name?: string; frequency?: number; radioSetting?: number }) =>
  request<State>(`api/bands/${id}`, "PUT", band);
export const removeBand = (id: number) => request<State>(`api/bands/${id}`, "DELETE");
export const getMenu = (radio: number) => request<Menu>(`api/radios/${radio}/menu`);
export const menuAction = (radio: number, action: MenuAction) =>
  request<Menu>(`api/radios/${radio}/menu`, "POST", action);
export const getJson = <T>(url: string) => request<T>(url);

// --- interference detection (web/src/detector.h) ---

export type InterferenceType = "narrowband" | "wideband" | "swept" | "pulsed" | "noise";

export interface InterferenceEvent {
  id: number;
  band: number;
  type: InterferenceType;
  active: boolean;
  start: number; // ms since the epoch
  last: number;
  end: number; // 0 while active
  duration: number; // s
  center: number; // Hz, latest power weighted center
  low: number; // Hz, latest occupied range
  high: number;
  minCenter: number;
  maxCenter: number;
  bandwidth: number; // Hz, widest occupied bandwidth seen
  peak: number | null; // dB
  excess: number; // dB over the baseline, for "noise" the rise of the noise floor
  snr: number; // dB over the noise floor
  duty: number; // % of the received lines in which it was present
  drift: number; // Hz/s
  period: number; // ms between appearances, 0 if it did not repeat
  appearances: number;
}

export interface InterferenceSettings {
  enabled: boolean;
  thresholdDb: number;
  noiseRiseDb: number;
  learnSeconds: number;
  adaptMinutes: number;
}

export interface DetectorBand {
  id: number;
  enabled: boolean;
  learning: boolean;
  learnProgress: number; // 0 to 1
  noiseFloor: number; // dB
  baselineFloor: number; // dB
  active: number;
}

export interface Interference {
  settings: InterferenceSettings;
  logFile: string;
  bands: DetectorBand[];
  active: InterferenceEvent[];
  history: InterferenceEvent[]; // Ended events, newest first
}

export const getInterference = () => request<Interference>("api/interference");
export const setInterference = (settings: Partial<InterferenceSettings>) => request<Interference>("api/interference", "PUT", settings);
export const relearn = (band?: number) => request<Interference>("api/interference/learn", "POST", band === undefined ? {} : { band });
export const clearHistory = () => request<Interference>("api/interference/history", "DELETE");
