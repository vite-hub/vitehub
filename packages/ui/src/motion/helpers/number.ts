import { writeMotionStyle } from "../registry.ts";
import { frameOf, glyphNode, motionSkipped, openFrame, own, reduced, setText } from "./frame.ts";
import type { GlyphFrame } from "./frame.ts";
import { cubicBezier, easeIn, easeOut, tween } from "./tween.ts";
import type { Tween } from "./tween.ts";

/** One column of a number, counted from the right, so the units of the old and new number line up. */
export interface DigitColumn {
  /** The index from the right: 0 is the last character. */
  index: number;
  from: string;
  to: string;
}

/**
 * The columns of a number change, right-aligned. A column that only the new text has comes in from an empty `from`, and
 * a column that only the old text has leaves to an empty `to`. Columns that keep their character are not listed.
 */
export function diffDigits(from: string, to: string): DigitColumn[] {
  const a = [...from].reverse();
  const b = [...to].reverse();
  const changed: DigitColumn[] = [];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const before = a[index] ?? "";
    const after = b[index] ?? "";
    if (before !== after) changed.push({ index, from: before, to: after });
  }
  return changed;
}

// The numbers of the prototype's count: the old digit leaves 1em (12px on 12px text) toward where the count goes, at
// 0.55 of its size with a 2px blur, in 240ms. The new one comes from the other side in 380ms, 60ms later, on an
// overshoot curve. Under reduced motion the changed digits crossfade in 150ms.
const travel = 1;
const small = 0.55;
const blur = 2;
const out = { duration: 240, ease: easeIn };
const into = { duration: 380, delay: 60, ease: cubicBezier(0.3, 1.4, 0.5, 1) };
const crossfade = 150;

interface Glyph {
  node: HTMLSpanElement;
  fade?: Tween;
  /** 1 when it shows, 0 when it is gone. */
  shown: number;
}

interface Column {
  node: HTMLSpanElement;
  char: string;
  current?: Glyph;
  leaving: Set<Glyph>;
}

interface Roll {
  frame: GlyphFrame;
  text: string;
  value: number;
  columns: Column[];
}

const rolls = new WeakMap<HTMLElement, Roll>();
const values = new WeakMap<HTMLElement, number>();

function glyph(char: string): Glyph {
  const node = glyphNode(char);
  node.style.gridArea = "1 / 1";
  return { node, shown: 1 };
}

function column(char: string): Column {
  const node = own(document.createElement("span"));
  // One cell: the old and the new digit share it, and it clips them as the prototype's odometer does.
  node.style.cssText = "display:inline-grid;overflow:hidden;justify-items:center";
  const current = char ? glyph(char) : undefined;
  if (current) node.append(current.node);
  return { node, char, current, leaving: new Set() };
}

function paint(item: Glyph, value: number, direction: number, reducedMotion: boolean): void {
  item.shown = value;
  const gone = 1 - value;
  writeMotionStyle(item.node, {
    opacity: value >= 1 ? null : String(Math.max(0, value)),
    filter: reducedMotion || value >= 1 ? null : `blur(${Math.max(0, blur * gone).toFixed(2)}px)`,
    scale: reducedMotion || value === 1 ? null : String(1 - (1 - small) * gone),
    translate: reducedMotion || value === 1 ? null : `0 ${(direction * travel * gone).toFixed(3)}em`,
  });
}

function idle(roll: Roll): boolean {
  return !roll.frame.width.active && roll.columns.every(item => !item.leaving.size && !item.current?.fade);
}

function finishIfIdle(element: HTMLElement, roll: Roll): void {
  if (rolls.get(element) !== roll || !idle(roll)) return;
  rolls.delete(element);
  roll.frame.collapse(roll.text);
}

/**
 * Rolls the number in `element` to `value`, as rule 6 of docs/design/motion.md asks: only the digits that change roll,
 * up when the number grows and down when it shrinks. The width of the element follows with a spring. `format` turns the
 * number into its text, such as `n => n.toLocaleString()`. The default is `String`.
 *
 * Call it again at any time: a digit that is still rolling in rolls out from where it is. The element keeps the final
 * text for screen readers, and holds plain text again when the roll ends. Under reduced motion the changed digits
 * crossfade in 150ms. Inside `data-motion="none"`, or before the element is on the page, it sets the text at once.
 */
export function rollNumber(element: HTMLElement, value: number, format: (value: number) => string = String): void {
  const text = format(value);
  let roll = rolls.get(element);
  const before = roll?.text ?? element.textContent ?? "";
  const previous = roll?.value ?? values.get(element) ?? parseCount(before);
  values.set(element, value);
  if (motionSkipped(element) || previous === undefined || (!roll && before === text)) {
    if (roll) {
      for (const item of roll.columns) for (const g of [item.current, ...item.leaving]) g?.fade?.stop();
      rolls.delete(element);
    }
    setText(element, text);
    return;
  }
  const direction = value > previous ? 1 : value < previous ? -1 : 0;
  const reducedMotion = reduced();
  if (!roll) {
    const frame = frameOf(element) ?? openFrame(element, "end", () => {
      const running = rolls.get(element);
      if (running) finishIfIdle(element, running);
    });
    const columns = [...before].map(column);
    frame.holder.append(...columns.map(item => item.node));
    frame.width.set(frame.natural());
    roll = { frame, text: before, value: previous, columns };
    rolls.set(element, roll);
  }
  const state = roll;
  state.frame.restore();
  state.text = text;
  state.value = value;
  state.frame.name(text);

  const chars = [...text];
  const count = Math.max(chars.length, state.columns.length);
  // Columns are right-aligned: pad the left with empty columns, so the units of both numbers share a column.
  while (state.columns.length < count) {
    const added = column("");
    state.frame.holder.prepend(added.node);
    state.columns.unshift(added);
  }
  const offset = count - chars.length;
  state.columns.forEach((item, index) => {
    const next = chars[index - offset] ?? "";
    if (next === item.char) return;
    item.char = next;
    const old = item.current;
    if (old) {
      old.fade?.stop();
      item.leaving.add(old);
      old.fade = tween(old.shown, 0, reducedMotion ? { duration: crossfade, ease: easeOut } : out, v => paint(old, v, -direction, reducedMotion), () => {
        old.fade = undefined;
        old.node.remove();
        item.leaving.delete(old);
        settleColumns(element, state);
      });
    }
    item.current = undefined;
    if (!next) return;
    const incoming = glyph(next);
    item.current = incoming;
    item.node.append(incoming.node);
    paint(incoming, 0, direction, reducedMotion);
    incoming.fade = tween(0, 1, reducedMotion ? { duration: crossfade, ease: easeOut } : into, v => paint(incoming, v, direction, reducedMotion), () => {
      incoming.fade = undefined;
      paint(incoming, 1, direction, reducedMotion);
      settleColumns(element, state);
    });
  });
  // The width goes to the width of the new number. A column that leaves stays in the flow until its digit is gone,
  // and the letters sit at the end of the element, so nothing jumps.
  const width = state.frame.width;
  const leavingColumns = state.columns.filter(item => !item.char);
  for (const item of leavingColumns) item.node.style.display = "none";
  const end = state.frame.natural();
  for (const item of leavingColumns) item.node.style.display = "inline-grid";
  if (reducedMotion) width.set(end);
  else width.to(end);
}

/** The number in a text such as "1,204" or "12%", for the first roll of an element that the server rendered. */
function parseCount(text: string): number | undefined {
  const digits = text.replace(/[^\d.-]/g, "");
  const value = digits ? Number(digits) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function settleColumns(element: HTMLElement, roll: Roll): void {
  if (rolls.get(element) !== roll) return;
  roll.columns = roll.columns.filter((item) => {
    if (item.char || item.leaving.size) return true;
    item.node.remove();
    return false;
  });
  finishIfIdle(element, roll);
}
