<script setup lang="ts">
import type { ConsoleSectionId } from "../sections";
import ConsoleRail from "./console-rail.vue";
import ConsoleToaster from "./console-toaster.vue";

defineProps<{
  /** Section that the current page shows. Leave it unset on the Overview. */
  active?: ConsoleSectionId;
  sectionsBase: string;
}>();
</script>

<template>
  <!-- Local storage keeps sidebar sizes and collapsed state across reloads; the cookie storage needs Nuxt to persist. -->
  <UDashboardGroup class="vitehub-console" unit="rem" storage="local" storage-key="vitehub-console-v2">
    <ConsoleRail :active="active" :sections-base="sectionsBase" />
    <slot />
    <!-- Console toasts render here, apart from the toaster of a host app. -->
    <ConsoleToaster />
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
  font-family: var(--font-mono);
  font-size: 0.75rem;
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

<style>
/*
 * The section sidebar of every Console section: pages, headings, and grouped rows, such as Content's collections,
 * Database tables, and Definitions. Rows match the rail: 2rem tall, 13px labels, a quiet background on hover and a
 * stronger one on the current row. Rows change at once, without a transition (Rauno: no motion on menus used many times
 * a day).
 */
.vitehub-console__section-nav {
  display: grid;
  gap: 1px;
  overflow-y: auto;
  padding: 0 0.5rem 0.75rem;
}

.vitehub-console__section-link {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  display: flex;
  font-size: 0.8125rem;
  font-weight: 500;
  gap: 0.5rem;
  height: 2rem;
  min-width: 0;
  padding-inline: 0.5rem;
  position: relative;
}

.vitehub-console__section-link:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}

.vitehub-console__section-link[aria-current="page"],
.vitehub-console__section-link[aria-current="true"] {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

.vitehub-console__section-link:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.vitehub-console__section-nav.is-collapsed .vitehub-console__section-link {
  justify-content: center;
  padding-inline: 0;
}

/* A row with a second line, such as a Definition's source under its name. */
.vitehub-console__section-link.is-detailed {
  height: auto;
  min-height: 2.75rem;
  padding-block: 0.375rem;
}

.vitehub-console__section-icon {
  flex-shrink: 0;
  height: 1rem;
  width: 1rem;
}

/* A collection monogram sits in the same 16px box as a page icon. */
.vitehub-console__collection-mark {
  align-items: center;
  border: 1px solid var(--ui-border-accented);
  border-radius: 0.25rem;
  display: inline-flex;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 600;
  height: 1rem;
  justify-content: center;
  line-height: 1;
  min-width: 1rem;
  padding-inline: 0.125rem;
}

.vitehub-console__section-link[aria-current="page"] .vitehub-console__collection-mark {
  border-color: var(--ui-text-muted);
  color: var(--ui-text-highlighted);
}

.vitehub-console__section-heading {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 500;
  padding: 0.75rem 0.5rem 0.25rem;
}

.vitehub-console__section-rule {
  border-top: 1px solid var(--ui-border);
  margin: 0.375rem 0.5rem;
}

.vitehub-console__section-hint {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 400;
}

/* Counts are quiet: muted tabular numbers behind a status dot, no filled badge. */
.vitehub-console__pills {
  display: inline-flex;
  flex-shrink: 0;
  gap: 0.5rem;
}

.vitehub-console__pill {
  align-items: center;
  color: var(--ui-text-dimmed);
  display: inline-flex;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
  gap: 0.25rem;
}

.vitehub-console__pill-dot {
  border-radius: 999px;
  height: 0.375rem;
  width: 0.375rem;
}

.vitehub-console__pill-dot.is-draft {
  box-shadow: inset 0 0 0 1px var(--ui-text-dimmed);
}

.vitehub-console__pill-dot.is-changed {
  background: var(--ui-warning);
}

.vitehub-console__collapsed-dot {
  background: var(--ui-warning);
  border-radius: 999px;
  height: 0.375rem;
  position: absolute;
  right: 0.375rem;
  top: 0.375rem;
  width: 0.375rem;
}
</style>
