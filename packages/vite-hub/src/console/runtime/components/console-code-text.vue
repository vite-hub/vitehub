<script setup lang="ts">
import { computed } from "vue";

/** Text whose names in backticks, such as `console.origins`, render as code. */
const props = defineProps<{ text: string }>();

const parts = computed(() => props.text.split("`").map((value, index) => ({ code: index % 2 === 1, value })));
</script>

<template>
  <template v-for="(part, index) in parts" :key="index">
    <code v-if="part.code" class="font-mono text-[0.92em]">{{ part.value }}</code>
    <template v-else>{{ part.value }}</template>
  </template>
</template>
