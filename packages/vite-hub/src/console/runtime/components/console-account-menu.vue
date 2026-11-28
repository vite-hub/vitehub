<script setup lang="ts">
import { computed, inject } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances } from "../client/appearance";
import { showConsoleAccountPage, signOutConsole, useConsoleProjects } from "../client/project-session";
import { consoleDocsItem } from "../client/sidebar";
import { useConsoleToast } from "../client/toast";
import ConsoleSidebarItem from "./console-sidebar-item.vue";
import Icon from "./console-icon.vue";

/**
 * The user menu of an `account` Console, the last row of the sidebar: the account, the theme, the docs, and Sign out.
 * The team and its pages are in the switcher at the top of the sidebar.
 */

const projects = useConsoleProjects();
const toast = useConsoleToast();
const account = computed(() => projects.account.value);

const label = computed(() => account.value?.user.name || "Account");
const initials = computed(() => label.value.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase());
const email = computed(() => account.value?.hasEmail ? account.value.user.email : undefined);
// The standalone Console provides its appearance. A Nuxt host owns color mode, so the menu leaves it out there.
const appearance = inject(consoleAppearanceKey, undefined);
// One "Theme" row opens the three choices, so the menu stays short.
const appearanceItems = computed<DropdownMenuItem[]>(() => appearance
  ? [{
      icon: consoleAppearanceOptions[appearance.preference.value].icon,
      label: "Theme",
      children: consoleAppearances.map((option): DropdownMenuItem => ({
        type: "checkbox",
        icon: consoleAppearanceOptions[option].icon,
        label: consoleAppearanceOptions[option].label,
        checked: appearance.preference.value === option,
        onSelect: () => appearance.select(option),
      })),
    }]
  : []);

const identityItems = computed<DropdownMenuItem[]>(() => [{ type: "label", label: label.value }, ...(email.value ? [{ type: "label" as const, label: email.value }] : [])]);
const signOutItems: DropdownMenuItem[] = [{ icon: "i-lucide-log-out", label: "Sign out", onSelect: () => void signOutConsole().catch(error => toast.show({ title: error instanceof Error ? error.message : "Try again." })) }];

const items = computed<DropdownMenuItem[][]>(() => {
  if (!account.value) return [[...appearanceItems.value, consoleDocsItem]];
  return [
    identityItems.value,
    [
      { icon: "i-lucide-circle-user", label: "Account settings", onSelect: () => showConsoleAccountPage("settings") },
      ...appearanceItems.value,
      consoleDocsItem,
    ],
    signOutItems,
  ];
});
</script>

<template>
  <UDropdownMenu size="sm" :items="items" :content="{ side: 'top', align: 'start', sideOffset: 4 }" :ui="{ content: 'w-60' }">
    <ConsoleSidebarItem :label="label">
      <template #icon><UAvatar :src="account?.user.image ?? undefined" :alt="label" :text="initials" size="2xs" /></template>
      <template #trailing>
        <Icon name="i-lucide-chevrons-up-down" class="vitehub-sidebar__fade size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
      </template>
    </ConsoleSidebarItem>
  </UDropdownMenu>
</template>
