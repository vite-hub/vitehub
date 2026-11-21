import { prefersReducedMotion } from "../reduced-motion.ts";
import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";
import { createGhost, pinGhost } from "./ghost.ts";

// The numbers of the list mover: a removed item folds back to 90% on (260, 28), and it is gone below 2%.
const fold = { stiffness: 260, damping: 28 };
const slotScale = 0.9;
const crossfade = 0.15;

const leaving = new WeakMap<HTMLElement, { ghost: HTMLElement; spring: Spring }>();

function stop(element: HTMLElement): void {
  const entry = leaving.get(element);
  if (!entry) return;
  leaving.delete(element);
  entry.spring.stop();
  entry.ghost.remove();
  element.removeAttribute("data-motion-leave-managed");
  writeMotionStyle(element, { opacity: null });
}

/**
 * A mark that leaves while its page keeps it a moment longer, such as a comment pin when one comment shows on its own:
 * the page sets `data-leaving="true"` on it and removes it later. A copy of it folds away in its place, as a removed item
 * of a list does, and the mark itself hides at once, so the time the page keeps it does not matter. When the page shows
 * it again, the copy goes. Under reduced motion the copy fades out in 150ms.
 */
export const leave: MotionEffect = {
  name: "leave",
  // Every element: when the page shows the mark again, it removes the attribute, and the copy must go too.
  selector: "*",
  state(element, { attribute, value }) {
    if (attribute !== "data-leaving") return;
    stop(element);
    if (value !== "true" || !element.parentNode) return;
    element.setAttribute("data-motion-leave-managed", "");
    const rect = element.getBoundingClientRect();
    const ghost = createGhost(element, element.parentNode, element.nextSibling);
    // A mark that the page places itself, with `absolute` or `fixed`, stays where it is. Any other leaves the flow.
    const position = getComputedStyle(element).position;
    if (position !== "absolute" && position !== "fixed") pinGhost(ghost, rect);
    writeMotionStyle(element, { opacity: "0" });
    const reduced = prefersReducedMotion();
    const spring = createSpring(1, (progress) => {
      writeMotionStyle(ghost, {
        scale: reduced ? null : (slotScale + (1 - slotScale) * progress).toFixed(4),
        opacity: Math.max(0, progress).toFixed(3),
      });
      if (progress < 0.02) {
        spring.stop();
        ghost.remove();
      }
    }, fold);
    leaving.set(element, { ghost, spring });
    spring.to(0, reduced ? { tween: crossfade } : { preset: fold });
  },
};
