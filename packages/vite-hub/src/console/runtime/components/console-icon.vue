<script setup lang="ts">
import { Icon, iconLoaded } from "@iconify/vue";
import { computed } from "vue";

const props = defineProps<{
  /** Iconify name with the `i-` prefix, such as `i-lucide-x` or `i-vitehub-kv`. */
  name: string;
}>();

// Nuxt UI's `UIcon` gives Iconify the same name and `ssr` flag, so both draw the same SVG. The icon data comes from the
// collections that `client/icons.ts` and the Nuxt UI icon bundle add to Iconify.
const icon = computed(() => props.name.replace(/^i-/, ""));
// An icon that is already loaded draws in the first render, not after mount.
const ssr = computed(() => iconLoaded(icon.value));
</script>

<template>
  <Icon :icon="icon" :ssr="ssr" />
</template>
