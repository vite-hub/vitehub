<script setup lang="ts">
/**
 * The row under a page header for search, filters, and view options: the same height, padding, and gap on every page
 * that lists things, such as a collection and Media. Put controls that belong at the end after an `ms-auto` wrapper.
 */
</script>

<template>
  <div class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-default px-3 py-2 sm:px-4">
    <slot />
  </div>
</template>
