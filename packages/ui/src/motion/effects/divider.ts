import type { MotionEffect } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";

const springBack = { stiffness: 500, damping: 14 };
const reach = 60;
const inset = 40;

const svgNamespace = "http://www.w3.org/2000/svg";
export const rekaHandleSelector = "[role=separator][data-panel-resize-handle-id]";
export const rekaDragAttribute = "data-resize-handle-active";

type Axis = "x" | "y";

interface Line {
  color: string;
  width: number;
  own: boolean;
}

interface Bend {
  handle: HTMLElement;
  axis: Axis;
  line: Line;
  at: number;
  spring: Spring;
  lane?: { svg: SVGSVGElement; path: SVGPathElement };
}

const bends = new WeakMap<HTMLElement, Bend>();

function axisOf(handle: HTMLElement, rect: DOMRect): Axis {
  const orientation = handle.getAttribute("aria-orientation");
  if (orientation === "vertical") return "x";
  if (orientation === "horizontal") return "y";
  return rect.height >= rect.width ? "x" : "y";
}

function shows(color: string): boolean {
  return !/^transparent$|rgba\([^)]*,\s*0\)$|\/\s*0\)$/.test(color.trim());
}

function lineOf(handle: HTMLElement, axis: Axis): Line {
  const across = (style: CSSStyleDeclaration) => Number.parseFloat(axis === "x" ? style.width : style.height);
  const styles = [getComputedStyle(handle), getComputedStyle(handle, "::before"), getComputedStyle(handle, "::after")];
  for (const child of handle.children) styles.push(getComputedStyle(child));
  for (const style of styles) {
    const width = across(style);
    if (style.display !== "none" && shows(style.backgroundColor) && width > 0 && width <= 4) {
      return { color: style.backgroundColor, width, own: true };
    }
  }
  return { color: "var(--ui-border, var(--vh-border, currentColor))", width: 1, own: false };
}

function draw(bend: Bend, amount: number): void {
  const { handle, axis, line } = bend;
  if (Math.abs(amount) < 0.5 && !bend.spring.active) {
    bend.lane?.svg.remove();
    writeMotionStyle(handle, { opacity: null });
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
  if (line.own) writeMotionStyle(handle, { opacity: "0" });
  const zoom = handle.offsetHeight ? handle.getBoundingClientRect().height / handle.offsetHeight || 1 : 1;
  const scaled = (box: DOMRect) => ({ left: box.left / zoom, top: box.top / zoom, width: box.width / zoom, height: box.height / zoom });
  const origin = scaled(svg.getBoundingClientRect());
  const rect = scaled(handle.getBoundingClientRect());
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
    if (handle.matches(rekaHandleSelector) && handle.getAttribute(rekaDragAttribute) !== "pointer") return;
    const rect = handle.getBoundingClientRect();
    const axis = axisOf(handle, rect);
    const along = (pointer: PointerEvent) => axis === "x" ? pointer.clientX : pointer.clientY;
    const across = (pointer: PointerEvent) => axis === "x" ? pointer.clientY : pointer.clientX;
    const center = (box: DOMRect) => axis === "x" ? box.left + box.width / 2 : box.top + box.height / 2;
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
    const measure = () => {
      frame = 0;
      const box = handle.getBoundingClientRect();
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
