<script setup lang="ts">
import { ref, watch } from "vue";

import type { ConsoleAppIdentity } from "../client/app-identity";

/** The favicon of an app in a frame, or the first letter of its name when the site has no favicon. */
const props = defineProps<{ app: ConsoleAppIdentity }>();

const failed = ref(false);
watch(() => props.app.icon, () => { failed.value = false; });
</script>

<template>
  <span class="vitehub-app-logo" aria-hidden="true">
    <img v-if="app.icon && !failed" :src="app.icon" alt="" referrerpolicy="no-referrer" @error="failed = true">
    <span v-else>{{ app.letter }}</span>
  </span>
</template>

<style>
/* The frame takes its size from the caller. The favicon fills 60% of it, as Vercel and Executor show logos. */
.vitehub-app-logo {
  align-items: center;
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
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
