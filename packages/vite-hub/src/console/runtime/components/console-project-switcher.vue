<script setup lang="ts">
import { PrimitiveRailItem } from "@vite-hub/ui/primitive-rail";
import { computed, shallowRef } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import type { ConsoleProjectStatus } from "../client/project-session";
import type { ConsoleLinkedProject } from "../client/projects";
import { checkConsoleProjects, forgetConsoleProject, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost, consoleProjectName } from "../client/projects";
import ConsoleProjectLink from "./console-project-link.vue";

const projects = useConsoleProjects();
const forgetting = shallowRef<ConsoleLinkedProject>();

const current = computed(() => projects.current.value);
const name = computed(() => projects.info.value?.name || (current.value ? consoleProjectName(current.value) : "Project"));
const host = computed(() => current.value ? consoleProjectHost(current.value) : "");
const monogram = computed(() => name.value.trim().charAt(0).toUpperCase() || "P");

const statusLabels: Record<ConsoleProjectStatus, string> = {
  checking: "Checking",
  ready: "Reachable",
  "sign-in": "Sign-in needed",
  unreachable: "Unreachable",
};

function status(project: ConsoleLinkedProject): ConsoleProjectStatus {
  return projects.statuses.value[project.id] ?? "checking";
}

// The menu opens on pointerdown, like the other menus of the rail, so it opens before the rail closes under the pointer.
// It opens below the item: a menu at the right of a collapsed rail would sit under a pointer that clicked the expanded
// label, and the pointerup would select the project under it.
const items = computed<DropdownMenuItem[][]>(() => [
  [
    { type: "label", label: "Projects" },
    ...projects.projects.value.map((project): DropdownMenuItem => ({
      description: `${consoleProjectHost(project)}${status(project) === "ready" ? "" : ` · ${statusLabels[status(project)]}`}`,
      label: consoleProjectName(project),
      project,
      slot: "project" as const,
      onSelect: () => {
        if (project.id !== current.value?.id) switchConsoleProject(project.id);
      },
    })),
  ],
  [
    { icon: "i-lucide-plus", label: "Link project", onSelect: () => { projects.linkOpen.value = true; } },
    {
      children: projects.projects.value.map((project): DropdownMenuItem => ({
        description: consoleProjectHost(project),
        label: consoleProjectName(project),
        onSelect: () => { forgetting.value = project; },
      })),
      icon: "i-lucide-trash-2",
      label: "Forget project",
    },
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

function forget(): void {
  const project = forgetting.value;
  forgetting.value = undefined;
  if (project) forgetConsoleProject(project.id);
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
      No tooltip: the rail shows the name and host when it expands, and the menu lists every project with its host.
    -->
    <PrimitiveRailItem class="vitehub-project-switcher" :label="`Switch project. Current: ${name}, ${host}`">
      <span class="vitehub-project-switcher__mark">{{ monogram }}</span>
      <template #label>
        <span class="vitehub-project-switcher__name">{{ name }}</span>
        <span class="vitehub-project-switcher__host">{{ host }}</span>
      </template>
    </PrimitiveRailItem>

    <template #project-leading="{ item }">
      <span class="vitehub-project-menu__dot" :data-status="itemStatus(item)" aria-hidden="true" />
    </template>
    <template #project-trailing="{ item }">
      <template v-if="projectOf(item)?.id === current?.id">
        <UIcon name="i-lucide-check" class="size-4 shrink-0 text-muted" aria-hidden="true" />
        <span class="sr-only">Open now</span>
      </template>
    </template>
  </UDropdownMenu>

  <UModal
    :open="Boolean(forgetting)"
    :title="forgetting ? `Forget ${consoleProjectName(forgetting)}?` : 'Forget project?'"
    :content="{ role: 'alertdialog' }"
    :ui="{ content: 'sm:max-w-[440px]' }"
    @update:open="(value: boolean) => { if (!value) forgetting = undefined; }"
  >
    <template #body>
      <p class="text-pretty text-[13px] text-muted">
        This browser removes the URL and the Console token of {{ forgetting ? consoleProjectHost(forgetting) : "the project" }}. The project does not change. To open it again, link it with its token.
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="forgetting = undefined" />
        <UButton color="error" label="Forget project" @click="forget" />
      </div>
    </template>
  </UModal>

  <ConsoleProjectLink v-model:open="projects.linkOpen.value" />
</template>

<style>
.vh-primitive-rail .vitehub-project-switcher .vh-primitive-rail__label {
  display: grid;
  line-height: 1rem;
}

.vitehub-project-switcher__mark {
  align-items: center;
  border: 1px solid var(--ui-border-accented);
  border-radius: 0.3125rem;
  color: var(--ui-text-highlighted);
  display: inline-flex;
  font-size: 0.6875rem;
  font-weight: 600;
  height: 1.25rem;
  justify-content: center;
  line-height: 1;
  width: 1.25rem;
}

.vitehub-project-switcher__name {
  color: var(--ui-text-highlighted);
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-project-switcher__host {
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-project-menu {
  width: 18rem;
}

.vitehub-project-menu__dot {
  background: var(--ui-text-dimmed);
  border-radius: 999px;
  flex: none;
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
