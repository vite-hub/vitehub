import { getMotionSlowFactor } from "../spring.ts";

/**
 * A copy of an element that leaves the page, so its exit can play after the component removed or hid it. Reka and
 * ui-sdk remove a closed tooltip or toast at once when it has no CSS animation, and the motion layer does not use CSS
 * animations, so the effect plays the exit on this copy.
 *
 * The copy is inert, hidden from assistive technology, and inside `data-motion="none"`, so the layer does not take it
 * for a new tooltip or toast. It has no `id` and no `role`.
 */
export function createGhost(source: HTMLElement, parent: Node, before: Node | null): HTMLElement {
  const ghost = source.cloneNode(true) as HTMLElement;
  for (const element of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
    for (const name of ["id", "role", "tabindex", "hidden", "inert", "popover", "data-ending-style", "data-starting-style", "aria-live"]) element.removeAttribute(name);
  }
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("data-motion", "none");
  ghost.inert = true;
  ghost.style.pointerEvents = "none";
  parent.insertBefore(ghost, before?.parentNode === parent ? before : null);
  return ghost;
}

/**
 * Puts a ghost at a place on the screen with `position: fixed`, outside the layout of the list it came from. A parent
 * with a transform moves fixed elements, so the ghost measures where it landed and corrects for it.
 */
export function pinGhost(ghost: HTMLElement, rect: DOMRect): void {
  Object.assign(ghost.style, {
    position: "fixed",
    inset: "auto",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    boxSizing: "border-box",
    transform: "none",
    translate: "none",
    zIndex: "2147483647",
  });
  const landed = ghost.getBoundingClientRect();
  if (Math.abs(landed.left - rect.left) > 0.5) ghost.style.left = `${2 * rect.left - landed.left}px`;
  if (Math.abs(landed.top - rect.top) > 0.5) ghost.style.top = `${2 * rect.top - landed.top}px`;
}

/** Calls `callback` after `ms` of motion time, so ¼× also slows the waits between the steps of an effect. */
export function after(ms: number, callback: () => void): number {
  return window.setTimeout(callback, ms * getMotionSlowFactor());
}
