<script setup lang="ts">
import { computed, defineAsyncComponent, inject, onMounted, ref } from "vue";

import type { DropdownMenuItem } from "@nuxt/ui";
import { consoleAccountViewsKey } from "../client/account-views";
import { canManageConsoleProjects, forgetConsoleProject, openConsoleProject, switchConsoleProject, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost, consoleProjectName } from "../client/projects";
import ConsoleCodeText from "./console-code-text.vue";
import ConsoleMark from "./console-mark.vue";

// Only an `account` Console shows these, so they load with the Better Auth client. The page loads the view of its first
// paint before it mounts.
const views = inject(consoleAccountViewsKey, {});
const ConsoleAccountLink = defineAsyncComponent(() => import("./console-account-link.vue"));
const ConsoleAccountShell = views.shell ?? defineAsyncComponent(() => import("./console-account-shell.vue"));
const ConsoleAccountSignIn = views.signIn ?? defineAsyncComponent(() => import("./console-account-sign-in.vue"));

/**
 * What the Console shows before it opens a project: the sign-in page or the team sidebar of an `account` Console, or
 * why the project did not open. While the project answers, it draws the same shapes as the server page.
 */
const projects = useConsoleProjects();
const gate = projects.gate;
const busy = ref(false);

const current = computed(() => projects.current.value);
// A signed-in person of an `account` Console sees the sidebar of the team on every page before a project opens.
// A project that is still opening stays in the sidebar when the page started there.
const accountShell = computed(() => projects.mode === "account" && Boolean(projects.account.value) && (["home", "empty", "setup", "problem"].includes(gate.value.kind) || (gate.value.kind === "opening" && projects.openingView === "shell")));
const host = computed(() => current.value ? consoleProjectHost(current.value) : "");
const others = computed(() => projects.projects.value.filter(project => project.id !== current.value?.id));
const switchItems = computed<DropdownMenuItem[][]>(() => [
  others.value.map(project => ({ label: consoleProjectName(project), description: consoleProjectHost(project), onSelect: () => switchConsoleProject(project.id) })),
  [
    { icon: "i-lucide-link", label: "Link an app", onSelect: () => { projects.linkOpen.value = true; } },
    ...(current.value?.id ? [{ color: "error" as const, icon: "i-lucide-trash-2", label: "Unlink this project", onSelect: () => void forgetConsoleProject(current.value!.id) }] : []),
  ],
].filter(group => group.length));

/**
 * Why a `/_vitehub` link did not sign the browser in to the app: one title and one sentence, then the way back to the
 * page. Owners and admins can link an app that is no project of the team.
 */
const siteRefusal = computed(() => {
  const value = gate.value;
  if (value.kind !== "site-refused") return { title: "", text: "", host: "", back: "", link: false };
  const host = consoleProjectHost({ url: value.url });
  const team = projects.account.value?.teams.find(item => item.id === projects.account.value?.teamId)?.name ?? "your team";
  const back = `${value.url}${value.page}`;
  if (!value.linked) {
    const link = projects.account.value ? canManageConsoleProjects(projects.account.value) : false;
    return { title: `${host} is not an app of ${team}`, text: link ? "Link it once, and /_vitehub signs you in there." : "Ask an owner of the team that has this app to invite you.", host, back, link };
  }
  return { title: `${host} did not sign you in`, text: value.message ?? "Try again.", host, back, link: false };
});

async function retry(): Promise<void> {
  if (gate.value.kind === "problem" && gate.value.home) {
    projects.navigate(projects.home);
    return;
  }
  busy.value = true;
  await openConsoleProject().catch(() => undefined);
  busy.value = false;
}

// The page of an `account` Console opens its project before it renders, so a slow project is already opening.
onMounted(() => {
  if (gate.value.kind === "opening" && projects.mode !== "account") void openConsoleProject();
});
</script>

<template>
  <ConsoleAccountShell v-if="accountShell" />

  <div v-else-if="gate.kind === 'opening' || gate.kind === 'site'" class="vitehub-console-boot">
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
        {{ host && projects.mode !== "embedded" ? `Opening ${host}…` : "Opening Console…" }}
      </p>
    </div>
  </div>

  <main v-else class="vitehub-project-gate">
    <div class="vitehub-project-gate__body">
      <ConsoleMark class="size-6 text-highlighted!" />

      <ConsoleAccountSignIn v-if="gate.kind === 'account'" :invitation="gate.invitation" />

      <template v-else-if="gate.kind === 'site-refused'">
        <div class="grid gap-1.5" role="alert">
          <h1 class="vitehub-project-gate__title">{{ siteRefusal.title }}</h1>
          <p class="vitehub-project-gate__text">{{ siteRefusal.text }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton v-if="siteRefusal.link" icon="i-lucide-link" label="Link this app" @click="projects.linkOpen.value = true" />
          <UButton :color="siteRefusal.link ? 'neutral' : 'primary'" :variant="siteRefusal.link ? 'outline' : 'solid'" icon="i-lucide-arrow-left" :label="`Back to ${siteRefusal.host}`" :href="siteRefusal.back" />
        </div>
      </template>

      <template v-else-if="gate.kind === 'problem'">
        <div class="grid gap-1.5" role="alert">
          <h1 class="vitehub-project-gate__title">{{ gate.problem.title }}</h1>
          <p class="vitehub-project-gate__text"><ConsoleCodeText :text="gate.problem.message" /></p>
          <p v-if="gate.problem.fix" class="vitehub-project-gate__fix"><ConsoleCodeText :text="gate.problem.fix" /></p>
        </div>
        <UButton
          :icon="gate.home ? 'i-lucide-arrow-left' : 'i-lucide-refresh-cw'"
          :label="gate.home ? 'Back to the Console' : 'Try again'"
          class="justify-self-start"
          :loading="busy"
          @click="retry"
        />
      </template>

      <div v-if="projects.mode !== 'embedded' && current && gate.kind !== 'empty' && gate.kind !== 'account' && gate.kind !== 'site-refused'" class="vitehub-project-gate__host">
        <span class="min-w-0 truncate font-mono">{{ current.url }}</span>
        <UDropdownMenu :items="switchItems" :content="{ align: 'end' }" :ui="{ content: 'min-w-60', item: 'pointer-coarse:min-h-11' }">
          <UButton variant="ghost" size="xs" trailing-icon="i-lucide-chevron-down" label="Switch project" />
        </UDropdownMenu>
      </div>
    </div>
    <ConsoleAccountLink v-if="projects.mode === 'account'" v-model:open="projects.linkOpen.value" :url="gate.kind === 'site-refused' ? gate.url : undefined" />
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
