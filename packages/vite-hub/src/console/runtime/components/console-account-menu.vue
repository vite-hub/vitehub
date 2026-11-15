<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances } from "../client/appearance";
import { createConsoleTeam, signOutConsoleAccount, switchConsoleTeam } from "../client/account";
import { reloadConsoleAccount, showConsoleAccountPage, useConsoleProjects } from "../client/project-session";
import { consoleDocsItem } from "../client/sidebar";
import { useConsoleToast } from "../client/toast";
import ConsoleSidebarItem from "./console-sidebar-item.vue";

/**
 * The account menu of an `account` Console. In an open project, the last row of the sidebar holds teams, the account,
 * and the docs. The sidebar of the account pages splits it: `team` is the team switcher at the top, `user` the account
 * at the bottom.
 */
const props = withDefaults(defineProps<{ variant?: "sidebar" | "team" | "user" }>(), { variant: "sidebar" });

const projects = useConsoleProjects();
const toast = useConsoleToast();
const account = computed(() => projects.account.value);
const creating = ref(false);
const teamName = ref("");
const busy = ref(false);
const problem = ref<string>();

const label = computed(() => account.value?.user.name || "Account");
const initials = computed(() => label.value.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase());
const email = computed(() => account.value?.hasEmail ? account.value.user.email : undefined);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
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

watch(creating, () => {
  teamName.value = "";
  problem.value = undefined;
  busy.value = false;
});

const identityItems = computed<DropdownMenuItem[]>(() => [{ type: "label", label: label.value }, ...(email.value ? [{ type: "label" as const, label: email.value }] : [])]);
// The user row in the sidebar already shows the name, so its menu shows only the email.
const emailItems = computed<DropdownMenuItem[]>(() => email.value ? [{ type: "label", label: email.value }] : []);
const teamItems = computed<DropdownMenuItem[]>(() => [
  { type: "label", label: "Teams" },
  ...(account.value?.teams ?? []).map((item): DropdownMenuItem => ({
    type: "checkbox",
    label: item.name,
    checked: item.id === account.value?.teamId,
    onSelect: () => {
      if (item.id !== account.value?.teamId) void switchConsoleTeam(item.id).then(reloadConsoleAccount, error => toast.show({ title: error instanceof Error ? error.message : "Try again." }));
    },
  })),
  { icon: "i-lucide-plus", label: "Create team", onSelect: () => { creating.value = true; } },
]);
const signOutItems: DropdownMenuItem[] = [{ icon: "i-lucide-log-out", label: "Sign out", onSelect: () => void signOutConsoleAccount().then(reloadConsoleAccount) }];

const items = computed<DropdownMenuItem[][]>(() => {
  if (!account.value) return [appearanceItems.value];
  if (props.variant === "team") return [teamItems.value];
  // Account settings sits in the sidebar footer, right above this menu.
  if (props.variant === "user") return [emailItems.value, [...appearanceItems.value, consoleDocsItem], signOutItems].filter(group => group.length);
  return [
    identityItems.value,
    teamItems.value,
    [
      { icon: "i-lucide-layout-grid", label: "All apps", onSelect: () => showConsoleAccountPage("home") },
      { icon: "i-lucide-users", label: "Members", onSelect: () => showConsoleAccountPage("team") },
      { icon: "i-lucide-settings", label: "Account settings", onSelect: () => showConsoleAccountPage("settings") },
      ...appearanceItems.value,
      consoleDocsItem,
    ],
    signOutItems,
  ].filter(group => group.length);
});

async function create(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    await createConsoleTeam(teamName.value);
    reloadConsoleAccount();
  }
  catch (error) {
    problem.value = error instanceof Error ? error.message : "Try again.";
    busy.value = false;
  }
}
</script>

<template>
  <UDropdownMenu v-if="variant === 'team'" size="sm" :items="items" :content="{ align: 'start' }" :ui="{ content: 'min-w-(--reka-dropdown-menu-trigger-width)' }">
    <button type="button" class="vitehub-account-menu__trigger" data-focus-inset :aria-label="`Team: ${team?.name ?? 'none'}. Switch team`">
      <span class="vitehub-account-menu__team-mark" aria-hidden="true">{{ (team?.name ?? "T").slice(0, 1).toUpperCase() }}</span>
      <span class="min-w-0 flex-1 truncate text-start">{{ team?.name ?? "Team" }}</span>
      <UIcon name="i-lucide-chevrons-up-down" class="size-3.5 shrink-0 text-muted" aria-hidden="true" />
    </button>
  </UDropdownMenu>

  <UDropdownMenu v-else-if="variant === 'user'" size="sm" :items="items" :content="{ align: 'start', side: 'top' }" :ui="{ content: 'min-w-(--reka-dropdown-menu-trigger-width)' }">
    <button type="button" class="vitehub-account-menu__trigger" data-focus-inset>
      <UAvatar :src="account?.user.image ?? undefined" :alt="label" :text="initials" size="xs" />
      <span class="grid min-w-0 flex-1 text-start">
        <span class="truncate">{{ label }}</span>
        <span v-if="email" class="truncate text-xs font-normal text-muted">{{ email }}</span>
      </span>
      <UIcon name="i-lucide-chevrons-up-down" class="size-3.5 shrink-0 text-muted" aria-hidden="true" />
    </button>
  </UDropdownMenu>

  <UDropdownMenu v-else size="sm" :items="items" :content="{ side: 'top', align: 'start', sideOffset: 4 }" :ui="{ content: 'w-60' }">
    <ConsoleSidebarItem :label="label">
      <template #icon><UAvatar :src="account?.user.image ?? undefined" :alt="label" :text="initials" size="2xs" /></template>
      <template #trailing>
        <UIcon name="i-lucide-chevrons-up-down" class="vitehub-sidebar__fade size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
      </template>
    </ConsoleSidebarItem>
  </UDropdownMenu>

  <UModal v-model:open="creating" title="Create team" description="Teams share their linked apps. You will be the owner." :ui="{ content: 'sm:max-w-[440px]' }">
    <template #body>
      <form id="vitehub-account-team" class="grid gap-3" @submit.prevent="create">
        <UFormField label="Team name" name="team" required>
          <UInput v-model="teamName" required class="w-full" autofocus />
        </UFormField>
        <p v-if="problem" role="alert" class="text-[13px] text-error">{{ problem }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="creating = false" />
        <UButton type="submit" form="vitehub-account-team" label="Create team" :loading="busy" />
      </div>
    </template>
  </UModal>
</template>

<style>
.vitehub-account-menu__trigger {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-highlighted);
  display: flex;
  font-size: 0.8125rem;
  font-weight: 500;
  gap: 0.5rem;
  min-height: 2.25rem;
  padding: 0.25rem 0.5rem;
  width: 100%;
}

.vitehub-account-menu__trigger:hover,
.vitehub-account-menu__trigger[data-state="open"] {
  background: var(--ui-bg-elevated);
}

.vitehub-account-menu__team-mark {
  align-items: center;
  background: var(--ui-bg-accented);
  border-radius: 0.3125rem;
  color: var(--ui-text-highlighted);
  display: inline-flex;
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 600;
  height: 1.25rem;
  justify-content: center;
  width: 1.25rem;
}
</style>
