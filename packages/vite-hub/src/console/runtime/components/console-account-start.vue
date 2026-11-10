<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import type { ConsoleAccountAppStatus } from "../client/account";
import { canManageConsoleProjects, loadConsoleTeam } from "../client/account";
import { linkAccountProject, openAccountProject, showConsoleAccountPage, useConsoleProjects } from "../client/project-session";
import { consoleProjectHost, consoleProjectName } from "../client/projects";

/**
 * The onboarding of an `account` Console: what the team has done, and the next step. Linking the first app happens
 * here, without a dialog.
 */
const props = defineProps<{ status: Record<string, ConsoleAccountAppStatus> }>();

const projects = useConsoleProjects();
const account = computed(() => projects.account.value);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
const apps = computed(() => account.value?.projects ?? []);
const manage = computed(() => account.value ? canManageConsoleProjects(account.value) : false);
const firstName = computed(() => account.value?.user.name.split(/\s+/)[0] ?? "");
const shared = ref(false);

const url = ref("");
const busy = ref(false);
const problem = ref<string>();
const framework = ref("nuxt");
const snippets: Record<string, { file: string, code: string }> = {
  nuxt: { file: "nuxt.config.ts", code: "export default defineNuxtConfig({\n  modules: ['vite-hub/nuxt'],\n  vitehub: {\n    console: { auth: 'token' },\n  },\n})" },
  vite: { file: "vite.config.ts", code: "export default defineConfig({\n  plugins: [vitehub({\n    console: { auth: 'token' },\n  })],\n})" },
};

const setupApp = computed(() => apps.value.find(app => props.status[app.id] === "setup"));
const steps = computed(() => {
  const linked = apps.value.length > 0;
  const connected = apps.value.some(app => props.status[app.id] === "connected");
  return [
    { id: "account", done: true },
    { id: "link", done: linked },
    { id: "connect", done: connected },
    { id: "invite", done: shared.value },
  ] as const;
});
const doneCount = computed(() => steps.value.filter(step => step.done).length);
const active = computed(() => steps.value.find(step => !step.done)?.id);

onMounted(async () => {
  const details = await loadConsoleTeam().catch(() => undefined);
  shared.value = Boolean(details && (details.members.length > 1 || details.invitations.length > 0));
});

async function link(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = undefined;
  try {
    await linkAccountProject(url.value);
  }
  catch (error) {
    problem.value = error instanceof Error ? error.message : "Try again.";
    busy.value = false;
  }
}

const statusLabels: Record<ConsoleAccountAppStatus, string> = { checking: "Checking…", connected: "Connected", setup: "Needs its variable", unreachable: "Not reachable" };
</script>

<template>
  <div class="grid max-w-2xl gap-8">
    <header class="grid gap-3">
      <div class="grid gap-1">
        <h1 class="text-xl font-semibold text-highlighted">{{ firstName ? `Welcome, ${firstName}` : "Welcome" }}</h1>
        <p class="text-sm text-pretty text-muted">Set up {{ team?.name ?? "your team" }} in a few steps. Each app that you link opens here, for everyone in the team, in any browser.</p>
      </div>
      <div class="flex items-center gap-3" role="group" :aria-label="`${doneCount} of ${steps.length} steps done`">
        <div class="flex flex-1 gap-1" aria-hidden="true">
          <span v-for="step in steps" :key="step.id" class="h-1 flex-1 rounded-full" :class="step.done ? 'bg-inverted' : 'bg-accented'" />
        </div>
        <span class="text-xs tabular-nums text-dimmed">{{ doneCount }} of {{ steps.length }}</span>
      </div>
    </header>

    <ol class="vitehub-account-steps">
      <li class="vitehub-account-step" data-done>
        <span class="vitehub-account-step__mark" aria-hidden="true"><UIcon name="i-lucide-check" class="size-3.5" /></span>
        <div class="vitehub-account-step__body">
          <h2 class="vitehub-account-step__title">Create your account</h2>
          <p class="vitehub-account-step__text">Signed in as {{ account?.user.name }}. Your personal team is ready.</p>
        </div>
      </li>

      <li class="vitehub-account-step" :data-done="steps[1].done || undefined" :data-active="active === 'link' || undefined">
        <span class="vitehub-account-step__mark" aria-hidden="true"><UIcon v-if="steps[1].done" name="i-lucide-check" class="size-3.5" /><template v-else>2</template></span>
        <div class="vitehub-account-step__body">
          <h2 class="vitehub-account-step__title">Link an app</h2>
          <p class="vitehub-account-step__text">
            <template v-if="steps[1].done">{{ apps.length === 1 ? "1 app is" : `${apps.length} apps are` }} linked to {{ team?.name ?? "this team" }}.</template>
            <template v-else>Turn on the Console token in a deployed ViteHub app, then enter its URL.</template>
          </p>
          <template v-if="active === 'link'">
            <div class="vitehub-account-snippet">
              <div class="flex items-center justify-between gap-2 border-b border-default px-1">
                <UTabs v-model="framework" :items="[{ label: 'Nuxt', value: 'nuxt' }, { label: 'Vite', value: 'vite' }]" :content="false" variant="link" size="xs" color="neutral" />
                <span class="pe-2 font-mono text-xs text-dimmed">{{ snippets[framework]!.file }}</span>
              </div>
              <pre class="overflow-x-auto p-3 font-mono text-xs leading-5 text-default">{{ snippets[framework]!.code }}</pre>
            </div>
            <form v-if="manage" class="grid gap-1.5" @submit.prevent="link">
              <div class="flex flex-wrap gap-2">
                <UInput v-model="url" type="url" inputmode="url" autocomplete="url" placeholder="https://app.example.com" aria-label="App URL" required class="min-w-56 flex-1" />
                <UButton type="submit" icon="i-lucide-link" label="Link app" :loading="busy" />
              </div>
              <p v-if="problem" role="alert" class="text-[13px] text-error">{{ problem }}</p>
            </form>
            <p v-else class="vitehub-account-step__text">Only owners and admins of {{ team?.name ?? "this team" }} link apps. Ask one of them to link yours.</p>
          </template>
        </div>
      </li>

      <li class="vitehub-account-step" :data-done="steps[2].done || undefined" :data-active="active === 'connect' || undefined">
        <span class="vitehub-account-step__mark" aria-hidden="true"><UIcon v-if="steps[2].done" name="i-lucide-check" class="size-3.5" /><template v-else>3</template></span>
        <div class="vitehub-account-step__body">
          <h2 class="vitehub-account-step__title">Set its variable</h2>
          <p class="vitehub-account-step__text">
            <template v-if="steps[2].done">The app accepts its token. Open it from the sidebar.</template>
            <template v-else>The Console shows one variable for each app. The app keeps only the SHA-256 of the token, and the token never reaches the browser.</template>
          </p>
          <UButton v-if="active === 'connect' && setupApp" class="justify-self-start" icon="i-lucide-key-round" :label="`Show the variable for ${consoleProjectName(setupApp)}`" @click="openAccountProject(setupApp.id)" />
        </div>
      </li>

      <li class="vitehub-account-step" :data-done="steps[3].done || undefined" :data-active="active === 'invite' || undefined">
        <span class="vitehub-account-step__mark" aria-hidden="true"><UIcon v-if="steps[3].done" name="i-lucide-check" class="size-3.5" /><template v-else>4</template></span>
        <div class="vitehub-account-step__body">
          <h2 class="vitehub-account-step__title">Invite your team <span class="font-normal text-dimmed">Optional</span></h2>
          <p class="vitehub-account-step__text">
            <template v-if="steps[3].done">Your team has more people, or an invitation that waits for them.</template>
            <template v-else>People in the team open the same apps. Invite them by the email of their GitHub account.</template>
          </p>
          <UButton v-if="!steps[3].done" class="justify-self-start" color="neutral" variant="outline" icon="i-lucide-user-plus" label="Invite people" @click="showConsoleAccountPage('team')" />
        </div>
      </li>
    </ol>

    <section v-if="apps.length" class="grid gap-2" aria-labelledby="vitehub-account-apps">
      <div class="flex items-center justify-between gap-2">
        <h2 id="vitehub-account-apps" class="text-sm font-semibold text-highlighted">Apps</h2>
        <UButton v-if="manage" size="sm" color="neutral" variant="ghost" icon="i-lucide-plus" label="Link an app" @click="projects.linkOpen.value = true" />
      </div>
      <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default">
        <li v-for="app in apps" :key="app.id">
          <button type="button" class="vitehub-account-app" @click="openAccountProject(app.id)">
            <span class="vitehub-account-shell__dot" :data-status="status[app.id] ?? 'checking'" aria-hidden="true" />
            <span class="grid min-w-0 flex-1 text-start">
              <span class="truncate text-sm font-medium text-highlighted">{{ consoleProjectName(app) }}</span>
              <span class="truncate font-mono text-xs text-dimmed">{{ consoleProjectHost(app) }}</span>
            </span>
            <span class="text-xs text-muted">{{ statusLabels[status[app.id] ?? "checking"] }}</span>
            <UIcon name="i-lucide-chevron-right" class="size-4 text-dimmed" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style>
.vitehub-account-steps {
  border: 1px solid var(--ui-border);
  border-radius: 0.625rem;
  display: grid;
}

.vitehub-account-step {
  display: grid;
  gap: 0.875rem;
  grid-template-columns: 1.5rem minmax(0, 1fr);
  padding: 1rem 1.125rem;
}

.vitehub-account-step + .vitehub-account-step {
  border-top: 1px solid var(--ui-border);
}

.vitehub-account-step[data-active] {
  background: var(--ui-bg-muted);
}

.vitehub-account-step__mark {
  align-items: center;
  border: 1px solid var(--ui-border-accented);
  border-radius: 999px;
  color: var(--ui-text-muted);
  display: inline-flex;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  height: 1.5rem;
  justify-content: center;
  width: 1.5rem;
}

.vitehub-account-step[data-active] .vitehub-account-step__mark {
  background: var(--ui-bg-inverted);
  border-color: var(--ui-bg-inverted);
  color: var(--ui-bg);
}

.vitehub-account-step[data-done] .vitehub-account-step__mark {
  background: var(--ui-bg-accented);
  border-color: transparent;
  color: var(--ui-text-highlighted);
}

.vitehub-account-step__body {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}

.vitehub-account-step__title {
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.5rem;
}

.vitehub-account-step__title + .vitehub-account-step__text {
  margin-top: -0.625rem;
}

.vitehub-account-step__text {
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  line-height: 1.25rem;
  text-wrap: pretty;
}

.vitehub-account-step[data-done] .vitehub-account-step__title {
  color: var(--ui-text-muted);
}

.vitehub-account-snippet {
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  min-width: 0;
}

.vitehub-account-app {
  align-items: center;
  display: flex;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem;
  width: 100%;
}

.vitehub-account-app:hover {
  background: var(--ui-bg-elevated);
}

.vitehub-account-app:focus-visible {
  outline: 2px solid var(--vitehub-console-focus);
  outline-offset: -2px;
}
</style>
