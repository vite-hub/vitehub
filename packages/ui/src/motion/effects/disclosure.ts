import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring, springs } from "../spring.ts";
import type { Spring } from "../spring.ts";

/** The elements that open and close a part: a control with `aria-expanded`, or a native `<details>`. */
const owners = "[aria-expanded], details";

const turning = new WeakMap<Element, Spring>();

function isOpen(attribute: string, value: string | null): boolean {
  return attribute === "open" ? value !== null : value === "true";
}

/** The icons that the element turns: each `data-motion-turn` icon in it whose nearest owner is this element. */
function iconsOf(element: Element): Array<HTMLElement | SVGElement> {
  return [...element.querySelectorAll<HTMLElement | SVGElement>("[data-motion-turn]")].filter(icon => icon.parentElement?.closest(owners) === element);
}

function turn(icon: HTMLElement | SVGElement, from: number, to: number): void {
  let spring = turning.get(icon);
  if (!spring) {
    const current = createSpring(from, (value, velocity) => {
      // At rest the stylesheet turns the icon. The layer only draws the way there.
      writeMotionStyle(icon, { rotate: velocity === 0 && value === current.target ? null : `${Math.round(value * 100) / 100}deg` });
    }, springs.snappy);
    spring = current;
    turning.set(icon, spring);
  }
  // A spring that already turns keeps its speed. A new one starts at the old angle.
  if (!spring.active) spring.set(from);
  spring.to(to, { preset: springs.snappy });
}

/**
 * Something expands or collapses: the chevron of a disclosure turns with a spring. The part itself opens at once,
 * because a person reads it. An icon in the control with `data-motion-turn="<degrees>"` turns by that many degrees
 * while the control is open: `aria-expanded="true"`, or the `open` attribute of a `<details>`. The stylesheet sets
 * the same `rotate` for the open state, so the icon also turns without the layer. Under reduced motion it turns at once.
 */
export const disclosure: MotionEffect = {
  name: "disclosure",
  selector: `:is(${owners}):has([data-motion-turn])`,
  state(element, { attribute, oldValue, value }) {
    if (attribute !== "aria-expanded" && attribute !== "open") return;
    const wasOpen = isOpen(attribute, oldValue);
    const open = isOpen(attribute, value);
    if (wasOpen === open) return;
    for (const icon of iconsOf(element)) {
      const degrees = Number.parseFloat(icon.getAttribute("data-motion-turn") ?? "");
      if (!Number.isFinite(degrees)) continue;
      turn(icon, wasOpen ? degrees : 0, open ? degrees : 0);
    }
  },
};
