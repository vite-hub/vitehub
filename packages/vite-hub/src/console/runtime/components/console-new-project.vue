<script setup lang="ts">
import { featureIds, features } from "@vite-hub/internal/features";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";

import type { FeatureId } from "@vite-hub/internal/features";
import type { NewProjectFeature, NewProjectStack } from "../client/new-project";
import type { ConsolePendingLinkTicket } from "../client/pending-links";
import {
  newProjectCommandParts,
  newProjectHostFeatureCount,
  newProjectHosts,
  newProjectPrompt,
  newProjectQuery,
  planNewProject,
  readNewProjectQuery,
  withNewProjectDefaults,
} from "../client/new-project";
import { addNewProjectHostIcons, newProjectFeatureIcons, newProjectHostIcons } from "../client/new-project-icons";
import { createConsolePendingLink, useConsoleProjects } from "../client/project-session";
import ConsoleCodeText from "./console-code-text.vue";
import ConsoleMark from "./console-mark.vue";

addNewProjectHostIcons();

/**
 * The `/new` page of a hosted Console. The stack lives in the URL query, so the page is shareable and survives a reload.
 * It prints the `vite-hub init` command, or a prompt that asks a coding agent to run it. The one-time link is made once
 * the stack has no problems, one per page view, and its id and verifier stay out of the URL.
 */
const projects = useConsoleProjects();

const stack = shallowRef<NewProjectStack>(withNewProjectDefaults(readNewProjectQuery(window.location.search)));
const plan = computed(() => planNewProject(stack.value));
const ticket = shallowRef<ConsolePendingLinkTicket>();
const commandParts = computed(() => ticket.value ? newProjectCommandParts(stack.value, ticket.value, plan.value) : undefined);
const command = computed(() => commandParts.value?.join(" "));

// How the person starts the project: the command in a terminal, or a prompt for a coding agent.
const mode = ref<"command" | "prompt">("command");
const modeItems = [
  { label: "Terminal", value: "command", icon: "i-lucide-terminal" },
  { label: "Agent prompt", value: "prompt", icon: "i-lucide-sparkles" },
];
const prompt = computed(() => ticket.value ? newProjectPrompt(stack.value, ticket.value, plan.value) : undefined);
const output = computed(() => mode.value === "prompt" ? prompt.value : command.value);

// The search filters the feature cards only. A feature that it hides stays in the stack.
const query = ref("");
const shownFeatures = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return plan.value.features;
  return plan.value.features.filter((row) => {
    const text = `${row.id} ${row.title} ${row.summary}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
});

// Field errors show after Enter in a field, and the folder error also after the field loses focus. The command box
// names the first problem at once.
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

const search = useTemplateRef<{ inputRef?: HTMLInputElement }>("search");

function clearSearch(): void {
  query.value = "";
  search.value?.inputRef?.focus();
}

function hostIcon(value: unknown): string | undefined {
  const host = newProjectHosts.find(entry => entry.id === value);
  return host && newProjectHostIcons[host.id];
}
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

// Replace, not push: each change is not a page of its own, and Back leaves the page.
watch(stack, (value) => {
  const url = `${window.location.pathname}${newProjectQuery(value, planNewProject(value))}`;
  window.history.replaceState(window.history.state, "", url);
});

async function focusFirstProblem(): Promise<void> {
  await nextTick();
  const first = plan.value.problems[0];
  if (!first) return;
  // The search may hide the feature card with the problem.
  if (first.field === "features" && query.value) {
    query.value = "";
    await nextTick();
  }
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

async function makeLink(): Promise<void> {
  if (creating.value || ticket.value) return;
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

// The command shows as soon as the stack is complete. A change after that keeps the same link.
watch(() => plan.value.problems.length === 0, (ready) => {
  if (ready) void makeLink();
}, { immediate: true });

// Enter in a field marks the problems and focuses the first one.
async function create(): Promise<void> {
  submitted.value = true;
  if (plan.value.problems.length) await focusFirstProblem();
}

async function copy(): Promise<void> {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  }
  catch {
    // The command stays on the page to select by hand.
  }
}

onBeforeUnmount(() => clearTimeout(copiedTimer));
watch(mode, () => (copied.value = false));

function leave(): void {
  projects.navigate(projects.home);
}

// The page scrolls itself, so its heading takes focus on load: a screen reader starts at the title, and Page Down and
// Space scroll the page before anything is clicked.
const heading = useTemplateRef<HTMLElement>("heading");
onMounted(() => heading.value?.focus({ preventScroll: true }));
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
          <h1 ref="heading" class="vitehub-new-project__title" tabindex="-1">New project</h1>
          <p class="vitehub-new-project__text">
            Pick a host and the features. The Console prints the <code class="vitehub-new-project__code">vite-hub init</code> command for this stack, or a prompt for your coding agent. The address of this page holds the stack, so you can share it.
          </p>
        </div>

        <section>
          <!-- UFormField links the field to its description only through the prop, so the prop stays next to the slot. -->
          <UFormField label="Folder name" name="dir" description="vite-hub init creates the app in this folder." :error="dirError">
            <template #description><code class="vitehub-new-project__code">vite-hub init</code> creates the app in this folder.</template>
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
            indicator="end"
            :ui="{ fieldset: 'grid gap-2 grid-cols-2 sm:grid-cols-3', item: 'items-start' }"
            @update:model-value="setHost"
          >
            <template #label="{ item }">
              <span class="flex items-center gap-2">
                <UIcon v-if="hostIcon(item.value)" :name="hostIcon(item.value)!" class="size-4 shrink-0 text-highlighted" aria-hidden="true" />
                {{ item.label }}
              </span>
            </template>
            <template #description="{ item }">
              <span class="block ps-6">{{ item.description }}</span>
            </template>
          </URadioGroup>
          <p v-if="hostError" role="alert" class="vitehub-new-project__error">
            <UIcon name="i-lucide-circle-alert" class="vitehub-new-project__error-icon" aria-hidden="true" />
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
          <UInput
            ref="search"
            v-model="query"
            type="search"
            icon="i-lucide-search"
            placeholder="Search features"
            aria-label="Search features"
            aria-controls="new-project-feature-list"
            autocomplete="off"
            spellcheck="false"
            data-1p-ignore
            data-lpignore="true"
            class="vitehub-new-project__search w-full sm:max-w-xs"
            :ui="{ trailing: 'pe-1' }"
            @keydown.esc="query && ($event.preventDefault(), query = '')"
          >
            <template v-if="query" #trailing>
              <UButton color="neutral" variant="link" size="xs" icon="i-lucide-x" aria-label="Clear the search" @click="clearSearch" />
            </template>
          </UInput>
          <span class="sr-only" aria-live="polite">{{ query.trim() ? `${shownFeatures.length} ${shownFeatures.length === 1 ? "feature" : "features"}` : "" }}</span>
          <ul id="new-project-feature-list" class="grid gap-2 sm:grid-cols-2">
            <li v-for="row in shownFeatures" :id="`new-project-feature-${row.id}`" :key="row.id" class="grid">
              <UCheckbox
                variant="card"
                size="sm"
                indicator="end"
                :model-value="row.state.kind !== 'off'"
                :disabled="locked(row)"
                :ui="{
                  root: ['h-full items-start', row.support?.level === 'unsupported' && row.state.kind === 'off' ? 'opacity-60' : '', featureError(row.id) ? 'border-error has-data-[state=checked]:border-error not-has-disabled:has-focus-visible:border-error has-focus-visible:ring-error' : ''],
                  wrapper: 'grid gap-1',
                }"
                :aria-invalid="Boolean(featureError(row.id))"
                @update:model-value="(value) => toggle(row.id, value === true)"
              >
                <template #label>
                  <span class="flex flex-wrap items-center gap-x-2">
                    <UIcon :name="newProjectFeatureIcons[row.id]" class="size-4 shrink-0 text-muted" aria-hidden="true" />
                    {{ row.title }}
                    <span v-if="note(row)" class="text-xs font-normal text-dimmed">{{ note(row) }}</span>
                  </span>
                </template>
                <template #description>
                  <span class="block ps-6 text-pretty"><ConsoleCodeText :text="row.support?.level === 'unsupported' ? row.support.detail : row.summary" /></span>
                  <span v-if="featureError(row.id)" role="alert" class="vitehub-new-project__error mt-2 ps-6">
                    <UIcon name="i-lucide-circle-alert" class="vitehub-new-project__error-icon" aria-hidden="true" />
                    {{ featureError(row.id) }}
                  </span>
                </template>
              </UCheckbox>
            </li>
          </ul>
          <p v-if="!shownFeatures.length" class="vitehub-new-project__text">
            No feature matches “{{ query.trim() }}”.
            <button type="button" class="font-medium text-highlighted underline underline-offset-2" @click="clearSearch">Clear the search</button>
          </p>
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
                <span class="text-pretty">{{ features[input.feature].title }}: <ConsoleCodeText :text="input.detail" /></span>
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
          <h2 id="new-project-command-heading" class="vitehub-new-project__heading">Start the project</h2>
          <p class="vitehub-new-project__text">
            <span class="font-mono text-highlighted">{{ stack.dir || "…" }}</span>
            on {{ hostLabel ?? "no host yet" }}<template v-if="turnedOn.length">, with {{ turnedOn.map(row => row.title).join(", ") }}</template>.
          </p>
        </div>

        <UTabs v-model="mode" :items="modeItems" :content="false" size="xs" class="w-full" :ui="{ trigger: 'flex-1 justify-center' }" />

        <div class="overflow-hidden rounded-lg border border-default">
          <div class="flex items-center justify-between gap-3 border-b border-default py-1.5 pr-1.5 pl-3">
            <span class="text-xs text-muted">{{ mode === "prompt" ? "Prompt" : "Terminal" }}</span>
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              :label="copied ? 'Copied' : 'Copy'"
              :disabled="!output"
              @click="copy"
            />
          </div>
          <pre v-if="mode === 'prompt' && prompt" class="vitehub-new-project__command vitehub-new-project__prompt"><code>{{ prompt }}</code></pre>
          <!-- Each flag with its value is one box, so lines wrap between flags and not inside `--option`. -->
          <pre v-else-if="mode === 'command' && commandParts" class="vitehub-new-project__command"><code><template v-for="(part, index) in commandParts" :key="index"><span>{{ part }}</span>{{ index < commandParts.length - 1 ? " " : "" }}</template></code></pre>
          <div v-else-if="createError" role="alert" class="grid justify-items-start gap-2 p-3">
            <p class="vitehub-new-project__error">
              <UIcon name="i-lucide-circle-alert" class="vitehub-new-project__error-icon" aria-hidden="true" />
              {{ createError }}
            </p>
            <UButton color="neutral" variant="outline" size="xs" label="Try again" @click="makeLink" />
          </div>
          <p v-else class="p-3 text-sm text-muted">{{ plan.problems[0]?.message ?? "Making the link…" }}</p>
        </div>
        <span class="sr-only" aria-live="polite">{{ copied ? `${mode === "prompt" ? "Prompt" : "Command"} copied` : "" }}</span>
        <p v-if="mode === 'command' && commandParts" class="vitehub-new-project__text">Run it, deploy the app, then open the link that it prints in this browser.</p>
      </aside>
    </form>
  </div>
</template>

<style>
/* The Console locks the page scroll, so this page scrolls itself. The padding keeps the content 72rem wide at most. */
.vitehub-new-project {
  height: 100dvh;
  overflow-y: auto;
  padding: 1rem max(1.5rem, calc((100% - 69rem) / 2)) 4rem;
}

.vitehub-new-project :is(button, a[href]):focus-visible {
  outline-offset: 2px;
}

@media (pointer: coarse) {
  .vitehub-new-project :is(button:not([role="checkbox"], [role="radio"]), input:not([type="checkbox"], [type="radio"])) {
    min-height: 44px;
  }
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

.vitehub-new-project__title:focus {
  outline: none;
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

/* One error style on the page: small red text that starts at the text column of its field or card. */
.vitehub-new-project__error {
  align-items: flex-start;
  color: var(--ui-error);
  display: flex;
  font-size: 0.75rem;
  font-weight: 400;
  gap: 0.375rem;
  line-height: 1rem;
  text-wrap: pretty;
}

.vitehub-new-project__error-icon {
  flex-shrink: 0;
  height: 0.875rem;
  margin-top: 0.0625rem;
  width: 0.875rem;
}

.vitehub-new-project__code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.9em;
}

.vitehub-new-project__command {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.25rem;
  padding: 0.75rem;
  white-space: pre-wrap;
}

/* The prompt is prose with a command in it, so it wraps anywhere, even inside the long link key. */
.vitehub-new-project__prompt {
  overflow-wrap: anywhere;
}

/* The clear button of the search replaces the browser's own. */
.vitehub-new-project__search input::-webkit-search-cancel-button {
  appearance: none;
}

.vitehub-new-project__command span {
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
}
</style>
