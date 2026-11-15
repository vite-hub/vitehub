<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import ConsoleSidebarTrigger from "./console-sidebar-trigger.vue";
import ConsoleAppCrumb from "./console-app-crumb.vue";

/**
 * The header of every Console page, in one row: the sidebar button, the app, the pages above this one, the title, a
 * quiet mono description such as a collection's glob or a store name, the tabs of the page, and the actions on the
 * right. Content, KV, Database, Blob, and the contributed sections share it, so titles keep one weight, one height, and
 * one place for the next action.
 *
 * Ancestors hide on small screens; Back then leads one level up. A `UTabs` view switch goes in the `tabs` slot, after the
 * title, never in `right`.
 */
withDefaults(defineProps<{
  /** One level up. Pages with ancestors usually pass the last one. */
  back?: { label: string, to: RouteLocationRaw };
  /** Shown after the title on wide screens, such as `posts/**\/*.md`. */
  description?: string;
  title: string;
  /** Pages above this one, outermost first. */
  trail?: readonly { label: string, to: RouteLocationRaw }[];
  /** Show the button that opens the section sidebar on small screens. Pages without a sidebar turn it off. */
  toggle?: boolean;
}>(), { toggle: true, trail: () => [] });
</script>

<template>
  <UDashboardNavbar class="vitehub-page-header" :ui="{ root: 'border-b border-default', left: 'self-stretch', right: 'gap-1.5' }" :toggle="toggle ? { 'aria-label': 'Open section navigation' } : false">
    <template #leading>
      <ConsoleSidebarTrigger />
      <UButton v-if="back" :to="back.to" variant="ghost" icon="i-lucide-arrow-left" :aria-label="`Back to ${back.label}`" />
    </template>
    <template #title>
      <span class="flex min-w-0 items-center gap-2">
        <ConsoleAppCrumb />
        <template v-for="item in trail" :key="`${item.label}:${JSON.stringify(item.to)}`">
          <RouterLink
            :to="item.to"
            class="hidden max-w-48 shrink-0 truncate rounded-md text-sm font-normal text-muted hover:text-highlighted sm:inline"
          >
            {{ item.label }}
          </RouterLink>
          <span class="hidden text-sm font-normal text-dimmed sm:inline" aria-hidden="true">/</span>
        </template>
        <span class="truncate text-sm font-semibold text-highlighted">{{ title }}</span>
        <span v-if="description" class="hidden truncate font-mono text-xs font-normal text-dimmed sm:inline">{{ description }}</span>
        <slot name="title-trailing" />
      </span>
    </template>
    <template v-if="$slots.tabs" #trailing>
      <div class="vitehub-page-header__tabs">
        <slot name="tabs" />
      </div>
    </template>
    <template #right>
      <slot name="right" />
    </template>
  </UDashboardNavbar>
</template>

<style>
.vitehub-page-header [data-slot="title"] {
  flex-shrink: 1000;
  min-width: 3rem;
}

/*
 * Tabs follow the title and rest on the bottom border, so the tab line and the border are one line. The tab list draws
 * its line 1px below itself, so the scroller makes room for it and overlaps the border.
 */
.vitehub-page-header__tabs {
  align-self: flex-end;
  flex: 0 1 auto;
  margin-bottom: -1px;
  padding-bottom: 1px;
  margin-inline-start: 0.5rem;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
</style>
