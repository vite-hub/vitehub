<script setup lang="ts">
import { PrimitiveRailItem } from "@vite-hub/ui/primitive-rail";
import { computed, defineAsyncComponent } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import type { ConsoleProjectStatus } from "../client/project-session";
import type { ConsoleLinkedProject } from "../client/projects";
import { canManageConsoleProjects, checkConsoleProjects, consoleProjectDisplayName, showConsoleAccountPage, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost } from "../client/projects";

// Only an `account` Console shows it, so it loads with the Better Auth client.
const ConsoleAccountLink = defineAsyncComponent(() => import("./console-account-link.vue"));

/**
 * The app switcher of an `account` Console, below the Overview item of the rail. Its menu lists the apps of the active
 * team and leads back to the team: Home and Members. Unlinking an app is on Home, outside this menu.
 */
const projects = useConsoleProjects();
const teamName = computed(() => projects.account.value?.teams.find(team => team.id === projects.account.value?.teamId)?.name);
// Only owners and admins link apps, as in the team sidebar.
const manage = computed(() => projects.account.value ? canManageConsoleProjects(projects.account.value) : false);

const current = computed(() => projects.current.value);
const name = computed(() => projects.info.value?.name || (current.value ? consoleProjectDisplayName(current.value) : "App"));
const host = computed(() => current.value ? consoleProjectHost(current.value) : "");
const monogram = computed(() => name.value.trim().charAt(0).toUpperCase() || "A");

const statusLabels: Record<ConsoleProjectStatus, string> = {
  checking: "Checking",
  ready: "Reachable",
  "sign-in": "Sign-in needed",
  unreachable: "Unreachable",
};

function status(project: ConsoleLinkedProject): ConsoleProjectStatus {
  return projects.statuses.value[project.id] ?? "checking";
}

/** The second line of an app: its host, unless the name is the host, and a status that needs attention. */
function description(project: ConsoleLinkedProject): string | undefined {
  const projectHost = consoleProjectHost(project);
  const state = status(project);
  const parts = [
    consoleProjectDisplayName(project) === projectHost ? undefined : projectHost,
    state === "sign-in" || state === "unreachable" ? statusLabels[state] : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

// The menu opens on pointerdown, like the other menus of the rail, so it opens before the rail closes under the pointer.
// It opens below the item: a menu at the right of a collapsed rail would sit under a pointer that clicked the expanded
// label, and the pointerup would select the app under it.
const items = computed<DropdownMenuItem[][]>(() => [
  [
    { type: "label", label: teamName.value ?? "Team" },
    { icon: "i-lucide-house", label: "Home", onSelect: () => showConsoleAccountPage("home") },
    { icon: "i-lucide-users", label: "Members", onSelect: () => showConsoleAccountPage("team") },
  ],
  [
    { type: "label", label: "Apps" },
    ...projects.projects.value.map((project): DropdownMenuItem => ({
      description: description(project),
      label: consoleProjectDisplayName(project),
      project,
      slot: "project" as const,
      onSelect: () => {
        if (project.id !== current.value?.id) switchConsoleProject(project.id);
      },
    })),
    ...(manage.value ? [{ icon: "i-lucide-plus", label: "Link an app", onSelect: () => { projects.linkOpen.value = true; } }] : []),
  ],
]);

function onOpen(open: boolean): void {
  if (open) void checkConsoleProjects();
}

function projectOf(item: DropdownMenuItem): ConsoleLinkedProject | undefined {
  const project: unknown = Reflect.get(item, "project");
  return projects.projects.value.find(entry => entry === project);
}

function itemStatus(item: DropdownMenuItem): ConsoleProjectStatus {
  const project = projectOf(item);
  return project ? status(project) : "checking";
}
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ side: 'bottom', align: 'start', sideOffset: 4 }"
    :ui="{ content: 'vitehub-project-menu', itemDescription: 'truncate' }"
    @update:open="onOpen"
  >
    <!--
      No tooltip: the rail shows the name and host when it expands, and the menu lists every app with its host.
    -->
    <PrimitiveRailItem class="vitehub-project-switcher" :label="`Switch app. Current: ${name}${host && host !== name ? `, ${host}` : ''}`">
      <span class="vitehub-project-switcher__mark">{{ monogram }}</span>
      <UIcon name="i-lucide-chevrons-up-down" class="vitehub-project-switcher__chevron" data-compact />
      <template #label>
        <span class="vitehub-project-switcher__text">
          <span class="vitehub-project-switcher__name">{{ name }}</span>
          <span v-if="host && host !== name" class="vitehub-project-switcher__host">{{ host }}</span>
        </span>
        <UIcon name="i-lucide-chevrons-up-down" class="vitehub-project-switcher__chevron" aria-hidden="true" />
      </template>
    </PrimitiveRailItem>

    <template #project-leading="{ item }">
      <!-- One line high, so the dot sits on the name line when the item has a second line. -->
      <span class="vitehub-project-menu__status" aria-hidden="true">
        <span class="vitehub-project-menu__dot" :data-status="itemStatus(item)" />
      </span>
    </template>
    <template #project-trailing="{ item }">
      <span v-if="itemStatus(item) === 'ready' || itemStatus(item) === 'checking'" class="sr-only">{{ statusLabels[itemStatus(item)] }}</span>
      <template v-if="projectOf(item)?.id === current?.id">
        <UIcon name="i-lucide-check" class="size-4 shrink-0 text-muted" aria-hidden="true" />
        <span class="sr-only">Open now</span>
      </template>
    </template>
  </UDropdownMenu>

  <ConsoleAccountLink v-model:open="projects.linkOpen.value" />
</template>

<style>
/*
 * The switcher is a 40px target, 2px larger than the 36px rail items on each side, so the tile stays centered under the
 * rail icons. Compact, a chevron next to the tile says that it opens a menu. Expanded, the chevron moves to the row end.
 */
.vh-primitive-rail .vitehub-project-switcher {
  height: 2.5rem;
  margin-inline: -0.125rem;
  width: calc(100% + 0.25rem);
}

.vh-primitive-rail .vitehub-project-switcher .vh-primitive-rail__icon {
  gap: 0.125rem;
  width: 2.5rem;
}

.vh-primitive-rail .vitehub-project-switcher .vh-primitive-rail__label {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

.vitehub-project-switcher__mark {
  align-items: center;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border-accented);
  border-radius: calc(var(--ui-radius) * 1.5);
  color: var(--ui-text-highlighted);
  display: inline-flex;
  flex: none;
  font-size: 0.75rem;
  font-weight: 600;
  height: 1.5rem;
  justify-content: center;
  line-height: 1;
  width: 1.5rem;
}

.vitehub-project-switcher__chevron {
  color: var(--ui-text-dimmed);
  flex: none;
  height: 0.75rem;
  width: 0.75rem;
}

.vitehub-project-switcher__chevron[data-compact] {
  transition: opacity 150ms ease;
}

.vh-primitive-rail[data-expanded] .vitehub-project-switcher__chevron[data-compact] {
  opacity: 0;
}

.vitehub-project-switcher__text {
  display: grid;
  flex: 1 1 auto;
  line-height: 1rem;
  min-width: 0;
}

.vitehub-project-switcher__name {
  color: var(--ui-text-highlighted);
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-project-switcher__host {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-project-menu {
  width: 18rem;
}

.vitehub-project-menu__status {
  align-items: center;
  display: flex;
  flex: none;
  height: 1.25rem;
}

.vitehub-project-menu__dot {
  background: var(--ui-text-dimmed);
  border-radius: 999px;
  height: 0.5rem;
  width: 0.5rem;
}

.vitehub-project-menu__dot[data-status="ready"] {
  background: var(--ui-success);
}

.vitehub-project-menu__dot[data-status="sign-in"] {
  background: var(--ui-warning);
}

.vitehub-project-menu__dot[data-status="unreachable"] {
  background: var(--ui-error);
}

.vitehub-project-menu__dot[data-status="checking"] {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--ui-text-dimmed);
}
</style>
