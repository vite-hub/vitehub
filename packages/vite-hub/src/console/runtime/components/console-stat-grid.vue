<script setup lang="ts" generic="T extends ConsoleStat">
import type { ConsoleStat } from "./console-facts";

/**
 * Numbers and short facts as a grid of label and value, such as the totals of Usage or the size and type of a file.
 * Values use `tabular-nums`, so numbers line up and do not move when they change.
 * - `size="lg"` is for the key numbers at the top of a page: the value is 24px.
 * - The default size is for facts in a detail panel: the value is 13px.
 * - `framed` draws each cell inside one bordered box, for totals that read as one block.
 * The `#label` and `#value` slots replace the text of one cell, for a status dot or a skeleton.
 */
withDefaults(
  defineProps<{
    /** Columns on a wide screen. A phone shows two. */
    columns?: 2 | 3 | 4 | 5;
    framed?: boolean;
    items: readonly T[];
    /** The accessible name of the grid. */
    label?: string;
    size?: "md" | "lg";
  }>(),
  { columns: 2, framed: false, label: undefined, size: "md" },
);
defineSlots<{
  label?: (props: { item: T }) => unknown;
  value?: (props: { item: T }) => unknown;
}>();
const columnClass = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
} as const;
</script>

<template>
  <dl
    class="grid"
    :class="[
      columnClass[columns],
      framed ? 'gap-px overflow-hidden rounded-lg border border-default bg-(--ui-border)' : size === 'lg' ? 'gap-x-6 gap-y-4' : 'gap-x-4 gap-y-2',
    ]"
    :aria-label="label"
  >
    <div v-for="item in items" :key="item.label" class="grid min-w-0 content-start gap-1" :class="framed ? 'bg-default px-4 py-3' : ''">
      <dt class="truncate text-xs text-muted" :title="item.label">
        <slot name="label" :item="item">{{ item.label }}</slot>
      </dt>
      <!-- A key number keeps its hint on the same line, so every cell stays one row tall. -->
      <dd v-if="size === 'lg'" class="flex min-w-0 items-baseline gap-1.5">
        <span class="truncate text-2xl font-semibold tracking-[-0.015em] tabular-nums text-highlighted" :title="String(item.value)">
          <slot name="value" :item="item">{{ item.value }}</slot>
        </span>
        <span v-if="item.hint" class="shrink-0 text-xs text-muted">{{ item.hint }}</span>
      </dd>
      <template v-else>
        <dd class="min-w-0 truncate text-[13px] tabular-nums text-highlighted" :title="String(item.value)">
          <slot name="value" :item="item">{{ item.value }}</slot>
        </dd>
        <dd v-if="item.hint" class="text-xs text-pretty text-muted">{{ item.hint }}</dd>
      </template>
    </div>
  </dl>
</template>
