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
import { isConsoleSignInRequired, requestConsole } from "../client/request";
import { consoleNavigationError, loadConsoleNavigation, resolveConsoleSectionDetails } from "../client/sections";
import { recentTimestamp } from "../client/time";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSectionIcon from "./console-section-icon.vue";
import ConsoleState from "./console-state.vue";
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
// Usage comes with Agents, so it is not offered on its own. A user limited to some sections may not see the others,
// so the Overview does not call them "not enabled".
const notEnabledPrimitives = computed(() =>
  installedNavigation.value?.scoped
    ? []
    : consolePrimitives.filter((entry) => entry.id !== "usage" && !sections.value.includes(entry.id)),
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
  if (!count) return isConsoleSignInRequired(error.value) ? "Sign in to see what this project enables." : "No primitives enabled yet.";
  return `${count} ${count === 1 ? "primitive" : "primitives"} enabled in ${groups} ${groups === 1 ? "group" : "groups"}.`;
});


async function loadRecentSessions(): Promise<void> {
  sessionsLoadedAt.value = Date.now();
  await recentSessions.refresh();
}

async function loadSections(): Promise<void> {
  const currentRequest = ++request;
  loading.value = true;
  try {
    const navigation = await loadConsoleNavigation(props.sectionsBase);
    if (!navigation) throw consoleNavigationError(props.sectionsBase) ?? viteHubErrorDiagnostics.VITE_HUB_R0101({ message: "The console could not load its configuration." });
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

            <!-- With app sign-in, the Console page loads for anyone; its data needs a signed-in user. -->
            <UAlert
              v-else-if="error && !availableSections.length && isConsoleSignInRequired(error)"
              class="mt-10"
              color="neutral"
              variant="subtle"
              icon="i-lucide-log-in"
              title="Sign in to use the Console"
              description="You are not signed in, or your session ended. Sign in, then reload this page."
              :actions="[{ label: 'Reload', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: loadSections }]"
            />
            <ConsoleState
              v-else-if="error && !availableSections.length"
              class="mt-12"
              icon="i-lucide-cloud-off"
              title="Could not load sections"
              :error="error"
              :retry="loadSections"
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
                    v-if="lastSectionDetails"
                    type="button"
                    class="vitehub-console__overview-link"
                    @click="lastSectionDetails && openSection(lastSectionDetails.routeName)"
                  >
                    <span class="flex items-center justify-between gap-3">
                      <span class="vitehub-console__overview-icon size-9">
                        <ConsoleSectionIcon :section="lastSectionDetails.id" :icon="lastSectionDetails.icon" class="size-[1.125rem]" />
                      </span>
                      <span class="font-mono text-xs uppercase tracking-[0.08em] text-dimmed">Last visited</span>
                    </span>
                    <span class="mt-auto block pt-6 text-base font-semibold text-highlighted">{{ lastSectionDetails.label }}</span>
                    <span class="mt-1 block text-sm text-muted">{{ lastSectionDetails.description }}</span>
                    <span class="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted transition-colors group-hover:text-highlighted">
                      Continue in {{ lastSectionDetails.label }}
                      <UIcon name="i-lucide-arrow-right" class="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </button>

                  <div v-if="agentsEnabled" class="flex flex-col overflow-hidden rounded-lg border border-default" :class="lastSectionDetails ? 'min-h-40' : ''">
                    <div class="flex items-center justify-between gap-3 border-b border-default px-4 py-2.5">
                      <span class="flex items-center gap-2 text-sm font-medium text-highlighted">
                        <ConsoleSectionIcon section="agents" :icon="consoleSectionDetails.agents.icon" class="size-4 text-muted" />
                        Recent sessions
                      </span>
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        label="View all"
                        trailing-icon="i-lucide-arrow-right"
                        @click="openSection(consoleSectionDetails.agents.routeName)"
                      />
                    </div>
                    <div v-if="recentSessions.pending.value && !sessionItems.length" class="grid gap-2 p-4" aria-hidden="true">
                      <USkeleton v-for="index in 3" :key="index" class="h-6 rounded-md" />
                    </div>
                    <div v-else-if="recentSessions.error.value" class="flex flex-1 items-center gap-2 px-4 py-6 text-sm text-muted">
                      <UIcon name="i-lucide-cloud-off" class="size-4 shrink-0" />
                      <span class="min-w-0 flex-1">Could not load recent sessions.</span>
                      <UButton color="neutral" variant="link" size="xs" label="Try again" @click="loadRecentSessions" />
                    </div>
                    <p v-else-if="!sessionItems.length" class="flex flex-1 items-center px-4 py-6 text-sm text-muted">
                      No Agent sessions yet. Invoke an Agent to see its sessions here.
                    </p>
                    <ul v-else class="divide-y divide-default">
                      <li v-for="session in sessionItems" :key="session.id">
                        <button
                          type="button"
                          class="vitehub-console__overview-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-left disabled:cursor-default"
                          :disabled="!session.agentName"
                          :aria-label="`Open ${session.agentName || 'Agent'} session ${session.context}, status ${session.status}${session.time ? `, ${session.time}` : ''}`"
                          @click="session.agentName && openSession(session.agentName, session.id)"
                        >
                          <span class="size-1.5 rounded-full" :class="session.dot" aria-hidden="true" />
                          <span class="flex min-w-0 items-baseline gap-2">
                            <span class="min-w-0 truncate text-sm font-medium text-highlighted">{{ session.agentName || "Agent Invocation" }}</span>
                            <span class="truncate font-mono text-xs text-muted">{{ session.context }}</span>
                          </span>
                          <span class="flex items-center gap-3 text-xs text-muted">
                            <span class="hidden sm:inline">{{ session.status }}</span>
                            <span v-if="session.time" class="w-12 text-right font-mono tabular-nums text-dimmed">{{ session.time }}</span>
                          </span>
                        </button>
                      </li>
                    </ul>
                  </div>
                </div>

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
                    <span class="pointer-events-none min-w-0">
                      <span class="block text-sm font-medium text-highlighted">{{ section.label }}</span>
                      <span class="mt-1 block text-[13px]/[18px] text-muted">{{ section.description }}</span>
                    </span>
                  </li>
                  <li
                    v-for="filler in group.fillers"
                    :key="filler.index"
                    class="vitehub-console__overview-filler hidden"
                    :class="[filler.sm ? 'sm:block' : '', filler.lg ? 'lg:block' : 'lg:hidden']"
                    aria-hidden="true"
                  />
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
                      <span class="text-sm font-medium text-toned">{{ entry.label }}</span>
                      <span class="vitehub-console__overview-docs ms-auto inline-flex items-center gap-1">
                        Set up
                        <UIcon name="i-lucide-arrow-up-right" class="size-3" />
                      </span>
                    <span class="text-[13px]/[18px] text-muted">{{ entry.pitch }}</span>
                  </a>
                  </li>
                </ul>
              </section>

              <section class="mt-12" aria-labelledby="console-home-learn">
                <h2 id="console-home-learn" class="vitehub-console__overview-eyebrow">
                  <span>Learn</span>
                </h2>
                <div class="vitehub-console__overview-grid grid gap-px overflow-hidden rounded-lg border border-default sm:grid-cols-2 lg:grid-cols-4">
                  <a
                    v-for="guide in consoleGuides"
                    :key="guide.href"
                    class="vitehub-console__overview-cell group flex flex-col gap-3 p-4"
                    :href="guide.href"
                    rel="noreferrer"
                    target="_blank"
                  >
                    <span class="flex items-center justify-between gap-3">
                      <UIcon :name="guide.icon" class="size-4 text-muted transition-colors group-hover:text-highlighted" />
                      <UIcon name="i-lucide-arrow-up-right" class="size-3 text-dimmed transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </span>
                    <span>
                      <span class="block text-sm font-medium text-highlighted">{{ guide.label }}</span>
                      <span class="mt-1 block text-[13px]/[18px] text-muted">{{ guide.description }}</span>
                    </span>
                  </a>
                </div>
              </section>
            </template>
          </div>
        </main>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>

<style>
/* Section labels use mono uppercase eyebrows with a hairline to the right. */
.vitehub-console__overview-eyebrow {
  align-items: center;
  color: var(--ui-text-muted);
  display: flex;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  gap: 0.75rem;
  letter-spacing: 0.08em;
  margin-block-end: 0.75rem;
  text-transform: uppercase;
}

.vitehub-console__overview-eyebrow::after {
  background: var(--ui-border);
  content: "";
  flex: 1 1 auto;
  height: 1px;
  order: 1;
}

.vitehub-console__overview-eyebrow > :last-child:not(:first-child) {
  order: 2;
}

/* Docs and Set up links stay quiet until the pointer reaches them. */
.vitehub-console__overview-docs {
  border-radius: 0.25rem;
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 12px;
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.vitehub-console__overview-icon {
  align-items: center;
  background: var(--ui-bg-muted);
  border: 1px solid var(--ui-border);
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  display: inline-flex;
  flex: none;
  justify-content: center;
  transition: color 150ms ease, border-color 150ms ease;
}

/* Hover layers the elevated tint over the page color because the dark tint is translucent. */
.vitehub-console__overview-cell,
.vitehub-console__overview-card,
.vitehub-console__overview-row {
  outline: none;
  transition: background 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
}

.vitehub-console__overview-row:not(:disabled):hover {
  background: linear-gradient(var(--ui-bg-elevated), var(--ui-bg-elevated)), var(--ui-bg);
}

/* Grid cells share hairlines, so hover adds an inset border over the tint. */
.vitehub-console__overview-cell:hover {
  background: linear-gradient(var(--ui-bg-elevated), var(--ui-bg-elevated)), var(--ui-bg);
  box-shadow: inset 0 0 0 1px var(--ui-border-accented);
}

.vitehub-console__overview-card {
  background: linear-gradient(var(--ui-bg-muted), var(--ui-bg-muted)), var(--ui-bg);
}

.vitehub-console__overview-card:hover {
  background: linear-gradient(var(--ui-bg-elevated), var(--ui-bg-elevated)), var(--ui-bg);
  border-color: var(--ui-border-accented);
}

.vitehub-console__overview-cell:hover .vitehub-console__overview-icon,
.vitehub-console__overview-card:hover .vitehub-console__overview-icon {
  border-color: var(--ui-border-accented);
  color: var(--ui-text-highlighted);
}

.vitehub-console__overview-cell:focus-visible,
.vitehub-console__overview-cell:has(> .vitehub-console__overview-cell-target:focus-visible),
.vitehub-console__overview-card:focus-visible,
.vitehub-console__overview-row:focus-visible {
  box-shadow: inset 0 0 0 2px var(--ui-border-inverted);
  position: relative;
  z-index: 1;
}
</style>
