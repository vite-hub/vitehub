<script setup lang="ts">
/**
 * The row under a page header for search, filters, and view options: the same height, padding, and gap on every page
 * that lists things, such as a collection and Media. Put controls that belong at the end after an `ms-auto` wrapper.
 *
 * A page that centers its content in a column passes the same `width`, so the controls start on the content's edge.
 */
const props = defineProps<{
  width?: "4xl" | "5xl" | "6xl";
}>();

const widths = {
  "4xl": "max-w-4xl px-4 sm:px-6",
  "5xl": "max-w-5xl px-4 sm:px-6",
  "6xl": "max-w-6xl px-4 sm:px-6",
} as const;
</script>

<template>
  <div class="flex min-h-12 shrink-0 border-b border-default">
    <div
      class="mx-auto flex w-full flex-wrap items-center gap-2 py-2"
      :class="props.width ? widths[props.width] : 'px-3 sm:px-4'"
    >
      <slot />
    </div>
  </div>
</template>
