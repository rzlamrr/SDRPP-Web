// Small set of controls that look and behave like the Dear ImGui widgets SDR++ uses.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ImGui labels hide everything after "##"
export function visibleLabel(label: string): string {
  const pos = label.indexOf("##");
  return pos < 0 ? label : label.slice(0, pos);
}

// Runs an async action with the most recent value only: values arriving while a call is in flight replace each other
export function latest<T>(action: (value: T) => Promise<unknown>): (value: T) => void {
  let busy = false;
  let next: { value: T } | null = null;
  const run = async (value: T) => {
    busy = true;
    try {
      await action(value);
    } catch {
      // The caller reports errors itself
    }
    busy = false;
    if (next) {
      const n = next;
      next = null;
      run(n.value);
    }
  };
  return (value: T) => {
    if (busy) next = { value };
    else run(value);
  };
}

export function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "im-button", text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function checkbox(text: string, value: boolean, onChange: (value: boolean) => void): HTMLLabelElement {
  const root = el("label", "im-checkbox");
  const input = el("input");
  input.type = "checkbox";
  input.checked = value;
  input.addEventListener("change", () => onChange(input.checked));
  root.append(input, el("span", "im-check"), el("span", "im-check-label", text));
  return root;
}

export function radio(text: string, active: boolean, onClick: () => void): HTMLLabelElement {
  const root = el("label", "im-checkbox im-radio");
  const input = el("input");
  input.type = "radio";
  input.checked = active;
  input.addEventListener("click", onClick);
  root.append(input, el("span", "im-check"), el("span", "im-check-label", text));
  return root;
}

export function combo(items: string[], index: number, onChange: (index: number) => void): HTMLSelectElement {
  const select = el("select", "im-combo");
  items.forEach((item, i) => {
    const option = el("option", undefined, item);
    option.value = String(i);
    select.append(option);
  });
  select.selectedIndex = index >= 0 && index < items.length ? index : -1;
  select.addEventListener("change", () => onChange(select.selectedIndex));
  return select;
}

export function inputInt(value: number, step: number, onChange: (value: number) => void): HTMLDivElement {
  const root = el("div", "im-inputint");
  const input = el("input", "im-input");
  input.type = "text";
  input.inputMode = "numeric";
  input.value = String(value);
  const commit = (v: number) => {
    if (!Number.isFinite(v)) {
      input.value = String(value);
      return;
    }
    value = Math.round(v);
    input.value = String(value);
    onChange(value);
  };
  input.addEventListener("change", () => commit(Number(input.value)));
  root.append(input, button("-", () => commit(value - step)), button("+", () => commit(value + step)));
  return root;
}

export function inputText(value: string, onChange: (value: string) => void): HTMLInputElement {
  const input = el("input", "im-input");
  input.type = "text";
  input.value = value;
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

export interface SliderOptions {
  min: number;
  max: number;
  value: number;
  step?: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

// Horizontal slider: a frame with a grab and the value printed in the middle
export function slider(opts: SliderOptions): HTMLDivElement {
  const root = el("div", "im-slider");
  const grab = el("div", "im-grab");
  const text = el("span", "im-slider-value");
  root.append(grab, text);
  let value = opts.value;
  const GRAB = 12;

  const place = () => {
    const span = opts.max - opts.min;
    const t = span === 0 ? 0 : (value - opts.min) / span;
    grab.style.left = `calc(${Math.min(Math.max(t, 0), 1)} * (100% - ${GRAB + 4}px) + 2px)`;
    text.textContent = opts.format(value);
  };
  const fromPointer = (ev: PointerEvent) => {
    const rect = root.getBoundingClientRect();
    const t = Math.min(Math.max((ev.clientX - rect.left - GRAB / 2) / Math.max(rect.width - GRAB, 1), 0), 1);
    let v = opts.min + t * (opts.max - opts.min);
    const step = opts.step ?? 0;
    if (step > 0) v = opts.min + Math.round((v - opts.min) / step) * step;
    v = Math.min(Math.max(v, Math.min(opts.min, opts.max)), Math.max(opts.min, opts.max));
    if (v !== value) {
      value = v;
      place();
      opts.onChange(value);
    }
  };
  root.addEventListener("pointerdown", (ev) => {
    root.setPointerCapture(ev.pointerId);
    fromPointer(ev);
  });
  root.addEventListener("pointermove", (ev) => {
    if (root.hasPointerCapture(ev.pointerId)) fromPointer(ev);
  });
  place();
  return root;
}

export interface VSlider {
  set(value: number): void;
}

// Vertical slider of the waterfall controls. `bottom` and `top` are the values at each end.
export function vslider(host: HTMLElement, bottom: number, top: number, value: number, onChange: (value: number) => void): VSlider {
  host.classList.add("im-vslider");
  const grab = el("div", "im-vgrab");
  host.append(grab);
  const GRAB = 14;

  const place = () => {
    const t = (value - bottom) / (top - bottom);
    grab.style.bottom = `calc(${Math.min(Math.max(t, 0), 1)} * (100% - ${GRAB + 4}px) + 2px)`;
  };
  const fromPointer = (ev: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    const t = Math.min(Math.max((rect.bottom - ev.clientY - GRAB / 2) / Math.max(rect.height - GRAB, 1), 0), 1);
    value = bottom + t * (top - bottom);
    place();
    onChange(value);
  };
  host.addEventListener("pointerdown", (ev) => {
    host.setPointerCapture(ev.pointerId);
    fromPointer(ev);
  });
  host.addEventListener("pointermove", (ev) => {
    if (host.hasPointerCapture(ev.pointerId)) fromPointer(ev);
  });
  place();
  return {
    set(v: number) {
      value = v;
      place();
    },
  };
}

// ImGui::LeftLabel: text on the left, the control fills the rest of the line
export function leftLabel(text: string, control: HTMLElement): HTMLDivElement {
  const row = el("div", "im-row");
  row.append(el("span", "im-left-label", text), control);
  control.classList.add("im-fill");
  return row;
}

export function row(...children: HTMLElement[]): HTMLDivElement {
  const r = el("div", "im-row");
  r.append(...children);
  return r;
}

export interface Section {
  root: HTMLDivElement;
  body: HTMLDivElement;
}

// ImGui::CollapsingHeader. The open state is remembered per browser.
export function collapsingHeader(title: string, defaultOpen = true): Section {
  const key = `sdrpp.menu.${title}`;
  let open = defaultOpen;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) open = saved === "1";
  } catch {
    // Storage can be unavailable, the default is fine
  }
  const root = el("div", "im-section");
  const header = el("div", "im-header");
  const arrow = el("span", "im-arrow");
  header.append(arrow, el("span", undefined, title));
  const body = el("div", "im-section-body");
  const apply = () => {
    arrow.textContent = open ? "▼" : "▶";
    body.hidden = !open;
  };
  header.addEventListener("click", () => {
    open = !open;
    try {
      localStorage.setItem(key, open ? "1" : "0");
    } catch {
      // Not remembered, nothing else to do
    }
    apply();
  });
  apply();
  root.append(header, body);
  return { root, body };
}
