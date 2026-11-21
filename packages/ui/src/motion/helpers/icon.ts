import { iconShape } from "../effects/icon-shape.ts";
import type { IconShape } from "../effects/icon-shape.ts";
import type { MotionStyleProperty } from "../registry.ts";
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
  /** The shapes of a stroke that draws in, put back when the draw ends or stops. */
  stroke?: IconShape;
  styles?: Map<string, () => void>;
  restorePlacement?: () => void;
}

const states = new WeakMap<Element, IconState>();
const positioned = new WeakMap<HTMLElement, { exits: number; restore: () => void }>();

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

/**
 * The shapes of an SVG icon that a draw reveals, through the same shape editor as the check and jelly effects, or
 * undefined when the icon is not an SVG with strokes.
 */
function strokes(icon: Element): { shape: IconShape; parts: SVGGeometryElement[] } | undefined {
  const svg = icon instanceof SVGSVGElement ? icon : icon.querySelector("svg");
  const shape = svg ? iconShape(svg) : undefined;
  const parts = shape?.shapes.filter(part => getComputedStyle(part).stroke !== "none") ?? [];
  return shape && parts.length ? { shape, parts } : undefined;
}

function saveStyle(style: CSSStyleDeclaration, property: string): () => void {
  const value = style.getPropertyValue(property);
  const priority = style.getPropertyPriority(property);
  return () => {
    if (value) style.setProperty(property, value, priority);
    else style.removeProperty(property);
  };
}

function paintIcon(icon: Element, state: IconState, values: Partial<Record<MotionStyleProperty, string>>): void {
  if (!styled(icon)) return;
  const styles = state.styles ??= new Map();
  for (const [property, value] of Object.entries(values)) {
    if (!styles.has(property)) styles.set(property, saveStyle(icon.style, property));
    icon.style.setProperty(property, value);
  }
}

function clear(state: IconState): void {
  state.stroke?.restore();
  state.stroke = undefined;
  for (const restore of state.styles?.values() ?? []) restore();
  state.styles = undefined;
}

function stopIcon(icon: Element): void {
  const state = states.get(icon);
  if (!state) return;
  state.fade?.stop();
  clear(state);
  state.restorePlacement?.();
  states.delete(icon);
}

function leave(icon: Element, kind: IconExit, reducedMotion: boolean, done: () => void): void {
  const state = stateOf(icon);
  state.fade?.stop();
  clear(state);
  state.leaving = true;
  const [x, y] = kind === "blur" ? [0, 0] : directions[kind];
  state.fade = tween(state.shown, 0, { duration: reducedMotion ? crossfade : exit.duration, ease: reducedMotion ? easeOut : easeIn }, (value) => {
    state.shown = value;
    const gone = 1 - value;
    paintIcon(icon, state, {
      opacity: String(value),
      ...reducedMotion ? {} : kind === "blur"
        ? { filter: `blur(${(exit.blur * gone).toFixed(2)}px)`, scale: String(1 - (1 - exit.scale) * gone) }
        : { translate: `${x * exit.travel * gone}px ${y * exit.travel * gone}px` },
    });
  }, () => {
    state.fade = undefined;
    done();
  });
}

function come(icon: Element, kind: IconEnter, reducedMotion: boolean, from: number): void {
  const state = stateOf(icon);
  state.fade?.stop();
  state.restorePlacement?.();
  state.restorePlacement = undefined;
  state.leaving = false;
  clear(state);
  const stroke = kind === "draw" && !reducedMotion ? strokes(icon) : undefined;
  state.stroke = stroke?.shape;
  const finish = () => {
    state.fade = undefined;
    state.shown = 1;
    clear(state);
  };
  if (reducedMotion) {
    state.fade = tween(from, 1, { duration: crossfade, ease: easeOut }, (value) => {
      state.shown = value;
      paintIcon(icon, state, { opacity: String(value) });
    }, finish);
    return;
  }
  if (stroke) {
    // The stroke draws in. The icon shows at once, so a spinner keeps its turn.
    const { shape, parts } = stroke;
    for (const part of parts) {
      shape.set(part, "pathLength", "1");
      shape.set(part, "stroke-dasharray", "1");
      shape.set(part, "stroke-dashoffset", "1");
    }
    shape.commit();
    const spins = icon.matches(".animate-spin") || !!icon.querySelector(".animate-spin");
    state.shown = 1;
    state.fade = tween(1, 0, { duration: spins ? draw.spinner : draw.duration, delay: draw.delay, ease: draw.ease }, (value) => {
      for (const part of parts) shape.set(part, "stroke-dashoffset", String(value));
      shape.commit();
    }, finish);
    return;
  }
  // An icon with no stroke to draw blurs in.
  const effective = kind === "draw" ? "blur" : kind;
  if (effective === "blur") {
    state.fade = tween(from, 1, { duration: enterBlur.duration, delay: from ? 0 : enterBlur.delay, ease: enterBlur.ease }, (value) => {
      state.shown = Math.min(1, value);
      const gone = 1 - value;
      paintIcon(icon, state, {
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
    const gone = 1 - value;
    paintIcon(icon, state, { opacity: String(Math.min(1, value)), translate: `${-x * enterSlide.travel * gone}px ${-y * enterSlide.travel * gone}px` });
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
      stopIcon(old);
      remove(old);
    }
    stopIcon(icon);
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
  let position = positioned.get(container);
  if (!position && getComputedStyle(container).position === "static") {
    position = { exits: 0, restore: saveStyle(container.style, "position") };
    positioned.set(container, position);
    container.style.position = "relative";
  }
  if (position) position.exits++;
  const restores: (() => void)[] = [];
  if (styled(old)) {
    const placement = {
      position: "absolute", left: `${at.left}px`, top: `${at.top}px`, "pointer-events": "none",
      "margin-top": "0", "margin-right": "0", "margin-bottom": "0", "margin-left": "0",
    };
    for (const [property, value] of Object.entries(placement)) {
      restores.push(saveStyle(old.style, property));
      old.style.setProperty(property, value);
    }
  }
  const hidden = old.getAttribute("aria-hidden");
  old.setAttribute("aria-hidden", "true");
  stateOf(old).restorePlacement = () => {
    for (const restore of restores) restore();
    if (hidden === null) old.removeAttribute("aria-hidden");
    else old.setAttribute("aria-hidden", hidden);
    if (position && --position.exits === 0) {
      position.restore();
      positioned.delete(container);
    }
  };
  leave(old, exit, reducedMotion, () => {
    stopIcon(old);
    remove(old);
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
