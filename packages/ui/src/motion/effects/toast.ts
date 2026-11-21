import { prefersReducedMotion } from "../reduced-motion.ts";
import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring, springs } from "../spring.ts";
import type { Spring } from "../spring.ts";
import { createGhost, pinGhost } from "./ghost.ts";

const crossfade = 0.15;

interface Item {
  element: HTMLElement;
  /** Where the toast is without motion, on the screen. */
  rest: { left: number; top: number; width: number; height: number };
  x: Spring;
  y: Spring;
  fade?: Spring;
}

interface List {
  element: HTMLElement;
  items: Map<HTMLElement, Item>;
  observer: MutationObserver;
  region: HTMLElement;
  /** Frames left to check the places of the toasts, for a toaster that lays its stack out after it renders. */
  watchFrames: number;
  frame: number;
}

const lists = new WeakMap<HTMLElement, List>();

const fixed = (element: Element | null) => !!element && getComputedStyle(element).position === "fixed";

/**
 * True when the item is a toast: an item of the list of a notifications region that stays on the screen. Nuxt UI's
 * toaster renders a `role=region` with a fixed list, and ui-sdk's toast region is fixed itself.
 */
function isToast(element: HTMLElement): boolean {
  const list = element.parentElement;
  if (!list || (list.tagName !== "OL" && list.tagName !== "UL")) return false;
  const region = list.closest("[role=region], [data-slot=toast-region]");
  return !!region && (fixed(list) || fixed(list.parentElement) || fixed(region));
}

/** The edge of the screen that the toasts live at: the nearer one, top or bottom. */
function edgeOf(rect: { top: number; height: number }): "top" | "bottom" {
  return rect.top + rect.height / 2 > innerHeight / 2 ? "bottom" : "top";
}

/** How far the toast moves to be just past its edge of the screen. */
function pastEdge(rect: { top: number; height: number }): number {
  return edgeOf(rect) === "bottom" ? innerHeight - rect.top : -(rect.top + rect.height);
}

/**
 * Where a toast that closes goes: past the side of the screen that the toaster sits at, so it does not cross the other
 * toasts, or past its top or bottom edge for a toaster in the middle.
 */
function exitOf(rect: DOMRect, direction?: string | null): { axis: "x" | "y"; distance: number } {
  if (direction === "left") return { axis: "x", distance: -rect.right };
  if (direction === "right") return { axis: "x", distance: innerWidth - rect.left };
  if (direction === "up") return { axis: "y", distance: -rect.bottom };
  if (direction === "down") return { axis: "y", distance: innerHeight - rect.top };
  const center = rect.left + rect.width / 2;
  if (Math.abs(center - innerWidth / 2) < innerWidth / 8) return { axis: "y", distance: pastEdge(rect) };
  return { axis: "x", distance: center > innerWidth / 2 ? innerWidth - rect.left : -rect.right };
}

function exitDirection(list: List, element: HTMLElement): string | null {
  const align = list.region.getAttribute("data-align");
  if (align === "center") return list.region.getAttribute("data-side") === "top" ? "up" : "down";
  if (align === "start" || align === "end") {
    return (align === "start") !== (getComputedStyle(list.region).direction === "rtl") ? "left" : "right";
  }
  return element.getAttribute("data-swipe-direction");
}

function swipeOffset(element: HTMLElement, axis: "x" | "y", released = false): number {
  const reka = `--reka-toast-swipe-${released ? "end" : "move"}-${axis}`;
  return Number.parseFloat(element.style.getPropertyValue(reka) || element.style.getPropertyValue(`--toast-swipe-${axis}`)) || 0;
}

function write(element: HTMLElement, x: Spring, y: Spring, fade?: Spring): void {
  const still = Math.abs(x.value) < 0.01 && Math.abs(y.value) < 0.01;
  const offset = (value: number, axis: "x" | "y") => {
    const motion = `${Math.round(value * 100) / 100}px`;
    return `calc(${motion} + var(--reka-toast-swipe-move-${axis}, var(--toast-swipe-${axis}, 0px)))`;
  };
  writeMotionStyle(element, {
    translate: still && !x.active && !y.active ? null : `${offset(x.value, "x")} ${offset(y.value, "y")}`,
    opacity: fade && (fade.active || fade.value < 1) ? String(fade.value) : null,
  });
}

function createItem(element: HTMLElement, rest: Item["rest"]): Item {
  const item = { element, rest } as Item;
  const frame = () => write(element, item.x, item.y, item.fade);
  item.x = createSpring(0, frame, springs.snappy);
  item.y = createSpring(0, frame, springs.snappy);
  return item;
}

/** Moves a spring by `distance` and lets it spring back to rest from there with the speed it has. */
function shift(spring: Spring, distance: number): void {
  const velocity = spring.velocity;
  spring.set(spring.value + distance);
  spring.to(0, { velocity });
}

/**
 * Measures where each toast is now. A toast that the list moved, because a toast came or left, starts from where a
 * person saw it and springs to its new place.
 */
function relayout(list: List): void {
  for (const item of list.items.values()) {
    if (!item.element.isConnected) continue;
    const rect = item.element.getBoundingClientRect();
    const rest = {
      left: rect.left - item.x.value - swipeOffset(item.element, "x"),
      top: rect.top - item.y.value - swipeOffset(item.element, "y"),
      width: rect.width,
      height: rect.height,
    };
    const dx = item.rest.left - rest.left;
    const dy = item.rest.top - rest.top;
    item.rest = rest;
    if (Math.abs(dx) > 0.5) shift(item.x, dx);
    if (Math.abs(dy) > 0.5) shift(item.y, dy);
  }
}

/** Checks the places of the toasts on each frame for a short time, as Nuxt UI lays its stack out after it renders. */
function watchLayout(list: List): void {
  list.watchFrames = 12;
  if (list.frame) return;
  const step = () => {
    relayout(list);
    const moving = [...list.items.values()].some(item => item.x.active || item.y.active);
    list.watchFrames = moving ? Math.max(list.watchFrames, 2) : list.watchFrames - 1;
    list.frame = list.watchFrames > 0 ? requestAnimationFrame(step) : 0;
  };
  list.frame = requestAnimationFrame(step);
}

/** A toast leaves past the screen edge, and the others make room. */
function leave(list: List, element: HTMLElement): void {
  const item = list.items.get(element);
  if (!item) return;
  list.items.delete(element);
  item.x.stop();
  item.y.stop();
  const direction = exitDirection(list, element);
  const swipe = element.getAttribute("data-swipe") === "end" || (element.matches("[data-slot=toast]") && element.hasAttribute("data-swipe-direction"));
  const swipeDirection = swipe ? element.getAttribute("data-swipe-direction") : null;
  const parent = list.region.parentNode;
  if (parent) {
    const rect = new DOMRect(
      item.rest.left + item.x.value + (swipe ? swipeOffset(element, "x", true) : 0),
      item.rest.top + item.y.value + (swipe ? swipeOffset(element, "y", true) : 0),
      item.rest.width,
      item.rest.height,
    );
    const ghost = createGhost(element, parent, list.region.nextSibling);
    writeMotionStyle(ghost, { translate: null, opacity: null });
    pinGhost(ghost, rect);
    if (prefersReducedMotion()) {
      const fade = createSpring(1, (value) => {
        writeMotionStyle(ghost, { opacity: String(value) });
        if (!fade.active && value === 0) ghost.remove();
      });
      fade.to(0, { tween: crossfade });
    }
    else {
      const { axis, distance: target } = exitOf(rect, swipeDirection ?? direction);
      const spring = createSpring(0, (value) => {
        const offset = `${Math.round(value * 100) / 100}px`;
        writeMotionStyle(ghost, { translate: axis === "x" ? `${offset} 0px` : `0px ${offset}` });
        // Gone once it is fully past the edge, or when the spring rests there.
        if ((target > 0 ? value >= target : value <= target) || !spring.active) {
          spring.stop();
          ghost.remove();
        }
      }, springs.snappy);
      spring.to(target);
    }
  }
  relayout(list);
  watchLayout(list);
  if (!list.items.size) {
    list.observer.disconnect();
    lists.delete(list.element);
  }
}

function listOf(element: HTMLElement): List {
  const parent = element.parentElement!;
  let list = lists.get(parent);
  if (list) return list;
  const current: List = {
    element: parent,
    items: new Map(),
    observer: new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node instanceof HTMLElement && !node.isConnected) leave(current, node);
      }
    }),
    region: parent.closest<HTMLElement>("[role=region], [data-slot=toast-region]") ?? parent,
    watchFrames: 0,
    frame: 0,
  };
  current.observer.observe(parent, { childList: true });
  lists.set(parent, current);
  list = current;
  return list;
}

/**
 * Something arrives on its own: a toast comes in from its edge of the screen, and the toasts that the list moves make
 * room with a spring. A toast that closes leaves past the side of the screen that the toaster sits at, and the others
 * close the gap. A toast that a person
 * swiped away leaves from where they let go. Under reduced motion a toast crossfades in and out in 150ms, and the others
 * take their new places at once.
 *
 * It is a role effect on the items of a notifications region, so Nuxt UI's `UToast` and ui-sdk's `Toast` both get it.
 */
export const toast: MotionEffect = {
  name: "toast",
  selector: "[role=region] li, [data-slot=toast]",
  enter(element) {
    if (!isToast(element)) return;
    const list = listOf(element);
    if (list.items.has(element)) return;
    // The others moved when this toast came in: they start from where a person saw them.
    relayout(list);
    const rect = element.getBoundingClientRect();
    const item = createItem(element, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    list.items.set(element, item);
    if (prefersReducedMotion()) {
      const fade = createSpring(0, () => write(element, item.x, item.y, fade));
      item.fade = fade;
      // Write the start at once, as `item.y.set()` does below. A spring writes nothing until its first frame, so until
      // then the toast has no opacity of its own and looks settled at full opacity to anything that reads it.
      fade.set(0);
      fade.to(1, { tween: crossfade });
    }
    else {
      item.y.set(pastEdge(rect));
      item.y.to(0);
    }
    watchLayout(list);
  },
};
