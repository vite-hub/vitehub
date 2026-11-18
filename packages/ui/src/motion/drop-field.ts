import { isMotionOff } from "./layer.ts";
import { prefersReducedMotion } from "./reduced-motion.ts";
import { onEachFrame } from "./spring.ts";

// The numbers of the prototype's drop zone: a dot every 14px, 0.9px round at rest and 16% strong. A dot within 110px of
// the file grows by up to 1.9px, gets up to 70% stronger, and leans up to 3px toward it. The pull follows the file at
// 15% a frame, each dot at 20% a frame, at 60 frames a second.
const gap = 14;
const reach = 110;
const lean = 3;
const powerRate = 0.15;
const dotRate = 0.2;

export interface DropFieldOptions {
  /** The files that were dropped on the field. */
  onFiles?: (files: File[], event: DragEvent) => void;
  /** The element that draws the dots. Defaults to the field. Use it when the field covers more than the dots. */
  surface?: HTMLElement;
  /** True when the field takes this drag. Defaults to a drag that carries files. */
  accepts?: (event: DragEvent) => boolean;
}

export interface DropField {
  /** True while a file is over the field. The field also has `data-over` then. */
  readonly over: boolean;
  /** Removes the listeners and the dots. */
  destroy(): void;
}

interface Dot {
  x: number;
  y: number;
  /** How much the file pulls this dot, from 0 to 1. */
  pull: number;
}

const carriesFiles = (event: DragEvent) => [...event.dataTransfer?.types ?? []].includes("Files");

/** A rate per frame at 60 frames a second, for a step of `seconds`. */
const rate = (perFrame: number, seconds: number) => 1 - (1 - perFrame) ** (seconds * 60);

/**
 * The drop field of docs/design/motion.md: "Files are dragged in". A grid of dots behind the content of `surface` leans
 * toward the dragged file and rests again when it leaves or drops. It wraps the native file drop of `field`: the drag
 * events, `dropEffect`, and `onFiles`. A click or a key that opens a file picker stays with the field's own controls.
 *
 * The dots use `--vh-drop-dot`, or the text color of the surface. Under reduced motion and inside `data-motion="none"`
 * the dots stay still; `data-over` still marks the field, so its colors change.
 */
export function createDropField(field: HTMLElement, options: DropFieldOptions = {}): DropField {
  const surface = options.surface ?? field;
  const accepts = options.accepts ?? carriesFiles;
  const canvas = document.createElement("canvas");
  canvas.dataset.part = "dots";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { height: "100%", inset: "0", pointerEvents: "none", position: "absolute", width: "100%", zIndex: "-1" });
  if (getComputedStyle(surface).position === "static") surface.style.position = "relative";
  surface.style.isolation = "isolate";
  surface.prepend(canvas);
  const context = canvas.getContext("2d");

  let dots: Dot[] = [];
  let pointer = { x: -999, y: -999 };
  let over = false;
  let depth = 0;
  let power = 0;
  let stop: (() => void) | undefined;
  const still = () => prefersReducedMotion() || isMotionOff(surface);

  function build(): void {
    dots = [];
    for (let y = gap / 2 + 3; y < surface.clientHeight; y += gap) {
      for (let x = gap / 2 + 3; x < surface.clientWidth; x += gap) dots.push({ x, y, pull: 0 });
    }
  }

  // Draws one frame. Returns true while a dot still moves.
  function draw(seconds: number): boolean {
    if (!context) return false;
    const ratio = devicePixelRatio || 1;
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const style = getComputedStyle(surface);
    context.fillStyle = style.getPropertyValue("--vh-drop-dot").trim() || style.color;
    const target = over ? 1 : 0;
    const quiet = still();
    power += (target - power) * rate(powerRate, seconds);
    let moving = false;
    for (const dot of dots) {
      const distance = Math.hypot(dot.x - pointer.x, dot.y - pointer.y);
      const want = quiet ? 0 : power * Math.max(0, 1 - distance / reach) ** 2;
      dot.pull += (want - dot.pull) * rate(dotRate, seconds);
      if (Math.abs(want - dot.pull) > 0.002) moving = true;
      const shift = quiet ? 0 : dot.pull * lean;
      const angle = Math.atan2(pointer.y - dot.y, pointer.x - dot.x);
      context.globalAlpha = 0.16 + dot.pull * 0.7;
      context.beginPath();
      context.arc(dot.x + Math.cos(angle) * shift, dot.y + Math.sin(angle) * shift, 0.9 + dot.pull * 1.9, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    return moving || Math.abs(power - target) > 0.01;
  }

  function kick(): void {
    if (stop) return;
    stop = onEachFrame((seconds) => {
      if (draw(seconds)) return true;
      stop = undefined;
      return false;
    });
  }

  function setOver(next: boolean): void {
    if (next === over) return;
    over = next;
    if (next) field.dataset.over = "";
    else delete field.dataset.over;
    kick();
  }

  function locate(event: DragEvent): void {
    const box = surface.getBoundingClientRect();
    pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  const onEnter = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    depth++;
    locate(event);
    setOver(true);
  };
  const onOver = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    locate(event);
    setOver(true);
    kick();
  };
  const onLeave = (event: DragEvent) => {
    if (!accepts(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) setOver(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    depth = 0;
    setOver(false);
    options.onFiles?.([...event.dataTransfer?.files ?? []], event);
  };
  field.addEventListener("dragenter", onEnter);
  field.addEventListener("dragover", onOver);
  field.addEventListener("dragleave", onLeave);
  field.addEventListener("drop", onDrop);
  const resize = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        build();
        draw(0);
      })
    : undefined;
  resize?.observe(surface);
  build();
  draw(0);

  return {
    get over() {
      return over;
    },
    destroy() {
      stop?.();
      resize?.disconnect();
      field.removeEventListener("dragenter", onEnter);
      field.removeEventListener("dragover", onOver);
      field.removeEventListener("dragleave", onLeave);
      field.removeEventListener("drop", onDrop);
      delete field.dataset.over;
      canvas.remove();
    },
  };
}
