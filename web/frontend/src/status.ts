// Health of a band and severity of an event, worked out in the browser from what the API already reports.

import type { BandState, DetectorBand, InterferenceEvent, InterferenceSettings, RadioState } from "./api";

export type BandStatus = "clear" | "learning" | "warning" | "interference" | "offline" | "idle";
export type Severity = "high" | "med" | "low";

export const STATUS: Record<BandStatus, { label: string; color: string }> = {
  clear: { label: "Clear", color: "var(--ok)" },
  learning: { label: "Learning", color: "var(--learn)" },
  warning: { label: "Warning", color: "var(--warn)" },
  interference: { label: "Interference", color: "var(--bad)" },
  offline: { label: "No radio", color: "var(--muted)" },
  idle: { label: "Stopped", color: "var(--muted)" },
};

export const SEVERITY: Record<Severity, { label: string; rank: number; color: string }> = {
  high: { label: "High", rank: 3, color: "#e5484d" },
  med: { label: "Med", rank: 2, color: "#f5a524" },
  low: { label: "Low", rank: 1, color: "#8b95a7" },
};

// An event that ended this recently still marks its band as a warning
const RECENT_MS = 5 * 60 * 1000;

export function severity(e: InterferenceEvent, s: InterferenceSettings): Severity {
  if (e.type === "noise") return e.excess >= s.noiseRiseDb ? "high" : "med";
  if (e.excess >= s.thresholdDb + 10) return "high";
  if (e.excess >= s.thresholdDb + 4) return "med";
  return "low";
}

export interface BandHealth {
  status: BandStatus;
  active: InterferenceEvent[];
  detector: DetectorBand | undefined;
  delta: number | null; // Noise floor minus its baseline, dB
}

export function bandHealth(
  band: BandState,
  radios: RadioState[],
  running: boolean,
  detector: DetectorBand | undefined,
  active: InterferenceEvent[],
  history: InterferenceEvent[],
  settings: InterferenceSettings | undefined,
  now = Date.now(),
): BandHealth {
  const mine = active.filter((e) => e.band === band.id);
  const delta = detector && !detector.learning ? detector.noiseFloor - detector.baselineFloor : null;
  const radio = radios.find((r) => r.id === band.radio);
  let status: BandStatus;
  if (!radio || !radio.online) status = "offline";
  else if (!running) status = "idle";
  else if (mine.length > 0) status = "interference";
  else if (detector?.learning && settings?.enabled) status = "learning";
  else if (
    (delta !== null && settings && delta > settings.noiseRiseDb / 2) ||
    history.some((e) => e.band === band.id && now - (e.end || e.last) < RECENT_MS)
  )
    status = "warning";
  else status = "clear";
  return { status, active: mine, detector, delta };
}

// Most severe first, then the longest running
export function sortEvents(events: InterferenceEvent[], s: InterferenceSettings): InterferenceEvent[] {
  return [...events].sort((a, b) => SEVERITY[severity(b, s)].rank - SEVERITY[severity(a, s)].rank || b.duration - a.duration);
}
