<script setup lang="ts">
import { featureIds, features } from "@vite-hub/internal/features";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";

import type { FeatureId } from "@vite-hub/internal/features";
import type { NewProjectFeature, NewProjectStack } from "../client/new-project";
import type { ConsolePendingLinkTicket } from "../client/pending-links";
import {
  newProjectCommandParts,
  newProjectHostFeatureCount,
  newProjectHosts,
  newProjectQuery,
  planNewProject,
  readNewProjectQuery,
  withNewProjectDefaults,
} from "../client/new-project";
import { createConsolePendingLink, useConsoleProjects } from "../client/project-session";
import ConsoleMark from "./console-mark.vue";

/**
 * The `/new` page of a hosted Console. The stack lives in the URL query, so the page is shareable and survives a reload.
 * The one-time link is made only on "Create command", and its id and verifier stay out of the URL.
 */
const projects = useConsoleProjects();

const stack = shallowRef<NewProjectStack>(withNewProjectDefaults(readNewProjectQuery(window.location.search)));
const plan = computed(() => planNewProject(stack.value));
const ticket = shallowRef<ConsolePendingLinkTicket>();
const commandParts = computed(() => ticket.value ? newProjectCommandParts(stack.value, ticket.value, plan.value) : undefined);
const command = computed(() => commandParts.value?.join(" "));

// Errors show after the first "Create command", and the folder error also after the field loses focus.
const submitted = ref(false);
const dirBlurred = ref(false);
const creating = ref(false);
const createError = ref<string>();
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const hostLabel = computed(() => newProjectHosts.find(host => host.id === stack.value.host)?.label);
const hostItems = newProjectHosts.map((host) => {
  const count = newProjectHostFeatureCount(host.id);
  return { value: host.id, label: host.label, description: count === featureIds.length ? "Every feature" : `${count} of ${featureIds.length} features` };
});
const turnedOn = computed(() => plan.value.features.filter(row => row.state.kind === "on" || row.state.kind === "implied"));

function problem(field: "dir" | "host"): string | undefined {
  return plan.value.problems.find(entry => entry.field === field)?.message;
}

const dirError = computed(() => submitted.value || dirBlurred.value ? problem("dir") : undefined);
const hostError = computed(() => submitted.value ? problem("host") : undefined);

function featureError(id: FeatureId): string | undefined {
  return plan.value.problems.find(entry => entry.field === "features" && entry.feature === id)?.message;
}

function optionError(path: string): string | undefined {
  if (!submitted.value) return undefined;
  return plan.value.problems.find(entry => entry.field === "option" && entry.path === path)?.message;
}

function update(next: Partial<NewProjectStack>): void {
  stack.value = withNewProjectDefaults({ ...stack.value, ...next });
}

function setHost(value: unknown): void {
  const host = newProjectHosts.find(entry => entry.id === value);
  if (host) update({ host: host.id });
}

function toggle(id: FeatureId, on: boolean): void {
  const picked = new Set(stack.value.features);
  if (on) picked.add(id);
  else picked.delete(id);
  update({ features: featureIds.filter(feature => picked.has(feature)) });
}

function setOption(path: string, value: string): void {
  update({ options: { ...stack.value.options, [path]: value } });
}

// A checkbox is off only when the host cannot run the feature, or another feature turns it on. A feature that is on
// stays enabled so the person can turn it off after a host change.
function locked(row: NewProjectFeature): boolean {
  if (row.state.kind === "default" || row.state.kind === "implied") return true;
  return row.state.kind === "off" && row.support?.level === "unsupported";
}

/** The short note after the title: why the feature is on, why it cannot run, or which option it needs. */
function note(row: NewProjectFeature): string | undefined {
  if (row.state.kind === "default") return "Always on";
  if (row.state.kind === "implied") return `Added by ${row.state.by.map(id => features[id].title).join(", ")}`;
  if (row.support?.level === "unsupported") return hostLabel.value ? `Not on ${hostLabel.value}` : undefined;
  if (row.support?.level === "explicit") return `Needs ${row.support.option}`;
  return undefined;
}

/** Text with `code` spans from the catalog, split so the template renders the code parts in `<code>`. */
function codeParts(text: string): { text: string, code: boolean }[] {
  return text.split("`").map((part, index) => ({ code: index % 2 === 1, text: part })).filter(part => part.text);
}

// Replace, not push: each change is not a page of its own, and Back leaves the page.
watch(stack, (value) => {
  const url = `${window.location.pathname}${newProjectQuery(value, planNewProject(value))}`;
  window.history.replaceState(window.history.state, "", url);
});

async function focusFirstProblem(): Promise<void> {
  await nextTick();
  const first = plan.value.problems[0];
  if (!first) return;
  const id = first.field === "dir"
    ? "new-project-dir"
    : first.field === "host"
      ? "new-project-host"
      : first.field === "features"
        ? `new-project-feature-${first.feature}`
        : `new-project-option-${first.path}`;
  const target = document.getElementById(id);
  (target?.matches("input, button, select, textarea") ? target : target?.querySelector<HTMLElement>("input, button"))?.focus();
}

async function create(): Promise<void> {
  submitted.value = true;
  if (creating.value || ticket.value) return;
  if (plan.value.problems.length) {
    await focusFirstProblem();
    return;
  }
  creating.value = true;
  createError.value = undefined;
  try {
    ticket.value = await createConsolePendingLink();
  }
  catch (error) {
    createError.value = error instanceof Error ? error.message : "Could not make a link. Allow this Console to use browser storage, then try again.";
  }
  creating.value = false;
}

async function copy(): Promise<void> {
  if (!command.value) return;
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  }
  catch {
    // The command stays on the page to select by hand.
  }
}

onBeforeUnmount(() => clearTimeout(copiedTimer));

function leave(): void {
  projects.navigate(projects.home);
}
</script>

<template>
  <div class="vitehub-new-project">
    <header class="vitehub-new-project__bar">
      <span class="flex items-center gap-2 text-sm font-medium text-highlighted">
        <ConsoleMark class="size-5" />
        ViteHub Console
      </span>
      <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-arrow-left" :label="projects.projects.value.length ? 'Back to projects' : 'Back'" @click="leave" />
    </header>

    <form class="vitehub-new-project__layout" novalidate @submit.prevent="create">
      <main class="grid min-w-0 gap-10">
        <div class="grid gap-1.5">
          <h1 class="vitehub-new-project__title">New project</h1>
          <p class="vitehub-new-project__text">
            Pick a host and the features. The Console prints the <code>vite-hub init</code> command for this stack. The address of this page holds the stack, so you can share it.
          </p>
        </div>

        <section>
          <UFormField label="Folder name" name="dir" description="vite-hub init creates the app in this folder." :error="dirError">
            <UInput
              id="new-project-dir"
              :model-value="stack.dir"
              autocomplete="off"
              spellcheck="false"
              data-1p-ignore
              data-lpignore="true"
              class="w-full max-w-xs font-mono"
              @update:model-value="(value: string | number) => update({ dir: String(value).trim() })"
              @blur="dirBlurred = true"
            />
          </UFormField>
        </section>

        <section class="grid gap-4" aria-labelledby="new-project-host-heading">
          <div class="grid gap-1">
            <h2 id="new-project-host-heading" class="vitehub-new-project__heading">Host</h2>
            <p class="vitehub-new-project__text">The host runs the app. It decides which features the app can use.</p>
          </div>
          <URadioGroup
            id="new-project-host"
            :model-value="stack.host"
            :items="hostItems"
            variant="card"
            size="sm"
            orientation="horizontal"
            aria-labelledby="new-project-host-heading"
            :ui="{ fieldset: 'grid gap-2 grid-cols-2 sm:grid-cols-3', item: 'items-start' }"
            @update:model-value="setHost"
          />
          <p v-if="hostError" role="alert" class="vitehub-new-project__error">
            <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0" aria-hidden="true" />
            {{ hostError }}
          </p>
        </section>

        <section class="grid gap-4" aria-labelledby="new-project-features-heading">
          <div class="grid gap-1">
            <h2 id="new-project-features-heading" class="vitehub-new-project__heading">Features</h2>
            <p class="vitehub-new-project__text">
              {{ hostLabel ? `Features that ${hostLabel} cannot run are greyed out and say why.` : "Pick a host to see which features it runs." }} Some features turn on others, and the list marks them.
            </p>
          </div>
          <ul class="grid gap-2 sm:grid-cols-2">
            <li v-for="row in plan.features" :id="`new-project-feature-${row.id}`" :key="row.id" class="grid gap-1">
              <UCheckbox
                variant="card"
                size="sm"
                :model-value="row.state.kind !== 'off'"
                :disabled="locked(row)"
                :ui="{
                  root: ['h-full items-start', row.support?.level === 'unsupported' && row.state.kind === 'off' ? 'opacity-60' : '', featureError(row.id) ? 'border-error' : ''],
                  wrapper: 'grid gap-1',
                }"
                :aria-invalid="Boolean(featureError(row.id))"
                @update:model-value="(value) => toggle(row.id, value === true)"
              >
                <template #label>
                  <span class="flex flex-wrap items-baseline gap-x-2">
                    {{ row.title }}
                    <span v-if="note(row)" class="text-xs font-normal text-dimmed">{{ note(row) }}</span>
                  </span>
                </template>
                <template #description>
                  <span class="text-pretty">
                    <template v-for="(part, index) in codeParts(row.support?.level === 'unsupported' ? row.support.detail : row.summary)" :key="index">
                      <code v-if="part.code" class="vitehub-new-project__code">{{ part.text }}</code>
                      <template v-else>{{ part.text }}</template>
                    </template>
                  </span>
                </template>
              </UCheckbox>
              <p v-if="featureError(row.id)" role="alert" class="vitehub-new-project__error">
                <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0" aria-hidden="true" />
                {{ featureError(row.id) }}
              </p>
            </li>
          </ul>
        </section>

        <section v-if="plan.options.length" class="grid gap-4" aria-labelledby="new-project-options-heading">
          <div class="grid gap-1">
            <h2 id="new-project-options-heading" class="vitehub-new-project__heading">Options</h2>
            <p class="vitehub-new-project__text">{{ hostLabel }} needs these options for the features that you picked.</p>
          </div>
          <div class="grid gap-5">
            <UFormField
              v-for="input in plan.options"
              :key="input.path"
              :name="input.path"
              :error="optionError(input.path)"
            >
              <template #label>
                <code class="font-mono">{{ input.path }}</code>
              </template>
              <template #description>
                <span class="text-pretty">{{ features[input.feature].title }}: <template v-for="(part, index) in codeParts(input.detail)" :key="index"><code v-if="part.code" class="vitehub-new-project__code">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></span>
              </template>
              <USelect
                v-if="input.choices"
                :id="`new-project-option-${input.path}`"
                :model-value="stack.options[input.path]"
                :items="[...input.choices]"
                placeholder="Choose a value"
                class="w-full max-w-xs font-mono"
                @update:model-value="(value) => setOption(input.path, String(value))"
              />
              <UInput
                v-else
                :id="`new-project-option-${input.path}`"
                :model-value="stack.options[input.path] ?? ''"
                :placeholder="input.placeholder"
                autocomplete="off"
                spellcheck="false"
                data-1p-ignore
                data-lpignore="true"
                class="w-full max-w-md font-mono"
                @update:model-value="(value: string | number) => setOption(input.path, String(value))"
              />
            </UFormField>
          </div>
        </section>
      </main>

      <aside class="vitehub-new-project__aside" aria-labelledby="new-project-command-heading">
        <div class="grid gap-1">
          <h2 id="new-project-command-heading" class="vitehub-new-project__heading">Command</h2>
          <p class="vitehub-new-project__text">
            <span class="font-mono text-highlighted">{{ stack.dir || "…" }}</span>
            on {{ hostLabel ?? "no host yet" }}<template v-if="turnedOn.length">, with {{ turnedOn.map(row => row.title).join(", ") }}</template>.
          </p>
        </div>

        <template v-if="!ticket">
          <p class="vitehub-new-project__text">The command carries a one-time link to this Console. This browser keeps its key.</p>
          <UButton type="submit" block :loading="creating" :label="creating ? 'Creating…' : 'Create command'" />
          <p v-if="submitted && plan.problems.length" class="vitehub-new-project__error">
            <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0" aria-hidden="true" />
            Fix the marked fields first.
          </p>
          <p v-if="createError" role="alert" class="vitehub-new-project__error">
            <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0" aria-hidden="true" />
            {{ createError }}
          </p>
        </template>

        <template v-else>
          <div class="overflow-hidden rounded-lg border border-default">
            <div class="flex items-center justify-between gap-3 border-b border-default py-1.5 pr-1.5 pl-3">
              <span class="text-xs text-muted">Terminal</span>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                :label="copied ? 'Copied' : 'Copy'"
                :disabled="!command"
                @click="copy"
              />
            </div>
            <!-- Each flag with its value is one box, so lines wrap between flags and not inside `--option`. -->
            <pre v-if="commandParts" class="vitehub-new-project__command"><code><template v-for="(part, index) in commandParts" :key="index"><span>{{ part }}</span>{{ index < commandParts.length - 1 ? " " : "" }}</template></code></pre>
            <p v-else class="p-3 text-sm text-muted">Fix the marked fields to update the command.</p>
          </div>
          <span class="sr-only" aria-live="polite">{{ copied ? "Command copied" : "" }}</span>
          <p class="vitehub-new-project__text text-default">Run it in your terminal, deploy the app, then open the link that the CLI prints in this browser.</p>
          <p class="vitehub-new-project__text">The link works once, for 24 hours, in this browser profile. A change above updates the command and keeps the same link.</p>
        </template>
      </aside>
    </form>
  </div>
</template>

<style>
.vitehub-new-project {
  margin: 0 auto;
  max-width: 72rem;
  min-height: 100dvh;
  padding: 1rem 1.5rem 4rem;
}

.vitehub-new-project__bar {
  align-items: center;
  display: flex;
  justify-content: space-between;
  margin-bottom: 2.5rem;
}

.vitehub-new-project__layout {
  display: grid;
  gap: 2.5rem;
}

@media (min-width: 64rem) {
  .vitehub-new-project__layout {
    align-items: start;
    grid-template-columns: minmax(0, 1fr) 22rem;
  }

  .vitehub-new-project__aside {
    position: sticky;
    top: 1.5rem;
  }
}

.vitehub-new-project__aside {
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
  display: grid;
  gap: 1rem;
  padding: 1.25rem;
}

.vitehub-new-project__title {
  color: var(--ui-text-highlighted);
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.75rem;
  text-wrap: balance;
}

.vitehub-new-project__heading {
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25rem;
}

.vitehub-new-project__text {
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.25rem;
  max-width: 65ch;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.vitehub-new-project__error {
  align-items: center;
  color: var(--ui-error);
  display: flex;
  font-size: 0.8125rem;
  gap: 0.375rem;
  line-height: 1.25rem;
}

.vitehub-new-project__code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
}

.vitehub-new-project__command {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.25rem;
  padding: 0.75rem;
  white-space: pre-wrap;
}

.vitehub-new-project__command span {
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
}
</style>
