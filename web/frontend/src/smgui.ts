// Draws an SmGui draw list recorded by a source module, the browser side of core/src/gui/smgui.cpp.
// Step numbers and argument layouts follow SmGui::DrawStep and DrawList::draw().

import type { Menu, MenuAction, MenuElement } from "./api";
import { button, checkbox, combo, el, inputInt, inputText, radio, slider, visibleLabel } from "./widgets";

const STEP = {
  FILL_WIDTH: 0x00,
  SAME_LINE: 0x01,
  BEGIN_DISABLED: 0x02,
  END_DISABLED: 0x03,
  COMBO: 0x80,
  BUTTON: 0x81,
  COLUMNS: 0x82,
  NEXT_COLUMN: 0x83,
  RADIO_BUTTON: 0x84,
  BEGIN_GROUP: 0x85,
  END_GROUP: 0x86,
  LEFT_LABEL: 0x87,
  SLIDER_INT: 0x88,
  SLIDER_FLOAT_WITH_STEPS: 0x89,
  INPUT_INT: 0x8a,
  CHECKBOX: 0x8b,
  SLIDER_FLOAT: 0x8c,
  INPUT_TEXT: 0x8d,
  TEXT: 0x8e,
  TEXT_COLORED: 0x8f,
  OPEN_POPUP: 0x90,
  BEGIN_POPUP: 0x91,
  END_POPUP: 0x92,
  BEGIN_TABLE: 0x93,
  END_TABLE: 0x94,
  TABLE_NEXT_ROW: 0x95,
  TABLE_SET_COLUMN_INDEX: 0x96,
  SET_NEXT_ITEM_WIDTH: 0x97,
} as const;

// Number of arguments that follow each step
const ARG_COUNT: Record<number, number> = {
  [STEP.COMBO]: 4,
  [STEP.BUTTON]: 3,
  [STEP.COLUMNS]: 3,
  [STEP.RADIO_BUTTON]: 2,
  [STEP.LEFT_LABEL]: 1,
  [STEP.SLIDER_INT]: 6,
  [STEP.SLIDER_FLOAT_WITH_STEPS]: 6,
  [STEP.INPUT_INT]: 5,
  [STEP.CHECKBOX]: 2,
  [STEP.SLIDER_FLOAT]: 6,
  [STEP.INPUT_TEXT]: 4,
  [STEP.TEXT]: 1,
  [STEP.TEXT_COLORED]: 5,
  [STEP.OPEN_POPUP]: 2,
  [STEP.BEGIN_POPUP]: 2,
  [STEP.BEGIN_TABLE]: 6,
  [STEP.TABLE_NEXT_ROW]: 2,
  [STEP.TABLE_SET_COLUMN_INDEX]: 1,
  [STEP.SET_NEXT_ITEM_WIDTH]: 1,
};

// SmGui::FormatString
function formatValue(format: number, value: number): string {
  switch (format) {
    case 0: return "";
    case 1: return value.toFixed(0);
    case 2: return `${value.toFixed(0)} dB`;
    case 4: return value.toFixed(0);
    case 5: return value.toFixed(1);
    case 6: return value.toFixed(2);
    case 8: return `${value.toFixed(0)} dB`;
    case 9: return `${value.toFixed(1)} dB`;
    case 10: return `${value.toFixed(2)} dB`;
    case 11: return `${value.toFixed(3)} dB`;
    default: return value.toFixed(3);
  }
}

function isStep(e: MenuElement): e is { step: number; sync: boolean } {
  return "step" in e;
}

export function renderMenu(host: HTMLElement, menu: Menu, onAction: (action: MenuAction) => void) {
  host.replaceChildren();
  const elements = menu.elements;
  const arg = (i: number) => (elements[i] as { v: boolean | number | string }).v;

  let fill = false;
  let sameLine = false;
  let disabled = 0;
  let pendingLabel: string | null = null;
  let lastRow: HTMLElement | null = null;

  const place = (widget: HTMLElement) => {
    if (disabled > 0) widget.classList.add("im-disabled");
    if (fill || pendingLabel !== null) widget.classList.add("im-fill");
    if (sameLine && lastRow) {
      lastRow.append(widget);
    } else {
      lastRow = el("div", "im-row");
      if (pendingLabel !== null) lastRow.append(el("span", "im-left-label", pendingLabel));
      lastRow.append(widget);
      host.append(lastRow);
    }
    fill = false;
    sameLine = false;
    pendingLabel = null;
  };

  for (let i = 0; i < elements.length; ) {
    const e = elements[i++];
    if (!isStep(e)) continue;
    const argc = ARG_COUNT[e.step] ?? 0;
    const a = i;
    i += argc;

    switch (e.step) {
      case STEP.FILL_WIDTH:
        fill = true;
        break;
      case STEP.SAME_LINE:
        sameLine = true;
        break;
      case STEP.BEGIN_DISABLED:
        disabled++;
        break;
      case STEP.END_DISABLED:
        disabled = Math.max(0, disabled - 1);
        break;
      case STEP.LEFT_LABEL:
        pendingLabel = String(arg(a));
        break;
      case STEP.COMBO: {
        const id = String(arg(a));
        // Items arrive NUL separated, as ImGui takes them
        const items = String(arg(a + 2)).split("\0").filter((s) => s.length > 0);
        place(combo(items, Number(arg(a + 1)), (index) => onAction({ id, type: "int", value: index })));
        break;
      }
      case STEP.BUTTON: {
        const id = String(arg(a));
        place(button(visibleLabel(id), () => onAction({ id, type: "void" })));
        break;
      }
      case STEP.RADIO_BUTTON: {
        const id = String(arg(a));
        place(radio(visibleLabel(id), Boolean(arg(a + 1)), () => onAction({ id, type: "void" })));
        break;
      }
      case STEP.CHECKBOX: {
        const id = String(arg(a));
        place(checkbox(visibleLabel(id), Boolean(arg(a + 1)), (value) => onAction({ id, type: "bool", value })));
        break;
      }
      case STEP.SLIDER_INT: {
        const id = String(arg(a));
        const format = Number(arg(a + 4));
        place(slider({
          min: Number(arg(a + 2)),
          max: Number(arg(a + 3)),
          value: Number(arg(a + 1)),
          step: 1,
          format: (v) => formatValue(format, v),
          onChange: (value) => onAction({ id, type: "int", value }),
        }));
        break;
      }
      case STEP.SLIDER_FLOAT_WITH_STEPS: {
        const id = String(arg(a));
        const format = Number(arg(a + 5));
        place(slider({
          min: Number(arg(a + 2)),
          max: Number(arg(a + 3)),
          value: Number(arg(a + 1)),
          step: Number(arg(a + 4)),
          format: (v) => formatValue(format, v),
          onChange: (value) => onAction({ id, type: "float", value }),
        }));
        break;
      }
      case STEP.SLIDER_FLOAT: {
        const id = String(arg(a));
        const format = Number(arg(a + 4));
        place(slider({
          min: Number(arg(a + 2)),
          max: Number(arg(a + 3)),
          value: Number(arg(a + 1)),
          format: (v) => formatValue(format, v),
          onChange: (value) => onAction({ id, type: "float", value }),
        }));
        break;
      }
      case STEP.INPUT_INT: {
        const id = String(arg(a));
        place(inputInt(Number(arg(a + 1)), Number(arg(a + 2)) || 1, (value) => onAction({ id, type: "int", value })));
        break;
      }
      case STEP.INPUT_TEXT: {
        const id = String(arg(a));
        place(inputText(String(arg(a + 1)), (value) => onAction({ id, type: "string", value })));
        break;
      }
      case STEP.TEXT:
        place(el("span", "im-text", String(arg(a))));
        break;
      case STEP.TEXT_COLORED: {
        const text = el("span", "im-text", String(arg(a + 4)));
        const c = [0, 1, 2].map((k) => Math.round(Number(arg(a + k)) * 255));
        text.style.color = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Number(arg(a + 3))})`;
        place(text);
        break;
      }
      default:
        // Columns, groups, tables and popups only arrange things; neither radio module uses them
        break;
    }
  }
}
