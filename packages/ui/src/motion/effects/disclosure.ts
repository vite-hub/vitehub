import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring, springs } from "../spring.ts";
import type { Spring } from "../spring.ts";

/*
 * Show or hide content (docs/design/motion.md): the chevron of a disclosure turns with a spring, and the content opens at
 * once, because the person reads it.
 *
 * A disclosure is a `<details>` with its `<summary>`, or a control with `aria-expanded`, such as an accordion item or a
 * folded group of a sidebar. Its stylesheet turns the chevron for each state, such as `group-open:rotate-90` or
 * `[aria-expanded=true] svg { transform: rotate(90deg) }`, with no transition. The effect reads the angle of each icon
 * in the trigger when the person presses it, and when the state changes it turns each icon whose angle changed from the
 * old angle to the new one. A change that no press started, such as one from code or on the first load, happens at once.
 */

const triggerSelector = "summary, [aria-expanded]";
// The icons of the trigger that may turn. Only an icon whose angle differs between the two states moves, so an icon in a
// wrapper turns once: the stylesheet turns either the wrapper or the icon. `data-motion-chevron` marks another element.
const iconSelector = "[data-motion-chevron], svg, img, .iconify, [data-slot=icon], [data-slot$=Icon]";

interface Turn {
  spring: Spring;
  /** The angle of the `transform` of the stylesheet. The effect writes `rotate`, which adds to it. */
  transform: number;
}

// The angle of each icon when the person pressed its trigger.
const pressed = new WeakMap<Element, number>();
const turns = new WeakMap<Element, Turn>();
// The spring counts in quarter turns, so it settles when the chevron is still to the eye, as a spring from 0 to 1 does.
const quarter = 90;

function degrees(value: string): number {
  const number = Number.parseFloat(value);
  if (value.endsWith("turn")) return number * 360;
  if (value.endsWith("grad")) return number * 0.9;
  if (value.endsWith("rad")) return number * 180 / Math.PI;
  return number || 0;
}

/** The angle of the CSS `rotate` property. A turn around another axis than z counts as 0. */
function rotateAngle(value: string): number {
  if (value === "none") return 0;
  const parts = value.trim().split(/\s+/);
  const angle = parts.pop()!;
  if (parts.length === 1 && parts[0] !== "z") return 0;
  if (parts.length === 3 && (Number(parts[0]) !== 0 || Number(parts[1]) !== 0)) return 0;
  return degrees(angle);
}

/** The angle of a computed `transform` matrix, in degrees. */
function transformAngle(value: string): number {
  const values = /^matrix(?:3d)?\(([^)]+)\)$/.exec(value)?.[1]?.split(",").map(Number);
  return values ? Math.atan2(values[1]!, values[0]!) * 180 / Math.PI : 0;
}

/** The angle that a person sees, and the part of it that comes from `transform`. */
function angles(icon: Element): { visual: number; transform: number } {
  const style = getComputedStyle(icon);
  const transform = transformAngle(style.transform);
  return { visual: transform + rotateAngle(style.rotate), transform };
}

/**
 * True when the icon still turns with a CSS transition of its own, such as Tailwind's `transition-transform` or Nuxt
 * UI's accordion chevron. The transition would smear each frame of the spring, so the effect leaves it alone, as the
 * press leaves a control that transitions `scale`.
 */
function transitionsRotate(icon: Element): boolean {
  const style = getComputedStyle(icon);
  const durations = style.transitionDuration.split(",");
  return style.transitionProperty.split(",").some((property, index) =>
    /^\s*(?:rotate|transform|all)\s*$/.test(property) && Number.parseFloat(durations[index % durations.length]!) > 0);
}

function iconsOf(trigger: Element): Array<HTMLElement | SVGElement> {
  return [...trigger.querySelectorAll<HTMLElement | SVGElement>(iconSelector)];
}

function rotateFor(turn: Turn): string {
  return `${(turn.spring.value * quarter - turn.transform).toFixed(2)}deg`;
}

function turn(icon: HTMLElement | SVGElement, from: number): void {
  let state = turns.get(icon);
  if (state?.spring.active) from = state.spring.value * quarter;
  // The angle of the new state, without what the effect wrote.
  writeMotionStyle(icon, { rotate: null });
  const rest = angles(icon);
  if (Math.abs(rest.visual - from) < 0.5 && !state?.spring.active) return;
  if (!state) {
    const current: Turn = {
      transform: rest.transform,
      spring: createSpring(from / quarter, (value, velocity) => {
        const settled = velocity === 0 && value === current.spring.target;
        writeMotionStyle(icon, { rotate: settled ? null : rotateFor(current) });
      }, springs.snappy),
    };
    state = current;
    turns.set(icon, state);
  }
  state.transform = rest.transform;
  // A spring that still turns keeps its speed toward the new angle, so a fast second click never jumps.
  if (!state.spring.active) state.spring.set(from / quarter);
  state.spring.to(rest.visual / quarter);
  // The first frame of the spring comes with the next paint. Until then the icon keeps its old angle.
  if (state.spring.active) writeMotionStyle(icon, { rotate: rotateFor(state) });
}

export const disclosure: MotionEffect = {
  name: "disclosure",
  selector: `details, ${triggerSelector}`,
  // The press comes before the change, so it reads where each icon is in the state that the person leaves. A press in
  // the content of an open `<details>` finds the `<details>`, not a trigger, and reads nothing.
  press(element) {
    if (!element.matches(triggerSelector)) return;
    for (const icon of iconsOf(element)) {
      const running = turns.get(icon)?.spring;
      pressed.set(icon, running?.active ? running.value * quarter : angles(icon).visual);
    }
  },
  state(element, { attribute }) {
    let trigger: Element | null = null;
    if (attribute === "open" && element instanceof HTMLDetailsElement) trigger = element.querySelector(":scope > summary");
    else if (attribute === "aria-expanded") trigger = element;
    if (!trigger) return;
    for (const icon of iconsOf(trigger)) {
      const from = pressed.get(icon);
      pressed.delete(icon);
      if (from === undefined || transitionsRotate(icon)) continue;
      turn(icon, from);
    }
  },
};
