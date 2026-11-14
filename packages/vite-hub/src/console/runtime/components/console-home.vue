<script setup lang="ts">
import { Status, type StatusTone } from "@vite-hub/ui";
import { useCollection } from "vite-hub/source/client";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { AgentInvocationStatus } from "./invocation";
import type { ConsoleSectionId } from "../sections";
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import type { ConsoleNavigation } from "../client/sections";
import { consoleSectionDetails, groupConsoleSections } from "../sections";
import { isConsoleSignInRequired, requestConsole } from "../client/request";
import { consoleNavigationError, loadConsoleNavigation, resolveConsoleSectionDetails } from "../client/sections";
import { recentTimestamp } from "../client/format";
import { accountAppStatusLabels } from "../client/account";
import { useConsoleApp } from "../client/app-identity";
import { useConsoleProjects } from "../client/project-session";
import { consoleAddPrimitiveOpen } from "../client/sidebar";
import ConsoleMark from "./console-mark.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
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

const projects = useConsoleProjects();
const app = useConsoleApp();
const availableSections = computed(() =>
  sections.value.flatMap((section) => {
    const details = resolveConsoleSectionDetails(installedNavigation.value, section);
    return details ? [{ id: section, ...details }] : [];
  }),
);
// One card per section, in the order of the sidebar groups. A card shows a number only when the app reported one:
// today that is the open threads of Comments, from `project.get`.
const sectionCards = computed(() =>
  groupConsoleSections(availableSections.value).flat().map((section) => {
    const metric = section.id === "comments" && projects.info.value?.comments
      ? { value: projects.info.value.comments.open, unit: "open" }
      : undefined;
    return { ...section, metric };
  }),
);
const agentsEnabled = computed(() => sections.value.includes("agents"));
// The build that serves the app, from `project.get`. A development server has none.
const build = computed(() => projects.info.value?.build);
const siteUrl = computed(() => projects.current.value?.url ? `${projects.current.value.url.replace(/\/+$/, "")}/` : undefined);
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
/** The Add a primitive dialog of the sidebar. */
function openAddPrimitive(): void {
  consoleAddPrimitiveOpen.value = true;
}

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
        <ConsolePageHeader title="Overview" :toggle="false">
          <template v-if="siteUrl" #right>
            <UButton color="neutral" variant="outline" icon="i-lucide-external-link" label="Visit site" :to="siteUrl" target="_blank" rel="noreferrer" />
          </template>
        </ConsolePageHeader>
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
        <main v-else class="vitehub-console-page">
          <ConsoleState
            v-if="!loading && error && !availableSections.length"
            icon="i-lucide-cloud-off"
            title="Could not load sections"
            :error="error"
            :retry="loadSections"
          />
          <div v-else class="vitehub-overview">
            <div class="grid min-w-0 content-start gap-8">
              <!-- The skeleton has the shape of the cards, so the page does not jump when they load. -->
              <div v-if="loading" class="vitehub-overview__cards" aria-hidden="true">
                <USkeleton v-for="index in 4" :key="index" class="h-[5.5rem] rounded-lg" />
              </div>
              <section v-else-if="!availableSections.length" class="grid justify-items-start gap-1 rounded-lg border border-default p-4" aria-labelledby="console-home-start">
                <h2 id="console-home-start" class="text-sm font-medium text-highlighted">Add your first primitive</h2>
                <p class="max-w-md text-sm text-pretty text-muted">No primitive in this app has a Console page yet.</p>
                <UButton class="mt-3" icon="i-lucide-plus" label="Add a primitive" @click="openAddPrimitive" />
              </section>
              <section v-else aria-label="Primitives" class="vitehub-overview__cards">
                <RouterLink
                  v-for="section in sectionCards"
                  :key="section.id"
                  :to="{ name: resolveConsoleRouteName(route.name, section.routeName) }"
                  class="vitehub-overview__card"
                >
                  <span class="flex items-center gap-2 text-[13px] font-medium text-highlighted">
                    <ConsoleSectionIcon :icon="section.icon" class="size-4 text-muted" />
                    {{ section.label }}
                  </span>
                  <span v-if="section.metric" class="mt-2 text-xl font-semibold tabular-nums text-highlighted">
                    {{ section.metric.value }}<small class="ms-1 text-[13px] font-normal text-muted">{{ section.metric.unit }}</small>
                  </span>
                  <span class="mt-1 line-clamp-2 text-xs text-pretty text-muted">{{ section.description }}</span>
                </RouterLink>
              </section>

              <section class="grid gap-2" aria-labelledby="console-home-activity">
                <h2 id="console-home-activity" class="text-sm font-semibold text-highlighted">Recent activity</h2>
                <ul class="vitehub-console__overview-list">
                  <li v-if="loading || (agentsEnabled && recentSessions.pending.value && !sessionItems.length)" class="grid gap-2 px-2 py-1.5" aria-hidden="true">
                    <USkeleton v-for="index in 3" :key="index" class="h-7" />
                  </li>
                  <template v-else>
                    <li v-if="build" class="vitehub-console__overview-row">
                      <UIcon name="i-lucide-rocket" class="vitehub-console__overview-icon" />
                      <span class="flex min-w-0 flex-1 items-center gap-1.5">
                        <span class="shrink-0 font-medium text-highlighted">{{ build.commit?.author ?? "Someone" }}</span>
                        <span class="shrink-0 text-muted">deployed</span>
                        <span v-if="build.commit" class="shrink-0 font-mono text-xs text-muted">{{ build.commit.sha.slice(0, 7) }}</span>
                        <span v-if="build.commit?.message" class="truncate text-default">{{ build.commit.message }}</span>
                      </span>
                      <span class="vitehub-console__overview-meta"><ConsoleRelativeTime :value="build.time" /></span>
                    </li>
                    <li v-if="agentsEnabled && recentSessions.error.value" class="vitehub-console__overview-row">
                      <UIcon name="i-lucide-cloud-off" class="vitehub-console__overview-icon" />
                      <span class="vitehub-console__overview-description">Could not load recent sessions.</span>
                      <UButton class="ms-auto" variant="ghost" size="xs" label="Try again" @click="loadRecentSessions" />
                    </li>
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
                    <li v-if="!build && !sessionItems.length && !recentSessions.error.value" class="vitehub-console__overview-row text-muted">
                      <UIcon name="i-lucide-activity" class="vitehub-console__overview-icon" />
                      <span class="vitehub-console__overview-description">No activity yet. Deploys and Agent sessions show here.</span>
                    </li>
                    <li v-if="sessionItems.length">
                      <button type="button" class="vitehub-console__overview-row text-muted" data-focus-inset @click="openSection(consoleSectionDetails.agents.routeName)">
                        <UIcon name="i-lucide-arrow-right" class="vitehub-console__overview-icon" />
                        <span>View all sessions</span>
                      </button>
                    </li>
                  </template>
                </ul>
              </section>
            </div>

            <!-- The details of the app. Each row shows only what the app reported. -->
            <aside class="vitehub-overview__details" aria-label="App details">
              <ul>
                <li v-if="app.host" class="vitehub-overview__detail">
                  <UIcon name="i-lucide-globe" class="vitehub-overview__detail-icon" />
                  <span class="min-w-0 flex-1 truncate"><a :href="siteUrl" target="_blank" rel="noreferrer" class="hover:underline">{{ app.host }}</a></span>
                  <span class="vitehub-overview__detail-key">Domain</span>
                </li>
                <li v-if="!loading" class="vitehub-overview__detail">
                  <span class="vitehub-overview__detail-icon"><Status :tone="error ? 'warning' : 'success'" /></span>
                  <span class="min-w-0 flex-1 truncate">{{ accountAppStatusLabels[error ? "unreachable" : "connected"] }}</span>
                  <span class="vitehub-overview__detail-key">Status</span>
                </li>
                <li v-if="projects.info.value?.vitehub" class="vitehub-overview__detail">
                  <span class="vitehub-overview__detail-icon"><ConsoleMark class="size-3.5 text-highlighted" /></span>
                  <span class="flex min-w-0 flex-1 items-center gap-1.5"><span>vite-hub</span><span class="truncate font-mono text-xs">{{ projects.info.value.vitehub }}</span></span>
                  <span class="vitehub-overview__detail-key">ViteHub</span>
                </li>
                <li v-if="build?.commit" class="vitehub-overview__detail">
                  <UIcon name="i-lucide-git-branch" class="vitehub-overview__detail-icon" />
                  <span class="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs">
                    <span v-if="build.commit.branch" class="truncate">{{ build.commit.branch }}</span>
                    <span class="shrink-0 text-muted">{{ build.commit.sha.slice(0, 7) }}</span>
                  </span>
                  <span class="vitehub-overview__detail-key">Source</span>
                </li>
                <li v-if="build" class="vitehub-overview__detail">
                  <UIcon name="i-lucide-rocket" class="vitehub-overview__detail-icon" />
                  <span class="flex min-w-0 flex-1 items-center gap-1">
                    <ConsoleRelativeTime :value="build.time" class="shrink-0" />
                    <span v-if="build.commit?.author" class="truncate text-muted">by {{ build.commit.author }}</span>
                  </span>
                  <span class="vitehub-overview__detail-key">Deployed</span>
                </li>
              </ul>
              <button type="button" class="vitehub-overview__detail vitehub-overview__add" @click="openAddPrimitive">
                <UIcon name="i-lucide-plus" class="vitehub-overview__detail-icon" />
                <span class="flex-1 text-start">Add a primitive</span>
                <UIcon name="i-lucide-chevron-right" class="size-3.5" />
              </button>
            </aside>
          </div>
        </main>
      </template>
    </UDashboardPanel>
</template>

<style>
/* The Overview: primitive cards and recent activity on the left, the details of the app on the right. */
.vitehub-overview {
  align-items: start;
  display: grid;
  gap: 1.5rem;
}

@media (min-width: 64rem) {
  .vitehub-overview {
    grid-template-columns: minmax(0, 1fr) 20rem;
  }
}

.vitehub-overview__cards {
  display: grid;
  gap: 0.625rem;
  grid-template-columns: repeat(auto-fill, minmax(13.75rem, 1fr));
}

.vitehub-overview__card {
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0.75rem 0.875rem;
  transition: background-color 150ms ease, border-color 150ms ease;
}

.vitehub-overview__card:hover {
  background: var(--ui-bg-elevated);
  border-color: var(--ui-border-accented);
}

.vitehub-overview__details {
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  overflow: hidden;
  padding-top: 0.25rem;
}

.vitehub-overview__detail {
  align-items: center;
  display: flex;
  gap: 0.625rem;
  min-height: 2.25rem;
  padding-inline: 0.875rem;
  width: 100%;
}

.vitehub-overview__detail-icon {
  align-items: center;
  color: var(--ui-text-muted);
  display: inline-flex;
  flex: none;
  height: 1rem;
  justify-content: center;
  width: 1rem;
}

.vitehub-overview__detail-key {
  color: var(--ui-text-dimmed);
  flex: none;
  font-size: 0.75rem;
}

.vitehub-overview__add {
  border-top: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  cursor: pointer;
  margin-top: 0.25rem;
  transition: background-color 150ms ease, color 150ms ease;
}

.vitehub-overview__add:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

.vitehub-console__overview-mark {
  color: var(--ui-text-highlighted);
}

/* Rows reach past the text edge, so the hover tint has room and the icons still line up with the heading. */
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
  font-size: 0.8125rem;
  gap: 0.75rem;
  line-height: 1.25rem;
  min-height: 2.25rem;
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
  .vitehub-console__overview-row:is(button, a):not(:disabled):hover {
    background: var(--ui-bg-elevated);
  }
}

.vitehub-console__overview-icon {
  align-items: center;
  color: var(--ui-text-muted);
  display: inline-flex;
  flex: none;
  height: 1rem;
  justify-content: center;
  pointer-events: none;
  width: 1rem;
}

.vitehub-console__overview-name {
  color: var(--ui-text-highlighted);
  flex: none;
  font-weight: 500;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  align-items: center;
  color: var(--ui-text-muted);
  display: inline-flex;
  flex: none;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  gap: 0.75rem;
  margin-inline-start: auto;
  white-space: nowrap;
}

/* On a phone the name and meta fit; a description after a name would truncate to a few letters. */
@media (max-width: 40rem) {
  .vitehub-console__overview-name + .vitehub-console__overview-description {
    display: none;
  }
}
</style>
