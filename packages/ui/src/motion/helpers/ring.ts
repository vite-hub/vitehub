import { motionSkipped, reduced } from "./frame.ts";
import { easeOut, tween } from "./tween.ts";
import type { Tween } from "./tween.ts";

const duration = 720;
const peak = 0.3;
const color = "var(--ui-border-accented, currentColor)";

const rings = new WeakMap<HTMLElement, { tween: Tween; own: string; ownRadius: string; under: string }>();

/**
 * Rings `element` once, as rule 7 of docs/design/motion.md asks for a finished action such as saved, published, or
 * copied: a 5px ring in the border color grows around it and fades. A second call starts the ring again. There is no
 * ring under reduced motion or inside `data-motion="none"`. A control joined to others in a field group, such as
 * Nuxt UI's `UFieldGroup`, rings the whole group, with the rounded corners of the joined controls.
 */
export function ring(element: HTMLElement): void {
  const group = joinedGroup(element);
  const target = group ?? element;
  const running = rings.get(target);
  running?.tween.stop();
  const own = running?.own ?? target.style.boxShadow;
  const ownRadius = running?.ownRadius ?? target.style.borderRadius;
  if (motionSkipped(target) || reduced()) {
    if (running) {
      rings.delete(target);
      restore(target, own, ownRadius);
    }
    return;
  }
  if (group && !running && Math.max(...cornerRadii(group)) === 0) target.style.borderRadius = `${childRadius(group)}px`;
  const base = running ? undefined : getComputedStyle(target).boxShadow;
  const under = running?.under ?? (base && base !== "none" ? `, ${base}` : "");
  const handle = tween(0, 1, { duration, ease: easeOut }, (progress) => {
    const spread = progress < peak ? 5 * (progress / peak) : 5 + 2 * ((progress - peak) / (1 - peak));
    const alpha = progress < peak ? 1 : 1 - (progress - peak) / (1 - peak);
    target.style.boxShadow = `0 0 0 ${spread.toFixed(2)}px color-mix(in oklab, ${color} ${(alpha * 100).toFixed(1)}%, transparent)${under}`;
  }, () => {
    rings.delete(target);
    restore(target, own, ownRadius);
  });
  rings.set(target, { tween: handle, own, ownRadius, under });
}

/** True while `element`, or the field group it is joined to, rings. */
export function ringing(element: HTMLElement): boolean {
  return rings.has(joinedGroup(element) ?? element);
}

function restore(target: HTMLElement, own: string, ownRadius: string): void {
  target.style.boxShadow = own;
  target.style.borderRadius = ownRadius;
  if (!target.getAttribute("style")) target.removeAttribute("style");
}

function joinedGroup(element: HTMLElement): HTMLElement | undefined {
  const group = element.parentElement;
  if (!group?.hasAttribute("data-orientation") || group.childElementCount < 2) return undefined;
  return cornerRadii(element).includes(0) && childRadius(group) > 0 ? group : undefined;
}

function childRadius(group: HTMLElement): number {
  return Math.max(...Array.from(group.children, (child) => child instanceof HTMLElement ? Math.max(...cornerRadii(child)) : 0));
}

function cornerRadii(element: HTMLElement): number[] {
  const style = getComputedStyle(element);
  return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
    .map((radius) => Number.parseFloat(radius) || 0);
}
