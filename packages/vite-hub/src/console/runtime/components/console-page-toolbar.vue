<script setup lang="ts">
/**
 * The row under a page header for search, filters, and view options: the same height, padding, and gap on every page
 * that lists things, such as a collection and Media. Put controls that belong at the end after an `ms-auto` wrapper.
 *
 * A `UTabs` strip goes in the `tabs` slot (or `tabs-end` for a view switch at the end), never in the default slot. The
 * slot rests the strip on the row's bottom border, so the tab line and the border are one line. On a phone the `tabs`
 * strip takes its own line under the controls, so it still rests on the border when the controls wrap.
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
  <div class="flex shrink-0 border-b border-default">
    <div
      class="mx-auto flex w-full flex-wrap gap-x-3"
      :class="props.width ? widths[props.width] : 'px-3 sm:px-4'"
    >
      <!-- The 1px padding keeps the active tab's line inside the scroller, and the negative margin lays it on the border. -->
      <div v-if="$slots.tabs" class="order-last -mb-px w-full min-w-0 self-end overflow-x-auto pb-px sm:order-none sm:w-auto">
        <slot name="tabs" />
      </div>
      <div class="flex min-h-12 min-w-0 flex-1 flex-wrap items-center gap-2 py-2">
        <slot />
      </div>
      <div v-if="$slots['tabs-end']" class="-mb-px shrink-0 self-end pb-px">
        <slot name="tabs-end" />
      </div>
    </div>
  </div>
</template>
