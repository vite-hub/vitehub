<script setup lang="ts">
import { defineShortcuts } from "@nuxt/ui/composables";
import { nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";

import { closeConsoleSidebarDrawer, consoleSidebarDrawer, consoleSidebarOpen, toggleConsoleSidebar } from "../client/sidebar";
import ConsoleMark from "./console-mark.vue";
import ConsoleSidebarItem from "./console-sidebar-item.vue";

/**
 * The sidebar of every Console page, for the team and for an app. It is a 52px icon rail that the person opens to a
 * 232px sidebar with the button in the page header or the `[` key. It never opens on hover. Top to bottom: the brand
 * row, which leads to the apps of the team, Search, the `app` slot, the pages, and the `footer` slot with the user menu.
 *
 * On a narrow screen the rail stays, and the open sidebar covers the page as a drawer.
 */
withDefaults(defineProps<{
  /** Where the brand row leads: the apps of the team, or the Overview of the only app. */
  homeHref: string;
  homeLabel: string;
  team?: string;
  /** Show the Search row. Pages without a search palette, such as the pages of a team, turn it off. */
  search?: boolean;
}>(), { search: true });

const emit = defineEmits<{ home: [event: MouseEvent], search: [] }>();

// The width animates only after the first paint, so a sidebar that was open on the last visit does not grow on load.
const ready = ref(false);

const surface = useTemplateRef<HTMLElement>("surface");

// `[` opens and closes the sidebar on every page, as in Linear. It does not run while a field has focus.
defineShortcuts({ "[": toggleConsoleSidebar });

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !consoleSidebarDrawer.value || !consoleSidebarOpen.value) return;
  closeConsoleSidebarDrawer();
  document.querySelector<HTMLElement>(".vitehub-sidebar-trigger")?.focus();
}

// A drawer that opens takes focus to its current row, so the keyboard continues in the drawer.
watch(consoleSidebarOpen, (open) => {
  if (!open || !consoleSidebarDrawer.value) return;
  void nextTick(() => surface.value?.querySelector<HTMLElement>(".vitehub-sidebar__item[aria-current='page'], .vitehub-sidebar__item")?.focus());
});

onMounted(() => {
  requestAnimationFrame(() => { ready.value = true; });
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div
    class="vitehub-sidebar"
    :data-open="consoleSidebarOpen ? '' : undefined"
    :data-drawer="consoleSidebarDrawer ? '' : undefined"
    :data-ready="ready ? '' : undefined"
  >
    <!-- A drawer covers the page. A click outside it closes it. -->
    <div v-if="consoleSidebarDrawer && consoleSidebarOpen" class="vitehub-sidebar__scrim" aria-hidden="true" @click="closeConsoleSidebarDrawer" />
    <nav ref="surface" class="vitehub-sidebar__surface" aria-label="Console">
      <div class="vitehub-sidebar__top">
        <ConsoleSidebarItem class="vitehub-sidebar__brand" :label="homeLabel" :href="homeHref" @click="emit('home', $event)">
          <template #icon><ConsoleMark class="size-[1.125rem] text-highlighted!" /></template>
          <template #trailing>
            <span class="vitehub-sidebar__brand-text" aria-hidden="true">
              <span class="vitehub-sidebar__brand-name">ViteHub</span>
              <span v-if="team" class="vitehub-sidebar__brand-team">{{ team }}</span>
            </span>
          </template>
        </ConsoleSidebarItem>
      </div>

      <ConsoleSidebarItem v-if="search" class="vitehub-sidebar__search" label="Search" icon="i-lucide-search" :shortcut="['meta', 'k']" @click="emit('search')">
        <template #trailing>
          <UKbd value="meta" size="sm" class="vitehub-sidebar__fade" /><UKbd value="k" size="sm" class="vitehub-sidebar__fade" />
        </template>
      </ConsoleSidebarItem>

      <slot name="app" />

      <div v-if="search || $slots.app" class="vitehub-sidebar__rule" />
      <div class="vitehub-sidebar__scroll">
        <slot />
      </div>
      <div class="vitehub-sidebar__rule" />
      <slot name="footer" />
    </nav>
  </div>
</template>

<style>
/*
 * Measures: the rail is 52px and the open sidebar 232px. Rows are 34px with a 9px inset, so an 18px icon sits in the
 * middle of the 52px rail, and it keeps the same place when the sidebar opens. Labels are clipped, not hidden, so the
 * width can animate and nothing moves.
 */
.vitehub-sidebar {
  --vitehub-sidebar-rail: 3.25rem;
  --vitehub-sidebar-open: 14.5rem;
  flex: none;
  height: 100%;
  position: relative;
  width: var(--vitehub-sidebar-rail);
  z-index: 20;
}

.vitehub-sidebar[data-open]:not([data-drawer]) {
  width: var(--vitehub-sidebar-open);
}

.vitehub-sidebar__surface {
  background: var(--ui-bg-muted);
  border-inline-end: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
  inset-block: 0;
  inset-inline-start: 0;
  overflow: hidden;
  padding: 0 0.5rem 0.5rem;
  position: absolute;
  width: var(--vitehub-sidebar-rail);
}

.vitehub-sidebar[data-open] .vitehub-sidebar__surface {
  width: var(--vitehub-sidebar-open);
}

.vitehub-sidebar[data-drawer][data-open] .vitehub-sidebar__surface {
  box-shadow: var(--vh-shadow-floating);
}

.vitehub-sidebar__scrim {
  background: color-mix(in oklab, var(--ui-bg-inverted) 20%, transparent);
  inset: 0;
  position: fixed;
}

@media (prefers-reduced-motion: no-preference) {
  .vitehub-sidebar[data-ready],
  .vitehub-sidebar[data-ready] .vitehub-sidebar__surface {
    transition: width 200ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .vitehub-sidebar[data-ready] :is(.vitehub-sidebar__label, .vitehub-sidebar__badge, .vitehub-sidebar__fade, .vitehub-sidebar__brand-text, .vitehub-sidebar__group-label, .vitehub-sidebar__group-label::after) {
    transition: opacity 150ms ease-out, color 150ms ease-out;
  }
}

/* The brand row is as tall as the page header, so its bottom line continues the header line. */
.vitehub-sidebar__top {
  align-items: center;
  border-bottom: 1px solid var(--ui-border);
  display: flex;
  flex: none;
  height: var(--ui-header-height);
  margin: 0 -0.5rem 0.375rem;
  padding: 0 0.5rem;
}

.vitehub-sidebar__item {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  display: flex;
  flex: none;
  font-size: 0.8125rem;
  font-weight: 500;
  gap: 0.625rem;
  height: 2.125rem;
  overflow: hidden;
  padding: 0 0.5625rem;
  text-align: start;
  white-space: nowrap;
  width: 100%;
}

.vitehub-sidebar__item:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}

.vitehub-sidebar__item[aria-current="page"] {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

.vitehub-sidebar__icon {
  align-items: center;
  display: inline-flex;
  flex: none;
  height: 1.125rem;
  justify-content: center;
  width: 1.125rem;
}

.vitehub-sidebar__icon > * {
  height: 1.125rem;
  width: 1.125rem;
}

.vitehub-sidebar__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-sidebar__badge {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}

.vitehub-sidebar:not([data-open]) :is(.vitehub-sidebar__label, .vitehub-sidebar__badge, .vitehub-sidebar__fade, .vitehub-sidebar__brand-text) {
  opacity: 0;
}

.vitehub-sidebar__brand {
  color: var(--ui-text-highlighted);
}

.vitehub-sidebar__brand:hover {
  background: none;
}

/* The brand row shows its own text, so the label stays for screen readers only. */
.vitehub-sidebar__brand .vitehub-sidebar__label {
  flex: none;
  height: 1px;
  margin: -1px;
  position: absolute;
  width: 1px;
}

.vitehub-sidebar__brand-text {
  align-items: baseline;
  display: flex;
  gap: 0.375rem;
  min-width: 0;
}

.vitehub-sidebar__brand-name {
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 600;
}

.vitehub-sidebar__brand-team {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Open, Search looks like a field. Collapsed, it is one more icon. */
.vitehub-sidebar[data-open] .vitehub-sidebar__search {
  background: var(--ui-bg);
  box-shadow: inset 0 0 0 1px var(--ui-border);
  color: var(--ui-text-dimmed);
}

.vitehub-sidebar[data-open] .vitehub-sidebar__search:hover {
  box-shadow: inset 0 0 0 1px var(--ui-border-accented);
}

.vitehub-sidebar__search .vitehub-sidebar__label {
  font-weight: 400;
}

.vitehub-sidebar__search kbd + kbd {
  margin-inline-start: -0.375rem;
}

.vitehub-sidebar__rule {
  background: var(--ui-border);
  flex: none;
  height: 1px;
  margin: 0.375rem 0.25rem;
}

.vitehub-sidebar__scroll {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  margin: 0 -0.5rem;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 0.5rem;
  scrollbar-width: none;
}

.vitehub-sidebar__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 0.5rem;
}

/* The group label keeps its height in both states. The rail shows a short line in its place. */
.vitehub-sidebar__group-label {
  align-items: center;
  color: var(--ui-text-dimmed);
  display: flex;
  flex: none;
  font-size: 0.75rem;
  height: 1.375rem;
  overflow: hidden;
  padding: 0 0.5625rem;
  position: relative;
  white-space: nowrap;
}

.vitehub-sidebar__group-label::after {
  background: var(--ui-border-accented);
  content: "";
  height: 1px;
  inset-inline-start: 0.5625rem;
  opacity: 0;
  position: absolute;
  top: 50%;
  width: 1.125rem;
}

.vitehub-sidebar:not([data-open]) .vitehub-sidebar__group-label {
  color: transparent;
}

.vitehub-sidebar:not([data-open]) .vitehub-sidebar__group-label::after {
  opacity: 1;
}

.vitehub-sidebar__quiet {
  color: var(--ui-text-dimmed);
}

/* Touch screens get 44px rows, so taps land. */
@media (pointer: coarse) {
  .vitehub-sidebar__item {
    height: 2.75rem;
  }
}
</style>
