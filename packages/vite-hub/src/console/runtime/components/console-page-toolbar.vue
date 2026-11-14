<script setup lang="ts">
/**
 * The row under a page header for search, filters, and view options: the same height, padding, and gap on every page
 * that lists things, such as a collection and Media. Put controls that belong at the end after an `ms-auto` wrapper.
 *
 * A `UTabs` strip goes in the `tabs` slot (or `tabs-end` for a view switch at the end), never in the default slot. The
 * slot rests the strip on the row's bottom border, so the tab line and the border are one line. On a phone the `tabs`
 * strip takes its own line under the controls, so it still rests on the border when the controls wrap.
 *
 * A page whose content uses the page width (`vitehub-console-page`) passes `width="page"`, so the controls start on the
 * content's edge. Without it, the row takes the full width, as full-width pages such as Database do.
 */
const props = defineProps<{
  width?: "page";
}>();
</script>

<template>
  <div class="flex shrink-0 border-b border-default">
    <div
      class="flex w-full flex-wrap gap-x-3"
      :class="props.width ? 'max-w-[78rem] px-4 sm:px-6' : 'px-3 sm:px-4'"
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
