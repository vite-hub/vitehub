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
    <!-- Every page has a skip target, including pages without a main landmark or heading. -->
    <span id="vitehub-console-content" class="sr-only" tabindex="-1">Page content</span>
    <slot />
    <!-- Console toasts render here, apart from the toaster of a host app. -->
    <ConsoleToaster />
  </UDashboardGroup>
</template>

<style>
.vitehub-console {
  /* Sidebar and detail headers use the 44px height of the page header, so their titles and hairlines line up. */
  --ui-header-height: 2.75rem;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.vitehub-console__nav[data-slot="root"] {
  background: var(--ui-bg-muted);
  border-inline-end: 1px solid var(--ui-border);
}

.vitehub-console__nav [data-slot="header"] {
  min-height: 2.75rem;
  padding-inline: 0.5rem;
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

/*
 * The icon buttons of a panel title, such as Refresh and New chat, are 24px. On a touch screen each one takes the full
 * 44px header height and half of the 8px gap to its neighbors, so taps do not miss and never land on the next button.
 * Devices with only fine pointers keep 24px.
 */
@media (any-pointer: coarse) {
  .vitehub-console__panel-title :is(a, button) {
    position: relative;
  }

  .vitehub-console__panel-title :is(a, button)::before {
    content: "";
    inset: -0.625rem -0.25rem;
    position: absolute;
  }
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
  border-radius: 0.375rem;
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
