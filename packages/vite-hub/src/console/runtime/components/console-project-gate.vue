<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import type { ConsoleProjectProblem } from "../client/project-link";
import { consoleTokenRefused } from "../client/project-link";
import { consoleProjectsVolatileNote, forgetConsoleProject, openConsoleProject, signInConsoleProject, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost, consoleProjectName } from "../client/projects";
import ConsoleCodeText from "./console-code-text.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleProjectLink from "./console-project-link.vue";
import ConsoleProjectToken from "./console-project-token.vue";

/**
 * What the Console shows before it opens a project: the empty state of a hosted Console, the Console token form, or why
 * the project did not open. While the project answers, it draws the same shapes as the server page.
 */
const projects = useConsoleProjects();
const gate = projects.gate;
const busy = ref(false);
const tokenError = shallowRef<ConsoleProjectProblem>();

const current = computed(() => projects.current.value);
const host = computed(() => current.value ? consoleProjectHost(current.value) : "");
const others = computed(() => projects.projects.value.filter(project => project.id !== current.value?.id));
const switchItems = computed<DropdownMenuItem[][]>(() => [
  others.value.map(project => ({ label: consoleProjectName(project), description: consoleProjectHost(project), onSelect: () => switchConsoleProject(project.id) })),
  [
    { icon: "i-lucide-plus", label: "Link project", onSelect: () => { projects.linkOpen.value = true; } },
    ...(current.value?.id ? [{ color: "error" as const, icon: "i-lucide-trash-2", label: "Forget this project", onSelect: () => forgetConsoleProject(current.value!.id) }] : []),
  ],
].filter(group => group.length));

async function signIn(token: string): Promise<void> {
  busy.value = true;
  tokenError.value = undefined;
  const next = await signInConsoleProject(token).catch(() => undefined);
  busy.value = false;
  if (!next) tokenError.value = { title: `Cannot reach ${host.value}`, message: "Check the connection and try again." };
  else if (next.kind === "token") tokenError.value = { title: "The token is not correct", message: consoleTokenRefused(host.value) };
  else if (next.kind === "problem") tokenError.value = next.problem;
}

async function retry(): Promise<void> {
  busy.value = true;
  await openConsoleProject().catch(() => undefined);
  busy.value = false;
}

onMounted(() => {
  if (gate.value.kind === "opening") void openConsoleProject();
});
</script>

<template>
  <div v-if="gate.kind === 'opening'" class="vitehub-console-boot">
    <div class="vh-primitive-rail">
      <div class="vh-primitive-rail__surface">
        <div class="vh-primitive-rail__header">
          <span class="vh-primitive-rail__item"><span class="vh-primitive-rail__icon"><ConsoleMark class="vitehub-console-boot__mark" /></span></span>
        </div>
      </div>
    </div>
    <div class="vitehub-console-boot__panel">
      <div class="vitehub-console-boot__header" />
      <p role="status" class="vitehub-console-opening">
        <UIcon name="i-lucide-loader-circle" class="size-4 motion-safe:animate-spin" aria-hidden="true" />
        {{ host && projects.mode === "hosted" ? `Opening ${host}…` : "Opening Console…" }}
      </p>
    </div>
  </div>

  <main v-else class="vitehub-project-gate">
    <div class="vitehub-project-gate__body">
      <ConsoleMark class="size-6 text-highlighted" />

      <template v-if="gate.kind === 'empty'">
        <div class="grid gap-1.5">
          <h1 class="vitehub-project-gate__title">Link your first project</h1>
          <p class="vitehub-project-gate__text"><ConsoleCodeText text="This Console opens ViteHub apps that list it in `console.origins`. The project list and tokens stay in this browser." /></p>
        </div>
        <UButton icon="i-lucide-plus" label="Link project" class="justify-self-start" @click="projects.linkOpen.value = true" />
      </template>

      <template v-else-if="gate.kind === 'token'">
        <div class="grid gap-1.5">
          <h1 class="vitehub-project-gate__title">Enter the Console token</h1>
          <p class="vitehub-project-gate__text">
            <template v-if="gate.rejected && !tokenError">The saved token no longer works for {{ host }}. Paste the current token.</template>
            <ConsoleCodeText v-else :text="`${host} uses \`auth: &quot;token&quot;\`.`" />
          </p>
        </div>
        <ConsoleProjectToken :busy="busy" :problem="tokenError" @submit="signIn" />
      </template>

      <template v-else-if="gate.kind === 'problem'">
        <div class="grid gap-1.5" role="alert">
          <h1 class="vitehub-project-gate__title">{{ gate.problem.title }}</h1>
          <p class="vitehub-project-gate__text"><ConsoleCodeText :text="gate.problem.message" /></p>
          <p v-if="gate.problem.fix" class="vitehub-project-gate__fix"><ConsoleCodeText :text="gate.problem.fix" /></p>
        </div>
        <UButton icon="i-lucide-refresh-cw" label="Try again" class="justify-self-start" :loading="busy" @click="retry" />
      </template>

      <p v-if="!projects.persistent.value" class="vitehub-project-gate__note">
        <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {{ consoleProjectsVolatileNote }}
      </p>

      <div v-if="projects.mode === 'hosted' && current && gate.kind !== 'empty'" class="vitehub-project-gate__host">
        <span class="min-w-0 truncate font-mono">{{ current.url }}</span>
        <UDropdownMenu :items="switchItems" :content="{ align: 'end' }" :ui="{ content: 'min-w-60', item: 'pointer-coarse:min-h-11' }">
          <UButton variant="ghost" size="xs" trailing-icon="i-lucide-chevron-down" label="Switch project" />
        </UDropdownMenu>
      </div>
    </div>
    <ConsoleProjectLink v-model:open="projects.linkOpen.value" />
  </main>
</template>

<style>
/* The top of the form stays in place, so an error below a field moves nothing above it. */
.vitehub-project-gate {
  align-items: start;
  display: grid;
  justify-items: center;
  min-height: 100dvh;
  padding: min(18dvh, 10rem) 1.5rem 1.5rem;
}

.vitehub-project-gate__body {
  display: grid;
  gap: 1.25rem;
  width: min(24rem, 100%);
}

.vitehub-project-gate__title {
  color: var(--ui-text-highlighted);
  font-size: 1.125rem;
  font-weight: 600;
  line-height: 1.5rem;
  overflow-wrap: anywhere;
  text-wrap: balance;
}

.vitehub-project-gate__text {
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.25rem;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.vitehub-project-gate__fix {
  color: var(--ui-text);
  font-size: 0.875rem;
  line-height: 1.25rem;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.vitehub-project-gate__note {
  color: var(--ui-text-muted);
  display: flex;
  font-size: 0.75rem;
  gap: 0.375rem;
  line-height: 1rem;
  text-wrap: pretty;
}

@media (pointer: coarse) {
  .vitehub-project-gate :is(button:not([role="checkbox"], [role="radio"]), input) {
    min-height: 44px;
  }
}

.vitehub-project-gate__host {
  align-items: center;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-text-dimmed);
  display: flex;
  font-size: 0.75rem;
  gap: 0.75rem;
  justify-content: space-between;
  padding-top: 0.75rem;
}
</style>
