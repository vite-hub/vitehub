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
          <UDashboardPanel v-else id="console-opening">
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

// The skip link moves focus to the first control of the page content: in the main landmark, or next to the first
// heading. Focus never lands on a container, so the theme's focus ring never frames the whole page. A page without a
// control gets the frame's hidden "Page content" target, which sits right after the rail.
const tabbable = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function skipToContent(): void {
  const content = document.querySelector<HTMLElement>("main")
    ?? document.querySelector<HTMLElement>(".vitehub-console h1")?.parentElement;
  const target = content?.querySelector<HTMLElement>(tabbable) ?? document.getElementById("vitehub-console-content");
  target?.focus();
}
</script>

<style>
.vitehub-console__skip-link {
  background: var(--ui-bg);
  border-radius: 0.375rem;
  box-shadow: var(--vh-shadow-floating);
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
</style>
