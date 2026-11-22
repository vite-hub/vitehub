import { motionSkipped, reduced } from "./frame.ts";
import { easeOut, tween } from "./tween.ts";
import type { Tween } from "./tween.ts";

const duration = 720;
const peak = 0.3;
const color = "var(--ui-border-accented, currentColor)";

const rings = new WeakMap<HTMLElement, { tween: Tween; own: string; under: string }>();

/**
 * Rings `element` once, as rule 7 of docs/design/motion.md asks for a finished action such as saved, published, or
 * copied: a 5px ring in the border color grows around it and fades. A second call starts the ring again. There is no
 * ring under reduced motion or inside `data-motion="none"`.
 */
export function ring(element: HTMLElement): void {
  const running = rings.get(element);
  running?.tween.stop();
  const own = running?.own ?? element.style.boxShadow;
  if (motionSkipped(element) || reduced()) {
    if (running) {
      rings.delete(element);
      element.style.boxShadow = own;
    }
    return;
  }
  const base = running ? undefined : getComputedStyle(element).boxShadow;
  const under = running?.under ?? (base && base !== "none" ? `, ${base}` : "");
  const handle = tween(0, 1, { duration, ease: easeOut }, (progress) => {
    const spread = progress < peak ? 5 * (progress / peak) : 5 + 2 * ((progress - peak) / (1 - peak));
    const alpha = progress < peak ? 1 : 1 - (progress - peak) / (1 - peak);
    element.style.boxShadow = `0 0 0 ${spread.toFixed(2)}px color-mix(in oklab, ${color} ${(alpha * 100).toFixed(1)}%, transparent)${under}`;
  }, () => {
    rings.delete(element);
    element.style.boxShadow = own;
    if (!element.getAttribute("style")) element.removeAttribute("style");
  });
  rings.set(element, { tween: handle, own, under });
}

/** True while `element` rings. */
export function ringing(element: HTMLElement): boolean {
  return rings.has(element);
}
