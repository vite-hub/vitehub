<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";

import type { CommandPaletteGroup, CommandPaletteItem, DropdownMenuItem } from "@nuxt/ui";
import type { ConsoleAppIdentity } from "../client/app-identity";
import type { ConsoleLinkedProject } from "../client/projects";
import { consoleAppIdentity } from "../client/app-identity";
import { canManageConsoleProjects, checkConsoleProjects, consoleInviteRequested, recentAccountProjects, reloadConsoleAccount, showConsoleAccountPage, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { orderSwitcherProjects } from "../client/projects";
import { consoleSidebarOpen } from "../client/sidebar";
import { useConsoleToast } from "../client/toast";
import ConsoleAppLogo from "./console-app-logo.vue";
import Icon from "./console-icon.vue";

// Only an `account` Console shows them, so they load with the Better Auth client.
const ConsoleAccountLink = defineAsyncComponent(() => import("./console-account-link.vue"));
const ConsoleTeamCreate = defineAsyncComponent(() => import("./console-team-create.vue"));

/**
 * The tile at the top of the sidebar: where the person is. In an `account` Console it names the open app and its team,
 * or the team on the pages of the team, and opens the switcher: the team with its people and settings, then a search
 * over the apps of the team, the recent ones first. An embedded Console has one app, so the tile only names it.
 */
const props = defineProps<{ app?: ConsoleAppIdentity }>();

const projects = useConsoleProjects();
const toast = useConsoleToast();
const switcher = computed(() => projects.mode === "account");
const account = computed(() => projects.account.value);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
// Only owners and admins link apps and invite people.
const manage = computed(() => account.value ? canManageConsoleProjects(account.value) : false);
const role = computed(() => ["owner", "admin", "member"].find(item => account.value?.roles.includes(item)));
const current = computed(() => props.app ? projects.current.value : undefined);
const open = ref(false);
const query = ref("");
const creating = ref(false);

const teamIdentity = computed<ConsoleAppIdentity>(() => {
  const name = team.value?.name ?? "Team";
  return { name, host: "", letter: name.trim().charAt(0).toUpperCase() || "T" };
});
const tile = computed(() => props.app
  ? { identity: props.app, name: props.app.name, detail: switcher.value ? team.value?.name : (props.app.host !== props.app.name ? props.app.host : undefined) }
  : { identity: teamIdentity.value, name: teamIdentity.value.name, detail: role.value ? `Team · ${role.value.charAt(0).toUpperCase()}${role.value.slice(1)}` : "Team" });

function appItem(project: ConsoleLinkedProject): CommandPaletteItem {
  const identity = consoleAppIdentity(project);
  return {
    label: identity.name,
    suffix: identity.host === identity.name ? undefined : identity.host,
    identity,
    current: project.id === current.value?.id,
    slot: "app" as const,
    onSelect: () => {
      open.value = false;
      if (project.id !== current.value?.id) switchConsoleProject(project.id);
    },
  };
}

const groups = computed<CommandPaletteGroup[]>(() => {
  const ordered = orderSwitcherProjects(projects.projects.value, recentAccountProjects(account.value?.teamId), project => consoleAppIdentity(project).name);
  return [
    { id: "recent", label: "Recent", items: ordered.recent.map(appItem) },
    { id: "apps", label: ordered.recent.length ? "All apps" : undefined, items: ordered.others.map(appItem) },
  ].filter(group => group.items.length);
});

const teamItems = computed<DropdownMenuItem[][]>(() => [
  [
    { type: "label", label: "Teams" },
    ...(account.value?.teams ?? []).map((item): DropdownMenuItem => ({
      type: "checkbox",
      label: item.name,
      checked: item.id === account.value?.teamId,
      onSelect: () => {
        if (item.id === account.value?.teamId) return;
        open.value = false;
        void import("../client/account").then(({ switchConsoleTeam }) => switchConsoleTeam(item.id)).then(reloadConsoleAccount, error => toast.show({ title: error instanceof Error ? error.message : "Try again." }));
      },
    })),
  ],
  [{ icon: "i-lucide-plus", label: "Create team", onSelect: () => { open.value = false; creating.value = true; } }],
]);

function go(page: "home" | "team" | "team-settings", invite = false): void {
  open.value = false;
  consoleInviteRequested.value = invite;
  showConsoleAccountPage(page);
}

function linkApp(): void {
  open.value = false;
  projects.linkOpen.value = true;
}

function onOpen(value: boolean): void {
  if (!value) return;
  query.value = "";
  void checkConsoleProjects();
}

const label = computed(() => props.app
  ? `Switch app or team. Current: ${props.app.name}${team.value ? `, team ${team.value.name}` : ""}`
  : `Switch team or app. Current team: ${teamIdentity.value.name}`);
</script>

<template>
  <UPopover
    v-if="switcher"
    v-model:open="open"
    :content="{ side: 'bottom', align: 'start', sideOffset: 4 }"
    :ui="{ content: 'vitehub-switcher' }"
    @update:open="onOpen"
  >
    <UTooltip :text="app ? 'Switch app or team' : 'Switch team or app'" :content="{ side: 'right', sideOffset: 10 }" :disabled="consoleSidebarOpen">
      <button type="button" class="vitehub-app-tile" :aria-label="label">
        <ConsoleAppLogo :app="tile.identity" class="vitehub-app-tile__logo" />
        <span class="vitehub-app-tile__text">
          <span class="vitehub-app-tile__name">{{ tile.name }}</span>
          <span v-if="tile.detail" class="vitehub-app-tile__host">{{ tile.detail }}</span>
        </span>
        <Icon name="i-lucide-chevrons-up-down" class="vitehub-app-tile__chevron" aria-hidden="true" />
      </button>
    </UTooltip>

    <template #content>
      <section class="vitehub-switcher__team" aria-label="Team">
        <UDropdownMenu size="sm" :items="teamItems" :content="{ side: 'bottom', align: 'start', sideOffset: 4 }" :ui="{ content: 'w-60' }">
          <button type="button" class="vitehub-switcher__team-button" :aria-label="`Team ${teamIdentity.name}. Switch or create a team`">
            <ConsoleAppLogo :app="teamIdentity" class="vitehub-switcher__team-logo" />
            <span class="vitehub-switcher__team-name">{{ teamIdentity.name }}</span>
            <span v-if="role" class="vitehub-switcher__team-role">{{ role }}</span>
            <Icon name="i-lucide-chevrons-up-down" class="vitehub-switcher__team-chevron" aria-hidden="true" />
          </button>
        </UDropdownMenu>
        <div class="vitehub-switcher__team-actions">
          <UButton v-if="manage" size="xs" color="neutral" variant="ghost" icon="i-lucide-user-plus" label="Invite" @click="go('team', true)" />
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-users" label="Members" @click="go('team')" />
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-settings" label="Settings" @click="go('team-settings')" />
        </div>
      </section>

      <UCommandPalette
        v-model:search-term="query"
        :groups="groups"
        :placeholder="`Search ${projects.projects.value.length} apps`"
        :fuse="{ resultLimit: 100 }"
        size="sm"
        autofocus
        class="vitehub-switcher__apps"
        :ui="{ input: '[&_input]:h-9', item: 'py-1', itemLabelSuffix: 'truncate' }"
      >
        <template #app-leading="{ item }">
          <ConsoleAppLogo :app="item.identity" class="vitehub-switcher__app-logo" />
        </template>
        <template #app-trailing="{ item }">
          <template v-if="item.current">
            <Icon name="i-lucide-check" class="size-4 text-highlighted" aria-hidden="true" />
            <span class="sr-only">Open now</span>
          </template>
        </template>
        <template #empty>
          <p class="px-3 py-6 text-center text-sm text-muted">No app matches “{{ query }}”.</p>
        </template>
      </UCommandPalette>

      <footer class="vitehub-switcher__footer">
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-layout-grid" label="All apps" @click="go('home')" />
        <UButton v-if="manage" size="xs" color="neutral" variant="ghost" icon="i-lucide-plus" label="Link app" @click="linkApp" />
      </footer>
    </template>
  </UPopover>

  <UTooltip v-else-if="app" :text="app.name" :content="{ side: 'right', sideOffset: 10 }" :disabled="consoleSidebarOpen">
    <div class="vitehub-app-tile is-static">
      <ConsoleAppLogo :app="app" class="vitehub-app-tile__logo" />
      <span class="vitehub-app-tile__text">
        <span class="vitehub-app-tile__name">{{ app.name }}</span>
        <span v-if="app.host && app.host !== app.name" class="vitehub-app-tile__host">{{ app.host }}</span>
      </span>
    </div>
  </UTooltip>

  <template v-if="switcher">
    <ConsoleAccountLink v-model:open="projects.linkOpen.value" />
    <ConsoleTeamCreate v-if="creating" v-model:open="creating" />
  </template>
</template>

<style>
/* The 30px logo sits in the middle of the 52px rail, as the 18px icons below it do. */
.vitehub-app-tile {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.5rem;
  display: flex;
  flex: none;
  gap: 0.625rem;
  height: 2.5rem;
  margin-top: 0.25rem;
  overflow: hidden;
  padding: 0 0.1875rem;
  text-align: start;
  white-space: nowrap;
  width: 100%;
}

button.vitehub-app-tile:hover,
.vitehub-app-tile[aria-expanded="true"],
.vitehub-app-tile[data-state="open"] {
  background: var(--muted);
}

.vitehub-app-tile .vitehub-app-tile__logo {
  border-radius: 0.4375rem;
  height: 1.875rem;
  width: 1.875rem;
}

.vitehub-app-tile__text {
  display: grid;
  flex: 1 1 auto;
  line-height: 1.2;
  min-width: 0;
}

.vitehub-app-tile__name {
  color: var(--foreground);
  font-size: 0.8125rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-app-tile__host {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-app-tile__chevron {
  color: var(--ui-text-dimmed);
  flex: none;
  height: 0.875rem;
  width: 0.875rem;
}

.vitehub-sidebar:not([data-open]) :is(.vitehub-app-tile__text, .vitehub-app-tile__chevron) {
  opacity: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .vitehub-sidebar[data-ready] :is(.vitehub-app-tile__text, .vitehub-app-tile__chevron) {
    transition: opacity 150ms ease-out;
  }
}

.vitehub-switcher {
  display: flex;
  flex-direction: column;
  max-height: min(34rem, var(--reka-popover-content-available-height, 34rem));
  width: min(20rem, calc(100vw - 1rem));
}

.vitehub-switcher__team {
  border-bottom: 1px solid var(--border);
  display: grid;
  gap: 0.25rem;
  padding: 0.375rem;
}

.vitehub-switcher__team-button {
  align-items: center;
  border-radius: 0.375rem;
  display: flex;
  gap: 0.5rem;
  height: 2.25rem;
  padding: 0 0.375rem;
  text-align: start;
  width: 100%;
}

.vitehub-switcher__team-button:hover,
.vitehub-switcher__team-button[data-state="open"] {
  background: var(--muted);
}

.vitehub-switcher__team .vitehub-switcher__team-logo {
  height: 1.5rem;
  width: 1.5rem;
}

.vitehub-switcher__team-name {
  color: var(--foreground);
  flex: 0 1 auto;
  font-size: 0.8125rem;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-switcher__team-role {
  color: var(--ui-text-dimmed);
  flex: 1 0 auto;
  font-size: 0.75rem;
  text-transform: capitalize;
}

.vitehub-switcher__team-chevron {
  color: var(--ui-text-dimmed);
  flex: none;
  height: 0.875rem;
  width: 0.875rem;
}

.vitehub-switcher__team-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.125rem;
}

.vitehub-switcher__apps {
  flex: 1 1 auto;
  min-height: 0;
}

.vitehub-switcher .vitehub-switcher__app-logo {
  border-radius: 0.3125rem;
  font-size: 0.625rem;
  height: 1.25rem;
  width: 1.25rem;
}

.vitehub-switcher__footer {
  border-top: 1px solid var(--border);
  display: flex;
  gap: 0.125rem;
  padding: 0.375rem;
}
</style>
