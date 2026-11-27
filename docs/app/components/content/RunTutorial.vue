<script setup lang="ts">
import { isIsolatedTutorialPath } from "~/utils/runnable-tutorial";

// `::run-tutorial{to="/learn/first-agent"}` on a docs tutorial links to the copy that runs in the browser.
// The runnable page renders the same Markdown, so there it renders nothing.
defineProps<{ to: string }>();
const route = useRoute();
const runnable = computed(() => isIsolatedTutorialPath(route.path));
</script>

<template>
  <p v-if="!runnable" class="vh-run-tutorial">
    <UIcon name="i-lucide-play" class="size-4 shrink-0 self-center" aria-hidden="true" />
    <span>Prefer to skip the setup? <NuxtLink :to="to" class="font-medium text-highlighted underline underline-offset-2">Run this tutorial in your browser</NuxtLink> with a live editor and preview.</span>
  </p>
</template>

<style scoped>
.vh-run-tutorial {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
}
</style>
