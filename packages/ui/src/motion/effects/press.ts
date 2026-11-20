import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";

// The press of the prototype: a stiff, damped spring down, then a loose one back that passes rest once.
const down = { stiffness: 900, damping: 40 };
const up = { stiffness: 380, damping: 14 };

const roles = ["button", "link", "tab", "radio", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "switch", "checkbox"];

/** Everything a person presses: native controls and the roles of docs/design/motion.md, when they are enabled. */
export const pressSelector = `:is(button, a[href], summary, input:is([type=button], [type=submit], [type=reset], [type=checkbox], [type=radio]), ${roles.map(role => `[role=${role}]`).join(", ")}):not(:disabled, [aria-disabled="true"])`;

// An icon: an SVG, an image, or an Iconify CSS icon such as Nuxt UI's `UIcon`. A switch thumb is not one.
const iconSelector = "svg, img, .iconify, [data-slot=icon], [data-slot$=Icon]";

const pressed = new WeakMap<Element, { spring: Spring; amount: number }>();

/**
 * How much a press squashes, from the prototype: an icon-only control squashes its icon by 15%, and a control squashes
 * by 3% from 40px high, 4% from 32px, and 5% below.
 */
function squash(element: HTMLElement): { target: HTMLElement | SVGElement; amount: number } {
  const icon = element.firstElementChild;
  if (element.childElementCount === 1 && !element.textContent?.trim() && (icon instanceof HTMLElement || icon instanceof SVGElement) && icon.matches(iconSelector)) {
    return { target: icon, amount: 0.15 };
  }
  const height = element.offsetHeight;
  return { target: element, amount: height >= 40 ? 0.03 : height >= 32 ? 0.04 : 0.05 };
}

/**
 * True when the element still animates `scale` with a CSS transition of its own, as a hand-written press on the
 * allowlist of `test/design-rules.test.ts` does. The transition would smear each frame of the spring, so that element
 * keeps its own press until its wave moves it onto the layer. Tailwind's plain `transition` class also animates `scale`.
 */
function transitionsScale(style: CSSStyleDeclaration): boolean {
  const durations = style.transitionDuration.split(",");
  return style.transitionProperty.split(",").some((property, index) =>
    /^\s*(?:scale|all)\s*$/.test(property) && Number.parseFloat(durations[index % durations.length]!) > 0);
}

function nearEdge(bounds: DOMRect, event: PointerEvent, amount: number): boolean {
  const { left, right, top, bottom, width, height } = bounds;
  return Math.min(event.clientX - left, right - event.clientX) <= width * amount
    || Math.min(event.clientY - top, bottom - event.clientY) <= height * amount;
}

export const press: MotionEffect = {
  name: "press",
  selector: pressSelector,
  press(element, event) {
    const { target, amount } = squash(element);
    const style = getComputedStyle(target);
    if (transitionsScale(style) || style.display === "contents") return;
    if (style.display === "inline" && target === element && !(element instanceof HTMLInputElement)) return;
    let bounds: DOMRect | undefined;
    if (target === element && "pointerId" in event) {
      bounds = element.getBoundingClientRect();
      if (nearEdge(bounds, event, amount)) return;
    }
    let state = pressed.get(target);
    if (!state) {
      const current = { amount, spring: createSpring(0, (value) => {
        writeMotionStyle(target, { scale: value ? String(1 - current.amount * value) : null });
      }, down) };
      state = current;
      pressed.set(target, state);
    }
    state.amount = amount;
    const { spring } = state;
    spring.to(1, { preset: down });
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      spring.set(0);
    };
    return {
      move: bounds ? (pointer) => {
        if (nearEdge(bounds, pointer, amount)) cancel();
      } : undefined,
      release: () => {
        if (!cancelled) spring.to(0, { preset: up });
      },
      cancel,
    };
  },
};
