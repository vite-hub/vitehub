<script setup lang="ts">
import { computed, inject } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances } from "../client/appearance";
import { consoleDocsItem } from "../client/sidebar";
import ConsoleSidebarItem from "./console-sidebar-item.vue";

/**
 * The last row of the sidebar of a Console without accounts, such as the Console of a development server. It has no
 * person to show, so it holds the theme and the docs.
 */

// The standalone Console provides its appearance. A Nuxt host owns color mode, so the menu leaves it out there.
const appearance = inject(consoleAppearanceKey, undefined);
const items = computed<DropdownMenuItem[][]>(() => [
  appearance
    ? [
        { type: "label", label: "Theme" },
        ...consoleAppearances.map((option): DropdownMenuItem => ({
          type: "checkbox",
          icon: consoleAppearanceOptions[option].icon,
          label: consoleAppearanceOptions[option].label,
          checked: appearance.preference.value === option,
          onSelect: () => appearance.select(option),
        })),
      ]
    : [],
  [consoleDocsItem],
].filter(group => group.length));
</script>

<template>
  <UDropdownMenu :items="items" :content="{ side: 'top', align: 'start', sideOffset: 4 }" :ui="{ content: 'w-56' }">
    <ConsoleSidebarItem label="Preferences" icon="i-lucide-settings-2">
      <template #trailing>
        <UIcon name="i-lucide-chevrons-up-down" class="vitehub-sidebar__fade size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
      </template>
    </ConsoleSidebarItem>
  </UDropdownMenu>
</template>
