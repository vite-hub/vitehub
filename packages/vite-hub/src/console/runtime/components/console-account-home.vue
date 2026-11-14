<script setup lang="ts">
import { viteHubPageToolsQuery } from "@vite-hub/internal/runtime/page-tools-shared";
import { computed, onMounted, ref, shallowRef, watch } from "vue";

import type { ConsoleAccountAppStatus, ConsoleAccountCheck, ConsoleAccountProject } from "../client/account";
import { accountAppStatusLabels, loadConsoleTeam } from "../client/account";
import { consoleAppIdentity } from "../client/app-identity";
import { accountProjectPath, canManageConsoleProjects, consoleProjectDisplayName, linkAccountProject, openAccountProject, showConsoleAccountPage, useConsoleProjects } from "../client/project-session";
import { consoleProjectTarget } from "../client/projects";
import ConsoleAccountSnippet from "./console-account-snippet.vue";
import ConsoleAccountUnlink from "./console-account-unlink.vue";
import ConsoleAppLogo from "./console-app-logo.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";

/**
 * Home of an `account` Console. Until the team has a connected app, it is the setup checklist, and the first app is
 * linked here without a dialog. After that, it is the table of apps.
 */
const props = defineProps<{
  status: Record<string, ConsoleAccountAppStatus>;
  /** What each app answered in its check, such as its build and its open comments, by app id. */
  checks?: Record<string, ConsoleAccountCheck>;
}>();

const projects = useConsoleProjects();
const account = computed(() => projects.account.value);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
const teamName = computed(() => team.value?.name ?? "This team");
const apps = computed(() => account.value?.projects ?? []);
const manage = computed(() => account.value ? canManageConsoleProjects(account.value) : false);
const filter = ref("");
// Each app row: its logo, its Last deploy cell from the build that the app reported in its check, and its comments.
const rows = computed(() => apps.value.map((app) => {
  const check = props.checks?.[app.id];
  const build = check?.build;
  const deploy = build && { author: build.commit?.author, message: build.commit?.message, sha: build.commit?.sha.slice(0, 7), time: build.time };
  const site = `${consoleProjectTarget(app).url}/`;
  return {
    app,
    identity: consoleAppIdentity(app, name(app)),
    deploy,
    site,
    // The site opens with the Comments pill on, as Comment on site does in the app's Console.
    comments: check?.comments && { open: check.comments.open, url: `${site}?${viteHubPageToolsQuery}=comments` },
  };
}));
const shownRows = computed(() => {
  const query = filter.value.trim().toLowerCase();
  return query ? rows.value.filter(row => `${row.identity.name} ${row.identity.host}`.toLowerCase().includes(query)) : rows.value;
});
const firstName = computed(() => account.value?.user.name.split(/\s+/)[0] ?? "");
const shared = ref(false);

// The app whose Unlink dialog is open. Home is the place to unlink an app that works, so the app switcher stays navigation.
const unlinking = shallowRef<ConsoleAccountProject>();
const unlinkOpen = ref(false);

function askUnlink(app: ConsoleAccountProject): void {
  unlinking.value = app;
  unlinkOpen.value = true;
}

const url = ref("");
const busy = ref(false);
const problem = ref<string>();

const linked = computed(() => apps.value.length > 0);
const connected = computed(() => apps.value.some(app => props.status[app.id] === "connected"));
const checking = computed(() => apps.value.some(app => props.status[app.id] === "checking"));
// The app that step 3 opens: one that is not connected and not still being checked.
const setupApp = computed(() => apps.value.find(app => ["setup", "unconfigured", "unreachable"].includes(props.status[app.id] ?? "checking")));
// The required steps. Inviting people is optional, so it is not a step and does not count.
const steps = computed(() => [
  { id: "account", done: true },
  { id: "link", done: linked.value },
  { id: "connect", done: connected.value },
] as const);
const doneCount = computed(() => steps.value.filter(step => step.done).length);
const active = computed(() => steps.value.find(step => !step.done)?.id);
// After setup, Home is the app list. Links and invitations have their own places: the Apps header and Members.
// This browser remembers that the team finished setup, so a returning visit shows the list while the checks run, and
// an app that stops answering shows its status there instead of the first-time steps.
const doneKey = computed(() => `vitehub-console:setup-done:${account.value?.teamId ?? ""}`);
const finished = ref(readFinished());
const setupDone = computed(() => linked.value && (connected.value || finished.value));

function readFinished(): boolean {
  try {
    return globalThis.localStorage?.getItem(doneKey.value) === "1";
  }
  catch {
    return false;
  }
}

watch(connected, (value) => {
  if (!value) return;
  finished.value = true;
  try {
    globalThis.localStorage?.setItem(doneKey.value, "1");
  }
  catch {}
}, { immediate: true });

/** A plain click opens the app in place. A click with a modifier key opens its address as the browser does. */
function openApp(event: MouseEvent, id: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  openAccountProject(id);
}

onMounted(async () => {
  const details = await loadConsoleTeam().catch(() => undefined);
  shared.value = Boolean(details && (details.members.length > 1 || details.invitations.length > 0));
});

function name(app: ConsoleAccountProject): string {
  return consoleProjectDisplayName(app);
}

function stepLabel(index: number, done: boolean): string {
  return done ? "Completed:" : `Step ${index + 1} of ${steps.value.length}:`;
}

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
</script>

<template>
  <div class="grid gap-10" :class="{ 'max-w-2xl': !setupDone }">
    <header v-if="!setupDone" class="grid gap-1">
      <div class="flex items-baseline justify-between gap-4">
        <h2 class="text-xl font-semibold text-balance text-highlighted">{{ firstName ? `Welcome, ${firstName}` : "Welcome" }}</h2>
        <span class="shrink-0 text-xs tabular-nums text-muted">{{ doneCount }} of {{ steps.length }} done</span>
      </div>
      <p class="text-sm text-pretty text-muted">
        <template v-if="linked">One step left. When the app accepts its token, its Console opens here for everyone in {{ teamName }}.</template>
        <template v-else-if="manage">{{ teamName }} is ready. Link an app to open its Console here, for everyone in the team, in any browser.</template>
        <template v-else>{{ teamName }} has no apps yet. Ask an owner or admin of the team to link one. It then opens here for you.</template>
      </p>
    </header>

    <section v-if="setupDone" class="grid grid-cols-1 gap-4" aria-labelledby="vitehub-account-title">
      <div class="flex items-center gap-2">
        <UInput v-model="filter" type="search" icon="i-lucide-search" placeholder="Filter apps" aria-label="Filter apps" class="min-w-0 flex-1 sm:w-64 sm:flex-none" />
        <UButton v-if="manage" class="ms-auto" icon="i-lucide-plus" label="Link app" @click="projects.linkOpen.value = true" />
      </div>
      <div v-if="shownRows.length" class="overflow-x-auto rounded-lg border border-default">
        <table class="vitehub-apps">
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col" class="max-sm:hidden">Last deploy</th>
              <th scope="col">Status</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shownRows" :key="row.app.id">
              <td>
                <!-- The link covers the row, and the actions sit above it. -->
                <a :href="accountProjectPath(row.app.id)" class="vitehub-apps__open" data-focus-inset @click="openApp($event, row.app.id)">
                  <ConsoleAppLogo :app="row.identity" class="vitehub-apps__logo" />
                  <span class="grid min-w-0">
                    <span class="truncate font-medium text-highlighted">{{ row.identity.name }}</span>
                    <span v-if="row.identity.host !== row.identity.name" class="truncate font-mono text-xs text-muted">{{ row.identity.host }}</span>
                  </span>
                </a>
              </td>
              <td class="vitehub-apps__deploy max-sm:hidden">
                <span v-if="row.deploy" class="flex min-w-0 items-center gap-2" :title="row.deploy.message">
                  <span v-if="row.deploy.author" class="vitehub-apps__avatar" :title="row.deploy.author" aria-hidden="true">{{ row.deploy.author.charAt(0).toUpperCase() }}</span>
                  <ConsoleRelativeTime :value="row.deploy.time" class="shrink-0 text-default" />
                  <template v-if="row.deploy.sha">
                    <span class="shrink-0 text-dimmed" aria-hidden="true">·</span>
                    <span class="shrink-0 font-mono text-xs text-muted">{{ row.deploy.sha }}</span>
                  </template>
                  <span v-if="row.deploy.message" class="truncate text-muted">{{ row.deploy.message }}</span>
                  <span v-if="row.deploy.author" class="sr-only">by {{ row.deploy.author }}</span>
                </span>
                <span v-else class="text-dimmed">{{ status[row.app.id] === "connected" ? "No build recorded" : "" }}</span>
              </td>
              <td class="whitespace-nowrap">
                <span class="inline-flex items-center gap-1.5 text-muted">
                  <span class="vitehub-account-shell__dot" :data-status="status[row.app.id] ?? 'checking'" aria-hidden="true" />
                  {{ accountAppStatusLabels[status[row.app.id] ?? "checking"] }}
                </span>
              </td>
              <td>
                <span class="vitehub-apps__actions">
                  <span class="vitehub-apps__hover">
                    <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-external-link" label="Visit" :to="row.site" target="_blank" rel="noreferrer" :aria-label="`Visit ${row.identity.name}`" />
                    <UDropdownMenu v-if="manage" :items="[[{ icon: 'i-lucide-unlink', label: 'Unlink app', color: 'error', onSelect: () => askUnlink(row.app) }]]" :content="{ align: 'end' }">
                      <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="sm" :aria-label="`More actions for ${row.identity.name}`" />
                    </UDropdownMenu>
                  </span>
                  <UButton
                    v-if="row.comments && status[row.app.id] === 'connected'"
                    size="sm"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-message-square-plus"
                    :to="row.comments.url"
                    target="_blank"
                    rel="noreferrer"
                    :aria-label="`Comment on ${row.identity.name}, ${row.comments.open} open`"
                  >
                    <span class="max-sm:sr-only">Comment</span>
                    <span v-if="row.comments.open" class="vitehub-apps__count">{{ row.comments.open }}</span>
                  </UButton>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <UEmpty
        v-else
        variant="naked"
        class="py-16"
        icon="i-lucide-search"
        title="No matching apps"
        :description="`No app name or address contains “${filter.trim()}”.`"
        :actions="[{ label: 'Clear filter', color: 'neutral', variant: 'outline', onClick: () => { filter = ''; } }]"
      />
      <ConsoleAccountUnlink v-if="unlinking" v-model:open="unlinkOpen" :project-id="unlinking.id" :name="name(unlinking)" />
    </section>

    <section v-if="!setupDone" aria-label="Setup steps">
      <ol class="vitehub-account-steps">
        <li class="vitehub-account-step" data-done>
          <div class="vitehub-account-step__track" aria-hidden="true">
            <span class="vitehub-account-step__mark"><UIcon name="i-lucide-check" class="size-3.5" /></span>
            <span class="vitehub-account-step__line" />
          </div>
          <div class="vitehub-account-step__body">
            <h3 class="vitehub-account-step__title"><span class="sr-only">{{ stepLabel(0, true) }} </span>Create your account</h3>
          </div>
        </li>

        <li class="vitehub-account-step" :data-done="steps[1].done || undefined" :data-active="active === 'link' || undefined" :aria-current="active === 'link' ? 'step' : undefined">
          <div class="vitehub-account-step__track" aria-hidden="true">
            <span class="vitehub-account-step__mark"><UIcon v-if="steps[1].done" name="i-lucide-check" class="size-3.5" /><template v-else>2</template></span>
            <span class="vitehub-account-step__line" />
          </div>
          <div class="vitehub-account-step__body">
            <h3 class="vitehub-account-step__title"><span class="sr-only">{{ stepLabel(1, steps[1].done) }} </span>Link an app</h3>
            <p v-if="!steps[1].done" class="vitehub-account-step__text">
              <template v-if="manage">Enable Console access, deploy your app, then enter its URL.</template>
              <template v-else>Only owners and admins of {{ teamName }} link apps. Ask one of them to link yours.</template>
            </p>
            <template v-if="active === 'link' && manage">
              <ConsoleAccountSnippet class="vitehub-account-step__wide" />
              <form class="vitehub-account-step__wide grid gap-1.5" @submit.prevent="link">
                <div class="flex flex-wrap gap-2">
                  <UInput v-model="url" type="url" inputmode="url" autocomplete="url" placeholder="https://app.example.com" aria-label="App URL" required :aria-invalid="problem ? true : undefined" :aria-describedby="problem ? 'vitehub-home-link-problem' : undefined" class="min-w-0 flex-1 basis-56" />
                  <UButton type="submit" icon="i-lucide-link" label="Link app" class="justify-center max-sm:w-full" :loading="busy" />
                </div>
                <p v-if="problem" id="vitehub-home-link-problem" role="alert" class="text-[13px] text-error">{{ problem }}</p>
              </form>
            </template>
          </div>
        </li>

        <li class="vitehub-account-step" :data-done="steps[2].done || undefined" :data-active="active === 'connect' || undefined" :aria-current="active === 'connect' ? 'step' : undefined">
          <div class="vitehub-account-step__track" aria-hidden="true">
            <span class="vitehub-account-step__mark"><UIcon v-if="steps[2].done" name="i-lucide-check" class="size-3.5" /><template v-else>3</template></span>
          </div>
          <div class="vitehub-account-step__body">
            <h3 class="vitehub-account-step__title"><span class="sr-only">{{ stepLabel(2, steps[2].done) }} </span>Connect your app</h3>
            <p v-if="!steps[2].done" class="vitehub-account-step__text">
              <template v-if="active === 'connect' && checking">Checking the app…</template>
              <template v-else>Set one environment variable on the app, then redeploy.</template>
            </p>
            <UButton v-if="active === 'connect' && setupApp" class="justify-self-start" icon="i-lucide-key-round" :label="status[setupApp.id] === 'setup' ? `Show the variable for ${name(setupApp)}` : `Open ${name(setupApp)}`" @click="openAccountProject(setupApp.id)" />
          </div>
        </li>

      </ol>

      <div v-if="!shared" class="vitehub-account-invite">
        <UIcon name="i-lucide-user-plus" class="vitehub-account-icon shrink-0 text-muted" aria-hidden="true" />
        <p class="min-w-0 flex-1 text-[13px] leading-5 text-muted"><span class="font-medium text-highlighted">Invite your team.</span> Optional. People in {{ teamName }} open the same apps.</p>
        <UButton size="sm" color="neutral" variant="outline" label="Invite people" @click="showConsoleAccountPage('team')" />
      </div>
    </section>
  </div>
</template>

<style>
.vitehub-account-steps {
  display: grid;
}

.vitehub-account-step {
  display: grid;
  gap: 1rem;
  grid-template-columns: 1.5rem minmax(0, 1fr);
}

/* The rail joins the marks, like a timeline. Each step leaves 1.75rem before the next mark. */
.vitehub-account-step__track {
  align-items: center;
  display: flex;
  flex-direction: column;
}

.vitehub-account-step__line {
  background: var(--ui-border);
  flex: 1;
  margin-block: 0.375rem;
  min-height: 1rem;
  width: 1px;
}

.vitehub-account-step[data-done] .vitehub-account-step__line {
  background: var(--ui-border-accented);
}

.vitehub-account-step__mark {
  align-items: center;
  border: 1px solid var(--ui-border-accented);
  border-radius: 999px;
  color: var(--ui-text-muted);
  display: inline-flex;
  flex-shrink: 0;
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
  padding-bottom: 1.75rem;
}

/* A completed step is one line, so the open step and its form come first. */
.vitehub-account-step[data-done] .vitehub-account-step__body {
  padding-bottom: 0.75rem;
}

.vitehub-account-invite {
  align-items: center;
  border-top: 1px solid var(--ui-border);
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 2rem;
  padding-top: 1.25rem;
}

/* On a phone, the code and the form use the width under the step number too, so the open step has no rail. */
@media (max-width: 639px) {
  .vitehub-account-step__wide {
    margin-inline-start: -2.5rem;
  }

  .vitehub-account-step[data-active] .vitehub-account-step__line {
    visibility: hidden;
  }
}

.vitehub-account-step:last-child .vitehub-account-step__body {
  padding-bottom: 0;
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
  font-weight: 500;
}

/* Rows, not a table: one bordered list, a hairline between rows. Members and Settings use it too. */
.vitehub-account-list {
  border: 1px solid var(--ui-border);
  border-radius: 0.625rem;
  overflow: hidden;
}

.vitehub-account-list > li + li {
  border-top: 1px solid var(--ui-border);
}

.vitehub-account-list__row {
  align-items: center;
  display: flex;
  gap: 0.75rem;
  min-height: 3.25rem;
  padding: 0.5rem 0.875rem;
  width: 100%;
}

a.vitehub-account-list__row:hover {
  background: var(--ui-bg-elevated);
}

/* An app row: the link fills the row, and the menu of its actions sits at the end. The whole row takes the hover. */
.vitehub-account-list__item {
  align-items: center;
  display: flex;
}

.vitehub-account-list__item:hover {
  background: var(--ui-bg-elevated);
}

/* The Apps table: one row per app. The link of the first cell covers the row, and the actions sit above it. */
.vitehub-apps {
  font-size: 0.8125rem;
  text-align: start;
  width: 100%;
}

.vitehub-apps th {
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 400;
  height: 2rem;
  padding-inline: 0.75rem;
  text-align: start;
  white-space: nowrap;
}

.vitehub-apps td {
  height: 3.25rem;
  padding-inline: 0.75rem;
  vertical-align: middle;
}

.vitehub-apps tbody tr {
  position: relative;
}

.vitehub-apps tbody tr + tr td {
  border-top: 1px solid var(--ui-border);
}

.vitehub-apps tbody tr:hover td {
  background: var(--ui-bg-elevated);
}

.vitehub-apps__open {
  align-items: center;
  display: flex;
  gap: 0.625rem;
  min-width: 9rem;
}

.vitehub-apps__open::after {
  content: "";
  inset: 0;
  position: absolute;
}

.vitehub-apps .vitehub-apps__logo {
  height: 1.5rem;
  width: 1.5rem;
}

/* The Last deploy cell takes the free width and cuts the commit message. */
.vitehub-apps__deploy {
  max-width: 0;
  width: 45%;
}

.vitehub-apps__avatar {
  align-items: center;
  background: var(--ui-bg-accented);
  border-radius: 999px;
  color: var(--ui-text-highlighted);
  display: inline-flex;
  flex: none;
  font-size: 0.625rem;
  font-weight: 600;
  height: 1.125rem;
  justify-content: center;
  width: 1.125rem;
}

.vitehub-apps__actions {
  align-items: center;
  display: flex;
  gap: 0.25rem;
  justify-content: flex-end;
  position: relative;
  z-index: 1;
}

.vitehub-apps__count {
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
}

/* Visit and the menu show on the row that the pointer or the focus is on. A touch screen always shows them. */
@media (hover: hover) and (pointer: fine) {
  .vitehub-apps__hover {
    opacity: 0;
  }

  .vitehub-apps tbody tr:hover .vitehub-apps__hover,
  .vitehub-apps__hover:focus-within,
  .vitehub-apps__hover:has([data-state="open"]) {
    opacity: 1;
  }
}

.vitehub-apps__hover {
  display: inline-flex;
  gap: 0.25rem;
}
</style>
