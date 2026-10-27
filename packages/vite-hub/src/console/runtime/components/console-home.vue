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
import { consoleSignInURL } from "../client/sign-in";
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
const agentsEnabled = computed(() => sections.value.includes("agents"));
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

async function loadRecentSessions(): Promise<void> {
  sessionsLoadedAt.value = Date.now();
  await recentSessions.refresh();
}

// Without a session the Console has nothing to show, so the Overview is one centered state.
const signedOut = computed(() => !loading.value && !availableSections.value.length && isConsoleSignInRequired(error.value));
const checking = ref(false);
const stillSignedOut = ref(false);
// With a sign-in page, the Console sends the person there and back. Without one, it asks them to sign in elsewhere.
const signInURL = computed(() => (signedOut.value ? consoleSignInURL({ document, location: window.location }) : undefined));

/** A quiet load keeps the current page on screen while it runs, so the signed-out state does not flash a skeleton. */
async function loadSections(quiet = false): Promise<void> {
  const currentRequest = ++request;
  if (!quiet) loading.value = true;
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

/** Asks again whether this browser has a session. Only a check that someone asked for reports "still not signed in". */
async function checkSession(asked: boolean): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  if (asked) stillSignedOut.value = false;
  try {
    await loadSections(true);
  } finally {
    checking.value = false;
  }
  if (asked) stillSignedOut.value = signedOut.value;
  checkIfReturned();
}

// People sign in in another tab, so the Console checks again when this tab is shown or focused again. A return while a
// request is in flight waits for its answer, because that request may have left before the sign-in.
let returnedDuringRequest = false;
function checkOnReturn(): void {
  if (document.visibilityState !== "visible") return;
  if (loading.value || checking.value) returnedDuringRequest = true;
  else if (signedOut.value) void checkSession(false);
}

function checkIfReturned(): void {
  if (!returnedDuringRequest) return;
  returnedDuringRequest = false;
  if (signedOut.value) void checkSession(false);
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
  void loadSections().then(checkIfReturned);
  document.addEventListener("visibilitychange", checkOnReturn);
  window.addEventListener("focus", checkOnReturn);
});
onBeforeUnmount(() => {
  request++;
  document.removeEventListener("visibilitychange", checkOnReturn);
  window.removeEventListener("focus", checkOnReturn);
});
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
        <!-- With app sign-in, the Console page loads for anyone; its data needs a signed-in user. -->
        <main
          v-if="signedOut"
          class="flex flex-1 flex-col items-center justify-center px-6 pb-24 pt-12 text-center"
          aria-labelledby="console-home-signed-out"
        >
          <span class="vitehub-console__overview-mark grid size-10 place-items-center rounded-full border border-default" aria-hidden="true">
            <ConsoleMark class="size-[1.125rem]" />
          </span>
          <h2 id="console-home-signed-out" class="mt-4 text-base font-semibold text-balance text-highlighted">Sign in to use the Console</h2>
          <p class="mt-1.5 max-w-sm text-sm text-pretty text-muted">
            {{ signInURL ? "You are not signed in, or your session ended." : "You are not signed in, or your session ended. Sign in, then come back to this tab." }}
          </p>
          <UButton
            v-if="signInURL"
            class="mt-5"
            color="neutral"
            size="sm"
            icon="i-lucide-log-in"
            label="Sign in"
            :to="signInURL"
            external
          />
          <UButton
            v-else
            class="mt-5"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-refresh-cw"
            label="Check again"
            :loading="checking"
            @click="checkSession(true)"
          />
          <p class="mt-3 min-h-5 text-xs text-muted" role="status">{{ stillSignedOut ? "You are still not signed in." : "" }}</p>
        </main>
        <main v-else class="px-5 pb-24 pt-8 sm:px-8 lg:pt-12">
          <div class="mx-auto flex w-full max-w-3xl flex-col gap-10">
            <!-- Every block puts its label in a narrow left column, so rows of every section start on one edge. -->
            <header class="vitehub-console__overview-block items-center" data-header>
              <span class="vitehub-console__overview-mark grid size-10 shrink-0 place-items-center rounded-full border border-default">
                <ConsoleMark class="size-[1.125rem]" />
              </span>
              <div class="min-w-0">
                <h1 class="truncate text-base font-semibold tracking-tight text-highlighted">
                  {{ installedNavigation?.projectName || "ViteHub Console" }}
                </h1>
                <p class="text-sm text-muted">
                  {{ loading ? "Loading the enabled primitives…" : summary }}
                </p>
              </div>
            </header>

            <div v-if="loading" class="flex flex-col gap-10" aria-hidden="true">
              <div v-for="index in 3" :key="index" class="vitehub-console__overview-block">
                <USkeleton class="h-4 w-16 rounded-sm sm:mt-3" />
                <div class="grid gap-2 py-1.5">
                  <USkeleton v-for="row in 3" :key="row" class="h-7 rounded-md" />
                </div>
              </div>
            </div>

            <ConsoleState
              v-else-if="error && !availableSections.length"
              icon="i-lucide-cloud-off"
              title="Could not load sections"
              :error="error"
              :retry="loadSections"
            />

            <template v-else>
              <section v-if="!availableSections.length" class="vitehub-console__overview-block" aria-labelledby="console-home-start">
                <p class="vitehub-console__overview-label" aria-hidden="true">Get started</p>
                <div class="sm:pt-2.5">
                  <h2 id="console-home-start" class="text-sm font-medium text-highlighted">Add your first primitive</h2>
                  <p class="mt-1 max-w-md text-sm text-pretty text-muted">
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
                </div>
              </section>

              <section v-if="agentsEnabled" class="vitehub-console__overview-block" aria-labelledby="console-home-sessions">
                <h2 id="console-home-sessions" class="vitehub-console__overview-label">Recent sessions</h2>
                <ul class="vitehub-console__overview-list">
                  <li v-if="recentSessions.pending.value && !sessionItems.length" class="grid gap-2 px-2 py-1.5" aria-hidden="true">
                    <USkeleton v-for="index in 3" :key="index" class="h-7 rounded-md" />
                  </li>
                  <li v-else-if="recentSessions.error.value" class="vitehub-console__overview-row">
                    <UIcon name="i-lucide-cloud-off" class="vitehub-console__overview-icon" />
                    <span class="vitehub-console__overview-description">Could not load recent sessions.</span>
                    <UButton class="ms-auto" color="neutral" variant="link" size="xs" label="Try again" @click="loadRecentSessions" />
                  </li>
                  <li v-else-if="!sessionItems.length" class="vitehub-console__overview-row">
                    <ConsoleSectionIcon section="agents" :icon="consoleSectionDetails.agents.icon" class="vitehub-console__overview-icon" />
                    <span class="vitehub-console__overview-description">No Agent sessions yet. Invoke an Agent to see its sessions here.</span>
                  </li>
                  <template v-else>
                    <li v-for="session in sessionItems" :key="session.id">
                      <button
                        type="button"
                        class="vitehub-console__overview-row"
                        :disabled="!session.agentName"
                        :aria-label="`Open ${session.agentName || 'Agent'} session ${session.context}, status ${session.status}${session.time ? `, ${session.time}` : ''}`"
                        @click="session.agentName && openSession(session.agentName, session.id)"
                      >
                        <span class="vitehub-console__overview-icon" aria-hidden="true">
                          <span class="size-1.5 rounded-full" :class="session.dot" />
                        </span>
                        <span class="vitehub-console__overview-name">{{ session.agentName || "Agent Invocation" }}</span>
                        <span class="vitehub-console__overview-description font-mono text-xs" :title="session.context">{{ session.context }}</span>
                        <span class="vitehub-console__overview-meta">
                          <span class="hidden font-sans sm:inline">{{ session.status }}</span>
                          <span v-if="session.time" class="w-12 text-right tabular-nums">{{ session.time }}</span>
                        </span>
                      </button>
                    </li>
                  </template>
                  <li>
                    <button type="button" class="vitehub-console__overview-row text-muted" @click="openSection(consoleSectionDetails.agents.routeName)">
                      <UIcon name="i-lucide-arrow-right" class="vitehub-console__overview-icon" />
                      <span>View all sessions</span>
                    </button>
                  </li>
                </ul>
              </section>

              <!-- Groups follow the rail. They sit closer to each other than to the other sections, because together they list what is enabled. -->
              <div v-if="sectionGroups.length" class="flex flex-col gap-4 sm:gap-2">
                <section
                  v-for="group in sectionGroups"
                  :key="group.id"
                  class="vitehub-console__overview-block"
                  :aria-labelledby="`console-home-group-${group.id}`"
                >
                  <h2 :id="`console-home-group-${group.id}`" class="vitehub-console__overview-label">{{ group.label }}</h2>
                  <ul class="vitehub-console__overview-list">
                    <li v-for="section in group.sections" :key="section.id" class="vitehub-console__overview-row" data-cell>
                      <!-- The button covers the row. The Docs link sits above it, so a link never nests in the button. -->
                      <button
                        type="button"
                        class="vitehub-console__overview-cell-target absolute inset-0"
                        :aria-label="`Open ${section.label}`"
                        @click="openSection(section.routeName)"
                      />
                      <ConsoleSectionIcon :section="section.id" :icon="section.icon" class="vitehub-console__overview-icon" />
                      <span class="vitehub-console__overview-name">{{ section.label }}</span>
                      <span class="vitehub-console__overview-description" :title="section.description">{{ section.description }}</span>
                      <span class="vitehub-console__overview-meta">
                        <span v-if="section.id === lastSection" class="hidden font-sans sm:inline">Last visited</span>
                        <a
                          v-if="section.docs"
                          class="vitehub-console__overview-docs"
                          :href="section.docs"
                          rel="noreferrer"
                          target="_blank"
                          :aria-label="`${section.label} documentation`"
                        >
                          Docs
                        </a>
                      </span>
                    </li>
                  </ul>
                </section>
              </div>

              <section v-if="notEnabledPrimitives.length" class="vitehub-console__overview-block" aria-labelledby="console-home-not-enabled">
                <h2 id="console-home-not-enabled" class="vitehub-console__overview-label">Not enabled</h2>
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
                      <ConsoleSectionIcon :section="entry.id" :icon="entry.icon" class="vitehub-console__overview-icon" />
                      <span class="vitehub-console__overview-name">{{ entry.label }}</span>
                      <span class="vitehub-console__overview-description" :title="entry.pitch">{{ entry.pitch }}</span>
                      <span class="vitehub-console__overview-meta">
                        Set up
                        <UIcon name="i-lucide-arrow-up-right" class="size-3" />
                      </span>
                    </a>
                  </li>
                </ul>
              </section>

              <section class="vitehub-console__overview-block" aria-labelledby="console-home-learn">
                <h2 id="console-home-learn" class="vitehub-console__overview-label">Learn</h2>
                <ul class="vitehub-console__overview-list">
                  <li v-for="guide in consoleGuides" :key="guide.href">
                    <a class="vitehub-console__overview-row" :href="guide.href" rel="noreferrer" target="_blank">
                      <UIcon :name="guide.icon" class="vitehub-console__overview-icon" />
                      <span class="vitehub-console__overview-name">{{ guide.label }}</span>
                      <span class="vitehub-console__overview-description" :title="guide.description">{{ guide.description }}</span>
                      <span class="vitehub-console__overview-meta">
                        <UIcon name="i-lucide-arrow-up-right" class="size-3" />
                      </span>
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
 * The Overview is one column of blocks. Each block has a quiet label on the left and one-line rows on the right:
 * icon, name, description, and meta. Rows are 2.5rem high, and the label has the same line height, so it lines up
 * with the first row. Blocks stack on narrow screens.
 */
.vitehub-console__overview-block {
  display: grid;
  gap: 0.25rem 1.5rem;
}

/* The header keeps the mark beside the project name on a phone. */
.vitehub-console__overview-block[data-header] {
  column-gap: 0.75rem;
  grid-template-columns: auto minmax(0, 1fr);
}

@media (min-width: 40rem) {
  .vitehub-console__overview-block,
  .vitehub-console__overview-block[data-header] {
    column-gap: 1.5rem;
    grid-template-columns: 7rem minmax(0, 1fr);
  }
}

.vitehub-console__overview-label {
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (min-width: 40rem) {
  .vitehub-console__overview-label {
    line-height: 2.5rem;
  }
}

.vitehub-console__overview-mark {
  color: var(--ui-text-highlighted);
}

/* Rows reach past the text edge, so the hover tint has room and the icons still line up with the header. */
.vitehub-console__overview-list {
  display: flex;
  flex-direction: column;
  margin-inline: -0.5rem;
  min-width: 0;
}

.vitehub-console__overview-row {
  align-items: center;
  border-radius: 0.375rem;
  display: flex;
  font-size: 0.875rem;
  gap: 0.75rem;
  line-height: 1.25rem;
  min-height: 2.5rem;
  min-width: 0;
  outline: none;
  padding-inline: 0.5rem;
  position: relative;
  text-align: left;
  transition: background-color 150ms ease;
  width: 100%;
}

.vitehub-console__overview-row:is(button, a) {
  cursor: pointer;
}

.vitehub-console__overview-row:disabled {
  cursor: default;
}

@media (hover: hover) {
  .vitehub-console__overview-row:is(button, a, [data-cell]):not(:disabled):hover {
    background: var(--ui-bg-elevated);
  }

  .vitehub-console__overview-row:is(button, a, [data-cell]):not(:disabled):hover .vitehub-console__overview-icon {
    color: var(--ui-text-highlighted);
  }
}

.vitehub-console__overview-row:is(button, a):focus-visible,
.vitehub-console__overview-row[data-cell]:has(> .vitehub-console__overview-cell-target:focus-visible) {
  background: var(--ui-bg-elevated);
  box-shadow: inset 0 0 0 2px var(--ui-border-inverted);
}

.vitehub-console__overview-cell-target {
  border-radius: inherit;
  cursor: pointer;
  outline: none;
}

.vitehub-console__overview-icon {
  align-items: center;
  color: var(--ui-text-muted);
  display: inline-flex;
  flex: none;
  height: 1rem;
  justify-content: center;
  pointer-events: none;
  transition: color 150ms ease;
  width: 1rem;
}

.vitehub-console__overview-name {
  color: var(--ui-text-highlighted);
  flex: none;
  font-weight: 500;
  max-width: 45%;
  overflow: hidden;
  pointer-events: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-console__overview-description {
  color: var(--ui-text-muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  pointer-events: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-console__overview-meta {
  align-items: center;
  color: var(--ui-text-muted);
  display: inline-flex;
  flex: none;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  gap: 0.75rem;
  margin-inline-start: auto;
  white-space: nowrap;
}

/* The Docs link sits above the row button, so a pointer on it opens the docs and not the section. */
.vitehub-console__overview-docs {
  border-radius: 0.25rem;
  margin: -0.25rem -0.375rem;
  outline: none;
  padding: 0.25rem 0.375rem;
  position: relative;
  text-underline-offset: 3px;
  transition: color 150ms ease;
  z-index: 1;
}

.vitehub-console__overview-docs:hover {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
}

.vitehub-console__overview-docs:focus-visible {
  color: var(--ui-text-highlighted);
  outline: 2px solid var(--ui-border-inverted);
}

/* Primitives that are not enabled read one tone quieter, so they look optional. */
.vitehub-console__overview-row[data-optional] .vitehub-console__overview-name {
  color: var(--ui-text-toned);
  font-weight: 400;
}

/* On a phone the name and meta fit; a description after a name would truncate to a few letters. */
@media (max-width: 40rem) {
  .vitehub-console__overview-name + .vitehub-console__overview-description {
    display: none;
  }
}
</style>
