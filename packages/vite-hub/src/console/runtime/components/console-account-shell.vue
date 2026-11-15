<script setup lang="ts">
import type { Component } from "vue";
import { computed, defineAsyncComponent, inject, nextTick, onMounted, reactive, ref, shallowReactive, watch, watchEffect } from "vue";

import type { ConsoleAccountAppStatus, ConsoleAccountProject } from "../client/account";
import type { ConsoleAccountPage } from "../client/project-session";
import type { ConsoleProjectBuild } from "../client/project-link";
import { consoleAccountViewsKey } from "../client/account-views";
import { checkConsoleAccountProject, earlyConsoleSignInState, earlyConsoleTeam } from "../client/account";
import { useConsoleApp } from "../client/app-identity";
import { canManageConsoleProjects, consoleProjectDisplayName, openConsoleProject, showConsoleAccountPage, useConsoleProjects } from "../client/project-session";
import { closeConsoleSidebarDrawer, consoleSidebarDrawer } from "../client/sidebar";
import ConsoleAccountHome from "./console-account-home.vue";
import ConsoleAccountLink from "./console-account-link.vue";
import ConsoleAccountMenu from "./console-account-menu.vue";
import ConsoleAppLogo from "./console-app-logo.vue";
import ConsoleAccountSetup from "./console-account-setup.vue";
import ConsoleAccountUnlink from "./console-account-unlink.vue";
import ConsoleCodeText from "./console-code-text.vue";
import ConsoleProjectSwitcher from "./console-project-switcher.vue";
import ConsoleSidebar from "./console-sidebar.vue";
import ConsoleSidebarItem from "./console-sidebar-item.vue";
import ConsoleSidebarTrigger from "./console-sidebar-trigger.vue";
import ConsoleToaster from "./console-toaster.vue";

// A page whose code has loaded renders at once. The page of the first paint loads before the app mounts, and the other
// pages load when the browser is idle. Until then, a page loads on demand.
const views = inject(consoleAccountViewsKey, {});
const pageCode = {
  team: () => import("./console-account-team.vue"),
  settings: () => import("./console-account-settings.vue"),
};
const loadedPages = shallowReactive<{ team?: Component, settings?: Component }>({ team: views.team, settings: views.settings });
const ConsoleAccountTeam = computed(() => loadedPages.team ?? defineAsyncComponent(pageCode.team));
const ConsoleAccountSettings = computed(() => loadedPages.settings ?? defineAsyncComponent(pageCode.settings));

/**
 * The frame of an `account` Console before a project opens: the Console sidebar with the pages of the team, and a panel
 * with the apps, a page, or the step that an app still needs. An open app shows the same sidebar with its own pages.
 */
const projects = useConsoleProjects();
const gate = projects.gate;
const account = computed(() => projects.account.value);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
const apps = computed<ConsoleAccountProject[]>(() => account.value?.projects ?? []);
// Only owners and admins link apps, so only they see the controls for it.
const manage = computed(() => account.value ? canManageConsoleProjects(account.value) : false);
const status = reactive<Record<string, ConsoleAccountAppStatus>>({});
// The build that each connected app reported in its check, for the Last deploy cell of Home.
const builds = reactive<Record<string, ConsoleProjectBuild>>({});
const busy = ref(false);
const unlinking = ref(false);
const app = useConsoleApp();

const page = computed(() => {
  if (gate.value.kind === "home") return gate.value.page;
  if (gate.value.kind === "setup" || gate.value.kind === "problem" || gate.value.kind === "opening") return "app";
  return "home";
});
const currentApp = computed(() => page.value === "app" ? projects.current.value?.id : undefined);
const title = computed(() => {
  if (page.value === "team") return "Members";
  if (page.value === "settings") return "Account settings";
  if (page.value === "home") return "Apps";
  if (gate.value.kind === "setup") return `Connect ${appName(gate.value.project)}`;
  return projects.current.value ? appName(projects.current.value) : "App";
});

function appName(app: { id: string, label?: string | null, url: string }): string {
  return consoleProjectDisplayName(app);
}

function pagePath(target: ConsoleAccountPage): string {
  return `${projects.home.replace(/\/+$/, "")}/${target}`;
}

/** A plain click changes the page in place. A click with a modifier key opens the link as the browser does. */
function follow(event: MouseEvent, action: () => void): boolean {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return false;
  event.preventDefault();
  action();
  return true;
}


// After a page change in place, from the sidebar, a menu, or a button on the page, the drawer of a small screen closes
// and focus moves to the page title, as a page load would.
watch(() => [page.value, title.value], () => {
  if (consoleSidebarDrawer.value) closeConsoleSidebarDrawer();
  void nextTick(() => document.getElementById("vitehub-account-title")?.focus());
});

watchEffect(() => {
  document.title = page.value === "settings" ? `${title.value} · ViteHub Console` : `${title.value} · ${team.value?.name ?? "Team"} · ViteHub Console`;
});

/** Keep the code of a page that is not open, so the page renders at once when it opens. */
function preparePage(target: "team" | "settings"): void {
  if (loadedPages[target]) return;
  void pageCode[target]().then((module) => {
    // The open page keeps its component, so it does not mount again.
    if (page.value !== target) loadedPages[target] = module.default;
  }, () => undefined);
}

/** The pointer or the focus reached the link of a page: its data starts to load. */
function intent(target: "team" | "settings"): void {
  if (page.value === target) return;
  void (target === "team" ? earlyConsoleTeam : earlyConsoleSignInState).start();
  preparePage(target);
}

onMounted(() => {
  const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 200));
  idle(() => {
    preparePage("team");
    preparePage("settings");
  });
  // The server calls each app with its token. A linked app answers, and an app without the variable refuses it.
  for (const app of apps.value) {
    status[app.id] = "checking";
    void checkConsoleAccountProject(app.id).then(
      (result) => {
        status[app.id] = result.status;
        if (result.build) builds[app.id] = result.build;
      },
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
  <UDashboardGroup class="vitehub-console vitehub-account-shell" unit="rem" storage="local" storage-key="vitehub-console-account">
    <a href="#vitehub-account-main" class="vitehub-console__skip-link">Skip to content</a>
    <ConsoleSidebar :home-href="pagePath('home')" home-label="ViteHub, all apps" :team="team?.name" :search="false" @home="follow($event, () => showConsoleAccountPage('home'))">
      <template v-if="page === 'app' && projects.current.value" #app>
        <ConsoleProjectSwitcher :app="app" />
      </template>

      <ConsoleSidebarItem
        label="Apps"
        icon="i-lucide-layout-grid"
        :href="pagePath('home')"
        :current="page === 'home'"
        :badge="apps.length || undefined"
        badge-label="apps"
        @click="follow($event, () => showConsoleAccountPage('home'))"
      />
      <ConsoleSidebarItem
        label="Members"
        icon="i-lucide-users"
        :href="pagePath('team')"
        :current="page === 'team'"
        @pointerenter="intent('team')"
        @focus="intent('team')"
        @click="follow($event, () => showConsoleAccountPage('team'))"
      />

      <template #footer>
        <ConsoleAccountMenu />
      </template>
    </ConsoleSidebar>

    <UDashboardPanel id="console-account-page" :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <UDashboardNavbar :as="{ title: 'div' }" :ui="{ root: 'border-b border-default' }" :toggle="false">
          <template #leading>
            <ConsoleSidebarTrigger />
          </template>
          <template #title>
            <span class="flex min-w-0 items-center gap-2 text-sm">
              <template v-if="page === 'app' && projects.current.value">
                <ConsoleAppLogo :app="app" class="vitehub-account-shell__logo" />
              </template>
              <template v-else-if="page !== 'settings'">
                <span class="hidden truncate text-muted sm:inline">{{ team?.name ?? "Team" }}</span>
                <span class="hidden text-dimmed sm:inline" aria-hidden="true">/</span>
              </template>
              <h1 id="vitehub-account-title" tabindex="-1" class="truncate font-semibold text-highlighted outline-none">{{ title }}</h1>
            </span>
          </template>
        </UDashboardNavbar>
      </template>
      <template #body>
        <main id="vitehub-account-main" tabindex="-1" class="vitehub-account-shell__page outline-none">
          <ConsoleAccountHome v-if="page === 'home'" :status="status" :builds="builds" />
          <component :is="ConsoleAccountTeam" v-else-if="page === 'team'" />
          <component :is="ConsoleAccountSettings" v-else-if="page === 'settings'" />
          <ConsoleAccountSetup v-else-if="gate.kind === 'setup'" :key="gate.project.id" :project="gate.project" @checked="(value) => { status[gate.project.id] = value; }" />
          <p v-else-if="gate.kind === 'opening'" role="status" class="flex max-w-2xl items-center gap-2 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 motion-safe:animate-spin" aria-hidden="true" />
            Opening {{ title }}…
          </p>
          <div v-else-if="gate.kind === 'problem'" class="grid max-w-2xl gap-6">
            <header class="grid gap-1" role="alert">
              <h2 class="text-xl font-semibold text-highlighted">{{ gate.problem.title }}</h2>
              <p class="text-sm text-pretty text-muted"><ConsoleCodeText :text="gate.problem.message" /></p>
              <p v-if="gate.problem.fix" class="text-sm text-pretty text-default"><ConsoleCodeText :text="gate.problem.fix" /></p>
            </header>
            <div class="flex flex-wrap gap-2">
              <UButton icon="i-lucide-refresh-cw" label="Try again" :loading="busy" @click="retry" />
              <UButton v-if="projects.current.value?.id" color="neutral" variant="ghost" icon="i-lucide-unlink" :label="`Unlink ${appName(projects.current.value)}`" @click="unlinking = true" />
            </div>
            <ConsoleAccountUnlink v-if="projects.current.value?.id" v-model:open="unlinking" :project-id="projects.current.value.id" :name="appName(projects.current.value)" />
          </div>
        </main>
      </template>
    </UDashboardPanel>

    <ConsoleAccountLink v-if="!(page === 'app' && projects.current.value)" v-model:open="projects.linkOpen.value" />
    <ConsoleToaster />
  </UDashboardGroup>
</template>

<style>
/* Icons on the pages are 1.15 times the size of their label: 16px beside 14px page text. */
.vitehub-account-shell .vitehub-account-icon {
  height: calc(0.875rem * 1.15);
  width: calc(0.875rem * 1.15);
}

.vitehub-account-shell .vitehub-account-shell__logo {
  border-radius: 0.25rem;
  font-size: 0.5625rem;
  height: 1.125rem;
  width: 1.125rem;
}

.vitehub-account-shell__page {
  padding: clamp(1.5rem, 5vw, 3rem) clamp(1rem, 4vw, 2.5rem) 4rem;
}

/* One reading column, centered in the panel, so a wide screen keeps the page in front of the person. */
.vitehub-account-shell__page > * {
  margin-inline: auto;
}

.vitehub-account-shell__dot {
  border-radius: 999px;
  flex-shrink: 0;
  height: 0.5rem;
  width: 0.5rem;
}

.vitehub-account-shell__dot[data-status="checking"] {
  box-shadow: inset 0 0 0 1px var(--ui-text-muted);
}

.vitehub-account-shell__dot[data-status="connected"] {
  background: var(--ui-success);
}

.vitehub-account-shell__dot[data-status="setup"],
.vitehub-account-shell__dot[data-status="unconfigured"] {
  background: var(--ui-warning);
}

.vitehub-account-shell__dot[data-status="unreachable"] {
  background: var(--ui-error);
}

/* Touch screens get 44px rows and 16px fields, so taps land and iOS does not zoom into a field. */
@media (pointer: coarse) {
  /* Menus, dialogs, and the drawer of a small screen render under body, outside the shell. */
  body:has(.vitehub-account-shell) :is([role="menuitem"], [role="menuitemcheckbox"], [role="option"]),
  body:has(.vitehub-account-shell) [role="dialog"] :is(a, button, input, select) {
    min-height: 2.75rem;
  }

  body:has(.vitehub-account-shell) [role="dialog"] button {
    min-width: 2.75rem;
  }

  body:has(.vitehub-account-shell) [role="dialog"] :is(input, textarea) {
    font-size: 1rem;
  }

  .vitehub-account-shell :is(input, select, textarea) {
    font-size: 1rem;
    min-height: 2.75rem;
  }

  .vitehub-account-shell :is(.vitehub-sidebar__item, button) {
    min-height: 2.75rem;
  }

  .vitehub-account-shell button {
    min-width: 2.75rem;
  }
}
</style>
