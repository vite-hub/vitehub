import { prefersReducedMotion } from "../reduced-motion.ts";
import type { MotionEffect, MotionRoot } from "../registry.ts";
import { writeMotionStyle } from "../registry.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";

/*
 * A panel opens beside the page (docs/design/motion.md): a sidebar that a person opens to show its labels gets wider, and
 * the page next to it makes room. Its width follows a spring (420, 30), the one of the prototype's panels, from the old
 * width to the new one.
 *
 * The panel sets `data-motion-panel`, and its stylesheet gives it a width for each value of one of its state attributes,
 * such as `[data-open]`. The effect writes `width` inline only while the spring moves.
 */

interface Resize {
  spring: Spring;
  /** The padding and the border that `width` does not count, for a `content-box` panel. */
  frame: number;
}

// The prototype's panels spring to their new width with these numbers.
const resizeSpring = { stiffness: 420, damping: 30 };
const panelSelector = "[data-motion-panel]";
const resizes = new WeakMap<HTMLElement, Resize>();
const widths = new WeakMap<HTMLElement, number>();
const tracking = new WeakMap<HTMLElement, number>();
// The spring counts in hundreds of pixels, so it settles when the width is still to the eye, as a spring from 0 to 1 does.
const unit = 100;

function stopResize(element: HTMLElement): void {
  const spring = resizes.get(element)?.spring;
  if (!spring?.active) return;
  spring.stop();
  writeMotionStyle(element, { width: null });
}

function watchPanels(root: MotionRoot): () => void {
  const panels = new Set<HTMLElement>();
  const resize = new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (target instanceof HTMLElement && panels.has(target) && !resizes.get(target)?.spring.active) {
        widths.set(target, target.getBoundingClientRect().width);
      }
    }
  });
  function track(element: HTMLElement): void {
    if (panels.has(element) || !root.contains(element) || !element.matches(panelSelector)) return;
    panels.add(element);
    const count = tracking.get(element) ?? 0;
    if (count === 0) widths.set(element, element.getBoundingClientRect().width);
    tracking.set(element, count + 1);
    resize.observe(element, { box: "border-box" });
  }
  function untrack(element: HTMLElement): void {
    panels.delete(element);
    resize.unobserve(element);
    const count = tracking.get(element) ?? 1;
    if (count > 1) {
      tracking.set(element, count - 1);
      return;
    }
    tracking.delete(element);
    stopResize(element);
    widths.delete(element);
  }
  const observer = new MutationObserver(records => {
    for (const element of panels) {
      if (!root.contains(element) || !element.matches(panelSelector)) untrack(element);
    }
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof HTMLElement) track(record.target);
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        track(node);
        for (const element of node.querySelectorAll<HTMLElement>(panelSelector)) track(element);
      }
    }
  });
  if (root instanceof HTMLElement) track(root);
  for (const element of root.querySelectorAll<HTMLElement>(panelSelector)) track(element);
  observer.observe(root, { subtree: true, childList: true, attributeFilter: ["data-motion-panel"] });
  return () => {
    observer.disconnect();
    for (const element of panels) untrack(element);
    resize.disconnect();
  };
}

function frameOf(element: HTMLElement): number {
  const style = getComputedStyle(element);
  if (style.boxSizing === "border-box") return 0;
  return [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((sum, value) => sum + Number.parseFloat(value), 0);
}

function write(element: HTMLElement, resize: Resize): void {
  writeMotionStyle(element, { width: `${resize.spring.value * unit - resize.frame}px` });
}

export const panel: MotionEffect = {
  name: "panel",
  selector: panelSelector,
  watch: watchPanels,
  state(element) {
    let resize = resizes.get(element);
    const from = resize?.spring.active ? resize.spring.value * unit : widths.get(element);
    if (resize?.spring.active) writeMotionStyle(element, { width: null });
    const to = element.getBoundingClientRect().width;
    widths.set(element, to);
    if (from === undefined || prefersReducedMotion() || Math.abs(to - from) < 0.5) {
      stopResize(element);
      return;
    }
    if (!resize) {
      const current: Resize = {
        frame: 0,
        spring: createSpring(from / unit, (width, velocity) => {
          if (velocity === 0 && width === current.spring.target) writeMotionStyle(element, { width: null });
          else write(element, current);
        }, resizeSpring),
      };
      resize = current;
      resizes.set(element, resize);
    }
    resize.frame = frameOf(element);
    // A spring that still moves keeps its speed toward the new width, so a fast second toggle never jumps.
    if (!resize.spring.active) resize.spring.set(from / unit);
    resize.spring.to(to / unit);
    // The first frame of the spring comes with the next paint. Until then the panel keeps its old width.
    if (resize.spring.active) write(element, resize);
  },
};
