import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { prefersReducedMotion } from "../reduced-motion.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";
import { createGhost } from "./ghost.ts";
import { findIcons, iconShape } from "./icon-shape.ts";
import type { IconShape } from "./icon-shape.ts";

interface Check {
  element: HTMLElement;
  /** How much of the mark is drawn, from 0 to 1. */
  drawn: Spring;
  icon: IconShape | undefined;
  lengths: number[];
  /** The element whose opacity follows the spring: the mark under reduced motion, or the copy that draws out. */
  fade: HTMLElement | SVGElement | undefined;
  /** The part of the checkbox that holds the mark, such as Nuxt UI's indicator, kept to draw it out once it is gone. */
  indicator: Element | undefined;
  ghost: Element | undefined;
  reduced: boolean;
}

const checks = new WeakMap<HTMLElement, Check>();

function isOn(value: string | null): boolean {
  return value === "true" || value === "mixed";
}

function styleable(node: Element | undefined): HTMLElement | SVGElement | undefined {
  return node instanceof HTMLElement || node instanceof SVGElement ? node : undefined;
}

/** The child of `element` that holds `node`. */
function childOf(element: HTMLElement, node: Element): Element {
  let child = node;
  while (child.parentElement && child.parentElement !== element) child = child.parentElement;
  return child;
}

// Nuxt UI removes its indicator with the check, a moment after the state changes. A copy of it takes its place while
// the check draws out, then goes.
function keepGhost(check: Check): void {
  const { indicator } = check;
  if (check.drawn.target || check.ghost || !indicator || indicator.isConnected) return;
  const source = styleable(indicator);
  if (!source) return;
  const ghost = createGhost(source, check.element, null);
  check.ghost = ghost;
  bind(check, findIcons(ghost)[0], ghost);
}

function draw(check: Check, value: number): void {
  keepGhost(check);
  const drawn = Math.min(1, Math.max(0, value));
  if (check.icon && !check.reduced) {
    const { icon, lengths } = check;
    icon.shapes.forEach((shape, index) => {
      const length = lengths[index]!;
      icon.set(shape, "stroke-dasharray", `${length} ${length}`);
      icon.set(shape, "stroke-dashoffset", String(length * (1 - drawn)));
    });
    icon.commit();
  }
  if (check.fade) writeMotionStyle(check.fade, { opacity: String(drawn) });
}

// The spring settled: the mark is as the stylesheet draws it, and a copy that drew out is gone.
function finish(check: Check): void {
  check.icon?.restore();
  check.icon = undefined;
  if (check.fade) writeMotionStyle(check.fade, { opacity: null });
  check.fade = undefined;
  check.ghost?.remove();
  check.ghost = undefined;
}

function checkOf(element: HTMLElement, wasOn: boolean): Check {
  const existing = checks.get(element);
  if (existing) return existing;
  const check: Check = {
    element,
    drawn: createSpring(wasOn ? 1 : 0, (value) => {
      if (check.drawn.active) draw(check, value);
      else finish(check);
    }),
    icon: undefined,
    lengths: [],
    fade: undefined,
    indicator: undefined,
    ghost: undefined,
    reduced: false,
  };
  checks.set(element, check);
  return check;
}

/** Points the spring at the mark of `icon`, and puts back the mark that it drew before. */
function bind(check: Check, icon: HTMLElement | SVGSVGElement | undefined, fade: HTMLElement | SVGElement | undefined): boolean {
  check.icon?.restore();
  if (check.fade && check.fade !== fade) writeMotionStyle(check.fade, { opacity: null });
  check.icon = icon && !check.reduced ? iconShape(icon) : undefined;
  check.lengths = check.icon ? check.icon.measure(() => check.icon!.shapes.map(shape => shape.getTotalLength())) : [];
  check.fade = fade;
  return !!check.icon || !!fade;
}

export const check: MotionEffect = {
  name: "check",
  selector: "[role=checkbox]",
  state(element, { attribute, oldValue, value }) {
    if (attribute !== "aria-checked") return;
    const check = checkOf(element, isOn(oldValue));
    check.ghost?.remove();
    check.ghost = undefined;
    check.reduced = prefersReducedMotion();
    const options = check.reduced ? { tween: 0.15 } : undefined;
    if (isOn(value)) {
      const icon = findIcons(element)[0];
      check.indicator = icon && childOf(element, icon);
      // A new mark, such as the minus after the check, draws from the start. A mark that was drawing out draws back in.
      if (isOn(oldValue)) check.drawn.set(0);
      if (!bind(check, icon, check.reduced ? styleable(check.indicator) : undefined)) return;
      draw(check, check.drawn.value);
      check.drawn.to(1, options);
      return;
    }
    const icon = findIcons(element)[0];
    if (icon) check.indicator = childOf(element, icon);
    if (!bind(check, icon, check.reduced ? styleable(check.indicator) : undefined) && !check.indicator) return;
    check.drawn.to(0, options);
    draw(check, check.drawn.value);
  },
};
