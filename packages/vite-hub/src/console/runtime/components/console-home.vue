<script setup lang="ts">
import { useCollection } from "vite-hub/source/client";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { AgentInvocationStatus } from "./invocation";
import type { ConsoleSectionId } from "../sections";
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import type { ConsoleNavigation } from "../client/sections";
import {
  consoleGuides,
  consolePrimitives,
  consoleSectionDetails,
  consoleSectionGroupLabels,
  groupConsoleSections,
  readLastConsoleSection,
  resolveConsoleSectionDocs,
  resolveConsoleSectionGroup,
} from "../sections";
import { requestConsole } from "../client/request";
import { loadConsoleNavigation, resolveConsoleSectionDetails } from "../client/sections";
import { recentTimestamp } from "../client/time";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSectionIcon from "./console-section-icon.vue";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const route = useRoute();
const router = useRouter();
const sections = ref<ConsoleSectionId[]>([]);
const installedNavigation = shallowRef<ConsoleNavigation>();
const lastSection = ref<ConsoleSectionId>();
const loading = ref(true);
const error = ref<unknown>();
const sessionsLoadedAt = ref(Date.now());
let request = 0;

/** Labels match the Agent session list in `./invocation`. */
const sessionStatusLabels: Readonly<Record<AgentInvocationStatus, string>> = {
  cancelled: "Cancelled",
  completed: "Done",
  failed: "Failed",
  pending: "Queued",
  running: "Working",
};
const sessionStatusDots: Readonly<Record<AgentInvocationStatus, string>> = {
  cancelled: "bg-(--ui-text-dimmed)",
  completed: "bg-success",
  failed: "bg-error",
  pending: "bg-warning",
  running: "bg-info",
};

// The search endpoint lists the newest sessions when the request has no search term, like the palette.
const recentSessions = useCollection("vitehub-console-search", {
  immediate: false,
  limit: 5,
  request: async (_endpoint, options) => await requestConsole(props.searchBase, options),
});

const availableSections = computed(() =>
  sections.value.flatMap((section) => {
    const details = resolveConsoleSectionDetails(installedNavigation.value, section);
    return details ? [{ id: section, ...details }] : [];
  }),
);
const sectionGroups = computed(() =>
  groupConsoleSections(availableSections.value).map((group) => {
    const id = resolveConsoleSectionGroup(group[0].id);
    return {
      id,
      label: consoleSectionGroupLabels[id],
      sections: group.map((section) => ({ ...section, docs: resolveConsoleSectionDocs(section.id) })),
    };
  }),
);
// Usage comes with Agents, so it is not offered on its own.
const notEnabledPrimitives = computed(() =>
  consolePrimitives.filter((entry) => entry.id !== "usage" && !sections.value.includes(entry.id)),
);
const lastSectionDetails = computed(() =>
  availableSections.value.find((section) => section.id === lastSection.value),
);
const agentsEnabled = computed(() => sections.value.includes("agents"));
const showContinue = computed(() => Boolean(lastSectionDetails.value) || agentsEnabled.value);
const sessionItems = computed(() =>
  recentSessions.items.value.slice(0, 5).map((item) => ({
    agentName: item.agentName,
    context: item.excerpt || item.context,
    dot: Object.hasOwn(sessionStatusDots, item.status) ? sessionStatusDots[item.status] : "bg-(--ui-text-dimmed)",
    id: item.id,
    status: Object.hasOwn(sessionStatusLabels, item.status) ? sessionStatusLabels[item.status] : item.status,
    time: recentTimestamp(item.updatedAt, sessionsLoadedAt.value),
  })),
);
const summary = computed(() => {
  const count = availableSections.value.length;
  const groups = sectionGroups.value.length;
  if (!count) return "No primitives enabled yet.";
  return `${count} ${count === 1 ? "primitive" : "primitives"} enabled in ${groups} ${groups === 1 ? "group" : "groups"}.`;
});

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The console could not load its configuration.";
}

async function loadRecentSessions(): Promise<void> {
  sessionsLoadedAt.value = Date.now();
  await recentSessions.refresh();
}

async function loadSections(): Promise<void> {
  const currentRequest = ++request;
  loading.value = true;
  try {
    const navigation = await loadConsoleNavigation(props.sectionsBase);
    if (!navigation) throw viteHubErrorDiagnostics.VITE_HUB_R0101({ message: "The console could not load its configuration." });
    if (request !== currentRequest) return;
    installedNavigation.value = navigation;
    sections.value = [...new Set(navigation.sections)];
    error.value = undefined;
    if (sections.value.includes("agents")) void loadRecentSessions();
  } catch (requestError) {
    if (request === currentRequest) error.value = requestError;
  } finally {
    if (request === currentRequest) loading.value = false;
  }
}

async function openSection(routeName: string): Promise<void> {
  await router.push({ name: resolveConsoleRouteName(route.name, routeName) });
}

async function openSession(agentName: string, invocation: string): Promise<void> {
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
    params: { agent: encodeAgentRouteParam(agentName), invocation },
  });
}

onMounted(() => {
  lastSection.value = readLastConsoleSection();
  void loadSections();
});
onBeforeUnmount(() => request++);
</script>

<template>
  <ConsoleFrame :sections-base="sectionsBase">

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="console-home" :ui="{ body: 'min-h-0 overflow-y-auto p-0 gap-0' }">
      <template #header>
        <UDashboardNavbar title="Overview" :toggle="false" :ui="{ root: 'border-0' }" />
      </template>

      <template #body>
        <main class="px-5 pb-24 pt-8 sm:px-8 lg:pt-14">
          <div class="mx-auto w-full max-w-2xl">
            <header class="flex items-center gap-3">
              <span class="vitehub-console__overview-mark grid size-10 shrink-0 place-items-center rounded-full border border-default">
                <ConsoleMark class="size-[1.125rem]" />
              </span>
              <div class="min-w-0">
                <h1 class="truncate text-sm font-medium text-highlighted">
                  {{ installedNavigation?.projectName || "ViteHub Console" }}
                </h1>
                <p class="text-sm text-muted">
                  {{ loading ? "Loading the enabled primitives…" : summary }}
                </p>
              </div>
            </header>

            <div v-if="loading" class="mt-12 grid gap-10" aria-hidden="true">
              <div v-for="index in 3" :key="index" class="grid gap-3">
                <USkeleton class="h-4 w-24 rounded-sm" />
                <USkeleton v-for="row in 3" :key="row" class="h-6 rounded-md" />
              </div>
            </div>

            <UAlert
              v-else-if="error && !availableSections.length"
              class="mt-12"
              color="error"
              variant="subtle"
              icon="i-ph-cloud-slash-light"
              title="Could not load sections"
              :description="errorMessage(error)"
              :actions="[
                { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadSections },
              ]"
            />

            <template v-else>
              <section v-if="!availableSections.length" class="mt-12">
                <h2 class="text-sm font-medium text-highlighted">Add your first primitive</h2>
                <p class="mt-1 max-w-md text-sm leading-6 text-muted">
                  No primitive in this project has a Console page yet. Enable one in the ViteHub configuration, then reload the Console.
                </p>
                <div class="mt-4 flex flex-wrap gap-2">
                  <UButton
                    color="neutral"
                    icon="i-lucide-rocket"
                    label="Start with KV"
                    size="sm"
                    target="_blank"
                    to="https://vitehub.dev/docs/getting-started/first-server-primitive"
                    variant="solid"
                  />
                  <UButton
                    color="neutral"
                    :icon="consoleSectionDetails.agents.icon"
                    label="Build an Agent"
                    size="sm"
                    target="_blank"
                    to="https://vitehub.dev/docs/getting-started/first-agent"
                    variant="outline"
                  />
                </div>
              </section>

              <section v-if="showContinue" class="mt-12" aria-labelledby="console-home-continue">
                <div class="vitehub-console__overview-label">
                  <h2 id="console-home-continue">Continue</h2>
                  <button
                    v-if="agentsEnabled"
                    type="button"
                    class="vitehub-console__overview-link"
                    @click="openSection(consoleSectionDetails.agents.routeName)"
                  >
                    All sessions
                  </button>
                </div>
                <ul class="vitehub-console__overview-list">
                  <li v-if="lastSectionDetails">
                    <button
                      type="button"
                      class="vitehub-console__overview-row"
                      :aria-label="`Open ${lastSectionDetails.label}`"
                      @click="openSection(lastSectionDetails.routeName)"
                    >
                      <span class="vitehub-console__overview-icon">
                        <ConsoleSectionIcon :section="lastSectionDetails.id" :icon="lastSectionDetails.icon" class="size-3.5" />
                      </span>
                      <span class="vitehub-console__overview-name">{{ lastSectionDetails.label }}</span>
                      <span class="vitehub-console__overview-description">{{ lastSectionDetails.description }}</span>
                      <span class="vitehub-console__overview-meta">Last visited</span>
                    </button>
                  </li>
                  <template v-if="agentsEnabled">
                    <li v-if="recentSessions.pending.value && !sessionItems.length" aria-hidden="true">
                      <USkeleton class="my-2 h-5 rounded-md" />
                    </li>
                    <li v-else-if="recentSessions.error.value" class="vitehub-console__overview-row" data-static>
                      <span class="vitehub-console__overview-icon"><UIcon name="i-ph-cloud-slash-light" class="size-3.5" /></span>
                      <span class="vitehub-console__overview-description">Could not load recent sessions.</span>
                      <UButton class="ms-auto" color="neutral" variant="link" size="xs" label="Try again" @click="loadRecentSessions" />
                    </li>
                    <li v-else-if="!sessionItems.length" class="vitehub-console__overview-row" data-static>
                      <span class="vitehub-console__overview-description">No Agent sessions yet. Invoke an Agent to see its sessions here.</span>
                    </li>
                    <li v-for="session in sessionItems" v-else :key="session.id">
                      <button
                        type="button"
                        class="vitehub-console__overview-row"
                        :disabled="!session.agentName"
                        :aria-label="`Open ${session.agentName || 'Agent'} session ${session.context}, status ${session.status}${session.time ? `, ${session.time}` : ''}`"
                        @click="session.agentName && openSession(session.agentName, session.id)"
                      >
                        <span class="vitehub-console__overview-icon">
                          <span class="size-1.5 rounded-full" :class="session.dot" aria-hidden="true" />
                        </span>
                        <span class="vitehub-console__overview-name">{{ session.agentName || "Agent Invocation" }}</span>
                        <span class="vitehub-console__overview-description">{{ session.context }}</span>
                        <span class="vitehub-console__overview-meta">
                          {{ session.status }}<template v-if="session.time"> · <time>{{ session.time }}</time></template>
                        </span>
                      </button>
                    </li>
                  </template>
                </ul>
              </section>

              <section
                v-for="group in sectionGroups"
                :key="group.id"
                class="mt-12"
                :aria-labelledby="`console-home-group-${group.id}`"
              >
                <div class="vitehub-console__overview-label">
                  <h2 :id="`console-home-group-${group.id}`">{{ group.label }}</h2>
                </div>
                <ul class="vitehub-console__overview-list">
                  <li v-for="section in group.sections" :key="section.id" class="vitehub-console__overview-row group" data-cell>
                    <!-- The button covers the row. The Docs link sits above it, so a link never nests in the button. -->
                    <button
                      type="button"
                      class="vitehub-console__overview-cell-target absolute inset-0"
                      :aria-label="`Open ${section.label}`"
                      @click="openSection(section.routeName)"
                    />
                    <span class="vitehub-console__overview-icon">
                      <ConsoleSectionIcon :section="section.id" :icon="section.icon" class="size-3.5" />
                    </span>
                    <span class="vitehub-console__overview-name">{{ section.label }}</span>
                    <span class="vitehub-console__overview-description">{{ section.description }}</span>
                    <a
                      v-if="section.docs"
                      class="vitehub-console__overview-meta vitehub-console__overview-docs"
                      :href="section.docs"
                      rel="noreferrer"
                      target="_blank"
                      :aria-label="`${section.label} documentation`"
                    >
                      Docs
                    </a>
                  </li>
                </ul>
              </section>

              <section v-if="notEnabledPrimitives.length" class="mt-12" aria-labelledby="console-home-not-enabled">
                <div class="vitehub-console__overview-label">
                  <h2 id="console-home-not-enabled">Not enabled</h2>
                </div>
                <ul class="vitehub-console__overview-list">
                  <li v-for="entry in notEnabledPrimitives" :key="entry.id">
                    <a
                      class="vitehub-console__overview-row"
                      data-optional
                      :href="entry.setup"
                      rel="noreferrer"
                      target="_blank"
                      :aria-label="`Set up ${entry.label}`"
                    >
                      <span class="vitehub-console__overview-icon">
                        <ConsoleSectionIcon :section="entry.id" :icon="entry.icon" class="size-3.5" />
                      </span>
                      <span class="vitehub-console__overview-name">{{ entry.label }}</span>
                      <span class="vitehub-console__overview-description">{{ entry.pitch }}</span>
                      <span class="vitehub-console__overview-meta">Set up</span>
                    </a>
                  </li>
                </ul>
              </section>

              <section class="mt-12" aria-labelledby="console-home-learn">
                <div class="vitehub-console__overview-label">
                  <h2 id="console-home-learn">Learn</h2>
                </div>
                <ul class="vitehub-console__overview-list">
                  <li v-for="guide in consoleGuides" :key="guide.href">
                    <a class="vitehub-console__overview-row" :href="guide.href" rel="noreferrer" target="_blank">
                      <span class="vitehub-console__overview-icon">
                        <UIcon :name="guide.icon" class="size-3.5" />
                      </span>
                      <span class="vitehub-console__overview-name">{{ guide.label }}</span>
                      <span class="vitehub-console__overview-description">{{ guide.description }}</span>
                      <UIcon name="i-lucide-arrow-up-right" class="vitehub-console__overview-meta size-3.5" />
                    </a>
                  </li>
                </ul>
              </section>
            </template>
          </div>
        </main>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>

<style>
/*
 * The Overview reads like a personal site: one narrow column, sentence-case labels, and rows of
 * icon, name, description, and meta. Hierarchy comes from text tone, not from frames.
 */
.vitehub-console__overview-label {
  align-items: baseline;
  color: var(--ui-text-dimmed);
  display: flex;
  font-size: 0.875rem;
  justify-content: space-between;
  margin-block-end: 0.5rem;
}

.vitehub-console__overview-label h2 {
  font-size: inherit;
  font-weight: 400;
}

.vitehub-console__overview-link {
  color: var(--ui-text-muted);
  cursor: pointer;
  font-size: 0.8125rem;
  outline: none;
  transition: color 150ms ease;
}

.vitehub-console__overview-link:hover,
.vitehub-console__overview-link:focus-visible {
  color: var(--ui-text-highlighted);
}

.vitehub-console__overview-list {
  display: flex;
  flex-direction: column;
  margin-inline: -0.5rem;
}

.vitehub-console__overview-row {
  align-items: center;
  border-radius: 0.375rem;
  display: flex;
  font-size: 0.875rem;
  gap: 0.75rem;
  line-height: 1.25rem;
  min-height: 2.75rem;
  min-width: 0;
  outline: none;
  padding-inline: 0.5rem;
  position: relative;
  text-align: left;
  transition: background-color 150ms ease;
  width: 100%;
}

.vitehub-console__overview-row:is(button, a, [data-cell]):not(:disabled):hover,
.vitehub-console__overview-row:is(button, a):focus-visible,
.vitehub-console__overview-row[data-cell]:has(> .vitehub-console__overview-cell-target:focus-visible) {
  background: var(--ui-bg-elevated);
}

.vitehub-console__overview-row:disabled {
  cursor: default;
}

.vitehub-console__overview-cell-target {
  border-radius: inherit;
  cursor: pointer;
  outline: none;
}

.vitehub-console__overview-icon {
  align-items: center;
  border: 1px solid var(--ui-border);
  border-radius: 0.3125rem;
  color: var(--ui-text-muted);
  display: inline-flex;
  flex: none;
  height: 1.5rem;
  justify-content: center;
  width: 1.5rem;
}

.vitehub-console__overview-name {
  color: var(--ui-text-highlighted);
  flex: none;
  font-weight: 500;
}

.vitehub-console__overview-description {
  color: var(--ui-text-muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-console__overview-meta {
  color: var(--ui-text-dimmed);
  flex: none;
  margin-inline-start: auto;
  white-space: nowrap;
}

/* The Docs link sits above the row button, so a pointer on it opens the docs and not the section. */
.vitehub-console__overview-docs {
  outline: none;
  position: relative;
  transition: color 150ms ease;
  z-index: 1;
}

.vitehub-console__overview-docs:hover,
.vitehub-console__overview-docs:focus-visible {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* Primitives that are not enabled read one tone quieter, so they look optional. */
.vitehub-console__overview-row[data-optional] .vitehub-console__overview-name {
  color: var(--ui-text-toned);
}

.vitehub-console__overview-mark {
  color: var(--ui-text-highlighted);
}

@media (max-width: 40rem) {
  .vitehub-console__overview-description {
    display: none;
  }
}
</style>
