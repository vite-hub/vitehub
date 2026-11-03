<template>
  <UApp :toaster="null">
    <!-- The first Tab stop. It skips the section rail, which has about 20 stops before the page content. -->
    <a href="#vitehub-console-content" class="vitehub-console__skip-link" @click.prevent="skipToContent">Skip to content</a>
    <RouterView v-slot="{ Component }">
      <component :is="Component" v-if="Component" />
      <ConsoleLoading v-else />
    </RouterView>
  </UApp>
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
import ConsoleLoading from "../components/console-loading.vue";

// Prefer the page's main landmark or first heading; the shared frame supplies a fallback after the rail.
function skipToContent(): void {
  const target = document.querySelector<HTMLElement>("main")
    ?? document.querySelector<HTMLElement>(".vitehub-console h1")
    ?? document.getElementById("vitehub-console-content");
  if (!target) return;
  if (!target.matches("a[href], button, input, select, textarea, [tabindex]")) {
    target.tabIndex = -1;
    target.dataset.skipTarget = "";
  }
  target.focus();
}
</script>

<style>
.vitehub-console__skip-link {
  background: var(--ui-bg);
  border-radius: 0.375rem;
  box-shadow: 0 0 0 1px var(--ui-border-accented);
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
  inset-inline-start: 0.5rem;
  padding: 0.5rem 0.75rem;
  position: fixed;
  top: 0.5rem;
  transform: translateY(-200%);
  z-index: 200;
}

.vitehub-console__skip-link:focus-visible {
  transform: none;
}

/* Non-interactive skip targets do not draw a focus ring. */
[data-skip-target]:focus {
  outline: none;
}
</style>
