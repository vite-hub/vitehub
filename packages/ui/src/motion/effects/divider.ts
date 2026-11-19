import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";

// The elastic panel edge of the prototype. Within its limits a divider stays under the pointer, as its component puts
// it. Past a limit the divider stays and its line bends toward the pointer, up to 60px, and on release it springs back
// straight with a loose spring that passes straight once.
const springBack = { stiffness: 500, damping: 14 };
/** The bend comes near this many pixels on a long pull: `over / (1 + |over| / reach)`. */
const reach = 60;
/** The bend is drawn at least this far from each end of the line. */
const inset = 40;

const svgNamespace = "http://www.w3.org/2000/svg";

type Axis = "x" | "y";

interface Line {
  color: string;
  width: number;
  /**
   * The element that draws the line, when the line is part of the divider: the divider itself, for its own background
   * or a pseudo-element, or the thin child that is the line. It hides while the drawn line bends, and a grip or a label
   * beside it in the divider stays.
   */
  element?: HTMLElement;
}

interface Bend {
  handle: HTMLElement;
  /** The axis that the divider moves along. A vertical divider moves along x. */
  axis: Axis;
  line: Line;
  /** Where the pointer is on the line, in client pixels. */
  at: number;
  spring: Spring;
  lane?: { svg: SVGSVGElement; path: SVGPathElement };
}

const bends = new WeakMap<HTMLElement, Bend>();

/** A vertical divider (`aria-orientation="vertical"`, or taller than wide) moves along x. */
function axisOf(handle: HTMLElement, rect: DOMRect): Axis {
  const orientation = handle.getAttribute("aria-orientation");
  if (orientation === "vertical") return "x";
  if (orientation === "horizontal") return "y";
  return rect.height >= rect.width ? "x" : "y";
}

function shows(color: string): boolean {
  return !/^transparent$|rgba\([^)]*,\s*0\)$|\/\s*0\)$/.test(color.trim());
}

/**
 * The line that people see: the divider itself, its `::before` or `::after`, or a thin child, as the Console, the
 * workspace, and the agent session draw theirs. A divider with no line of its own, such as the edge of a Nuxt UI
 * dashboard panel, gets a drawn line in the border color while it bends.
 */
function lineOf(handle: HTMLElement, axis: Axis): Line {
  const across = (style: CSSStyleDeclaration) => Number.parseFloat(axis === "x" ? style.width : style.height);
  const styles: Array<[CSSStyleDeclaration, HTMLElement]> = [
    [getComputedStyle(handle), handle],
    [getComputedStyle(handle, "::before"), handle],
    [getComputedStyle(handle, "::after"), handle],
  ];
  for (const child of handle.children) if (child instanceof HTMLElement) styles.push([getComputedStyle(child), child]);
  for (const [style, element] of styles) {
    const width = across(style);
    if (style.display !== "none" && shows(style.backgroundColor) && width > 0 && width <= 4) {
      return { color: style.backgroundColor, width, element };
    }
  }
  return { color: "var(--ui-border, var(--vh-border, currentColor))", width: 1 };
}

function draw(bend: Bend, amount: number): void {
  const { handle, axis, line } = bend;
  if (Math.abs(amount) < 0.5 && !bend.spring.active) {
    bend.lane?.svg.remove();
    if (line.element) writeMotionStyle(line.element, { opacity: null });
    if (bends.get(handle) === bend) bends.delete(handle);
    return;
  }
  if (!bend.lane) {
    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.dataset.motion = "bend";
    svg.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;z-index:1";
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("fill", "none");
    path.style.stroke = line.color;
    path.style.strokeWidth = `${line.width}px`;
    svg.append(path);
    bend.lane = { svg, path };
  }
  const { svg, path } = bend.lane;
  if (!svg.isConnected) handle.after(svg);
  if (line.element) writeMotionStyle(line.element, { opacity: "0" });
  // In CSS pixels of the handle's parent, where the line is drawn, also on a page with CSS `zoom`.
  const zoom = handle.offsetHeight ? handle.getBoundingClientRect().height / handle.offsetHeight || 1 : 1;
  const scaled = (box: DOMRect) => ({ left: box.left / zoom, top: box.top / zoom, width: box.width / zoom, height: box.height / zoom });
  const origin = scaled(svg.getBoundingClientRect());
  const rect = scaled(handle.getBoundingClientRect());
  // In the coordinates of the drawn line: `u` along the axis the divider moves, `v` along the line.
  const u = (axis === "x" ? rect.left + rect.width / 2 - origin.left : rect.top + rect.height / 2 - origin.top);
  const from = axis === "x" ? rect.top - origin.top : rect.left - origin.left;
  const to = from + (axis === "x" ? rect.height : rect.width);
  const middle = (from + to) / 2;
  const at = to - from > 2 * inset ? Math.max(from + inset, Math.min(to - inset, bend.at / zoom - (axis === "x" ? origin.top : origin.left))) : middle;
  const point = (along: number, across: number) => axis === "x" ? `${across.toFixed(2)},${along.toFixed(2)}` : `${along.toFixed(2)},${across.toFixed(2)}`;
  const tip = u + amount;
  path.setAttribute("d", `M${point(from, u)} C${point(at - 70, u)} ${point(at - 40, tip)} ${point(at, tip)} C${point(at + 40, tip)} ${point(at + 70, u)} ${point(to, u)}`);
}

function draggable(handle: HTMLElement): boolean {
  if (handle.matches("[aria-disabled=true], [data-disabled]:not([data-disabled=false]), [data-panel-resize-handle-enabled=false]")) return false;
  return /resize/.test(getComputedStyle(handle).cursor) || handle.tabIndex >= 0 || handle.hasAttribute("aria-valuenow");
}

/**
 * Drag a value (docs/design/motion.md): a divider, `[role=separator]` that a person can drag, from Nuxt UI `USplitter`,
 * `UDashboardPanel`, Reka, ui-sdk and kit `Resizable`, or a plain handle. Past the limit of its panel, the divider
 * stays where its component keeps it and its line bends toward the pointer. On release it springs back straight.
 */
export const divider: MotionEffect = {
  name: "divider",
  selector: "[role=separator]",
  press(handle, event) {
    if (!(event instanceof PointerEvent) || !draggable(handle)) return;
    const rect = handle.getBoundingClientRect();
    const axis = axisOf(handle, rect);
    const along = (pointer: PointerEvent) => axis === "x" ? pointer.clientX : pointer.clientY;
    const across = (pointer: PointerEvent) => axis === "x" ? pointer.clientY : pointer.clientX;
    const center = (box: DOMRect) => axis === "x" ? box.left + box.width / 2 : box.top + box.height / 2;
    // Where on the divider the pointer took it, so a press off its center is not a pull.
    const grab = along(event) - center(rect);
    let bend = bends.get(handle);
    if (!bend) {
      const current: Bend = { handle, axis, line: lineOf(handle, axis), at: across(event), spring: createSpring(0, value => draw(current, value), springBack) };
      bend = current;
      bends.set(handle, bend);
    }
    const active = bend;
    active.at = across(event);
    let pointer = event;
    let frame = 0;
    // The component moves the divider in its own `pointermove` listener, after this one, so read it in the next frame.
    const measure = () => {
      frame = 0;
      const box = handle.getBoundingClientRect();
      // In CSS pixels, as the bend is drawn, also on a page with CSS `zoom`.
      const zoom = handle.offsetHeight ? box.height / handle.offsetHeight || 1 : 1;
      const over = (along(pointer) - grab - center(box)) / zoom;
      active.at = across(pointer);
      active.spring.set(Math.abs(over) < 1 ? 0 : over / (1 + Math.abs(over) / reach));
    };
    return {
      move(next) {
        pointer = next;
        if (!frame) frame = requestAnimationFrame(measure);
      },
      release() {
        cancelAnimationFrame(frame);
        active.spring.to(0, { preset: springBack });
      },
    };
  },
};
