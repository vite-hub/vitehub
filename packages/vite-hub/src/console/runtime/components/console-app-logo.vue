<script lang="ts">
const loadedIcon = new Map<string, number>();
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { ConsoleAppIdentity } from "../client/app-identity";

/** The favicon of an app in a frame, or the first letter of its name when the site has no favicon. */
const props = defineProps<{ app: ConsoleAppIdentity }>();

const icons = computed(() => props.app.icons ?? []);
const key = computed(() => icons.value.join(" "));
const index = ref(loadedIcon.get(key.value) ?? 0);
watch(key, (value) => { index.value = loadedIcon.get(value) ?? 0; });
const icon = computed(() => icons.value[index.value]);

function loaded(): void {
  loadedIcon.set(key.value, index.value);
}

function next(): void {
  index.value += 1;
  loadedIcon.set(key.value, index.value);
}
</script>

<template>
  <span class="vitehub-app-logo" aria-hidden="true">
    <img v-if="icon" :key="icon" :src="icon" alt="" referrerpolicy="no-referrer" @load="loaded" @error="next">
    <span v-else>{{ app.letter }}</span>
  </span>
</template>

<style>
/* The frame takes its size from the caller. The favicon fills 60% of it, as Vercel and Executor show logos. */
.vitehub-app-logo {
  align-items: center;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  color: var(--muted-foreground);
  display: inline-flex;
  flex: none;
  font-size: 0.6875rem;
  font-weight: 600;
  height: 1.625rem;
  justify-content: center;
  line-height: 1;
  overflow: hidden;
  width: 1.625rem;
}

.vitehub-app-logo img {
  height: 60%;
  object-fit: contain;
  width: 60%;
}
</style>
