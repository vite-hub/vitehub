import { writeMotionStyle } from "../registry.ts";
import { motionSkipped, reduced } from "./frame.ts";
import { cubicBezier, easeIn, easeOut, tween } from "./tween.ts";
import type { Tween } from "./tween.ts";

/** How the old icon leaves: it blurs out, or, for an arrow, it leaves in the direction that it points. */
export type IconExit = "blur" | "left" | "right" | "up" | "down";
/**
 * How the new icon comes in: it blurs in, it draws its stroke (a spinner, a check), or it slides in, moving in the
 * direction given, as an arrow that comes back.
 */
export type IconEnter = "blur" | "draw" | "left" | "right" | "up" | "down";

export interface SwapIconOptions {
  /** Default: `"blur"`. */
  exit?: IconExit;
  /** Default: `"draw"` for a spinning icon (`animate-spin`), else `"blur"`. */
  enter?: IconEnter;
  /**
   * Called for each old icon when it has left, in place of `icon.remove()`, for a container whose children a framework
   * renders. Vue removes the icon from its own list.
   */
  onRemove?: (icon: Element) => void;
}

// The prototype's Publish button: the old icon leaves in 200ms, an arrow moves 12px, and a blurred icon shrinks to 0.6
// with a 2px blur. A blurred icon comes in from 0.5 with a 3px blur in 260ms on an overshoot curve, a sliding one moves
// 10px in 260ms, and a stroke draws in 340ms (420ms for a spinner) after 120ms. Reduced motion crossfades in 150ms.
const exit = { duration: 200, travel: 12, scale: 0.6, blur: 2 };
const enterBlur = { duration: 260, delay: 40, scale: 0.5, blur: 3, ease: cubicBezier(0.3, 1.5, 0.5, 1) };
const enterSlide = { duration: 260, delay: 80, travel: 10, ease: cubicBezier(0.2, 0.8, 0.2, 1) };
const draw = { duration: 340, spinner: 420, delay: 120, ease: cubicBezier(0.6, 0, 0.2, 1) };
const crossfade = 150;

const directions = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] } as const;

interface IconState {
  /** 1 when the icon shows, 0 when it is gone. */
  shown: number;
  fade?: Tween;
  leaving: boolean;
}

const states = new WeakMap<Element, IconState>();

function stateOf(icon: Element): IconState {
  let state = states.get(icon);
  if (!state) {
    state = { shown: 1, leaving: false };
    states.set(icon, state);
  }
  return state;
}

function styled(icon: Element): icon is HTMLElement | SVGElement {
  return icon instanceof HTMLElement || icon instanceof SVGElement;
}

const strokeParts = "path, line, polyline, polygon, circle, ellipse, rect";

/** The parts of an SVG icon that a draw reveals, or none when the icon is not an SVG with strokes. */
function strokes(icon: Element): SVGGeometryElement[] {
  const svg = icon instanceof SVGSVGElement ? icon : icon.querySelector("svg");
  if (!svg) return [];
  return [...svg.querySelectorAll<SVGGeometryElement>(strokeParts)].filter(part => getComputedStyle(part).stroke !== "none");
}

function clear(icon: Element): void {
  if (styled(icon)) writeMotionStyle(icon, { opacity: null, filter: null, scale: null, translate: null });
}

function leave(icon: Element, kind: IconExit, reducedMotion: boolean, done: () => void): void {
  const state = stateOf(icon);
  state.fade?.stop();
  state.leaving = true;
  const [x, y] = kind === "blur" ? [0, 0] : directions[kind];
  state.fade = tween(state.shown, 0, { duration: reducedMotion ? crossfade : exit.duration, ease: reducedMotion ? easeOut : easeIn }, (value) => {
    state.shown = value;
    if (!styled(icon)) return;
    const gone = 1 - value;
    writeMotionStyle(icon, {
      opacity: String(value),
      filter: reducedMotion || kind !== "blur" ? null : `blur(${(exit.blur * gone).toFixed(2)}px)`,
      scale: reducedMotion || kind !== "blur" ? null : String(1 - (1 - exit.scale) * gone),
      translate: reducedMotion || kind === "blur" ? null : `${x * exit.travel * gone}px ${y * exit.travel * gone}px`,
    });
  }, () => {
    state.fade = undefined;
    done();
  });
}

function come(icon: Element, kind: IconEnter, reducedMotion: boolean, from: number): void {
  const state = stateOf(icon);
  state.fade?.stop();
  if (state.leaving && styled(icon)) {
    // An old icon that comes back takes its place in the flow again.
    for (const property of ["position", "left", "top", "margin", "pointer-events"]) icon.style.removeProperty(property);
    icon.removeAttribute("aria-hidden");
  }
  state.leaving = false;
  const parts = kind === "draw" && !reducedMotion ? strokes(icon) : [];
  const effective: IconEnter = kind === "draw" && !parts.length ? "blur" : kind;
  const finish = () => {
    state.fade = undefined;
    state.shown = 1;
    clear(icon);
    for (const part of parts) {
      part.removeAttribute("pathLength");
      part.style.removeProperty("stroke-dasharray");
      part.style.removeProperty("stroke-dashoffset");
    }
  };
  if (reducedMotion) {
    state.fade = tween(from, 1, { duration: crossfade, ease: easeOut }, (value) => {
      state.shown = value;
      if (styled(icon)) writeMotionStyle(icon, { opacity: String(value) });
    }, finish);
    return;
  }
  if (effective === "draw") {
    // The stroke draws in. The icon shows at once, so a spinner keeps its turn.
    for (const part of parts) {
      part.setAttribute("pathLength", "1");
      part.style.strokeDasharray = "1";
      part.style.strokeDashoffset = "1";
    }
    if (styled(icon)) writeMotionStyle(icon, { opacity: null, filter: null, scale: null, translate: null });
    const spins = icon.matches(".animate-spin") || !!icon.querySelector(".animate-spin");
    state.shown = 1;
    state.fade = tween(1, 0, { duration: spins ? draw.spinner : draw.duration, delay: draw.delay, ease: draw.ease }, (value) => {
      for (const part of parts) part.style.strokeDashoffset = String(value);
    }, finish);
    return;
  }
  if (effective === "blur") {
    state.fade = tween(from, 1, { duration: enterBlur.duration, delay: from ? 0 : enterBlur.delay, ease: enterBlur.ease }, (value) => {
      state.shown = Math.min(1, value);
      if (!styled(icon)) return;
      const gone = 1 - value;
      writeMotionStyle(icon, {
        opacity: String(Math.min(1, Math.max(0, value))),
        filter: `blur(${Math.max(0, enterBlur.blur * gone).toFixed(2)}px)`,
        scale: String(1 - (1 - enterBlur.scale) * gone),
      });
    }, finish);
    return;
  }
  const [x, y] = directions[effective];
  state.fade = tween(from, 1, { duration: enterSlide.duration, delay: from ? 0 : enterSlide.delay, ease: enterSlide.ease }, (value) => {
    state.shown = value;
    if (!styled(icon)) return;
    const gone = 1 - value;
    writeMotionStyle(icon, { opacity: String(Math.min(1, value)), translate: `${-x * enterSlide.travel * gone}px ${-y * enterSlide.travel * gone}px` });
  }, finish);
}

/** True when the icon still has to show, for a test or a component that waits for the swap. */
export function iconSwapping(icon: Element): boolean {
  return !!states.get(icon)?.fade;
}

/**
 * Swaps the icon in `container` for `icon`, as rule 5 of docs/design/motion.md asks: the old icon blurs out, or leaves in
 * the direction it points, while the new one comes in, and a spinner or a check draws its stroke. `icon` may already be
 * a child of `container`, as when a framework renders it; else the helper appends it. Every other icon in the container
 * leaves, and is removed when it is gone.
 *
 * Call it again at any time: an icon that is still coming in leaves from where it is. Under reduced motion the icons
 * crossfade in 150ms. Inside `data-motion="none"` the old icons go at once.
 */
export function swapIcon(container: HTMLElement, icon: Element, options: SwapIconOptions = {}): void {
  const remove = options.onRemove ?? ((old: Element) => old.remove());
  if (icon.parentNode !== container) container.append(icon);
  const known = states.get(icon);
  const others = [...container.children].filter(child => child !== icon && !states.get(child)?.leaving);
  const leavingNow = [...container.children].filter(child => child !== icon && states.get(child)?.leaving);
  if (motionSkipped(container)) {
    for (const old of [...others, ...leavingNow]) {
      states.get(old)?.fade?.stop();
      states.delete(old);
      remove(old);
    }
    states.get(icon)?.fade?.stop();
    states.delete(icon);
    clear(icon);
    return;
  }
  // A first icon with no old one to replace shows as it is, and the icon that shows already stays.
  if (!others.length && (known ? !known.leaving : !leavingNow.length)) {
    stateOf(icon);
    return;
  }
  const placed = others.map(old => ({ old, at: offsetIn(container, old) }));
  for (const { old, at } of placed) leaveIcon(container, old, at, options.exit ?? "blur", remove);
  enterIcon(icon, options.enter, known ? known.shown : 0);
}

/**
 * Takes `old` out of the flow at `at`, a place in the padding box of `container`, and plays its exit. `remove` runs when
 * it is gone. The label effect of the layer uses it for a copy of the icon that Vue already replaced.
 */
export function leaveIcon(container: HTMLElement, old: Element, at: { left: number; top: number }, exit: IconExit, remove: (old: Element) => void): void {
  const reducedMotion = reduced();
  const setPosition = getComputedStyle(container).position === "static";
  if (setPosition) container.style.position = "relative";
  if (styled(old)) {
    old.style.position = "absolute";
    old.style.left = `${at.left}px`;
    old.style.top = `${at.top}px`;
    old.style.margin = "0";
    old.style.pointerEvents = "none";
  }
  old.setAttribute("aria-hidden", "true");
  leave(old, exit, reducedMotion, () => {
    states.delete(old);
    remove(old);
    if (setPosition && ![...container.children].some(child => states.get(child)?.leaving)) container.style.removeProperty("position");
  });
}

/** Plays the entrance of `icon` from `from` (0 for a new icon). The default draws a spinning icon and blurs in others. */
export function enterIcon(icon: Element, enter: IconEnter | undefined, from: number): void {
  const spins = icon.matches(".animate-spin") || !!icon.querySelector(".animate-spin");
  come(icon, enter ?? (spins ? "draw" : "blur"), reduced(), from);
}

/**
 * Where `child` sits in the padding box of `container`, in layout pixels. An SVG has no `offsetLeft`, and a press may
 * scale the button around both, so it divides the distance on screen by that scale.
 */
export function offsetIn(container: HTMLElement, child: Element): { left: number; top: number } {
  const outer = container.getBoundingClientRect();
  const inner = child.getBoundingClientRect();
  const scale = container.offsetWidth ? outer.width / container.offsetWidth : 1;
  return {
    left: (inner.left - outer.left) / (scale || 1) - container.clientLeft,
    top: (inner.top - outer.top) / (scale || 1) - container.clientTop,
  };
}
