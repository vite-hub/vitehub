<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const answer = `## Fix

1. Measure each row after render.
2. Store the offsets in a cumulative array.
3. Recompute only the rows after a changed row.

\`\`\`ts
const offsets = heights.reduce<number[]>((all, height, index) => {
  all.push((all[index - 1] ?? 0) + height);
  return all;
}, []);
\`\`\``;

const length = ref(0);
const streaming = computed(() => length.value < answer.length);
const value = computed(() => answer.slice(0, length.value));
let interval: ReturnType<typeof setInterval> | undefined;

// Reveal the answer in small chunks, like a streamed text part.
onMounted(() => {
  interval = setInterval(() => {
    length.value = Math.min(answer.length, length.value + 6);
    if (!streaming.value) clearInterval(interval);
  }, 40);
});

onBeforeUnmount(() => clearInterval(interval));
</script>

<template>
  <div class="min-h-72">
    <AgentMarkdown :value="value" :streaming="streaming" />
  </div>
</template>
