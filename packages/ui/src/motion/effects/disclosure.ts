import { isMotionOff } from "../layer.ts";
import { prefersReducedMotion } from "../reduced-motion.ts";
import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring, springs } from "../spring.ts";
import type { Spring } from "../spring.ts";

// A disclosure opens or closes: a native `<details>`, or a trigger with `aria-expanded`, such as an accordion item or
// a folded group of a sidebar. The stylesheet turns its chevron for each state, and the chevron carries the change: it
// turns from the old angle to the new one on `snappy`, as an indicator moves. The section itself opens at once,
// because the person reads it.

// The icons of the trigger that may turn. Only an icon whose angle differs between the two states moves.
const iconSelector = "[data-motion-chevron], svg, .iconify, [data-slot=icon], [data-slot$=Icon]";

// The spring counts in quarter turns, so it settles at the same precision as a spring from 0 to 1.
const quarter = 90;

interface Turn {
  /** The angle of the icon, in quarter turns. */
  spring: Spring;
  /** The angle of the icon's own `transform` in the current state. The layer writes `rotate` on top of it. */
  base: number;
}

const turns = new WeakMap<Element, Turn>();
const pending = new WeakMap<HTMLElement, Map<Element, number>>();

/** The element that holds the chevron: the `<summary>` of a `<details>`, or the trigger itself. */
function triggerOf(element: HTMLElement): HTMLElement | null {
  return element instanceof HTMLDetailsElement ? element.querySelector<HTMLElement>(":scope > summary") : element;
}

function degrees(value: string): number {
  if (!value || value === "none") return 0;
  // `rotate` computes to an angle, or to an axis and an angle, such as "90deg" or "0 0 1 90deg".
  const angle = value.trim().split(/\s+/).at(-1)!;
  const number = Number.parseFloat(angle);
  if (angle.endsWith("turn")) return number * 360;
  if (angle.endsWith("rad")) return number * 180 / Math.PI;
  return Number.isFinite(number) ? number : 0;
}

/** The angle of a 2D transform matrix, such as "matrix(0, -1, 1, 0, 0, 0)" for -90deg. */
function matrixDegrees(value: string): number {
  const match = /^matrix\(([^)]+)\)$/.exec(value);
  if (!match) return 0;
  const [a = 1, b = 0] = match[1]!.split(",").map(Number);
  return Math.atan2(b, a) * 180 / Math.PI;
}

/** The angle that the stylesheet draws the icon at now, without what the effect wrote, split into its two sources. */
function measure(icon: HTMLElement | SVGElement): { total: number; base: number } {
  const written = icon.style.getPropertyValue("rotate");
  if (written) icon.style.removeProperty("rotate");
  const style = getComputedStyle(icon);
  const base = matrixDegrees(style.transform);
  const total = base + degrees(style.rotate);
  if (written) icon.style.setProperty("rotate", written);
  return { total, base };
}

/**
 * True when the icon still turns with a CSS transition of its own, as Nuxt UI's accordion chevron does. The transition
 * would smear each frame of the spring, so that icon keeps its own motion.
 */
function transitionsTurn(icon: Element): boolean {
  const style = getComputedStyle(icon);
  const durations = style.transitionDuration.split(",");
  return style.transitionProperty.split(",").some((property, index) =>
    /^\s*(?:transform|rotate|all)\s*$/.test(property) && Number.parseFloat(durations[index % durations.length]!) > 0);
}

function icons(trigger: HTMLElement): Array<HTMLElement | SVGElement> {
  return [...trigger.querySelectorAll<HTMLElement | SVGElement>(iconSelector)].filter(icon => !icon.parentElement?.closest(iconSelector) || icon.matches("[data-motion-chevron]"));
}

function turnOf(icon: HTMLElement | SVGElement): Turn {
  const turn = turns.get(icon);
  if (turn) return turn;
  const current: Turn = {
    base: 0,
    spring: createSpring(0, (value, velocity) => {
      if (isMotionOff(icon)) {
        current.spring.stop();
        writeMotionStyle(icon, { rotate: null });
        return;
      }
      const settled = velocity === 0 && value === current.spring.target;
      writeMotionStyle(icon, { rotate: settled ? null : `${(value * quarter - current.base).toFixed(2)}deg` });
    }, springs.snappy),
  };
  turns.set(icon, current);
  return current;
}

export const disclosure: MotionEffect = {
  name: "disclosure",
  selector: "details, summary, [aria-expanded]",
  // The press comes before the change, so it reads where the chevron is in the state that the person leaves.
  press(element) {
    // A press in the content of an open `<details>` does not change it.
    const owner = element.tagName === "SUMMARY" ? element.parentElement : element.matches("[aria-expanded]") ? element : null;
    if (!owner || !(owner instanceof HTMLDetailsElement || owner.matches("[aria-expanded]"))) return;
    const trigger = triggerOf(owner);
    if (!trigger) return;
    const angles = new Map<Element, number>();
    for (const icon of icons(trigger)) {
      if (isMotionOff(icon) || transitionsTurn(icon)) continue;
      const spring = turns.get(icon)?.spring;
      angles.set(icon, spring?.active ? spring.target * quarter : measure(icon).total);
    }
    if (!angles.size) return;
    pending.set(owner, angles);
    return {
      release() {
        setTimeout(() => {
          if (pending.get(owner) === angles) pending.delete(owner);
        });
      },
    };
  },
  state(element, { attribute }) {
    if (attribute !== (element instanceof HTMLDetailsElement ? "open" : "aria-expanded")) return;
    const angles = pending.get(element);
    pending.delete(element);
    const trigger = triggerOf(element);
    if (!trigger) return;
    for (const icon of icons(trigger)) {
      const previous = turns.get(icon);
      const sampled = angles?.get(icon);
      if (isMotionOff(icon) || sampled === undefined || prefersReducedMotion() || transitionsTurn(icon)) {
        if (previous?.spring.active) {
          previous.spring.stop();
          writeMotionStyle(icon, { rotate: null });
        }
        continue;
      }
      const turn = turnOf(icon);
      const from = turn.spring.active ? turn.spring.value * quarter : sampled;
      const { total, base } = measure(icon);
      turn.base = base;
      if (Math.abs(total - from) < 0.5) {
        if (turn.spring.active) turn.spring.set(total / quarter);
        continue;
      }
      if (!turn.spring.active) turn.spring.set(from / quarter);
      turn.spring.to(total / quarter);
      if (turn.spring.active) writeMotionStyle(icon, { rotate: `${(turn.spring.value * quarter - base).toFixed(2)}deg` });
    }
  },
};
