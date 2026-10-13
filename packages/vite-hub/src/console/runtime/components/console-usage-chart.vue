<script setup lang="ts">
import { computed, useId } from "vue";

const props = defineProps<{
  empty: string;
  format: (value: number) => string;
  from: string;
  points: Array<{ label: string; partial: boolean; start: string; value: number }>;
  to: string;
}>();

const width = 1_000;
const height = 220;
const tickCount = 4;
const gradientId = `usage-area-${useId()}`;

function niceMaximum(peak: number): number {
  if (peak <= 0) return 0;
  const roughStep = peak / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  return Math.ceil(peak / step) * step;
}

const maximum = computed(() => niceMaximum(Math.max(0, ...props.points.map(point => point.value))));
const ticks = computed(() =>
  Array.from({ length: tickCount + 1 }, (_, index) => (maximum.value / tickCount) * index),
);

function y(value: number): number {
  return maximum.value === 0 ? height : height - (value / maximum.value) * height;
}

function tickPosition(tick: number): string {
  return `${maximum.value === 0 ? 100 : 100 - (tick / maximum.value) * 100}%`;
}

const plotted = computed(() =>
  props.points.map((point, index) => ({
    ...point,
    x: props.points.length === 1 ? width / 2 : (index / (props.points.length - 1)) * width,
    y: y(point.value),
  })),
);
const line = computed(() =>
  plotted.value
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" "),
);
const area = computed(() => (line.value ? `${line.value} L${width},${height} L0,${height} Z` : ""));
const hasActivity = computed(() => plotted.value.some(point => point.value > 0));
const partialPoints = computed(() => plotted.value.filter(point => point.partial && point.value > 0));
</script>

<template>
  <div class="relative h-40 pl-14 pb-6" aria-label="Usage over time">
    <div class="absolute inset-y-6 left-0 w-12 text-right text-[10px] tabular-nums text-muted">
      <span
        v-for="tick in ticks"
        :key="tick"
        class="absolute right-0 -translate-y-1/2"
        :style="{ top: tickPosition(tick) }"
        >{{ format(tick) }}</span
      >
    </div>
    <div class="relative h-full border-b border-default">
      <svg
        class="absolute inset-0 size-full overflow-visible"
        :viewBox="`0 0 ${width} ${height}`"
        preserveAspectRatio="none"
        role="img"
      >
        <defs>
          <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="currentColor" stop-opacity="0.22" />
            <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <line
          v-for="tick in ticks"
          :key="`grid-${tick}`"
          x1="0"
          :y1="y(tick)"
          :x2="width"
          :y2="y(tick)"
          vector-effect="non-scaling-stroke"
          class="stroke-default"
          stroke-width="1"
          stroke-dasharray="3 4"
        />
        <path v-if="hasActivity" :d="area" :fill="`url(#${gradientId})`" class="text-primary" />
        <path
          v-if="hasActivity"
          :d="line"
          fill="none"
          class="stroke-primary"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
        <circle
          v-for="point in partialPoints"
          :key="`partial-${point.start}`"
          :cx="point.x"
          :cy="point.y"
          r="4"
          class="fill-warning stroke-default"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <p v-if="!hasActivity" class="absolute inset-0 grid place-items-center text-xs text-muted">
        {{ empty }}
      </p>
      <div
        class="absolute inset-0 grid"
        :style="{ gridTemplateColumns: `repeat(${Math.max(plotted.length, 1)}, minmax(0, 1fr))` }"
      >
        <UTooltip v-for="point in plotted" :key="point.start" :text="point.label">
          <button class="h-full w-full cursor-crosshair" :aria-label="point.label" />
        </UTooltip>
      </div>
      <span class="absolute top-full left-0 mt-2 text-[10px] text-muted">{{ from }}</span>
      <span class="absolute top-full right-0 mt-2 text-[10px] text-muted">{{ to }}</span>
    </div>
  </div>
</template>
