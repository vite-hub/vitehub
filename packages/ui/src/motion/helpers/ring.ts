import { motionSkipped, reduced } from "./frame.ts";
import { easeOut, tween } from "./tween.ts";
import type { Tween } from "./tween.ts";

const duration = 720;
const peak = 0.3;
const color = "var(--ui-border-accented, currentColor)";

const rings = new WeakMap<HTMLElement, { tween: Tween; own: string; restoreRadius?: () => void; under: string }>();
const corners = ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"];

/**
 * Rings `element` once, as rule 7 of docs/design/motion.md asks for a finished action such as saved, published, or
 * copied: a 5px ring in the border color grows around it and fades. A second call starts the ring again. There is no
 * ring under reduced motion or inside `data-motion="none"`. A control joined to others in a field group, such as
 * Nuxt UI's `UFieldGroup`, rings the whole group, with the rounded corners of the joined controls.
 */
export function ring(element: HTMLElement): void {
  const group = joinedGroup(element);
  const target = group ?? element;
  const skipped = motionSkipped(element);
  if (skipped && group && !motionSkipped(group)) return;
  const running = rings.get(target);
  running?.tween.stop();
  const own = running?.own ?? target.style.boxShadow;
  if (skipped || reduced()) {
    if (running) {
      rings.delete(target);
      restore(target, own, running.restoreRadius);
    }
    return;
  }
  const restoreRadius = running ? running.restoreRadius : group && roundGroup(group);
  const base = running ? undefined : getComputedStyle(target).boxShadow;
  const under = running?.under ?? (base && base !== "none" ? `, ${base}` : "");
  const handle = tween(0, 1, { duration, ease: easeOut }, (progress) => {
    const spread = progress < peak ? 5 * (progress / peak) : 5 + 2 * ((progress - peak) / (1 - peak));
    const alpha = progress < peak ? 1 : 1 - (progress - peak) / (1 - peak);
    target.style.boxShadow = `0 0 0 ${spread.toFixed(2)}px color-mix(in oklab, ${color} ${(alpha * 100).toFixed(1)}%, transparent)${under}`;
  }, () => {
    rings.delete(target);
    restore(target, own, restoreRadius);
  });
  rings.set(target, { tween: handle, own, restoreRadius, under });
}

/** True while `element`, or the field group it is joined to, rings. */
export function ringing(element: HTMLElement): boolean {
  return rings.has(joinedGroup(element) ?? element);
}

function restore(target: HTMLElement, own: string, restoreRadius?: () => void): void {
  target.style.boxShadow = own;
  restoreRadius?.();
  if (!target.getAttribute("style")) target.removeAttribute("style");
}

function joinedGroup(element: HTMLElement): HTMLElement | undefined {
  const group = element.parentElement;
  const orientation = group?.getAttribute("data-orientation");
  if (!group || (orientation !== "horizontal" && orientation !== "vertical") || group.childElementCount < 2) return undefined;
  const box = element.getBoundingClientRect();
  const vertical = orientation === "vertical";
  const joined = Array.from(group.children).some((child) => {
    if (child === element) return false;
    const other = child.getBoundingClientRect();
    if (!box.width || !box.height || !other.width || !other.height) return false;
    const gap = vertical
      ? Math.max(box.top - other.bottom, other.top - box.bottom)
      : Math.max(box.left - other.right, other.left - box.right);
    const overlap = vertical
      ? Math.min(box.right, other.right) - Math.max(box.left, other.left)
      : Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
    return overlap > 0 && gap >= -1 && gap <= 0;
  });
  return joined ? group : undefined;
}

function roundGroup(group: HTMLElement): (() => void) | undefined {
  if (cornerRadius(group) > 0) return undefined;
  const radius = Math.max(...Array.from(group.children, cornerRadius));
  if (!radius) return undefined;
  const { style } = group;
  const shorthand = style.getPropertyValue("border-radius");
  const properties = shorthand ? ["border-radius"] : corners;
  const original = properties.map(property => ({ property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) }));
  style.setProperty("border-radius", `${radius}px`);
  return () => {
    style.removeProperty("border-radius");
    for (const { property, value, priority } of original) if (value) style.setProperty(property, value, priority);
  };
}

function cornerRadius(element: Element): number {
  const style = getComputedStyle(element);
  return Math.max(...corners.map(radius => Number.parseFloat(style.getPropertyValue(radius)) || 0));
}
