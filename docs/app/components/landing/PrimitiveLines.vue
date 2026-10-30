<script setup lang="ts">
import {
  useEventListener,
  useMutationObserver,
  usePreferredReducedMotion,
  useRafFn,
  useResizeObserver,
} from "@vueuse/core";

const props = withDefaults(defineProps<{
  /** Icon name. The icon is drawn once off screen and read as a brightness map. */
  icon: string;
  /** The tile is hovered or focused. */
  active?: boolean;
  /** The grid is on screen. The first entrance waits for it. */
  play?: boolean;
  /** Entrance delay in milliseconds, so neighboring tiles do not draw in step. */
  delay?: number;
}>(), {
  active: false,
  play: true,
  delay: 0,
});

// Column pitch and row height in CSS pixels. Each row cell is one segment of a line.
const PITCH = 3;
const CELL = 2;
const MAX_WIDTH = 1.9;
const ENTRANCE = 760;
const POINTER_RADIUS = 28;

const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const source = useTemplateRef<HTMLElement>("source");
const reducedMotion = usePreferredReducedMotion();
const colorMode = useColorMode();

interface Field {
  width: number;
  height: number;
  dpr: number;
  // The icon box, in tile coordinates.
  x: number;
  y: number;
  size: number;
  cols: number;
  rows: number;
  brightness: Float32Array;
}

let field: Field | null = null;
let image: HTMLImageElement | null = null;

let entranceStart: number | null = null;
let energy = 0;
let push = 0;
let clock = 0;
let lastFrame = 0;
let pointer: { x: number; y: number } | null = null;
let activeChangedAt = 0;

const still = computed(() => reducedMotion.value === "reduce");

function smooth(value: number, target: number, dt: number, ms: number) {
  return value + (target - value) * (1 - Math.exp(-dt / ms));
}

function easeOut(t: number) {
  return 1 - (1 - t) ** 4;
}

// Turn the icon SVG into an image that the brightness map can read.
function readIcon() {
  const svg = source.value?.querySelector("svg");
  if (!svg) return;
  const markup = svg.outerHTML.includes("xmlns=")
    ? svg.outerHTML
    : svg.outerHTML.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  const next = new Image();
  next.onload = () => {
    image = next;
    measure();
  };
  next.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function measure() {
  const element = canvas.value;
  if (!element || !image) return;
  const width = element.clientWidth;
  const height = element.clientHeight;
  if (!width || !height) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  element.width = Math.round(width * dpr);
  element.height = Math.round(height * dpr);

  // The icon sits in the top right corner, above the name and description.
  const inset = 14;
  const size = Math.floor(Math.min(height * 0.56, width * 0.42));
  const cols = Math.floor(size / PITCH);
  const rows = Math.floor(size / CELL);

  // Draw the icon a little thicker and softer than its stroke, so line widths change smoothly at the edges.
  const sample = document.createElement("canvas");
  sample.width = size;
  sample.height = size;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  const spread = Math.max(1, size * 0.012);
  context.filter = `blur(${spread * 0.8}px)`;
  for (const [dx, dy] of [[0, 0], [spread, 0], [-spread, 0], [0, spread], [0, -spread]] as const) {
    context.drawImage(image, dx + size * 0.04, dy + size * 0.04, size * 0.92, size * 0.92);
  }
  const pixels = context.getImageData(0, 0, size, size).data;

  const brightness = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    const py = Math.min(size - 1, Math.round((row + 0.5) * CELL));
    for (let col = 0; col < cols; col++) {
      const px = Math.min(size - 1, Math.round((col + 0.5) * PITCH));
      brightness[row * cols + col] = (pixels[(py * size + px) * 4 + 3] ?? 0) / 255;
    }
  }

  field = {
    width,
    height,
    dpr,
    x: width - size - inset,
    y: inset,
    size,
    cols,
    rows,
    brightness,
  };
  draw(performance.now());
  wake();
}

function draw(now: number) {
  const element = canvas.value;
  const context = element?.getContext("2d");
  if (!element || !context || !field) return;

  const dt = lastFrame ? Math.min(now - lastFrame, 64) : 16;
  lastFrame = now;

  const target = props.active ? 1 : 0;
  energy = still.value ? target : smooth(energy, target, dt, props.active ? 140 : 260);
  push = still.value ? 0 : smooth(push, props.active && pointer ? 1 : 0, dt, props.active ? 90 : 220);
  if (energy > 0.001) clock += dt / 1000;

  const entrance = still.value || entranceStart === null
    ? (still.value ? 1 : 0)
    : Math.min(1, Math.max(0, (now - entranceStart - props.delay) / ENTRANCE));

  const { width, height, dpr, x: originX, y: originY, size, cols, rows, brightness } = field;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.globalCompositeOperation = "source-over";
  context.fillStyle = getComputedStyle(element).color;

  // Hairlines give the icon a field to stand in. They fade out at the top and bottom of the box.
  context.globalAlpha = 0.22;
  context.beginPath();
  for (let col = 0; col < cols; col++) {
    const reveal = easeOut(Math.min(1, Math.max(0, entrance * 1.6 - (col / cols) * 0.6)));
    if (!reveal) continue;
    context.rect(originX + (col + 0.5) * PITCH - 0.25, originY, 0.5, size * reveal);
  }
  context.fill();
  context.globalCompositeOperation = "destination-in";
  const fade = context.createLinearGradient(0, originY, 0, originY + size);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(0.2, "#000");
  fade.addColorStop(0.8, "#000");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  context.globalAlpha = 1;
  context.fillStyle = fade;
  context.fillRect(originX - 1, originY, size + 2, size);
  context.globalCompositeOperation = "source-over";
  context.fillStyle = getComputedStyle(element).color;

  // The icon itself: one segment per cell, wider where the icon is brighter.
  const t = clock;
  context.beginPath();
  for (let col = 0; col < cols; col++) {
    const reveal = easeOut(Math.min(1, Math.max(0, entrance * 1.6 - (col / cols) * 0.6)));
    if (!reveal) continue;
    const lineX = originX + (col + 0.5) * PITCH;
    const drop = (1 - reveal) * -12 + Math.sin(col * 0.5 + t * 2.2) * 1.2 * energy;
    for (let row = 0; row < rows; row++) {
      let value = brightness[row * cols + col] ?? 0;
      if (value < 0.02) continue;
      if (energy > 0.001) {
        // Bands of brightness flow down the lines while the tile is active.
        const wave = 0.5 + 0.5 * Math.sin(row * 0.21 - t * 5 + Math.sin(col * 0.37 + t) * 2);
        value *= 1 - energy * 0.45 + energy * 0.45 * (0.4 + wave);
      }
      const segment = value * MAX_WIDTH * reveal;
      if (segment < 0.3) continue;
      const lineY = originY + row * CELL + drop;
      let shift = 0;
      if (push > 0.001 && pointer) {
        const dx = lineX - pointer.x;
        const dy = lineY - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < POINTER_RADIUS) {
          const falloff = (1 - distance / POINTER_RADIUS) ** 2;
          shift = Math.sign(dx || 1) * falloff * POINTER_RADIUS * 0.3 * push;
        }
      }
      context.rect(lineX - segment / 2 + shift, lineY, segment, CELL);
    }
  }
  context.fill();

  const entering = !still.value && entranceStart !== null && entrance < 1;
  // Keep drawing while the CSS color transition runs, also when motion is reduced.
  const settling = Math.abs(energy - target) > 0.002 || push > 0.002 || now - activeChangedAt < 260;
  if (!entering && !settling && !(props.active && !still.value)) {
    pause();
    lastFrame = 0;
  }
}

const { pause, resume, isActive } = useRafFn(({ timestamp }) => draw(timestamp), { immediate: false });

function wake() {
  if (!isActive.value && field) resume();
}

// Start the entrance the first time the grid is on screen.
watch(() => props.play, (play) => {
  if (play && entranceStart === null) {
    entranceStart = performance.now();
    wake();
  }
}, { immediate: true });

watch(() => props.active, (active) => {
  activeChangedAt = performance.now();
  if (!active) pointer = null;
  wake();
});

watch(() => colorMode.value, () => nextTick(() => draw(performance.now())));

// Follow the pointer only while the tile is active. The canvas does not take pointer events.
useEventListener(window, "pointermove", (event: PointerEvent) => {
  if (!props.active || still.value || !canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
}, { passive: true });

useResizeObserver(canvas, () => measure());
useMutationObserver(source, () => {
  if (!image) readIcon();
}, { childList: true, subtree: true });
onMounted(readIcon);
</script>

<template>
  <div class="pointer-events-none absolute inset-0" aria-hidden="true">
    <canvas ref="canvas" class="size-full" />
    <span ref="source" class="hidden">
      <UIcon :name="icon" mode="svg" />
    </span>
  </div>
</template>
