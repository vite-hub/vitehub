<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";

import { useConsoleApp } from "../client/app-identity";
import { resolveConsoleRouteName } from "../console-route";
import ConsoleAppLogo from "./console-app-logo.vue";

/** The first step of the page path: the logo and name of the open app. It leads to the Overview of the app. */
const app = useConsoleApp();
const route = useRoute();
const overview = computed(() => ({ name: resolveConsoleRouteName(route.name, "vitehub-console") }));
</script>

<template>
  <RouterLink :to="overview" class="vitehub-app-crumb">
    <ConsoleAppLogo :app="app" class="vitehub-app-crumb__logo" />
    <span class="truncate">{{ app.name }}</span>
  </RouterLink>
  <span class="hidden text-sm font-normal text-dimmed sm:inline" aria-hidden="true">/</span>
</template>

<style>
.vitehub-app-crumb {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  display: none;
  flex-shrink: 0;
  font-size: 0.875rem;
  font-weight: 400;
  gap: 0.5rem;
  max-width: 12rem;
}

.vitehub-app-crumb:hover {
  color: var(--ui-text-highlighted);
}

@media (min-width: 40rem) {
  .vitehub-app-crumb {
    display: inline-flex;
  }
}

.vitehub-app-crumb .vitehub-app-crumb__logo {
  border-radius: 0.25rem;
  font-size: 0.5625rem;
  height: 1.125rem;
  width: 1.125rem;
}
</style>
