<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, reactive, ref } from "vue";

import type { ConsoleAccountAppStatus, ConsoleAccountProject } from "../client/account";
import { checkConsoleAccountProject } from "../client/account";
import { forgetConsoleProject, openAccountProject, openConsoleProject, showConsoleAccountPage, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost, consoleProjectName } from "../client/projects";
import ConsoleAccountLink from "./console-account-link.vue";
import ConsoleAccountMenu from "./console-account-menu.vue";
import ConsoleAccountSetup from "./console-account-setup.vue";
import ConsoleAccountStart from "./console-account-start.vue";
import ConsoleCodeText from "./console-code-text.vue";
import ConsoleMark from "./console-mark.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleToaster from "./console-toaster.vue";

const ConsoleAccountTeam = defineAsyncComponent(() => import("./console-account-team.vue"));
const ConsoleAccountSettings = defineAsyncComponent(() => import("./console-account-settings.vue"));

/**
 * The frame of an `account` Console before a project opens: a sidebar with the team, its apps, the team page, and the
 * settings, and a panel with the onboarding, a page, or the step that an app still needs.
 */
const projects = useConsoleProjects();
const gate = projects.gate;
const account = computed(() => projects.account.value);
const apps = computed<ConsoleAccountProject[]>(() => account.value?.projects ?? []);
const status = reactive<Record<string, ConsoleAccountAppStatus>>({});
const busy = ref(false);

const page = computed(() => {
  if (gate.value.kind === "home") return gate.value.page;
  if (gate.value.kind === "setup" || gate.value.kind === "problem") return "app";
  return "start";
});
const currentApp = computed(() => page.value === "app" ? projects.current.value?.id : undefined);
const title = computed(() => {
  if (page.value === "team") return "Team";
  if (page.value === "settings") return "Settings";
  if (page.value === "app") return projects.current.value ? consoleProjectName(projects.current.value) : "App";
  return "Get started";
});

const dotLabels: Record<ConsoleAccountAppStatus, string> = { checking: "Checking", connected: "Connected", setup: "Needs its variable", unreachable: "Not reachable" };

onMounted(() => {
  // The server calls each app with its token. A linked app answers, and an app without the variable refuses it.
  for (const app of apps.value) {
    status[app.id] = "checking";
    void checkConsoleAccountProject(app.id).then(
      (result) => { status[app.id] = result.linked ? "connected" : result.status === 401 || result.status === 500 ? "setup" : "unreachable"; },
      () => { status[app.id] = "unreachable"; },
    );
  }
});

async function retry(): Promise<void> {
  busy.value = true;
  await openConsoleProject().catch(() => undefined);
  busy.value = false;
}
</script>

<template>
  <UDashboardGroup class="vitehub-console" unit="rem" storage="local" storage-key="vitehub-console-account">
    <UDashboardSidebar
      id="console-account-navigation"
      class="vitehub-console__nav"
      :default-size="16"
      :min-size="14"
      :max-size="22"
      :menu="{ title: 'Console' }"
      :ui="{ body: 'gap-0 p-0', footer: 'grid gap-1 border-t border-default p-2' }"
    >
      <template #header>
        <div class="flex w-full min-w-0 items-center gap-1">
          <ConsoleMark class="ms-1.5 size-[1.125rem] text-highlighted" />
          <span class="text-dimmed" aria-hidden="true">/</span>
          <div class="min-w-0 flex-1">
            <ConsoleAccountMenu variant="team" />
          </div>
        </div>
      </template>

      <nav class="vitehub-console__section-nav pt-2" aria-label="Console">
        <button type="button" class="vitehub-console__section-link" :aria-current="page === 'start' ? 'page' : undefined" @click="showConsoleAccountPage('start')">
          <UIcon name="i-lucide-list-checks" class="vitehub-console__section-icon" />
          <span class="truncate">Get started</span>
        </button>

        <div class="vitehub-console__section-heading flex items-center justify-between pe-1">
          <span>Apps</span>
          <UTooltip text="Link an app">
            <UButton icon="i-lucide-plus" size="xs" variant="ghost" color="neutral" aria-label="Link an app" @click="projects.linkOpen.value = true" />
          </UTooltip>
        </div>
        <button
          v-for="app in apps"
          :key="app.id"
          type="button"
          class="vitehub-console__section-link"
          :aria-current="app.id === currentApp ? 'page' : undefined"
          @click="openAccountProject(app.id)"
        >
          <span class="vitehub-account-shell__dot" :data-status="status[app.id] ?? 'checking'" role="img" :aria-label="dotLabels[status[app.id] ?? 'checking']" />
          <span class="min-w-0 flex-1 truncate text-start">{{ consoleProjectName(app) }}</span>
        </button>
        <button v-if="!apps.length" type="button" class="vitehub-console__section-link text-dimmed" @click="projects.linkOpen.value = true">
          <UIcon name="i-lucide-link" class="vitehub-console__section-icon" />
          <span class="truncate">Link your first app</span>
        </button>

        <div class="vitehub-console__section-heading">Team</div>
        <button type="button" class="vitehub-console__section-link" :aria-current="page === 'team' ? 'page' : undefined" @click="showConsoleAccountPage('team')">
          <UIcon name="i-lucide-users" class="vitehub-console__section-icon" />
          <span class="truncate">Members</span>
        </button>
        <button type="button" class="vitehub-console__section-link" :aria-current="page === 'settings' ? 'page' : undefined" @click="showConsoleAccountPage('settings')">
          <UIcon name="i-lucide-settings" class="vitehub-console__section-icon" />
          <span class="truncate">Settings</span>
        </button>
      </nav>

      <template #footer>
        <a class="vitehub-console__section-link" href="https://vitehub.dev/docs/development/console#hosted-console" target="_blank" rel="noopener">
          <UIcon name="i-lucide-book-open" class="vitehub-console__section-icon" />
          <span class="flex-1 truncate">Docs</span>
          <UIcon name="i-lucide-arrow-up-right" class="size-3.5 text-dimmed" />
        </a>
        <ConsoleAccountMenu variant="user" />
      </template>
    </UDashboardSidebar>

    <UDashboardPanel id="console-account-page" :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <ConsolePageHeader :title="title" :description="page === 'app' && projects.current.value?.label ? consoleProjectHost(projects.current.value) : undefined" />
      </template>
      <template #body>
        <main class="vitehub-account-shell__page">
          <ConsoleAccountStart v-if="page === 'start'" :status="status" />
          <ConsoleAccountTeam v-else-if="page === 'team'" />
          <ConsoleAccountSettings v-else-if="page === 'settings'" />
          <div v-else-if="gate.kind === 'setup'" class="grid max-w-xl gap-5">
            <ConsoleAccountSetup :project="gate.project" />
          </div>
          <div v-else-if="gate.kind === 'problem'" class="grid max-w-xl gap-5">
            <div class="grid gap-1.5" role="alert">
              <h1 class="vitehub-project-gate__title">{{ gate.problem.title }}</h1>
              <p class="vitehub-project-gate__text"><ConsoleCodeText :text="gate.problem.message" /></p>
              <p v-if="gate.problem.fix" class="vitehub-project-gate__fix"><ConsoleCodeText :text="gate.problem.fix" /></p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton icon="i-lucide-refresh-cw" label="Try again" :loading="busy" @click="retry" />
              <UButton v-if="projects.current.value?.id" color="error" variant="ghost" icon="i-lucide-unlink" label="Unlink this app" @click="forgetConsoleProject(projects.current.value.id)" />
            </div>
          </div>
        </main>
      </template>
    </UDashboardPanel>

    <ConsoleAccountLink v-model:open="projects.linkOpen.value" />
    <ConsoleToaster />
  </UDashboardGroup>
</template>

<style>
.vitehub-account-shell__page {
  padding: clamp(1.5rem, 5vw, 3rem) clamp(1rem, 4vw, 2.5rem) 4rem;
}

.vitehub-account-shell__dot {
  border-radius: 999px;
  flex-shrink: 0;
  height: 0.5rem;
  margin-inline: 0.25rem;
  width: 0.5rem;
}

.vitehub-account-shell__dot[data-status="checking"] {
  box-shadow: inset 0 0 0 1px var(--ui-text-dimmed);
}

.vitehub-account-shell__dot[data-status="connected"] {
  background: var(--ui-success);
}

.vitehub-account-shell__dot[data-status="setup"] {
  background: var(--ui-warning);
}

.vitehub-account-shell__dot[data-status="unreachable"] {
  background: var(--ui-error);
}
</style>
