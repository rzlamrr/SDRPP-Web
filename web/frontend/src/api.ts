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
