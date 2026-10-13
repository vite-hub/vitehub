<script setup lang="ts">
import type { ConsoleSectionId } from "../sections";
import ConsoleRail from "./console-rail.vue";

defineProps<{
  /** Section that the current page shows. Leave it unset on the Overview. */
  active?: ConsoleSectionId;
  sectionsBase: string;
}>();
</script>

<template>
  <UDashboardGroup class="vitehub-console" unit="rem" storage-key="vitehub-console-v2">
    <ConsoleRail :active="active" :sections-base="sectionsBase" />
    <slot />
  </UDashboardGroup>
</template>

<style>
.vitehub-console {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.vitehub-console__nav[data-slot="root"] {
  background: var(--ui-bg-muted);
  border-inline-end: 1px solid var(--ui-border);
}

/* The context panel matches the primitive rail from @vite-hub/ui: the same surface and hairline. */
.dark .vitehub-console__nav[data-slot="root"] {
  background: #000;
}

.vitehub-console__nav [data-slot="header"] {
  min-height: 2.75rem;
  padding-inline: 0.5rem;
}

/* The search entry is a ghost row in every sidebar, like T3 Code's search row. */
.vitehub-console .vitehub-console__search {
  justify-content: flex-start !important;
  border: 0 !important;
  box-shadow: none !important;
  color: var(--ui-text-muted) !important;
  font-size: 0.8125rem !important;
  font-weight: 500 !important;
  height: 2rem !important;
  min-height: 2rem !important;
  padding-inline: 0.5rem !important;
}

.vitehub-console .vitehub-console__search:hover {
  color: var(--ui-text) !important;
}

/* The shortcut stays visible as quiet monospace text, not as key caps. */
.vitehub-console .vitehub-console__search [data-slot="trailing"] {
  gap: 0;
  opacity: 1;
}

.vitehub-console .vitehub-console__search [data-slot="trailing"] kbd {
  background: transparent;
  box-shadow: none;
  color: var(--ui-text-dimmed);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 0.6875rem;
  min-width: 0;
  padding-inline: 0.0625rem;
  transition: color 150ms ease;
}

.vitehub-console .vitehub-console__search:hover [data-slot="trailing"] kbd,
.vitehub-console .vitehub-console__search:focus-visible [data-slot="trailing"] kbd {
  color: var(--ui-text-muted);
}

/* A context panel opens with the section title, like the panel headers in Linear and Featurebase. */
.vitehub-console__panel-title {
  align-items: center;
  color: var(--ui-text-highlighted);
  display: flex;
  font-size: 0.875rem;
  font-weight: 600;
  gap: 0.5rem;
  height: 2rem;
  min-width: 0;
  padding-inline: 0.5rem;
}
</style>
