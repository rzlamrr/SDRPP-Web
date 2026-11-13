// Interference event types and how their figures are printed.

import type { InterferenceEvent, InterferenceType } from "./api";
import { printAndScale } from "./pane";

export const TYPES: Record<InterferenceType, { label: string; short: string; color: string; hint: string }> = {
  narrowband: { label: "Narrowband", short: "NB", color: "#ff5a5a", hint: "Narrow carrier (CW, oscillator, spurious)" },
  wideband: { label: "Wideband", short: "WB", color: "#ff9a2e", hint: "Wide occupied block" },
  swept: { label: "Swept", short: "SW", color: "#c77dff", hint: "Frequency moves over time (sweep / chirp)" },
  pulsed: { label: "Pulsed", short: "PL", color: "#ffd23f", hint: "Comes and goes repeatedly (pulse / burst)" },
  noise: { label: "Noise rise", short: "NF", color: "#ff3d7f", hint: "Noise floor of the whole band raised" },
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

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

// The parameter that tells this type apart, shown after the common ones
export function detail(e: InterferenceEvent): string {
  if (e.type === "noise") return `floor +${e.excess.toFixed(1)} dB`;
  if (e.type === "swept") return `${hz(e.minCenter)}..${hz(e.maxCenter)}, ${(e.drift / 1e3).toFixed(1)} kHz/s`;
  if (e.type === "pulsed") return `duty ${e.duty.toFixed(0)}%${e.period > 0 ? `, every ${e.period.toFixed(0)} ms` : ""}`;
  return `SNR ${e.snr.toFixed(1)} dB`;
}

export function tooltip(e: InterferenceEvent, bandName: string): string {
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
