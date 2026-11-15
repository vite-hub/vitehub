<script setup lang="ts">
import { Status, type StatusTone } from "@vite-hub/ui";
import { useCollection } from "vite-hub/source/client";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { AgentInvocationStatus } from "./invocation";
import type { ConsoleSectionId } from "../sections";
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import type { ConsoleNavigation } from "../client/sections";
import {
  consoleGuide,
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
import { recentTimestamp } from "../client/format";
import ConsoleMark from "./console-mark.vue";
import ConsolePageHeader from "./console-page-header.vue";
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
const sessionStatusTones: Readonly<Record<AgentInvocationStatus, StatusTone>> = {
  cancelled: "neutral",
  completed: "success",
  failed: "error",
  pending: "warning",
  running: "info",
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
// Usage and Skills come with Agents, so they are not offered on their own. A user limited to some sections may not see the others,
// so the Overview does not call them "not enabled".
const notEnabledPrimitives = computed(() =>
  installedNavigation.value?.scoped
    ? []
    : consolePrimitives.filter((entry) => entry.id !== "usage" && entry.id !== "skills" && !sections.value.includes(entry.id)),
);
const agentsEnabled = computed(() => sections.value.includes("agents"));
const sessionItems = computed(() =>
  recentSessions.items.value.slice(0, 5).map((item) => ({
    agentName: item.agentName,
    context: item.excerpt || item.context,
    tone: Object.hasOwn(sessionStatusTones, item.status) ? sessionStatusTones[item.status] : "neutral",
    id: item.id,
    status: Object.hasOwn(sessionStatusLabels, item.status) ? sessionStatusLabels[item.status] : item.status,
    time: recentTimestamp(item.updatedAt, sessionsLoadedAt.value),
  })),
);
// Plain words for the people who run the app, such as "This app uses Content and Comments."
const summary = computed(() => {
  const labels = availableSections.value.map(section => section.label);
  if (!labels.length) return "Nothing in this app has a Console page yet.";
  const shown = labels.length > 4 ? [...labels.slice(0, 3), `${labels.length - 3} more`] : labels;
  return `This app uses ${new Intl.ListFormat("en", { type: "conjunction" }).format(shown)}.`;
});
// Learn links the Console guide and the docs of the sections that the app uses. Sections that share a page link it once.
const sectionGuides = computed(() => {
  const seen = new Set<string>([consoleGuide.href]);
  return availableSections.value.flatMap((section) => {
    const primitive = consolePrimitives.find(entry => entry.id === section.id);
    if (!primitive || seen.has(primitive.docs)) return [];
    seen.add(primitive.docs);
    return [{ description: primitive.pitch, href: primitive.docs, icon: section.icon, label: `${section.label} docs` }];
  });
});

async function loadRecentSessions(): Promise<void> {
  sessionsLoadedAt.value = Date.now();
  await recentSessions.refresh();
}

// When the project refuses the call, the Console has nothing to show, so the Overview is one centered state.
const signedOut = computed(() => !loading.value && !availableSections.value.length && isConsoleSignInRequired(error.value));
const checking = ref(false);
const stillSignedOut = ref(false);

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

/** Asks the project again. Only a check that someone asked for reports "still refused". */
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

// People fix access in another tab, such as the key of the app, so the Console checks again when this tab is shown or
// focused again. A return while a request is in flight waits for its answer, because that request may have left first.
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

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="console-home">
      <template #header>
        <ConsolePageHeader title="Overview" :toggle="false" />
      </template>

      <template #body>
        <!-- The project refused the signed call, such as before it has the key of the link. -->
        <main
          v-if="signedOut"
          class="flex flex-1 flex-col items-center justify-center px-6 pb-24 pt-12 text-center"
          aria-labelledby="console-home-signed-out"
        >
          <span class="vitehub-console__overview-mark grid size-10 place-items-center rounded-full border border-default" aria-hidden="true">
            <ConsoleMark class="size-[1.125rem]" />
          </span>
          <h2 id="console-home-signed-out" class="mt-4 text-base font-semibold text-balance text-highlighted">The app refused this Console</h2>
          <p class="mt-1.5 max-w-sm text-sm text-pretty text-muted">
            The app does not accept the signature of this Console. Set the key of the link on the app, then check again.
          </p>
          <UButton
            class="mt-5"
            variant="outline"
            icon="i-lucide-refresh-cw"
            label="Check again"
            :loading="checking"
            @click="checkSession(true)"
          />
          <p class="mt-3 min-h-5 text-xs text-muted" role="status">{{ stillSignedOut ? "The app still refuses this Console." : "" }}</p>
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
                  <!-- The name comes with the sections, so a placeholder holds its line instead of a name that then changes. -->
                  <USkeleton v-if="loading" class="my-0.5 h-5 w-40" />
                  <template v-else>{{ installedNavigation?.projectName || "ViteHub Console" }}</template>
                </h1>
                <p class="text-sm text-muted">
                  {{ loading ? "Loading the enabled primitives…" : summary }}
                </p>
              </div>
            </header>

            <div v-if="loading" class="flex flex-col gap-10" aria-hidden="true">
              <div v-for="index in 3" :key="index" class="vitehub-console__overview-block">
                <USkeleton class="h-4 w-16 sm:mt-3" />
                <div class="grid gap-2 py-1.5">
                  <USkeleton v-for="row in 3" :key="row" class="h-7" />
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
                      icon="i-lucide-rocket"
                      label="Start with KV"
                      target="_blank"
                      to="https://vitehub.dev/docs/getting-started/first-server-primitive"
                    />
                    <UButton
                      :icon="consoleSectionDetails.agents.icon"
                      label="Build an Agent"
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
                    <USkeleton v-for="index in 3" :key="index" class="h-7" />
                  </li>
                  <li v-else-if="recentSessions.error.value" class="vitehub-console__overview-row">
                    <UIcon name="i-lucide-cloud-off" class="vitehub-console__overview-icon" />
                    <span class="vitehub-console__overview-description">Could not load recent sessions.</span>
                    <UButton class="ms-auto" variant="ghost" size="xs" label="Try again" @click="loadRecentSessions" />
                  </li>
                  <li v-else-if="!sessionItems.length" class="vitehub-console__overview-row">
                    <ConsoleSectionIcon :icon="consoleSectionDetails.agents.icon" class="vitehub-console__overview-icon" />
                    <span class="vitehub-console__overview-description">No Agent sessions yet. Invoke an Agent to see its sessions here.</span>
                  </li>
                  <template v-else>
                    <li v-for="session in sessionItems" :key="session.id">
                      <button
                        type="button"
                        class="vitehub-console__overview-row" data-focus-inset
                        :disabled="!session.agentName"
                        :aria-label="`Open ${session.agentName || 'Agent'} session ${session.context}, status ${session.status}${session.time ? `, ${session.time}` : ''}`"
                        @click="session.agentName && openSession(session.agentName, session.id)"
                      >
                        <span class="vitehub-console__overview-icon" aria-hidden="true">
                          <Status :tone="session.tone" />
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
                    <button type="button" class="vitehub-console__overview-row text-muted" data-focus-inset @click="openSection(consoleSectionDetails.agents.routeName)">
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
                      <ConsoleSectionIcon :icon="section.icon" class="vitehub-console__overview-icon" />
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
                          :title="`${section.label} documentation`"
                        >
                          <UIcon name="i-lucide-book-open" class="size-3.5" aria-hidden="true" />
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
                      class="vitehub-console__overview-row" data-focus-inset
                      data-optional
                      :href="entry.setup"
                      rel="noreferrer"
                      target="_blank"
                      :aria-label="`Set up ${entry.label}`"
                    >
                      <ConsoleSectionIcon :icon="entry.icon" class="vitehub-console__overview-icon" />
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
                  <li>
                    <a class="vitehub-console__overview-row" data-focus-inset :href="consoleGuide.href" rel="noreferrer" target="_blank">
                      <UIcon :name="consoleGuide.icon" class="vitehub-console__overview-icon" />
                      <span class="vitehub-console__overview-name">{{ consoleGuide.label }}</span>
                      <span class="vitehub-console__overview-description" :title="consoleGuide.description">{{ consoleGuide.description }}</span>
                      <span class="vitehub-console__overview-meta">
                        <UIcon name="i-lucide-arrow-up-right" class="size-3" />
                      </span>
                    </a>
                  </li>
                  <li v-for="guide in sectionGuides" :key="guide.href">
                    <a class="vitehub-console__overview-row" data-focus-inset :href="guide.href" rel="noreferrer" target="_blank">
                      <ConsoleSectionIcon :icon="guide.icon" class="vitehub-console__overview-icon" />
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

/* The row's button covers the row, so the focus ring of the theme frames the whole row. */
.vitehub-console__overview-cell-target {
  border-radius: inherit;
  cursor: pointer;
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
  align-items: center;
  border-radius: 0.375rem;
  display: inline-flex;
  justify-content: center;
  min-height: 1.5rem;
  min-width: 1.5rem;
  margin: -0.25rem -0.375rem;
  padding: 0.25rem 0.375rem;
  position: relative;
  text-underline-offset: 3px;
  transition: color 150ms ease, opacity 150ms ease;
  z-index: 1;
}

.vitehub-console__overview-docs:hover {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
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
@media (hover: hover) and (pointer: fine) {
  .vitehub-console__overview-docs {
    opacity: 0;
  }
  .vitehub-console__overview-row:hover .vitehub-console__overview-docs,
  .vitehub-console__overview-row:focus-within .vitehub-console__overview-docs {
    opacity: 1;
  }
}
@media (any-pointer: coarse) {
  .vitehub-console__overview-docs {
    min-height: 2.75rem;
    min-width: 2.75rem;
    opacity: 1;
  }
}
</style>
