<script setup lang="ts">
import { computed, useId } from "vue";
import type { AuthConsoleOverview } from "@vite-hub/auth/console";

const props = defineProps<{ analytics: NonNullable<AuthConsoleOverview["analytics"]> }>();
const titleId = useId();
const days = computed(() => props.analytics.days);
const maximum = computed(() =>
  Math.max(1, ...days.value.flatMap((day) => [day.signIns, day.signUps])),
);
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
</script>

<template>
  <section class="min-w-0 space-y-3" :aria-labelledby="titleId">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 :id="titleId" class="text-sm font-medium text-highlighted">
        Last 30 days <span class="font-normal text-muted">UTC</span>
      </h2>
      <div class="flex gap-3 text-xs text-muted">
        <span class="flex items-center gap-1.5"><span class="size-2 bg-primary" />Sign-ins</span
        ><span class="flex items-center gap-1.5"><span class="size-2 bg-info" />Sign-ups</span>
      </div>
    </div>
    <svg
      viewBox="0 0 640 180"
      class="h-40 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="Daily sign-ins and sign-ups. Exact counts follow in the data table."
    >
      <line
        v-for="fraction in [0, 0.5, 1]"
        :key="fraction"
        x1="32"
        x2="640"
        :y1="160 - fraction * 150"
        :y2="160 - fraction * 150"
        stroke="var(--ui-border)"
        stroke-dasharray="3 4"
      />
      <text x="0" y="15" font-size="10" fill="var(--ui-text-muted)">{{ maximum }}</text>
      <text x="0" y="160" font-size="10" fill="var(--ui-text-muted)">0</text>
      <g v-for="(day, index) in days" :key="day.day">
        <title>
          {{ dayLabel(day.day) }}: {{ day.signIns }} sign-ins, {{ day.signUps }} sign-ups
        </title>
        <rect
          :x="34 + index * 20"
          :y="160 - (day.signIns / maximum) * 150"
          width="7"
          :height="(day.signIns / maximum) * 150"
          fill="var(--ui-primary)"
        />
        <rect
          :x="42 + index * 20"
          :y="160 - (day.signUps / maximum) * 150"
          width="7"
          :height="(day.signUps / maximum) * 150"
          fill="var(--ui-info)"
        />
      </g>
    </svg>
    <div v-if="days.length" class="flex justify-between text-xs text-muted">
      <span>{{ dayLabel(days[0]!.day) }}</span
      ><span>{{ dayLabel(days.at(-1)!.day) }}</span>
    </div>
    <p v-if="!analytics.totals.signIns && !analytics.totals.signUps" class="text-xs text-muted">
      No sign-ins or sign-ups recorded in this period.
    </p>
    <details class="text-xs text-muted">
      <summary class="w-fit cursor-pointer rounded-sm focus-visible:outline-primary">
        Daily counts
      </summary>
      <table class="mt-2 w-full text-left tabular-nums">
        <caption class="sr-only">
          Auth events by UTC day
        </caption>
        <thead>
          <tr>
            <th scope="col" class="py-1 font-medium">Date</th>
            <th scope="col" class="font-medium">Sign-ins</th>
            <th scope="col" class="font-medium">Sign-ups</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="day in days" :key="day.day">
            <th scope="row" class="py-1 font-normal">{{ day.day }}</th>
            <td>{{ day.signIns }}</td>
            <td>{{ day.signUps }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </section>
</template>
