// The large per-digit frequency selector of the SDR++ top bar (gui/widgets/frequency_select.cpp).
// Click the upper half of a digit to raise it, the lower half to lower it, or scroll over it.

import { el } from "./widgets";

const DIGITS = 12;
const MAX_FREQ = 999_999_999_999;

export class FreqSelect {
  private digits: HTMLSpanElement[] = [];
  private frequency = 0;
  onChange: (frequency: number) => void = () => {};

  constructor(host: HTMLElement) {
    host.classList.add("freq-select");
    for (let i = 0; i < DIGITS; i++) {
      const power = DIGITS - 1 - i;
      const digit = el("span", "freq-digit", "0");
      const up = el("span", "freq-half freq-up");
      const down = el("span", "freq-half freq-down");
      digit.append(up, down);
      up.addEventListener("click", () => this.step(power, 1));
      down.addEventListener("click", () => this.step(power, -1));
      digit.addEventListener(
        "wheel",
        (ev) => {
          ev.preventDefault();
          this.step(power, ev.deltaY < 0 ? 1 : -1);
        },
        { passive: false },
      );
      host.append(digit);
      this.digits.push(digit);
      if (power % 3 === 0 && power !== 0) host.append(el("span", "freq-dot", "."));
    }
    this.render();
  }

  private step(power: number, direction: number) {
    const next = Math.min(Math.max(this.frequency + direction * 10 ** power, 0), MAX_FREQ);
    if (next === this.frequency) return;
    this.frequency = next;
    this.render();
    this.onChange(next);
  }

  set(frequency: number) {
    const f = Math.min(Math.max(Math.round(frequency), 0), MAX_FREQ);
    if (f === this.frequency) return;
    this.frequency = f;
    this.render();
  }

  private render() {
    const text = String(this.frequency).padStart(DIGITS, "0");
    let leading = true;
    this.digits.forEach((digit, i) => {
      if (text[i] !== "0") leading = false;
      // The first child is the text node, the halves follow it
      digit.firstChild!.nodeValue = text[i];
      digit.classList.toggle("dim", leading && i < DIGITS - 1);
    });
    // Separators are dimmed along with the zeros before them
    let node = this.digits[0].nextElementSibling;
    for (let i = 0; i < DIGITS && node; node = node.nextElementSibling) {
      if (node.classList.contains("freq-dot")) node.classList.toggle("dim", this.digits[i].classList.contains("dim"));
      else i++;
    }
  }
}
