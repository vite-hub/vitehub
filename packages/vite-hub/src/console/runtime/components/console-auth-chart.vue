<script setup lang="ts">
import { computed } from "vue";
import type { AuthConsoleOverview } from "@vite-hub/auth/console";
import ConsoleSection from "./console-section.vue";

const props = defineProps<{ analytics: NonNullable<AuthConsoleOverview["analytics"]> }>();
const days = computed(() => props.analytics.days);
const maximum = computed(() =>
  Math.max(1, ...days.value.flatMap((day) => [day.signIns, day.signUps])),
);
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
</script>

<template>
  <ConsoleSection title="Last 30 days" description="UTC days">
    <template #actions>
      <div class="flex gap-3 text-xs text-muted">
        <span class="flex items-center gap-1.5"><span class="size-2 bg-primary" />Sign-ins</span
        ><span class="flex items-center gap-1.5"><span class="size-2 bg-(--ui-text-dimmed)" />Sign-ups</span>
      </div>
    </template>
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
          fill="var(--ui-text-dimmed)"
        />
      </g>
    </svg>
    <div v-if="days.length" class="flex justify-between text-xs text-muted">
      <span>{{ dayLabel(days[0]!.day) }}</span
      ><span>{{ dayLabel(days.at(-1)!.day) }}</span>
    </div>
    <UEmpty
      v-if="!analytics.totals.signIns && !analytics.totals.signUps"
      variant="naked"
      size="sm"
      icon="i-lucide-chart-column"
      title="No sign-ins or sign-ups in this period"
      description="Each day fills in when people sign in or sign up."
    />
    <details class="group text-xs">
      <summary class="inline-flex cursor-pointer items-center gap-1 rounded-md text-muted select-none hover:text-highlighted">
        <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
        Show data table
      </summary>
      <div class="mt-2 max-h-64 overflow-y-auto rounded-lg border border-default">
        <table class="w-full text-xs">
          <caption class="sr-only">
            Auth events by UTC day
          </caption>
          <thead class="sticky top-0 bg-default text-left text-muted">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">Day (UTC)</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">Sign-ins</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">Sign-ups</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="day in days" :key="day.day" class="border-t border-default">
              <th scope="row" class="px-3 py-1.5 text-left font-normal">{{ dayLabel(day.day) }}</th>
              <td class="px-3 py-1.5 text-right tabular-nums text-highlighted">{{ day.signIns }}</td>
              <td class="px-3 py-1.5 text-right tabular-nums text-highlighted">{{ day.signUps }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </ConsoleSection>
</template>
