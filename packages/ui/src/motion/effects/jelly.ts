import type { MotionEffect } from "../registry.ts";
import { prefersReducedMotion } from "../reduced-motion.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";
import { findIcons, iconShape } from "./icon-shape.ts";
import type { IconShape } from "./icon-shape.ts";

// The jelly bookmark of the prototype: a bulge runs down the body of the icon. First the waist swells, then the tails
// splay and lift, then a small rebound. The wave runs from 0 to 1.5 in 1.5 × 560ms.
const waveEnd = 1.5;
const waveSeconds = 0.56 * waveEnd;
const points = 120;

interface Wave {
  shape: IconShape;
  path: SVGGeometryElement;
  /** The points of the outline, sampled along the path. */
  outline: Array<[number, number]>;
  box: { top: number; height: number; center: number };
  clock: Spring;
}

const waves = new WeakMap<Element, Wave>();

/** The outline of the path at `wave`, as a closed polyline. The formula is the prototype's, for any path size. */
function deform({ outline, box }: Wave, wave: number): string {
  const amount = wave <= 1 ? 0.5 * Math.sin(Math.PI * wave) : -0.12 * Math.sin(Math.PI * (wave - 1) / 0.5);
  const crest = -0.15 + 1.35 * Math.min(1, Math.max(0, wave));
  // The prototype's bookmark is 18 units high: its tails lift by up to 4 of them.
  const lift = 4 * box.height / 18;
  return `M${outline.map(([x, y]) => {
    const along = (y - box.top) / box.height;
    const bulge = Math.exp(-(((along - crest) / 0.3) ** 2));
    const swell = amount * bulge * (0.12 + 1.1 * Math.max(0, along) ** 1.6);
    const nextX = box.center + (x - box.center) * (1 + swell);
    const nextY = along > 0.8 ? y - amount * bulge * lift * (along - 0.8) : y;
    return `${nextX.toFixed(2)} ${nextY.toFixed(2)}`;
  }).join("L")}Z`;
}

// A path of one closed outline, such as a bookmark or a star. A path with a second `M` would join its parts.
function singleOutline(shape: IconShape): SVGGeometryElement | undefined {
  const [path, ...rest] = shape.shapes;
  if (rest.length || !(path instanceof SVGPathElement)) return;
  const data = path.getAttribute("d") ?? "";
  return /^[Mm][^MmZz]+[Zz]\s*$/.test(data.trim()) ? path : undefined;
}

function start(icon: HTMLElement | SVGSVGElement): void {
  const running = waves.get(icon);
  if (running) {
    // A second toggle starts the wave again from the outline of the first.
    running.clock.set(0);
    running.clock.to(1, { tween: waveSeconds });
    return;
  }
  const shape = iconShape(icon);
  const path = shape && singleOutline(shape);
  if (!shape || !path) return;
  const sampled = shape.measure(([geometry]) => {
    const length = geometry!.getTotalLength();
    const bounds = geometry!.getBBox();
    const outline = Array.from({ length: points }, (_, index): [number, number] => {
      const point = geometry!.getPointAtLength(length * index / points);
      return [point.x, point.y];
    });
    return { outline, box: { top: bounds.y, height: bounds.height, center: bounds.x + bounds.width / 2 } };
  });
  if (!sampled.box.height) return;
  const wave: Wave = {
    shape,
    path,
    ...sampled,
    // The tween eases out with a cube. The wave runs at an even speed, so it reads the time back from the eased value.
    clock: createSpring(0, (eased) => {
      const time = 1 - Math.cbrt(1 - Math.min(1, eased));
      if (time >= 1 || !icon.isConnected) {
        waves.delete(icon);
        wave.clock.stop();
        shape.restore();
        return;
      }
      shape.set(path, "d", deform(wave, time * waveEnd));
      shape.commit();
    }),
  };
  waves.set(icon, wave);
  wave.clock.to(1, { tween: waveSeconds });
}

// The changes of one batch, by parent. A row where one button turns on while another turns off at the same time is a
// choice of one of many, such as a segmented control, not a toggle, so it does not wobble.
let batch: Map<Element | null, HTMLElement[]> | undefined;

function flush(): void {
  const changes = batch!;
  batch = undefined;
  for (const elements of changes.values()) {
    const states = new Set(elements.map(element => element.getAttribute("aria-pressed") === "true"));
    if (states.size > 1) continue;
    for (const element of elements) {
      const icons = findIcons(element);
      // Only a toggle with one icon, such as a bookmark, a star, or a pin. Icons that are not one outline only squash.
      if (icons.length === 1) start(icons[0]!);
    }
  }
}

export const jelly: MotionEffect = {
  name: "jelly",
  selector: "[aria-pressed]",
  state(element, { attribute }) {
    if (attribute !== "aria-pressed" || prefersReducedMotion()) return;
    if (!batch) {
      batch = new Map();
      queueMicrotask(flush);
    }
    const siblings = batch.get(element.parentElement) ?? [];
    siblings.push(element);
    batch.set(element.parentElement, siblings);
  },
};
