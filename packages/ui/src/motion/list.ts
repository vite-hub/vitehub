import { cubicBezier, playTween } from "./helpers/tween.ts";
import { visualCopy } from "./helpers/visual-copy.ts";
import { isMotionOff } from "./layer.ts";
import { prefersReducedMotion } from "./reduced-motion.ts";
import { writeMotionStyle } from "./registry.ts";
import { createSpring, springs } from "./spring.ts";
import type { Spring, SpringPreset } from "./spring.ts";

const grow: SpringPreset = { stiffness: 380, damping: 26 };
const fold: SpringPreset = { stiffness: 260, damping: 28 };
const slotScale = 0.9;
const leaveDuration = 0.32;
const leaveEasing = cubicBezier(0.5, 0, 0.75, 0);
const ghostAttribute = "data-motion-ghost";

/** Where a new item comes from: one element for every new item, or a function that finds it for each one. */
export type MotionListOrigin = Element | ((item: HTMLElement) => Element | null | undefined);

export interface MotionListOptions {
  /** The items of the list. Defaults to the element children of the container. */
  items?: (container: HTMLElement) => HTMLElement[];
  /**
   * Only the items that stay move. A new item shows at once, and a removed item goes at once. Use it for items that come
   * and go for another reason than an add or a remove, such as the cards of a margin that the scroll brings in.
   */
  movesOnly?: boolean;
}

export interface MotionListPlay {
  /**
   * Where a new item comes from, such as the row that was duplicated. The new item starts on it and moves to its slot.
   * A new item without an origin grows in its slot.
   */
  origin?: MotionListOrigin | null;
  /** Where a removed item goes, such as the trash. Without it, a removed item folds away in its slot. */
  target?: Element | null;
}

export interface MotionList {
  /**
   * Reads where each item is. Call it before the list changes: just before, or after the last `play()`, also while the
   * items still move. A change that you only see after it happened, such as a resize, needs the second way.
   */
  measure(): void;
  /**
   * Call it just after the list changed. Each item that moved springs from where `measure()` found it to its new place,
   * a new item grows from its origin or its slot, and a removed item folds away.
   */
  play(options?: MotionListPlay): void;
  /** Stops every motion, clears what the list wrote, and removes the copies of removed items. */
  destroy(): void;
}

interface ItemMotion {
  x: Spring;
  y: Spring;
  grow: Spring;
  from: { x: number; y: number; scale: number };
}

interface Snapshot {
  x: number;
  y: number;
  rect: DOMRect;
}

const center = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

function onScreen(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && rect.width + rect.height > 0;
}

function defaultItems(container: HTMLElement): HTMLElement[] {
  return [...container.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute(ghostAttribute));
}

/**
 * The list mover of docs/design/motion.md: "Items are added, removed, or reordered". It is FLIP with the springs of the
 * motion layer. Call `measure()` before a change and `play()` after it.
 *
 * Neighbors spring to their new place and keep their speed when a second change comes before they settle. A new item
 * grows from its origin, such as the row it duplicates, or from its slot. A removed item folds away, or leaves toward
 * `target`. Items that are off screen before and after the change do not move, so a long list costs one read per item.
 * Under reduced motion nothing travels: a new item and a removed item cross-fade in 150ms. Inside `data-motion="none"`
 * nothing moves.
 */
export function createMotionList(container: HTMLElement, options: MotionListOptions = {}): MotionList {
  const items = options.items ?? defaultItems;
  const motions = new Map<HTMLElement, ItemMotion>();
  const ghosts = new Set<{ element: HTMLElement; stop: () => void }>();
  let snapshot = new Map<HTMLElement, Snapshot>();
  let starting = false;

  function offset(motion: ItemMotion | undefined): { x: number; y: number } {
    if (!motion) return { x: 0, y: 0 };
    const rest = 1 - motion.grow.value;
    return { x: motion.x.value + motion.from.x * rest, y: motion.y.value + motion.from.y * rest };
  }

  function write(element: HTMLElement, motion: ItemMotion): void {
    const { x, y, grow, from } = motion;
    if (!x.active && !y.active && !grow.active && x.value === 0 && y.value === 0 && grow.value === 1) {
      writeMotionStyle(element, { translate: null, scale: null, opacity: null });
      if (!starting) motions.delete(element);
      return;
    }
    const { x: dx, y: dy } = offset(motion);
    const scale = from.scale + (1 - from.scale) * grow.value;
    writeMotionStyle(element, {
      translate: dx || dy ? `${dx.toFixed(2)}px ${dy.toFixed(2)}px` : null,
      scale: scale === 1 ? null : scale.toFixed(4),
      opacity: grow.value >= 1 ? null : Math.max(0, Math.min(1, grow.value)).toFixed(3),
    });
  }

  function motionOf(element: HTMLElement): ItemMotion {
    let motion = motions.get(element);
    if (motion) return motion;
    const draw = () => motion && write(element, motion);
    motion = {
      x: createSpring(0, draw, springs.snappy),
      y: createSpring(0, draw, springs.snappy),
      grow: createSpring(1, draw, grow),
      from: { x: 0, y: 0, scale: 1 },
    };
    motions.set(element, motion);
    return motion;
  }

  function stopItem(element: HTMLElement): void {
    const motion = motions.get(element);
    if (!motion) return;
    motions.delete(element);
    motion.x.stop();
    motion.y.stop();
    motion.grow.stop();
    writeMotionStyle(element, { translate: null, scale: null, opacity: null });
  }

  function travel(spring: Spring, from: number): void {
    const velocity = spring.velocity;
    spring.set(from);
    spring.to(0, { preset: springs.snappy, velocity });
  }

  function leave(element: HTMLElement, before: DOMRect, target: Element | null | undefined): void {
    if (!onScreen(before)) return;
    const box = container.getBoundingClientRect();
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    const ghost = visualCopy(element);
    ghost.setAttribute(ghostAttribute, "");
    Object.assign(ghost.style, {
      boxSizing: "border-box",
      height: `${before.height}px`,
      left: `${before.left - box.left - container.clientLeft + container.scrollLeft}px`,
      margin: "0",
      pointerEvents: "none",
      position: "absolute",
      top: `${before.top - box.top - container.clientTop + container.scrollTop}px`,
      width: `${before.width}px`,
    });
    writeMotionStyle(ghost, { translate: null, scale: null, opacity: null, filter: null });
    container.append(ghost);
    const entry = { element: ghost, stop: () => {} };
    const end = () => {
      entry.stop();
      ghost.remove();
      ghosts.delete(entry);
    };
    ghosts.add(entry);

    if (prefersReducedMotion()) {
      const tween = playTween(0.15, p => writeMotionStyle(ghost, { opacity: (1 - p).toFixed(3) }));
      entry.stop = tween.stop;
      void tween.done.then(end);
      return;
    }
    if (target) {
      const to = center(target.getBoundingClientRect());
      const from = center(before);
      const tween = playTween(leaveDuration, (p) => {
        writeMotionStyle(ghost, {
          translate: `${((to.x - from.x) * p).toFixed(2)}px ${((to.y - from.y) * p).toFixed(2)}px`,
          scale: (1 - 0.8 * p).toFixed(4),
          opacity: (1 - p).toFixed(3),
          filter: p > 0 ? `blur(${(3 * p).toFixed(2)}px)` : null,
        });
      }, leaveEasing);
      entry.stop = tween.stop;
      void tween.done.then(end);
      return;
    }
    const spring = createSpring(1, (value) => {
      writeMotionStyle(ghost, { scale: (slotScale + (1 - slotScale) * value).toFixed(4), opacity: Math.max(0, value).toFixed(3) });
      if (value < 0.02) end();
    }, fold);
    entry.stop = () => spring.stop();
    spring.to(0);
  }

  return {
    measure() {
      snapshot = new Map();
      for (const element of items(container)) {
        const rect = element.getBoundingClientRect();
        // An item that is not laid out, such as one with `display: none`, has no place yet: it grows in when it shows.
        if (!rect.width && !rect.height) continue;
        // The place without the motion, so `measure()` can also run while items still move, such as right after `play()`.
        const now = center(rect);
        const shift = offset(motions.get(element));
        snapshot.set(element, { x: now.x - shift.x, y: now.y - shift.y, rect });
      }
    },
    play(play = {}) {
      const before = snapshot;
      snapshot = new Map();
      const off = isMotionOff(container);
      const current = items(container);
      const present = new Set(current);
      const reads = current.map((element) => {
        const rect = element.getBoundingClientRect();
        const shift = offset(motions.get(element));
        const now = center(rect);
        return { element, rect, layout: { x: now.x - shift.x, y: now.y - shift.y } };
      });
      const origins = reads.map(({ element }) => {
        if (before.has(element) || !play.origin) return undefined;
        const origin = typeof play.origin === "function" ? play.origin(element) : play.origin;
        return origin?.getBoundingClientRect();
      });

      for (const [element, { rect }] of before) {
        if (present.has(element)) continue;
        stopItem(element);
        if (!off && !options.movesOnly && !element.hasAttribute("data-motion-leaving")) leave(element, rect, play.target);
      }
      starting = true;
      reads.forEach(({ element, rect, layout }, index) => {
        if (off) return stopItem(element);
        const old = before.get(element);
        if (old) {
          const dx = old.x - layout.x;
          const dy = old.y - layout.y;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
          if (!onScreen(old.rect) && !onScreen(rect)) return stopItem(element);
          const motion = motionOf(element);
          travel(motion.x, motion.x.value + dx);
          travel(motion.y, motion.y.value + dy);
          return;
        }
        if (!onScreen(rect) || options.movesOnly) return;
        const motion = motionOf(element);
        const origin = origins[index];
        if (prefersReducedMotion()) motion.from = { x: 0, y: 0, scale: 1 };
        else if (origin) {
          const start = center(origin);
          const scale = Math.min(1, Math.max(0.2, Math.min(origin.width / (rect.width || 1), origin.height / (rect.height || 1))));
          motion.from = { x: start.x - layout.x, y: start.y - layout.y, scale };
        }
        else motion.from = { x: 0, y: 0, scale: slotScale };
        motion.grow.set(0);
        motion.grow.to(1, prefersReducedMotion() ? { tween: 0.15 } : { preset: grow });
      });
      starting = false;
    },
    destroy() {
      for (const element of motions.keys()) stopItem(element);
      for (const ghost of ghosts) {
        ghost.stop();
        ghost.element.remove();
      }
      ghosts.clear();
      snapshot = new Map();
    },
  };
}
