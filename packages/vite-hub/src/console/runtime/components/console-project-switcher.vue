<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import type { ConsoleAppIdentity } from "../client/app-identity";
import type { ConsoleProjectStatus } from "../client/project-session";
import type { ConsoleLinkedProject } from "../client/projects";
import { consoleAppIdentity } from "../client/app-identity";
import { canManageConsoleProjects, checkConsoleProjects, showConsoleAccountPage, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleSidebarOpen } from "../client/sidebar";
import ConsoleAppLogo from "./console-app-logo.vue";

// Only an `account` Console shows it, so it loads with the Better Auth client.
const ConsoleAccountLink = defineAsyncComponent(() => import("./console-account-link.vue"));

/**
 * The app tile of the sidebar: the logo of the open app, and its name and host when the sidebar is open. In an `account`
 * Console it opens the app switcher, as the organization switcher of Executor: a menu under the tile with every app of
 * the team, then All apps and Link app. An embedded Console has one app, so the tile only names it.
 */
const props = defineProps<{ app: ConsoleAppIdentity }>();

const projects = useConsoleProjects();
const switcher = computed(() => projects.mode === "account");
// Only owners and admins link apps.
const manage = computed(() => projects.account.value ? canManageConsoleProjects(projects.account.value) : false);
const current = computed(() => projects.current.value);

const statusLabels: Partial<Record<ConsoleProjectStatus, string>> = {
  "sign-in": "Sign-in needed",
  unreachable: "Unreachable",
};

function status(project: ConsoleLinkedProject): ConsoleProjectStatus {
  return projects.statuses.value[project.id] ?? "checking";
}

const items = computed<DropdownMenuItem[][]>(() => [
  projects.projects.value.map((project): DropdownMenuItem => {
    const identity = consoleAppIdentity(project);
    return {
      label: identity.name,
      description: identity.host === identity.name ? undefined : identity.host,
      identity,
      project,
      slot: "app" as const,
      onSelect: () => {
        if (project.id !== current.value?.id) switchConsoleProject(project.id);
      },
    };
  }),
  [
    { icon: "i-lucide-layout-grid", label: "All apps", onSelect: () => showConsoleAccountPage("home") },
    ...(manage.value ? [{ icon: "i-lucide-plus", label: "Link app", onSelect: () => { projects.linkOpen.value = true; } }] : []),
  ],
]);

function onOpen(open: boolean): void {
  if (open) void checkConsoleProjects();
}

function projectOf(item: DropdownMenuItem): ConsoleLinkedProject | undefined {
  const project: unknown = Reflect.get(item, "project");
  return projects.projects.value.find(entry => entry === project);
}

function identityOf(item: DropdownMenuItem): ConsoleAppIdentity {
  const project = projectOf(item);
  return project ? consoleAppIdentity(project) : props.app;
}

function attention(item: DropdownMenuItem): string | undefined {
  const project = projectOf(item);
  return project ? statusLabels[status(project)] : undefined;
}

const label = computed(() => `Switch app. Current: ${props.app.name}${props.app.host && props.app.host !== props.app.name ? `, ${props.app.host}` : ""}`);
</script>

<template>
  <UDropdownMenu
    v-if="switcher"
    :items="items"
    :content="{ side: 'bottom', align: 'start', sideOffset: 4 }"
    :ui="{ content: consoleSidebarOpen ? 'vitehub-app-menu w-(--reka-dropdown-menu-trigger-width)' : 'vitehub-app-menu w-62', itemDescription: 'truncate' }"
    @update:open="onOpen"
  >
    <UTooltip text="Switch app" :content="{ side: 'right', sideOffset: 10 }" :disabled="consoleSidebarOpen">
      <button type="button" class="vitehub-app-tile" :aria-label="label">
        <ConsoleAppLogo :app="app" class="vitehub-app-tile__logo" />
        <span class="vitehub-app-tile__text">
          <span class="vitehub-app-tile__name">{{ app.name }}</span>
          <span v-if="app.host && app.host !== app.name" class="vitehub-app-tile__host">{{ app.host }}</span>
        </span>
        <UIcon name="i-lucide-chevrons-up-down" class="vitehub-app-tile__chevron" aria-hidden="true" />
      </button>
    </UTooltip>

    <template #app-leading="{ item }">
      <ConsoleAppLogo :app="identityOf(item)" />
    </template>
    <template #app-trailing="{ item }">
      <UTooltip v-if="attention(item)" :text="attention(item)">
        <span class="vitehub-app-menu__dot" aria-hidden="true" />
      </UTooltip>
      <span v-if="attention(item)" class="sr-only">{{ attention(item) }}</span>
      <span class="vitehub-app-menu__check">
        <template v-if="projectOf(item)?.id === current?.id">
          <UIcon name="i-lucide-check" class="size-4 text-highlighted" aria-hidden="true" />
          <span class="sr-only">Open now</span>
        </template>
      </span>
    </template>
  </UDropdownMenu>

  <UTooltip v-else :text="app.name" :content="{ side: 'right', sideOffset: 10 }" :disabled="consoleSidebarOpen">
    <div class="vitehub-app-tile is-static">
      <ConsoleAppLogo :app="app" class="vitehub-app-tile__logo" />
      <span class="vitehub-app-tile__text">
        <span class="vitehub-app-tile__name">{{ app.name }}</span>
        <span v-if="app.host && app.host !== app.name" class="vitehub-app-tile__host">{{ app.host }}</span>
      </span>
    </div>
  </UTooltip>

  <ConsoleAccountLink v-if="switcher" v-model:open="projects.linkOpen.value" />
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
.vitehub-app-tile[aria-expanded="true"] {
  background: var(--ui-bg-elevated);
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
  color: var(--ui-text-highlighted);
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

.vitehub-app-menu__dot {
  background: var(--ui-warning);
  border-radius: 999px;
  display: block;
  height: 0.375rem;
  width: 0.375rem;
}

.vitehub-app-menu__check {
  display: inline-flex;
  flex: none;
  width: 1rem;
}
</style>
