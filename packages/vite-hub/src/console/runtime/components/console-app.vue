<script setup lang="ts">
import { AgentInvocation, AgentInvocationInspector, AgentInvocationList } from "@vite-hub/ui";
import { useAgentInvocation, useAgentInvocations } from "vite-hub/agent/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { DropdownMenuItem, SplitterItem } from "@nuxt/ui";
import type {
  AgentInvocationConfiguration,
  AgentInvocationListItem,
  AgentInvocationView,
} from "@vite-hub/ui";
import {
  decodeAgentRouteParam,
  encodeAgentRouteParam,
  resolveConsoleRouteName,
} from "../console-route";
import { requestConsole } from "../client/request";
import { relativeDuration } from "../client/time";
import { rememberConsoleSection } from "../sections";
import ConsoleBackButton from "./console-back-button.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSearch from "./console-search.vue";

const route = useRoute();
const router = useRouter();
const props = defineProps<{
  agentsBase: string;
  apiBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const initialAgentParam = decodeAgentRouteParam(route.params.agent);
const selectedInvocationId = ref<string>();
const selectedAgentName = ref(initialAgentParam?.trim() ? initialAgentParam : undefined);
const agentNames = ref<string[]>([]);
const agentsLoading = ref(true);
const agentsError = ref<unknown>();
const paginationRetryRevision = ref(0);
const lastSuccessfulPollAt = ref<Date>();
const nowMs = ref(Date.now());
const sessionsOpen = ref(false);
const sessionsCollapsed = ref(false);
const detailsOpen = ref(false);
const selectedActivityId = ref<string>();
const isDesktop = ref(false);
const pageVisible = ref(!import.meta.env.SSR && document.visibilityState !== "hidden");
let clock: ReturnType<typeof setInterval> | undefined;
let media: MediaQueryList | undefined;
let agentsRequest: AbortController | undefined;
const recordSuccessfulPoll = () => {
  lastSuccessfulPollAt.value = new Date();
};
const listPollInterval = computed(() => pageVisible.value ? 5_000 : false);
const detailPollInterval = computed(() =>
  pageVisible.value && selectedInvocationId.value ? 3_000 : false,
);

const list = useAgentInvocations({
  baseURL: props.apiBase,
  immediate: pageVisible.value,
  onSuccess: recordSuccessfulPoll,
  pollInterval: listPollInterval,
  request: requestConsole,
  requestSummaries: requestConsole,
  query: computed(() => selectedAgentName.value ? { agent: selectedAgentName.value } : {}),
});
const detail = useAgentInvocation(selectedInvocationId, {
  baseURL: props.apiBase,
  immediate: pageVisible.value,
  onSuccess: recordSuccessfulPoll,
  pollInterval: detailPollInterval,
  request: requestConsole,
});

const invocationItems = computed<AgentInvocationListItem[]>(() =>
  list.invocations.value.map((invocation) => ({
    agent: invocation.agentName,
    context: invocation.threadId || invocation.origin || invocation.channelId || invocation.id,
    description: invocation.error?.message,
    id: invocation.id,
    project: invocation.agentName || "Workspace",
    startedAt: invocation.startedAt,
    status: invocation.status,
    title: invocation.agentName || "Agent Invocation",
    updatedAt: invocation.updatedAt || invocation.startedAt || invocation.createdAt,
  })),
);
const invocationPaginationKey = computed(() =>
  `${paginationRetryRevision.value}:${list.cursor.value ?? ""}`,
);
const hasMultipleAgents = computed(() => agentNames.value.length > 1);
const selectedAgentLabel = computed(() =>
  selectedAgentName.value || (agentsLoading.value ? "Loading agents" : "Agents"),
);
const agentMenuItems = computed<DropdownMenuItem[]>(() =>
  agentNames.value.map((name) => ({
    icon: "i-lucide-bot",
    label: name,
    onSelect: () => selectAgent(name),
    trailingIcon: selectedAgentName.value === name ? "i-lucide-check" : undefined,
  })),
);
const routeInvocation = computed(() => {
  const value = route.params.invocation;
  return Array.isArray(value) ? value[0] : value;
});
const routeAgent = computed(() => {
  return decodeAgentRouteParam(route.params.agent);
});
const selectedSummary = computed(() =>
  list.invocations.value.find((invocation) => invocation.id === selectedInvocationId.value),
);
const invocationView = computed<AgentInvocationView | undefined>(() => {
  const invocation = detail.invocation.value;
  if (!invocation || invocation.id !== selectedInvocationId.value) return;
  if (selectedAgentName.value && invocation.agentName !== selectedAgentName.value) return;
  const persistedConfiguration = invocationConfiguration(record(invocation)?.configuration);
  const configuration = persistedConfiguration ?? observedConfiguration(detail.observations.value);
  const view: AgentInvocationView = {
    ...invocation,
    observations: detail.observations.value,
  };
  if (configuration) {
    const configured = detail.observations.value.findLast(
      (entry) => entry.name === "vitehub.agent.configured",
    );
    view.configuration = {
      ...configuration,
      truncated: configured?.attributes?.["vitehub.agent.configurationTruncated"] === true,
    };
  }
  return view;
});
const selectedTitle = computed(
  () => invocationView.value?.agentName || selectedSummary.value?.agentName || "Agent Invocation",
);
const splitterItems = computed<SplitterItem[]>(() =>
  detailsOpen.value
    ? [
        { id: "thread", slot: "thread", minSize: 52, defaultSize: 68, class: "min-w-0" },
        {
          id: "details",
          slot: "details",
          minSize: 24,
          maxSize: 44,
          defaultSize: 32,
          class: "min-w-0",
        },
      ]
    : [
        {
          id: "thread",
          slot: "thread",
          minSize: 100,
          maxSize: 100,
          defaultSize: 100,
          class: "min-w-0",
        },
      ],
);
const syncAgeMs = computed(() =>
  lastSuccessfulPollAt.value ? nowMs.value - lastSuccessfulPollAt.value.valueOf() : 0,
);
const syncStale = computed(() => Boolean(lastSuccessfulPollAt.value) && syncAgeMs.value >= 30_000);
const syncLabel = computed(() => {
  if (!lastSuccessfulPollAt.value) return "Connecting";
  if (!syncStale.value) return "Updated now";
  return `Stale · ${relativeDuration(syncAgeMs.value)}`;
});

function selectActivity(id: string) {
  selectedActivityId.value = undefined;
  if (!isDesktop.value) detailsOpen.value = false;
  void nextTick(() => { selectedActivityId.value = id; });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function invocationConfiguration(value: unknown): AgentInvocationConfiguration | undefined {
  const configuration = record(value);
  if (!configuration) return;
  // SAFETY: Persisted configuration is server-owned JSON and the console treats every field as optional.
  return configuration as AgentInvocationConfiguration;
}

function observedConfiguration(
  entries: AgentInvocationView["observations"],
): AgentInvocationConfiguration | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.name !== "vitehub.agent.configured") continue;
    const configuration = record(entry.attributes?.["vitehub.agent.configuration"]);
    if (configuration) return invocationConfiguration(configuration);
  }
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error
    ? error.message
    : error
      ? "The console could not load this data."
      : undefined;
}

async function selectInvocation(
  invocation: Pick<AgentInvocationListItem, "agent" | "id">,
): Promise<void> {
  const agentName = invocation.agent?.trim() || selectedAgentName.value;
  if (!agentName) return;
  sessionsOpen.value = false;
  selectedAgentName.value = agentName;
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
    params: { agent: encodeAgentRouteParam(agentName), invocation: invocation.id },
  });
}

async function selectAgent(name: string): Promise<void> {
  if (name === selectedAgentName.value) return;
  selectedAgentName.value = name;
  selectedInvocationId.value = undefined;
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
    params: { agent: encodeAgentRouteParam(name) },
  });
}

async function loadAgents(): Promise<void> {
  agentsRequest?.abort();
  const controller = new AbortController();
  agentsRequest = controller;
  agentsLoading.value = true;
  try {
    const value = record(await requestConsole(props.agentsBase, { signal: controller.signal }));
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The console API response is untrusted JSON, so validate every array entry before using it as an Agent identity.
    const names = Array.isArray(value?.agents)
      ? value.agents.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
      : [];
    if (agentsRequest === controller) {
      agentNames.value = [...new Set(names)];
      agentsError.value = undefined;
    }
  } catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return;
    if (agentsRequest === controller) agentsError.value = error;
  } finally {
    if (agentsRequest === controller) {
      agentsRequest = undefined;
      agentsLoading.value = false;
    }
  }
}

async function refresh(): Promise<void> {
  await Promise.all([
    loadAgents(),
    list.refresh(),
    selectedInvocationId.value ? detail.refresh() : Promise.resolve(),
  ]);
}

function retryPagination(): void {
  paginationRetryRevision.value++;
}

function updateDesktop(event?: MediaQueryListEvent): void {
  isDesktop.value = event?.matches ?? media?.matches ?? false;
}

function syncClock(): void {
  if (clock) clearInterval(clock);
  clock = undefined;
  if (!pageVisible.value) return;
  nowMs.value = Date.now();
  clock = setInterval(() => {
    nowMs.value = Date.now();
  }, 1_000);
}

function updatePageVisibility(): void {
  const wasVisible = pageVisible.value;
  pageVisible.value = document.visibilityState !== "hidden";
  syncClock();
  if (!wasVisible && pageVisible.value) void refresh();
}

watch(
  [routeInvocation, routeAgent, () => list.invocations.value[0]?.id, selectedAgentName],
  async ([requestedInvocation, requestedAgent, firstInvocation, agentName]) => {
    const agentRouteReady = !requestedAgent || requestedAgent === agentName;
    selectedInvocationId.value = requestedInvocation || (agentRouteReady ? firstInvocation : undefined);
    if (!requestedInvocation && firstInvocation && agentName && agentRouteReady) {
      await router.replace({
        name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
        params: { agent: encodeAgentRouteParam(agentName), invocation: firstInvocation },
      });
    }
  },
  { immediate: true },
);

watch(
  [routeAgent, agentNames],
  async ([requestedAgent, names]) => {
    if (!names.length) return;
    const agentName = requestedAgent && names.includes(requestedAgent)
      ? requestedAgent
      : names[0];
    selectedAgentName.value = agentName;
    if (requestedAgent !== agentName) {
      await router.replace({
        name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
        params: { agent: encodeAgentRouteParam(agentName) },
      });
    }
  },
  { immediate: true },
);

watch(
  [selectedAgentName, () => detail.invocation.value],
  async ([agentName, invocation]) => {
    if (
      !agentName ||
      !invocation ||
      invocation.id !== selectedInvocationId.value ||
      invocation.agentName === agentName
    ) return;
    selectedInvocationId.value = undefined;
    await router.replace({
      name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
      params: { agent: encodeAgentRouteParam(agentName) },
    });
  },
);

watch(selectedInvocationId, () => {
  selectedActivityId.value = undefined;
});

onMounted(() => {
  rememberConsoleSection("agents");
  media = window.matchMedia("(min-width: 1024px)");
  updateDesktop();
  media.addEventListener("change", updateDesktop);
  document.addEventListener("visibilitychange", updatePageVisibility);
  updatePageVisibility();
  if (pageVisible.value) void loadAgents();
});

onBeforeUnmount(() => {
  agentsRequest?.abort();
  if (clock) clearInterval(clock);
  media?.removeEventListener("change", updateDesktop);
  document.removeEventListener("visibilitychange", updatePageVisibility);
});
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="agent-sessions"
      v-model:open="sessionsOpen"
      v-model:collapsed="sessionsCollapsed"
      :default-size="21"
      :collapsed-size="4"
      :min-size="17"
      :max-size="28"
      :menu="{ title: 'Agent sessions', description: 'Browse persisted Agent Invocations.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'border-t border-default px-3 py-2' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <UDropdownMenu
          :items="agentMenuItems"
          :disabled="!hasMultipleAgents"
          :content="{ align: 'start', collisionPadding: 12 }"
          :ui="{ content: collapsed ? 'w-44' : 'w-(--reka-dropdown-menu-trigger-width)' }"
        >
          <button
            type="button"
            class="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 text-start outline-none data-[state=open]:bg-elevated focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default"
            :class="hasMultipleAgents ? 'hover:bg-elevated/70' : ''"
            :disabled="!hasMultipleAgents"
            :aria-label="hasMultipleAgents ? `Switch Agent. ${selectedAgentLabel} selected.` : selectedAgentLabel"
          >
            <ConsoleMark />
            <span v-if="!collapsed" class="grid min-w-0 flex-1 leading-none"
              ><small class="truncate text-[10px] font-bold uppercase tracking-[.12em] text-muted"
                >ViteHub Console</small
              ><strong class="mt-1 truncate text-sm font-semibold text-highlighted">{{
                selectedAgentLabel
              }}</strong></span
            >
            <UIcon
              v-if="!collapsed"
              name="i-lucide-chevrons-up-down"
              class="size-3.5 shrink-0 text-dimmed"
              :class="hasMultipleAgents ? 'opacity-100' : 'opacity-0'"
              aria-hidden="true"
            />
          </button>
        </UDropdownMenu>
      </template>

      <template #default="{ collapsed }">
        <div class="px-2 pt-2">
          <ConsoleBackButton :collapsed="collapsed" />
        </div>
        <div v-if="!collapsed" class="flex items-end justify-between px-4 pb-3 pt-5">
          <div>
            <span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted"
              >Agent activity</span
            >
            <h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Sessions</h1>
          </div>
          <span class="text-xs text-muted">{{ invocationItems.length }}</span>
        </div>
        <div v-if="!collapsed && errorMessage(agentsError)" class="px-3 pb-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Could not load agents"
            :description="errorMessage(agentsError)"
            :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: loadAgents }]"
          />
        </div>
        <div class="px-2 pb-3" :class="collapsed ? 'pt-2' : ''">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="w-full bg-transparent ring-default"
            label="Search console"
          />
        </div>
        <div
          v-if="!collapsed && errorMessage(list.error.value || list.loadMoreError.value)"
          class="px-3"
        >
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Could not load sessions"
            :description="errorMessage(list.error.value || list.loadMoreError.value)"
          />
          <UButton
            v-if="invocationItems.length && list.cursor.value && list.loadMoreError.value"
            class="mt-2"
            color="neutral"
            label="Retry loading older sessions"
            size="sm"
            variant="soft"
            :loading="list.isLoadingMore.value"
            @click="retryPagination"
          />
        </div>
        <div
          v-if="!collapsed && list.isLoading.value && !invocationItems.length"
          class="grid gap-2 px-3"
        >
          <USkeleton v-for="index in 4" :key="index" class="h-16 rounded-lg" />
        </div>
        <div v-if="collapsed" class="min-h-0 flex-1 overflow-y-auto">
          <div class="grid gap-1 px-2 py-1">
            <UTooltip
              v-for="invocation in invocationItems"
              :key="invocation.id"
              :text="invocation.title"
              :content="{ side: 'right' }"
              ><UButton
                icon="i-lucide-bot"
                color="neutral"
                :variant="selectedInvocationId === invocation.id ? 'soft' : 'ghost'"
                block
                :aria-label="invocation.title"
                @click="selectInvocation(invocation)"
            /></UTooltip>
          </div>
        </div>
        <AgentInvocationList
          v-else-if="
            (!list.isLoading.value || invocationItems.length) &&
            (!errorMessage(list.error.value) || invocationItems.length)
          "
          class="min-h-0 flex-1 px-1 pb-3"
          :continuation-key="list.cursor.value"
          :has-more="Boolean(list.cursor.value)"
          :items="invocationItems"
          :loading="list.isLoadingMore.value"
          :remaining-statuses="list.remainingStatuses.value"
          :now="nowMs"
          :retry-key="invocationPaginationKey"
          :selected-id="selectedInvocationId"
          @end-reached="list.loadMore()"
          @select="selectInvocation($event)"
        >
          <template #empty
            ><UEmpty
              class="px-4"
              icon="i-lucide-message-square-dashed"
              title="No sessions yet"
              description="The first Agent Invocation will appear here."
          /></template>
        </AgentInvocationList>
      </template>

      <template #footer="{ collapsed, collapse }">
        <template v-if="!collapsed"
          ><span class="flex items-center gap-1.5 text-xs text-muted"
            ><UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only</span
          ><span class="ml-auto text-xs" :class="syncStale ? 'text-warning' : 'text-muted'">{{
            syncLabel
          }}</span></template
        >
        <UTooltip text="Refresh sessions"
          ><UButton
            aria-label="Refresh sessions"
            color="neutral"
            icon="i-lucide-refresh-cw"
            size="xs"
            variant="ghost"
            :loading="list.isLoading.value || detail.isLoading.value"
            @click="refresh"
        /></UTooltip>
        <UButton
          class="max-lg:hidden"
          :class="collapsed ? '' : 'ml-1'"
          :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="collapsed ? 'Show sessions' : 'Hide sessions'"
          @click="collapse(!collapsed)"
        />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agent-names="agentNames"
      :agents-base="agentsBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="agent-session">
      <header
        v-if="!invocationView"
        data-slot="mobile-session-navigation"
        class="flex h-14 shrink-0 items-center border-b border-default px-4 lg:hidden"
      >
        <UButton
          aria-label="Open sessions"
          color="neutral"
          icon="i-lucide-panel-left"
          variant="ghost"
          @click="sessionsOpen = true"
        />
        <span class="ml-2 truncate text-sm font-semibold text-highlighted">{{ selectedAgentLabel }}</span>
      </header>
      <div class="min-h-0 flex-1" aria-live="polite">
        <div
          v-if="!selectedInvocationId"
          class="flex h-full items-center justify-center p-8 text-sm text-muted"
        >
          Select an Agent Invocation to inspect its work.
        </div>
        <UEmpty
          v-else-if="errorMessage(detail.error.value) && !invocationView"
          class="h-full"
          icon="i-lucide-cloud-off"
          title="Could not load this run"
          :description="errorMessage(detail.error.value)"
          :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: refresh }]"
        />
        <div
          v-else-if="detail.isLoading.value && !invocationView"
          class="flex h-full items-center justify-center"
        >
          <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" />
        </div>
        <div v-else-if="invocationView" class="flex h-full min-h-0 flex-col">
          <UAlert
            v-if="errorMessage(detail.error.value)"
            class="m-3 shrink-0"
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Could not refresh this run"
            :description="errorMessage(detail.error.value)"
            :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: refresh }]"
          />
          <USplitter
            v-if="isDesktop"
            id="agent-session-layout"
            :items="splitterItems"
            class="min-h-0 flex-1"
          >
            <template #thread
              ><AgentInvocation :invocation="invocationView" :selected-activity-id="selectedActivityId" class="h-full"
                ><template #title>{{ selectedTitle }}</template
                ><template #actions
                  ><UTooltip text="Session details"
                    ><UButton
                      icon="i-lucide-panel-right"
                      color="neutral"
                      :variant="detailsOpen ? 'soft' : 'ghost'"
                      size="sm"
                      aria-label="Session details"
                      :aria-pressed="detailsOpen"
                      @click="detailsOpen = !detailsOpen" /></UTooltip></template></AgentInvocation
            ></template>
            <template #details
              ><AgentInvocationInspector :invocation="invocationView" class="h-full" @select-activity="selectActivity"
                ><template #actions
                  ><UButton
                    icon="i-lucide-panel-right-close"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    aria-label="Close session details"
                    @click="detailsOpen = false" /></template></AgentInvocationInspector
            ></template>
          </USplitter>
          <AgentInvocation v-else :invocation="invocationView" :selected-activity-id="selectedActivityId" class="min-h-0 flex-1"
            ><template #title>{{ selectedTitle }}</template
            ><template #actions
              ><div class="flex items-center gap-1">
                <UButton
                  icon="i-lucide-panel-left"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  aria-label="Open sessions"
                  @click="sessionsOpen = true"
                /><UButton
                  icon="i-lucide-panel-right"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  aria-label="Session details"
                  @click="detailsOpen = true"
                /></div></template
          ></AgentInvocation>
          <USlideover
            v-if="!isDesktop"
            v-model:open="detailsOpen"
            side="right"
            title="Session details"
            :ui="{ content: 'w-full max-w-sm p-0' }"
            ><template #content
              ><AgentInvocationInspector :invocation="invocationView" class="h-full" @select-activity="selectActivity"
                ><template #actions
                  ><UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    aria-label="Close session details"
                    @click="detailsOpen = false" /></template></AgentInvocationInspector></template
          ></USlideover>
        </div>
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>

<style>
.vitehub-console [data-slot="invocation"],
.vitehub-console [data-slot="invocation-inspector"] {
  height: 100%;
  width: 100%;
}

.vitehub-console [data-slot="invocation-inspector"] {
  border-inline-start: 0;
}
</style>
