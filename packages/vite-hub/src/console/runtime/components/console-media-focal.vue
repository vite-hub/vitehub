<script setup lang="ts">
import { computed, ref } from "vue";

import { consoleAspectRatio, consoleFocalCropPosition, consoleMediaAspects } from "../client/media-library";

import type { ConsoleMediaFocal } from "../client/media-library";

/**
 * Sets the focal point of an image: click or drag on the image, or focus the marker and use the arrow keys (Shift for
 * larger steps). The previews below show how each common aspect crops around the point, the same way the serve route
 * crops variants. The model updates on release, so a drag saves once.
 */
const props = defineProps<{
  alt?: string;
  color?: string;
  disabled?: boolean;
  /** Natural size, so the frame keeps the image's aspect before it loads. */
  height?: number;
  src: string;
  width?: number;
}>();

const model = defineModel<ConsoleMediaFocal | undefined>();

const frame = ref<HTMLElement>();
const dragging = ref<ConsoleMediaFocal>();
const point = computed(() => dragging.value ?? model.value ?? { x: 0.5, y: 0.5 });
const ratio = computed(() => (props.width && props.height ? props.width / props.height : 4 / 3));

function round(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 1) * 1_000) / 1_000;
}

function at(event: PointerEvent): ConsoleMediaFocal | undefined {
  const box = frame.value?.getBoundingClientRect();
  if (!box?.width || !box.height) return undefined;
  return { x: round((event.clientX - box.left) / box.width), y: round((event.clientY - box.top) / box.height) };
}

function down(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = at(event);
}

function move(event: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = at(event) ?? dragging.value;
}

function up(): void {
  if (!dragging.value) return;
  const next = dragging.value;
  dragging.value = undefined;
  if (next.x !== model.value?.x || next.y !== model.value?.y) model.value = next;
}

function key(event: KeyboardEvent): void {
  if (props.disabled) return;
  const step = event.shiftKey ? 0.1 : 0.01;
  const delta = { ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step] }[event.key];
  if (!delta) return;
  event.preventDefault();
  model.value = { x: round(point.value.x + delta[0]!), y: round(point.value.y + delta[1]!) };
}

const previews = computed(() => consoleMediaAspects.map(entry => ({ ...entry, ratio: consoleAspectRatio(entry.aspect) ?? 1 })));
const percent = (value: number) => `${Math.round(value * 100)}%`;
</script>

<template>
  <div class="grid gap-3">
    <div
      ref="frame"
      class="vitehub-media-focal relative w-full touch-none overflow-hidden rounded-md select-none"
      :class="disabled ? '' : 'cursor-crosshair'"
      :style="{ aspectRatio: String(ratio), background: color ?? 'var(--ui-bg-elevated)' }"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
    >
      <img :src="src" :alt="alt ?? ''" class="absolute inset-0 size-full object-contain" draggable="false">
      <button
        type="button"
        class="vitehub-media-focal__marker"
        :style="{ left: percent(point.x), top: percent(point.y) }"
        :disabled="disabled"
        :aria-label="`Focal point, ${percent(point.x)} from the left and ${percent(point.y)} from the top. Use the arrow keys to move it.`"
        @keydown="key"
        @pointerdown.stop="down"
      />
    </div>
    <div class="grid grid-cols-4 items-end gap-2" aria-label="Crop previews">
      <figure v-for="preview in previews" :key="preview.aspect" class="grid gap-1">
        <div class="overflow-hidden rounded-sm ring-1 ring-(--ui-border) ring-inset" :style="{ aspectRatio: String(preview.ratio), background: color ?? 'var(--ui-bg-elevated)' }">
          <img :src="src" alt="" class="size-full object-cover" :style="{ objectPosition: consoleFocalCropPosition(point, { width, height }, preview.ratio) }" draggable="false">
        </div>
        <figcaption class="text-[11px] text-dimmed tabular-nums">{{ preview.aspect }}</figcaption>
      </figure>
    </div>
  </div>
</template>

<style>
/* A ring marker that reads on light and dark images: a white ring with a dark outline, and a dot in the middle. */
.vitehub-media-focal__marker {
  border-radius: 999px;
  box-shadow: 0 0 0 1.5px rgb(255 255 255 / 0.95), 0 0 0 3px rgb(0 0 0 / 0.35), 0 1px 6px rgb(0 0 0 / 0.3);
  height: 1.375rem;
  position: absolute;
  transform: translate(-50%, -50%);
  width: 1.375rem;
}

.vitehub-media-focal__marker::after {
  background: rgb(255 255 255);
  border-radius: 999px;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.35);
  content: "";
  height: 0.25rem;
  left: 50%;
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 0.25rem;
}

.vitehub-media-focal__marker:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 3px;
}

.vitehub-media-focal__marker:disabled {
  cursor: default;
}
</style>
