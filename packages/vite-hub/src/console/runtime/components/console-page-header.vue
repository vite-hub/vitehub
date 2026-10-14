<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";

/**
 * The header of every page of a document editor section: the navigation toggle on small screens, an optional Back
 * button, the title after its ancestors, a quiet mono description such as a collection's glob, and the page actions on
 * the right. The Dashboard, a collection, Settings, Media, and the editor share it, so titles keep one weight, one
 * height, and one place for the next action.
 *
 * Ancestors hide on small screens; Back then leads one level up.
 */
withDefaults(defineProps<{
  /** One level up. Pages with ancestors usually pass the last one. */
  back?: { label: string, to: RouteLocationRaw };
  /** Shown after the title on wide screens, such as `posts/**\/*.md`. */
  description?: string;
  title: string;
  /** Pages above this one, outermost first. */
  trail?: readonly { label: string, to: RouteLocationRaw }[];
}>(), { trail: () => [] });
</script>

<template>
  <UDashboardNavbar :ui="{ root: 'border-b border-default', right: 'gap-1.5' }" :toggle="{ 'aria-label': 'Open section navigation' }">
    <template v-if="back" #leading>
      <UButton :to="back.to" variant="ghost" size="sm" icon="i-lucide-arrow-left" :aria-label="`Back to ${back.label}`" />
    </template>
    <template #title>
      <span class="flex min-w-0 items-center gap-2">
        <template v-for="item in trail" :key="item.label">
          <RouterLink
            :to="item.to"
            class="hidden max-w-48 shrink-0 truncate rounded-sm text-sm font-normal text-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 sm:inline"
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
    <template #right>
      <slot name="right" />
    </template>
  </UDashboardNavbar>
</template>
