<script setup lang="ts" generic="T extends ConsoleProperty">
import type { ConsoleProperty } from "./console-facts";
import ConsoleSection from "./console-section.vue";
import ConsoleValue from "./console-value.vue";

/**
 * Read-only properties as label and value rows, such as the fields of a Definition or the metadata of a Blob object.
 * Values show the Console way (see ConsoleValue): status words as dots and timestamps as relative times. `mono` sets
 * identifiers such as paths and ETags in Geist Mono. Line breaks in a value stay, so a list such as email headers shows one
 * entry per line. An empty list shows `empty` instead of rows. The `#value` slot replaces the value of a row, for a row
 * with its own control, such as "Change role"; items may carry extra fields for it.
 */
withDefaults(defineProps<{
  /** Shown instead of rows when `items` is empty. */
  empty?: string;
  emptyDescription?: string;
  items: readonly T[];
  /** Shows the number of rows after the title, for metadata lists. */
  count?: boolean;
  /** The heading level of `title`: 3 inside a panel, 2 directly under a page title. */
  level?: 2 | 3;
  title?: string;
}>(), { count: false, empty: "Nothing to show", emptyDescription: undefined, level: 3, title: undefined });
defineSlots<{
  value?: (props: { item: T }) => unknown;
}>();
</script>

<template>
  <component :is="title ? ConsoleSection : 'div'" v-bind="title ? { title, level, count: count ? items.length : undefined } : {}">
    <dl v-if="items.length" class="divide-y divide-default border-y border-default">
      <div v-for="(item, index) in items" :key="`${index}:${item.label}`" class="grid gap-1 py-2.5 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] sm:gap-4">
        <dt class="truncate text-[13px] text-muted" :title="item.label">{{ item.label }}</dt>
        <dd class="min-w-0 whitespace-pre-wrap break-words text-highlighted" :class="item.mono ? 'font-mono text-xs leading-5' : 'text-[13px]'">
          <slot name="value" :item="item"><ConsoleValue :value="item.value" /></slot>
        </dd>
      </div>
    </dl>
    <UEmpty v-else variant="naked" size="sm" icon="i-lucide-list" :title="empty" :description="emptyDescription" />
  </component>
</template>
