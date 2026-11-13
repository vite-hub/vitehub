<script setup lang="ts">
// One illustration in a light and a dark file. The page shows the file of the color mode; both carry the same alt text.
const props = defineProps<{
  name?: string
  light?: string
  dark?: string
  alt: string
  /** Above the fold: load at once, with high priority. */
  eager?: boolean
}>()

const urls = computed(() => props.name ? illustrationUrls(props.name) : { light: props.light ?? "", dark: props.dark ?? "" })
</script>

<template>
  <span class="lumen-illustration">
    <img :src="urls.light" :alt="alt" width="480" height="360" :loading="eager ? 'eager' : 'lazy'" :fetchpriority="eager ? 'high' : undefined" decoding="async" class="dark:hidden">
    <img :src="urls.dark" :alt="alt" width="480" height="360" :loading="eager ? 'eager' : 'lazy'" :fetchpriority="eager ? 'high' : undefined" decoding="async" class="hidden dark:block">
  </span>
</template>

<style scoped>
.lumen-illustration {
  display: block;
  user-select: none;
}

.lumen-illustration img {
  width: 100%;
  height: auto;
  aspect-ratio: 4 / 3;
  margin: 0;
}
</style>
