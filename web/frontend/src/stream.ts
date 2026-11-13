// FFT frames from the WebSocket. Layout is defined in web/src/band.h.

export interface FftFrame {
  bandId: number;
  centerFreq: number;
  bandwidth: number;
  viewOffset: number;
  viewBandwidth: number;
  snr: number;
  // dB values, one per horizontal pixel of the view
  fft: Float32Array;
  hold: Float32Array | null;
}

const MAGIC = 0x31465053; // "SPF1"
const HEADER_SIZE = 56;
const FLAG_HOLD = 1;

function decode(buf: ArrayBuffer): FftFrame | null {
  if (buf.byteLength < HEADER_SIZE) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) return null;
  const count = dv.getUint32(40, true);
  const flags = dv.getUint32(44, true);
  const hasHold = (flags & FLAG_HOLD) !== 0;
  if (buf.byteLength < HEADER_SIZE + count * 2 * (hasHold ? 2 : 1)) return null;

  const toDb = (offset: number) => {
    const raw = new Int16Array(buf, offset, count);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = raw[i] / 100;
    return out;
  };

  return {
    bandId: dv.getInt32(4, true),
    centerFreq: dv.getFloat64(8, true),
    bandwidth: dv.getFloat64(16, true),
    viewOffset: dv.getFloat64(24, true),
    viewBandwidth: dv.getFloat64(32, true),
    snr: dv.getFloat32(48, true),
    fft: toDb(HEADER_SIZE),
    hold: hasHold ? toDb(HEADER_SIZE + count * 2) : null,
  };
}

export class Stream {
  private ws: WebSocket | null = null;
  private pending: string[] = [];
  onFrame: (frame: FftFrame) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};

  connect() {
    const url = new URL("ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.onStatus(true);
      for (const msg of this.pending) ws.send(msg);
      this.pending = [];
    };
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const frame = decode(ev.data);
      if (frame) this.onFrame(frame);
    };
    ws.onclose = () => {
      this.onStatus(false);
      this.ws = null;
      setTimeout(() => this.connect(), 1000);
    };
    this.ws = ws;
  }

  // Tell the server which part of a band to send and at what horizontal resolution
  setView(band: number, offset: number, bandwidth: number, points: number) {
    const msg = JSON.stringify({ type: "view", band, offset, bandwidth, points });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else this.pending.push(msg);
  }
}
