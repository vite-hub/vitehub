import { prefersReducedMotion } from "../reduced-motion.ts";
import type { MotionEffect, MotionStateAttribute } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";

/*
 * A panel opens beside the page (docs/design/motion.md): a sidebar that a person opens to show its labels gets wider, and
 * the page next to it makes room. Its width follows a spring (420, 30), the one of the prototype's panels, from the old
 * width to the new one.
 *
 * The panel sets `data-motion-panel`, and its stylesheet gives it a width for each value of one of its state attributes,
 * such as `[data-open]`. The effect writes `width` inline only while the spring moves.
 */

interface Resize {
  spring: Spring;
  /** The padding and the border that `width` does not count, for a `content-box` panel. */
  frame: number;
}

// The prototype's panels spring to their new width with these numbers.
const resizeSpring = { stiffness: 420, damping: 30 };
const resizes = new WeakMap<HTMLElement, Resize>();
// The spring counts in hundreds of pixels, so it settles when the width is still to the eye, as a spring from 0 to 1 does.
const unit = 100;
// The panels whose next state change is the effect's own: it puts the old state back for a moment to measure it.
const echoes = new WeakSet<HTMLElement>();

function writeState(element: HTMLElement, attribute: MotionStateAttribute, value: string | null): void {
  if (value === null) element.removeAttribute(attribute);
  else element.setAttribute(attribute, value);
}

/** The width of the panel in the old state: the attribute goes back to its old value while the effect reads it. */
function oldWidth(element: HTMLElement, attribute: MotionStateAttribute, oldValue: string | null, value: string | null): number {
  writeState(element, attribute, oldValue);
  const width = element.getBoundingClientRect().width;
  writeState(element, attribute, value);
  echoes.add(element);
  return width;
}

function frameOf(element: HTMLElement): number {
  const style = getComputedStyle(element);
  if (style.boxSizing === "border-box") return 0;
  return [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((sum, value) => sum + Number.parseFloat(value), 0);
}

function write(element: HTMLElement, resize: Resize): void {
  writeMotionStyle(element, { width: `${resize.spring.value * unit - resize.frame}px` });
}

export const panel: MotionEffect = {
  name: "panel",
  selector: "[data-motion-panel]",
  state(element, { attribute, oldValue, value }) {
    if (echoes.has(element)) {
      echoes.delete(element);
      return;
    }
    let resize = resizes.get(element);
    if (!resize?.spring.active && prefersReducedMotion()) return;
    const from = resize?.spring.active ? resize.spring.value * unit : oldWidth(element, attribute, oldValue, value);
    writeMotionStyle(element, { width: null });
    const to = element.getBoundingClientRect().width;
    if (Math.abs(to - from) < 0.5) return;
    if (!resize) {
      const current: Resize = {
        frame: 0,
        spring: createSpring(from / unit, (width, velocity) => {
          if (velocity === 0 && width === current.spring.target) writeMotionStyle(element, { width: null });
          else write(element, current);
        }, resizeSpring),
      };
      resize = current;
      resizes.set(element, resize);
    }
    resize.frame = frameOf(element);
    // A spring that still moves keeps its speed toward the new width, so a fast second toggle never jumps.
    if (!resize.spring.active) resize.spring.set(from / unit);
    resize.spring.to(to / unit);
    // The first frame of the spring comes with the next paint. Until then the panel keeps its old width.
    if (resize.spring.active) write(element, resize);
  },
};
