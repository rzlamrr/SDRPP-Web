// The band wall: every band as a live tile.
//  Grid:  one main band at full width on top, the other bands under it two per row. The main band keeps its
//         size however many bands there are: one screen shows the main band and one row of two, the rest
//         scrolls. A band left alone on the last row takes the full width.
//  Stack: one full-width row per band.

import type { BandState } from "./api";
import { Pane, type PaneCallbacks, type PaneSettings } from "./pane";
import { el } from "./widgets";

export type Layout = "grid" | "stack";
export const LAYOUTS: Layout[] = ["grid", "stack"];

const LAYOUT_KEY = "sentinel.layout";
const MAIN_KEY = "sentinel.mainBand";

// Share of the wall's visible height for the main band; the row of two under it gets the rest
const MAIN_SHARE = 0.6;
const GAP = 8; // Same as the gap in style.css

function storedLayout(): Layout {
  try {
    // "focus" was a third layout before; it is the grid now
    return localStorage.getItem(LAYOUT_KEY) === "stack" ? "stack" : "grid";
  } catch {
    return "grid";
  }
}

function storedMain(): number {
  try {
    const v = Number(localStorage.getItem(MAIN_KEY));
    return Number.isFinite(v) ? v : -1;
  } catch {
    return -1;
  }
}

export interface WallCallbacks extends Omit<PaneCallbacks, "onExpand"> {
  onLayout(layout: Layout): void;
  onAddBand(): void;
  onOpenSettings(): void;
}

export class Wall {
  readonly panes = new Map<number, Pane>();
  layout: Layout = storedLayout();
  // The main band of the grid, -1 for the first band
  private main = storedMain();
  private order: number[] = [];

  constructor(private host: HTMLElement, private settings: PaneSettings, private cb: WallCallbacks) {}

  setLayout(layout: Layout) {
    this.layout = layout;
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // Not remembered
    }
    this.arrange();
    this.cb.onLayout(layout);
  }

  get mainBand() {
    return this.panes.has(this.main) ? this.main : (this.order[0] ?? -1);
  }

  // Makes a band the main one. From the stack this switches to the grid, where the main band is shown.
  setMain(id: number) {
    if (!this.panes.has(id)) return;
    this.main = id;
    try {
      localStorage.setItem(MAIN_KEY, String(id));
    } catch {
      // Not remembered
    }
    if (this.layout === "stack") this.setLayout("grid");
    else this.arrange();
    this.host.scrollTo({ top: 0 });
  }

  // Makes sure a band is easy to see, for an alert that was clicked
  reveal(id: number) {
    if (!this.panes.has(id)) return;
    if (this.layout === "stack") this.panes.get(id)!.root.scrollIntoView({ block: "nearest" });
    else if (this.mainBand !== id) this.setMain(id);
    else this.host.scrollTo({ top: 0 });
  }

  sync(bands: BandState[], radiosOnline: boolean, running: boolean) {
    const ids = new Set(bands.map((b) => b.id));
    for (const [id, pane] of this.panes) {
      if (!ids.has(id)) {
        pane.root.remove();
        this.panes.delete(id);
      }
    }
    for (const band of bands) {
      let pane = this.panes.get(band.id);
      if (!pane) {
        pane = new Pane(band, this.settings, { ...this.cb, onExpand: (id) => this.setMain(id) });
        this.panes.set(band.id, pane);
      } else {
        pane.setBand(band);
      }
    }
    this.order = bands.map((b) => b.id);
    this.arrange(bands.length === 0 ? { radiosOnline, running } : undefined);
  }

  private arrange(empty?: { radiosOnline: boolean; running: boolean }) {
    const host = this.host;
    const n = this.order.length;
    host.classList.toggle("empty", n === 0);
    if (n === 0) {
      host.style.gridTemplateColumns = "";
      host.style.gridTemplateRows = "";
      host.style.gridAutoRows = "";
      host.replaceChildren(this.emptyCard(empty ?? { radiosOnline: true, running: false }));
      return;
    }
    if (host.querySelector(".empty-card")) host.replaceChildren();

    const grid = this.layout === "grid";
    const main = this.mainBand;
    // Main band first, then the others in band order
    const visual = grid ? [main, ...this.order.filter((id) => id !== main)] : this.order;
    const others = visual.length - 1;
    visual.forEach((id, i) => {
      const pane = this.panes.get(id)!;
      pane.setBig(grid && id === main && n > 1);
      // Full width: the main band, and in the grid a band left alone on the last row
      const full = !grid || i === 0 || (others % 2 === 1 && i === visual.length - 1);
      pane.root.style.gridColumn = full ? "1 / -1" : "";
      host.append(pane.root);
    });

    host.style.overflowY = "auto";
    if (!grid) {
      host.style.gridTemplateColumns = "minmax(0, 1fr)";
      // Rows share the height, but each keeps enough room to be readable; the wall scrolls past that
      host.style.gridTemplateRows = `repeat(${n}, minmax(150px, 1fr))`;
      host.style.gridAutoRows = "";
      return;
    }

    host.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
    if (n === 1) {
      host.style.gridTemplateRows = "minmax(0, 1fr)";
      host.style.gridAutoRows = "";
      return;
    }
    // Sized from the visible height, so more bands add rows below instead of shrinking the main band
    host.style.gridTemplateRows = `max(calc((100% - ${GAP}px) * ${MAIN_SHARE}), 240px)`;
    host.style.gridAutoRows = `max(calc((100% - ${GAP}px) * ${1 - MAIN_SHARE}), 150px)`;
  }

  // First run: what to do before anything can be shown
  private emptyCard(s: { radiosOnline: boolean; running: boolean }): HTMLElement {
    const card = el("div", "empty-card");
    card.append(el("h2", undefined, "Set up your first band"), el("div", "muted", "RF Sentinel watches each band you add and flags anything that rises above its normal spectrum."));
    const steps = el("ol");
    const step = (text: string, done: boolean) => steps.append(el("li", done ? "done" : undefined, text));
    step(s.radiosOnline ? "Radio connected" : "Connect a radio (it's picked up automatically)", s.radiosOnline);
    step("Add the bands to watch", false);
    step("Press Start, then let each band learn its baseline", false);
    const add = el("button", "btn primary", "Add band");
    add.type = "button";
    add.addEventListener("click", () => this.cb.onAddBand());
    const settings = el("button", "btn", "Open settings");
    settings.type = "button";
    settings.style.marginLeft = "8px";
    settings.addEventListener("click", () => this.cb.onOpenSettings());
    card.append(steps, add, settings);
    return card;
  }
}
