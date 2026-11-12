<script setup lang="ts">
// `::product-screenshot` shows the Console view of a primitive in a product hero, for primitives that a
// screenshot explains better than code. Give the light and the dark capture at the same size, so the
// page does not move when the color mode changes.
defineProps<{
  src: string;
  /** The capture in dark mode. The light capture shows when it is not set. */
  dark?: string;
  alt: string;
  /** Pixel size of the capture, so the page saves its space before the image loads. */
  width: number | string;
  height: number | string;
}>();
</script>

<template>
  <figure class="vh-screenshot not-prose">
    <img :src="src" :alt="alt" :width="width" :height="height" class="vh-screenshot-image" :class="{ 'is-light': dark }" decoding="async">
    <img v-if="dark" :src="dark" :alt="alt" :width="width" :height="height" class="vh-screenshot-image is-dark" decoding="async">
  </figure>
</template>

<style scoped>
.vh-screenshot {
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg-muted);
}

.vh-screenshot-image {
  display: block;
  width: 100%;
  height: auto;
}

.vh-screenshot-image.is-dark,
:root.dark .vh-screenshot-image.is-light {
  display: none;
}

:root.dark .vh-screenshot-image.is-dark {
  display: block;
}
</style>
