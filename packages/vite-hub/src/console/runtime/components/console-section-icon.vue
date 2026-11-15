<script setup lang="ts">
import { PrimitiveIcon, resolvePrimitiveIconName } from "@vite-hub/docs/primitive-rail";
import { computed } from "vue";

const props = defineProps<{
  /** Iconify name from the section details, such as `i-vitehub-kv`. */
  icon: string;
}>();

const primitiveIcon = computed(() => resolvePrimitiveIconName(props.icon));
</script>

<template>
  <!-- An `i-vitehub-*` icon renders inline, so it can move on hover in the rail. A contributed section can name any Iconify icon. -->
  <PrimitiveIcon v-if="primitiveIcon" :name="primitiveIcon" />
  <UIcon v-else :name="icon" aria-hidden="true" />
</template>
