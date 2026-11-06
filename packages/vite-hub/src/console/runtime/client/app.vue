<template>
  <UApp :toaster="null">
    <!-- Until the project answers, the Console sends it no other request: a token or a link may come first. -->
    <ConsoleProjectGate v-if="gate.kind !== 'ready'" />
    <template v-else>
      <!-- The first Tab stop. It skips the section rail, which has about 20 stops before the page content. -->
      <a href="#vitehub-console-content" class="vitehub-console__skip-link" @click.prevent="skipToContent">Skip to content</a>
      <!-- One frame for every route, so the rail stays mounted while a page loads and between sections. -->
      <ConsoleFrame :active="active" :sections-base="sectionsBase">
        <RouterView v-slot="{ Component }">
          <component :is="Component" v-if="Component" />
          <!-- The same panel and status as the server page, so the first paint does not change shape. -->
          <UDashboardPanel v-else id="console-opening" :ui="{ body: 'p-0 sm:p-0' }">
            <template #header>
              <UDashboardNavbar :toggle="false" :ui="{ root: 'border-0' }" />
            </template>
            <template #body>
              <p role="status" class="vitehub-console-opening">
                <UIcon name="i-lucide-loader-circle" class="size-4 motion-safe:animate-spin" aria-hidden="true" />
                Opening Console…
              </p>
            </template>
          </UDashboardPanel>
        </RouterView>
      </ConsoleFrame>
    </template>
  </UApp>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";

import { isConsoleSectionId } from "../sections";
import ConsoleFrame from "../components/console-frame.vue";
import ConsoleProjectGate from "../components/console-project-gate.vue";
import { useConsoleProjects } from "./project-session";

defineProps<{ sectionsBase: string }>();

const route = useRoute();
const gate = useConsoleProjects().gate;
// The Overview has no section, so the rail marks its home item.
const active = computed(() => isConsoleSectionId(route.meta.consoleSection) ? route.meta.consoleSection : undefined);

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
