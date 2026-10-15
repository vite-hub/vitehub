<script setup lang="ts">
import ConsoleValue from "./console-value.vue";

/**
 * Read-only properties as label and value rows, such as the fields of a Definition or the metadata of a Blob object.
 * Values show the Console way (see ConsoleValue): status words as dots and timestamps as relative times. `mono` sets
 * identifiers such as paths and ETags in Geist Mono. An empty list shows `empty` instead of rows.
 */
withDefaults(defineProps<{
  /** Shown instead of rows when `items` is empty. */
  empty?: string;
  items: readonly { label: string, mono?: boolean, value: string }[];
  /** Shows the number of rows after the title, for metadata lists. */
  count?: boolean;
  title?: string;
}>(), { count: false, empty: "Nothing to show." });
</script>

<template>
  <section class="grid gap-2" :aria-label="title">
    <h3 v-if="title" class="flex items-center gap-2 text-xs font-medium text-highlighted">
      {{ title }}
      <span v-if="count" class="font-normal text-dimmed tabular-nums">{{ items.length }}</span>
    </h3>
    <dl v-if="items.length" class="divide-y divide-default border-y border-default">
      <div v-for="item in items" :key="item.label" class="grid gap-1 py-2.5 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] sm:gap-4">
        <dt class="truncate text-[13px] text-muted" :title="item.label">{{ item.label }}</dt>
        <dd class="min-w-0 break-words text-highlighted" :class="item.mono ? 'font-mono text-xs leading-5' : 'text-[13px]'">
          <slot name="value" :item="item"><ConsoleValue :value="item.value" /></slot>
        </dd>
      </div>
    </dl>
    <p v-else class="text-[13px] text-muted">{{ empty }}</p>
  </section>
</template>
