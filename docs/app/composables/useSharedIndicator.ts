import type { Ref } from "vue";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One indicator that moves between items, such as the underline of the active tab. Each item renders its own indicator
 * while it is active, so the server HTML already shows it. When another item becomes active, its indicator starts at the
 * place of the last one and moves to its own place. Pass `track` as the template ref of the indicator, and call `reset`
 * when no item is active, so the next one appears in place.
 */
export function useSharedIndicator(container: Readonly<Ref<HTMLElement | null>>) {
  let last: Box | null = null;
  let element: HTMLElement | null = null;

  function measure(target: HTMLElement): Box | null {
    const root = container.value?.getBoundingClientRect();
    if (!root) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.left - root.left, y: rect.top - root.top, width: rect.width, height: rect.height };
  }

  function track(target: unknown) {
    if (!(target instanceof HTMLElement) || target === element) return;
    // The last indicator can still be in the page while the new one mounts. Its current place beats the stored one.
    const from = element?.isConnected ? measure(element) : last;
    element = target;
    const next = measure(target);
    last = next;
    if (!from || !next || !next.width || !next.height || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const transform = `translate(${from.x - next.x}px, ${from.y - next.y}px) scale(${from.width / next.width}, ${from.height / next.height})`;
    target.animate([{ transformOrigin: "0 0", transform }, { transformOrigin: "0 0", transform: "none" }], {
      duration: 240,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  }

  function reset() {
    last = null;
    element = null;
  }

  return { track, reset };
}
