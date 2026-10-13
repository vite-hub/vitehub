<script setup lang="ts">
import { computed, ref, useId } from "vue";

import type { ConsoleUsageChartPoint } from "./console-usage-model";
import { consoleUsageChartState, consoleUsageChartTicks, describeConsoleUsageChart } from "./console-usage-model";

const props = defineProps<{
  /** Text for a period range where every period reports zero. */
  empty: string;
  format: (value: number) => string;
  from: string;
  points: ConsoleUsageChartPoint[];
  title: string;
  to: string;
  /** Text for a period range where no period has evidence for the metric. */
  unavailable: string;
  /** Column heading for the values in the data table. */
  valueLabel: string;
}>();

const width = 1_000;
const height = 220;
const id = useId();
const gradientId = `usage-area-${id}`;
const titleId = `usage-chart-title-${id}`;
const descriptionId = `usage-chart-description-${id}`;

const state = computed(() => consoleUsageChartState(props.points));
const description = computed(() => describeConsoleUsageChart(props.points, props));
const ticks = computed(() => consoleUsageChartTicks(Math.max(0, ...props.points.map(point => point.value))));
const maximum = computed(() => ticks.value.at(-1) ?? 0);

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
// A period without evidence breaks the line, so an unknown value never reads as zero.
const segments = computed(() => {
  const result: Array<typeof plotted.value> = [];
  let current: typeof plotted.value = [];
  for (const point of plotted.value) {
    if (point.evidence === "unavailable") {
      if (current.length) result.push(current);
      current = [];
    }
    else current.push(point);
  }
  if (current.length) result.push(current);
  return result.map((points) => {
    const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    return {
      area: `${line} L${points.at(-1)!.x.toFixed(2)},${height} L${points[0]!.x.toFixed(2)},${height} Z`,
      line,
      single: points.length === 1 ? points[0] : undefined,
    };
  });
});
const partialPoints = computed(() => plotted.value.filter(point => point.evidence === "partial"));

// Pointer hover shows one period. Keyboard and screen reader users read the same values in the data table.
const hoverIndex = ref<number>();
const hovered = computed(() => (hoverIndex.value === undefined ? undefined : plotted.value[hoverIndex.value]));
function hover(event: PointerEvent): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement) || !plotted.value.length) return;
  const bounds = target.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
  hoverIndex.value = Math.round(ratio * (plotted.value.length - 1));
}
</script>

<template>
  <div>
    <div v-if="state === 'data'" class="relative h-40 pb-6 pl-14">
      <div class="absolute top-0 bottom-6 left-0 w-12 text-right text-[10px] tabular-nums text-muted" aria-hidden="true">
        <span
          v-for="tick in ticks"
          :key="tick"
          class="absolute right-0 -translate-y-1/2"
          :style="{ top: tickPosition(tick) }"
        >{{ format(tick) }}</span>
      </div>
      <div class="relative h-full border-b border-default" @pointermove="hover" @pointerleave="hoverIndex = undefined">
        <svg
          class="absolute inset-0 size-full overflow-visible"
          :viewBox="`0 0 ${width} ${height}`"
          preserveAspectRatio="none"
          role="img"
          :aria-labelledby="titleId"
          :aria-describedby="descriptionId"
          data-slot="usage-chart"
        >
          <title :id="titleId">{{ title }}</title>
          <desc :id="descriptionId">{{ description }}</desc>
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
          <template v-for="(segment, index) in segments" :key="index">
            <path :d="segment.area" :fill="`url(#${gradientId})`" class="text-primary" />
            <path
              :d="segment.line"
              fill="none"
              class="stroke-primary"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            />
            <circle
              v-if="segment.single"
              :cx="segment.single.x"
              :cy="segment.single.y"
              r="3"
              class="fill-primary"
              vector-effect="non-scaling-stroke"
            />
          </template>
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
        <div
          v-if="hovered"
          class="pointer-events-none absolute inset-y-0 w-px bg-(--ui-border-accented)"
          :style="{ left: `${(hovered.x / width) * 100}%` }"
          aria-hidden="true"
        >
          <div
            class="absolute top-0 w-max max-w-48 rounded-md border border-default bg-default px-2 py-1 text-xs shadow-sm"
            :class="hovered.x > width / 2 ? 'right-2' : 'left-2'"
          >
            <span class="block text-muted">{{ hovered.period }}</span>
            <span class="block font-medium tabular-nums text-highlighted">{{ hovered.display }}</span>
          </div>
        </div>
        <span class="absolute top-full left-0 mt-2 text-[10px] text-muted" aria-hidden="true">{{ from }}</span>
        <span class="absolute top-full right-0 mt-2 text-[10px] text-muted" aria-hidden="true">{{ to }} UTC</span>
      </div>
    </div>
    <div
      v-else
      class="grid h-40 place-content-center justify-items-center gap-2 rounded-md border border-dashed border-default px-4 text-center"
      :data-state="state"
      data-slot="usage-chart-empty"
    >
      <p class="text-sm font-medium" :class="state === 'unavailable' ? 'text-highlighted' : 'text-muted'">
        {{ state === "unavailable" ? unavailable : empty }}
      </p>
      <p class="text-xs text-muted">{{ from }} to {{ to }} UTC</p>
      <!-- Actions for the unavailable state, for example a switch to another metric. -->
      <slot v-if="state === 'unavailable'" name="unavailable" />
    </div>
    <details v-if="points.length" class="group mt-3 text-xs" data-slot="usage-chart-data">
      <summary class="inline-flex cursor-pointer items-center gap-1 rounded-sm text-muted select-none hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
        Show data table
      </summary>
      <div class="mt-2 max-h-64 overflow-y-auto rounded-md border border-default">
        <table class="w-full text-xs">
          <caption class="sr-only">{{ title }}, {{ from }} to {{ to }} UTC</caption>
          <thead class="sticky top-0 bg-default text-left text-muted">
            <tr>
              <th class="px-3 py-2 font-medium" scope="col">Period (UTC)</th>
              <th class="px-3 py-2 text-right font-medium" scope="col">{{ valueLabel }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="point in points" :key="point.start" class="border-t border-default">
              <th class="px-3 py-1.5 text-left font-normal" scope="row">{{ point.period }}</th>
              <td class="px-3 py-1.5 text-right tabular-nums" :class="point.evidence === 'complete' ? 'text-highlighted' : 'text-muted'">{{ point.display }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </div>
</template>
