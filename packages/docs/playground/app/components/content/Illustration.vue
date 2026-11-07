<script setup lang="ts">
// `::illustration{name="guides" alt="..."}` in a page shows one illustration of the media library.
defineProps<{ name: string, alt: string }>()
</script>

<template>
  <figure class="not-prose my-8 max-w-md border border-default bg-default">
    <LumenIllustration :name="name" :alt="alt" />
  </figure>
</template>
