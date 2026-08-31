<script setup lang="ts">
import {
  AgentInvocation,
  AgentInvocationList,
  agentInvocationContext,
  agentInvocationExternalUrl,
  agentInvocationProject,
  agentInvocationTitle,
} from "@vite-hub/ui";
import { useAgentInvocation, useAgentInvocations } from "vite-hub/agent/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isConsoleHealth } from "./console-health-model";

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
import { rememberConsoleSection } from "../sections";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleHealth from "./console-health.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSessionLoading from "./console-session-loading.vue";
import ConsoleSessionNavbar from "./console-session-navbar.vue";
import ConsoleSessionInspector from "./console-session-inspector.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleUsage from "./console-usage.vue";
import "./console-session.css";

const route = useRoute();
const router = useRouter();
const props = defineProps<{
  agentsBase: string;
  apiBase: string;
  definitionsBase: string;
  kvBase: string;
  hostBase: string;
  searchBase: string;
  sectionsBase: string;
  usageBase: string;
}>();
const initialAgentParam = decodeAgentRouteParam(route.params.agent);
const selectedInvocationId = ref<string>();
const selectedAgentName = ref(initialAgentParam?.trim() ? initialAgentParam : undefined);
const agentNames = ref<string[]>([]);
const agentsLoading = ref(true);
const agentsError = ref<unknown>();
const nowMs = ref(Date.now());
const sessionsOpen = ref(false);
const sessionsCollapsed = ref(false);
const detailsOpen = ref(false);
const detailsMaximized = ref(false);
const inspectorTab = ref<"details" | "trace" | "workspace">("details");
const inspectorActiveSurface = ref("view:details");
const inspectorOpenViews = ref<Array<"details" | "trace" | "workspace">>(["details"]);
const inspectorOpenPaths = ref<string[]>([]);
const inspectorSelectedPath = ref<string>();
const inspectorWorkspaceIdentity = ref<string>();
const activePage = ref<"health" | "sessions">("sessions");
const healthAvailable = ref(false);
const selectedActivityId = ref<string>();
const isDesktop = ref(false);
const pageVisible = ref(!import.meta.env.SSR && document.visibilityState !== "hidden");
const refreshing = ref(false);
let clock: ReturnType<typeof setInterval> | undefined;
let media: MediaQueryList | undefined;
let agentsRequest: AbortController | undefined;
let capabilitiesRequest: AbortController | undefined;
let refreshCount = 0;
let initialListPending = !selectedAgentName.value;
const sessionPollingEnabled = computed(
  () =>
    pageVisible.value &&
    activePage.value === "sessions" &&
    route.name !== resolveConsoleRouteName(route.name, "vitehub-console-usage"),
);
const listPollInterval = computed(() => (sessionPollingEnabled.value ? 5_000 : false));

const list = useAgentInvocations({
  baseURL: props.apiBase,
  immediate: pageVisible.value && !initialListPending,
  pollInterval: listPollInterval,
  request: requestConsole,
  requestSummaries: requestConsole,
  query: computed(() => ({
    ...(selectedAgentName.value ? { agent: selectedAgentName.value } : {}),
    limit: 10,
  })),
});
const selectedSummary = computed(() =>
  list.invocations.value.find((invocation) => invocation.id === selectedInvocationId.value),
);
const selectedDetailStatus = ref<{
  id: string;
  status: AgentInvocationListItem["status"];
}>();
const initialSessionLoading = computed(() =>
  !selectedInvocationId.value && (agentsLoading.value || list.isLoading.value),
);
const detailPollInterval = computed(() => {
  if (!sessionPollingEnabled.value || !selectedInvocationId.value) return false;
  const status =
    selectedSummary.value?.status ??
    (selectedDetailStatus.value?.id === selectedInvocationId.value
      ? selectedDetailStatus.value.status
      : undefined);
  return status === "completed" || status === "failed" || status === "cancelled" ? false : 3_000;
});
const detail = useAgentInvocation(selectedInvocationId, {
  baseURL: props.apiBase,
  immediate: pageVisible.value,
  pollInterval: detailPollInterval,
  request: requestConsole,
});

const invocationItems = computed<AgentInvocationListItem[]>(() =>
  list.invocations.value.map((invocation) => ({
    agent: invocation.agentName,
    context: agentInvocationContext(invocation),
    description: invocation.error?.message,
    id: invocation.id,
    project: agentInvocationProject(invocation),
    provider:
      stringValue(invocation.annotations?.["agent.model.provider"]) ||
      (invocation.id === selectedInvocationId.value
        ? invocationView.value?.configuration?.driver?.model?.provider ||
          invocationView.value?.configuration?.driver?.provider
        : undefined),
    startedAt: invocation.startedAt,
    status: invocation.status,
    title: agentInvocationTitle(invocation),
    updatedAt: invocation.updatedAt || invocation.startedAt || invocation.createdAt,
  })),
);
const hasMultipleAgents = computed(() => agentNames.value.length > 1);
const selectedAgentLabel = computed(
  () => selectedAgentName.value || (agentsLoading.value ? "Loading agents" : "Agents"),
);
const agentMenuItems = computed<DropdownMenuItem[]>(() =>
  agentNames.value.map((name) => ({
    icon: "i-ph-robot-light",
    label: name,
    onSelect: () => selectAgent(name),
    trailingIcon: selectedAgentName.value === name ? "i-ph-check-light" : undefined,
  })),
);
const routeInvocation = computed(() => {
  const value = route.params.invocation;
  return Array.isArray(value) ? value[0] : value;
});
const routeAgent = computed(() => {
  return decodeAgentRouteParam(route.params.agent);
});
const isUsageRoute = computed(
  () => route.name === resolveConsoleRouteName(route.name, "vitehub-console-usage"),
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
const selectedDisplay = computed(() => invocationView.value ?? selectedSummary.value);
const selectedTitle = computed(() =>
  selectedDisplay.value
    ? agentInvocationTitle(selectedDisplay.value)
    : selectedAgentName.value || "ViteHub Console",
);
const selectedProject = computed(() =>
  selectedDisplay.value
    ? agentInvocationProject(selectedDisplay.value)
    : selectedAgentName.value || "Agents",
);
const selectedExternalUrl = computed(() =>
  selectedDisplay.value ? agentInvocationExternalUrl(selectedDisplay.value) : undefined,
);
const splitterItems: SplitterItem[] = [
  {
    id: "thread",
    slot: "thread",
    minSize: 220,
    defaultSize: 680,
    sizeUnit: "px",
    class: "h-full min-h-0 min-w-0 overflow-hidden",
  },
  {
    id: "details",
    slot: "details",
    minSize: 300,
    maxSize: 1080,
    defaultSize: 560,
    sizeUnit: "px",
    class: "h-full min-h-0 min-w-0 overflow-hidden",
  },
];

function selectActivity(id: string): void {
  selectedActivityId.value = undefined;
  if (!isDesktop.value) detailsOpen.value = false;
  void nextTick(() => {
    selectedActivityId.value = id;
  });
}

function closeDetails(): void {
  detailsOpen.value = false;
  detailsMaximized.value = false;
}

async function showHealth(): Promise<void> {
  if (isUsageRoute.value) {
    await router.push(
      selectedAgentName.value
        ? {
            name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
            params: { agent: encodeAgentRouteParam(selectedAgentName.value) },
          }
        : { name: resolveConsoleRouteName(route.name, "vitehub-console-agents") },
    );
  }
  activePage.value = "health";
  closeDetails();
  sessionsOpen.value = false;
}

function showSessions(): void {
  activePage.value = "sessions";
}

async function detectHostCapabilities(): Promise<void> {
  capabilitiesRequest?.abort();
  const controller = new AbortController();
  capabilitiesRequest = controller;
  try {
    const response = await fetch(`${props.hostBase}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    const available = response.ok && isConsoleHealth(await response.json());
    if (capabilitiesRequest === controller) healthAvailable.value = available;
  } catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return;
    if (capabilitiesRequest === controller) healthAvailable.value = false;
  } finally {
    if (capabilitiesRequest === controller) capabilitiesRequest = undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Host responses are untrusted JSON, so validate strings at the capability boundary.
  return typeof value === "string" ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Host responses are untrusted JSON, so validate finite numbers at the capability boundary.
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  showSessions();
  sessionsOpen.value = false;
  selectedAgentName.value = agentName;
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
    params: { agent: encodeAgentRouteParam(agentName), invocation: invocation.id },
  });
}

async function selectAgent(name: string): Promise<void> {
  if (name === selectedAgentName.value) return;
  showSessions();
  selectedAgentName.value = name;
  selectedInvocationId.value = undefined;
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
    params: { agent: encodeAgentRouteParam(name) },
  });
}

async function toggleUsage(): Promise<void> {
  showSessions();
  sessionsOpen.value = false;
  if (isUsageRoute.value) {
    await router.push(
      selectedAgentName.value
        ? {
            name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
            params: { agent: encodeAgentRouteParam(selectedAgentName.value) },
          }
        : { name: resolveConsoleRouteName(route.name, "vitehub-console-agents") },
    );
    return;
  }
  await router.push({ name: resolveConsoleRouteName(route.name, "vitehub-console-usage") });
}
async function loadAgents(): Promise<void> {
  agentsRequest?.abort();
  const controller = new AbortController();
  agentsRequest = controller;
  agentsLoading.value = true;
  try {
    const value = record(await requestConsole(props.agentsBase, { signal: controller.signal }));
    const names = Array.isArray(value?.agents)
      ? value.agents.filter((name): name is string => {
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The console API response is untrusted JSON, so validate every array entry before using it as an Agent identity.
          return typeof name === "string" && Boolean(name.trim());
        })
      : [];
    if (agentsRequest === controller) {
      if (names.length && !isUsageRoute.value) initialListPending = false;
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
      if (initialListPending && !selectedAgentName.value) {
        initialListPending = false;
        if (pageVisible.value) void list.refresh();
      }
    }
  }
}

async function refresh(): Promise<void> {
  refreshCount++;
  refreshing.value = true;
  try {
    const agents = loadAgents();
    const invocations = initialListPending && !selectedAgentName.value
      ? agents.then(() => undefined)
      : list.refresh();
    await Promise.all([
      detectHostCapabilities(),
      agents,
      invocations,
      selectedInvocationId.value ? detail.refresh() : Promise.resolve(),
    ]);
  } finally {
    refreshCount--;
    refreshing.value = refreshCount > 0;
  }
}

function inspectSession(target: "agent" | "workspace"): void {
  const view = target === "agent" ? "details" : "workspace";
  inspectorTab.value = view;
  if (!inspectorOpenViews.value.includes(view)) {
    inspectorOpenViews.value = [...inspectorOpenViews.value, view];
  }
  inspectorActiveSurface.value = `view:${view}`;
  detailsOpen.value = true;
}

function statusIcon(status: AgentInvocationListItem["status"]): string {
  if (status === "running") return "i-ph-circle-notch-light";
  if (status === "completed") return "i-ph-check-light";
  if (status === "failed") return "i-ph-x-light";
  if (status === "cancelled") return "i-ph-prohibit-light";
  return "i-ph-clock-light";
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
  [
    routeInvocation,
    routeAgent,
    () => list.invocations.value[0]?.id,
    selectedAgentName,
    isUsageRoute,
  ],
  async (
    [requestedInvocation, requestedAgent, firstInvocation, agentName, usageRoute],
    previous,
  ) => {
    if (usageRoute) {
      selectedInvocationId.value = undefined;
      return;
    }
    const routeChanged =
      !previous || requestedInvocation !== previous[0] || requestedAgent !== previous[1];
    if ((requestedInvocation || requestedAgent) && routeChanged) showSessions();
    const agentRouteReady = !requestedAgent || requestedAgent === agentName;
    selectedInvocationId.value =
      requestedInvocation || (agentRouteReady ? firstInvocation : undefined);
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
  [routeAgent, agentNames, isUsageRoute],
  async ([requestedAgent, names, usageRoute]) => {
    if (usageRoute) return;
    if (!names.length) return;
    const agentName = requestedAgent && names.includes(requestedAgent) ? requestedAgent : names[0];
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
  [selectedAgentName, () => detail.invocation.value, isUsageRoute],
  async ([agentName, invocation, usageRoute]) => {
    if (
      usageRoute ||
      !agentName ||
      !invocation ||
      invocation.id !== selectedInvocationId.value ||
      invocation.agentName === agentName
    )
      return;
    selectedInvocationId.value = undefined;
    await router.replace({
      name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
      params: { agent: encodeAgentRouteParam(agentName) },
    });
  },
);

watch(selectedInvocationId, () => {
  selectedActivityId.value = undefined;
  selectedDetailStatus.value = undefined;
  const identity = selectedInvocationId.value
    ? `${props.hostBase}/api/invocations/${selectedInvocationId.value}`
    : undefined;
  if (identity !== inspectorWorkspaceIdentity.value) {
    inspectorWorkspaceIdentity.value = identity;
    inspectorSelectedPath.value = undefined;
    inspectorOpenPaths.value = [];
  }
});

watch(
  [() => detail.invocation.value?.id, () => detail.invocation.value?.status],
  ([id, status]) => {
    selectedDetailStatus.value = id && status ? { id, status } : undefined;
  },
);

watch(
  isUsageRoute,
  (usageRoute) => {
    rememberConsoleSection(usageRoute ? "usage" : "agents");
  },
  { immediate: true },
);

onMounted(() => {
  media = window.matchMedia("(min-width: 1024px)");
  updateDesktop();
  media.addEventListener("change", updateDesktop);
  document.addEventListener("visibilitychange", updatePageVisibility);
  updatePageVisibility();
  if (pageVisible.value) void loadAgents();
  void detectHostCapabilities();
});

onBeforeUnmount(() => {
  agentsRequest?.abort();
  capabilitiesRequest?.abort();
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
      :default-size="20"
      :collapsed-size="4"
      :min-size="16"
      :max-size="26"
      :menu="{ title: 'Agent sessions', description: 'Browse read-only Agent Invocations.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'px-2 py-1' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>

      <template #default="{ collapsed }">
        <div class="px-2 pb-2 pt-1">
          <UDropdownMenu
            :items="agentMenuItems"
            :disabled="!hasMultipleAgents"
            :content="{ align: 'start', collisionPadding: 12 }"
            :ui="{ content: collapsed ? 'w-44' : 'w-(--reka-dropdown-menu-trigger-width)' }"
          >
            <UButton
              block
              class="justify-start"
              color="neutral"
              icon="i-ph-robot-light"
              :label="collapsed ? undefined : selectedAgentLabel"
              :trailing-icon="
                !collapsed && hasMultipleAgents ? 'i-ph-caret-up-down-light' : undefined
              "
              variant="ghost"
              :aria-label="
                hasMultipleAgents
                  ? `Switch Agent. ${selectedAgentLabel} selected.`
                  : selectedAgentLabel
              "
            />
          </UDropdownMenu>
        </div>
        <div v-if="!collapsed && errorMessage(agentsError)" class="px-3 pb-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-ph-cloud-slash-light"
            title="Could not load agents"
            :description="errorMessage(agentsError)"
            :actions="[
              { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadAgents },
            ]"
          />
        </div>
        <div class="flex shrink-0 items-center gap-1 px-2 pb-2 pt-1">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="min-w-0 flex-1 bg-transparent ring-0 hover:bg-elevated/60"
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
            icon="i-ph-cloud-slash-light"
            title="Could not load sessions"
            :description="errorMessage(list.error.value || list.loadMoreError.value)"
            :actions="
              list.error.value
                ? [{ label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: list.refresh }]
                : undefined
            "
          />
          <UButton
            v-if="invocationItems.length && list.cursor.value && list.loadMoreError.value"
            class="mt-2"
            color="neutral"
            label="Retry loading older sessions"
            size="sm"
            variant="soft"
            :loading="list.isLoadingMore.value"
            @click="list.loadMore"
          />
        </div>
        <div
          v-if="
            !collapsed && (agentsLoading || list.isLoading.value) && !invocationItems.length
          "
          class="grid gap-2 px-3"
          aria-label="Loading sessions"
          role="status"
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
                :icon="statusIcon(invocation.status)"
                :color="invocation.status === 'failed' ? 'error' : 'neutral'"
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
          :loading="list.isLoading.value || list.isLoadingMore.value"
          :remaining-statuses="list.remainingStatuses.value"
          :now="nowMs"
          :selected-id="selectedInvocationId"
          @select="selectInvocation($event)"
        >
          <template #loading />
          <template #footer>
            <div v-if="list.cursor.value" class="flex justify-center px-2 py-3">
              <UButton
                color="neutral"
                label="Load older sessions"
                size="xs"
                variant="soft"
                :loading="list.isLoadingMore.value"
                @click="list.loadMore()"
              />
            </div>
          </template>
          <template #empty
            ><UEmpty
              class="px-4"
              icon="i-ph-chat-dots-light"
              title="No sessions yet"
              description="The first Agent Invocation will appear here."
          /></template>
        </AgentInvocationList>
      </template>

      <template #footer="{ collapsed, collapse }">
        <div class="flex min-w-0 items-center gap-1" :class="collapsed ? 'justify-center' : ''">
          <ConsolePrimitiveSwitcher
            :active="isUsageRoute ? 'usage' : 'agents'"
            :collapsed="collapsed"
            :exclude="['usage']"
            :sections-base="sectionsBase"
          />
          <UTooltip
            v-if="healthAvailable || activePage === 'health'"
            :text="activePage === 'health' ? 'Back to sessions' : 'Health'"
          >
            <UButton
              :icon="activePage === 'health' ? 'i-lucide-arrow-left' : 'i-lucide-heart-pulse'"
              color="neutral"
              :variant="activePage === 'health' ? 'soft' : 'ghost'"
              size="xs"
              :aria-label="activePage === 'health' ? 'Back to sessions' : 'Health'"
              @click="activePage === 'health' ? showSessions() : void showHealth()"
            />
          </UTooltip>
          <UTooltip :text="isUsageRoute ? 'Back to sessions' : 'Usage'">
            <UButton
              :block="!collapsed"
              :class="collapsed ? '' : 'min-w-0 flex-1 justify-start'"
              :icon="isUsageRoute ? 'i-lucide-arrow-left' : 'i-lucide-chart-no-axes-column'"
              :label="collapsed ? undefined : isUsageRoute ? 'Sessions' : 'Usage'"
              color="neutral"
              :variant="isUsageRoute ? 'soft' : 'ghost'"
              size="xs"
              :aria-label="isUsageRoute ? 'Back to sessions' : 'Usage'"
              @click="toggleUsage"
            />
          </UTooltip>
          <UTooltip :text="collapsed ? 'Show sessions' : 'Hide sessions'">
            <UButton
              class="ml-auto max-lg:hidden"
              icon="i-ph-sidebar-simple-light"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="collapsed ? 'Show sessions' : 'Hide sessions'"
              @click="collapse(!collapsed)"
            />
          </UTooltip>
        </div>
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agent-names="agentNames"
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
      @select-session="showSessions"
      @select-page="showSessions"
    />

    <ConsoleUsage v-if="isUsageRoute" :base="usageBase" @open-sessions="sessionsOpen = true" />

    <UDashboardPanel
      v-else-if="activePage === 'health'"
      id="agent-health"
      :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }"
    >
      <template #body><ConsoleHealth :endpoint="`${hostBase}/api/health`" /></template>
    </UDashboardPanel>

    <UDashboardPanel v-else id="agent-session" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <template #body>
        <div class="h-full min-h-0 overflow-hidden" aria-live="polite">
          <ConsoleSessionInspector
            v-if="invocationView && isDesktop && detailsOpen && detailsMaximized"
            :invocation="invocationView"
            :maximized="true"
            :workspace-base="`${hostBase}/api/invocations`"
            v-model:tab="inspectorTab"
            v-model:active-surface="inspectorActiveSurface"
            v-model:open-views="inspectorOpenViews"
            v-model:open-paths="inspectorOpenPaths"
            v-model:selected-path="inspectorSelectedPath"
            class="h-full"
            @close="closeDetails"
            @focus-activity="selectActivity"
            @toggle-maximized="detailsMaximized = false"
          />
          <USplitter
            v-else-if="invocationView && isDesktop && detailsOpen"
            id="agent-session-layout"
            auto-save-id="vitehub-agent-session-layout"
            :items="splitterItems"
            class="h-full min-h-0 overflow-hidden"
          >
            <template #thread>
              <div class="flex h-full min-h-0 flex-col overflow-hidden">
                <ConsoleSessionNavbar
                  :details-open="detailsOpen"
                  :external-url="selectedExternalUrl"
                  :has-display="Boolean(selectedDisplay)"
                  :has-selection="Boolean(selectedInvocationId)"
                  :loading="refreshing"
                  :project="selectedProject"
                  :title="selectedTitle"
                  @open-sessions="sessionsOpen = true"
                  @refresh="refresh"
                  @toggle-details="detailsOpen = !detailsOpen"
                />
                <UAlert
                  v-if="errorMessage(detail.error.value)"
                  class="m-3 shrink-0"
                  color="error"
                  variant="subtle"
                  icon="i-ph-cloud-slash-light"
                  title="Could not refresh this session"
                  :description="errorMessage(detail.error.value)"
                  :actions="[
                    { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: refresh },
                  ]"
                />
                <AgentInvocation
                  :header="false"
                  :invocation="invocationView"
                  :selected-activity-id="selectedActivityId"
                  class="min-h-0 flex-1"
                  @inspect="inspectSession"
                />
              </div>
            </template>
            <template #details>
              <ConsoleSessionInspector
                :invocation="invocationView"
                :workspace-base="`${hostBase}/api/invocations`"
                v-model:tab="inspectorTab"
                v-model:active-surface="inspectorActiveSurface"
                v-model:open-views="inspectorOpenViews"
                v-model:open-paths="inspectorOpenPaths"
                v-model:selected-path="inspectorSelectedPath"
                class="h-full"
                @close="closeDetails"
                @focus-activity="selectActivity"
                @toggle-maximized="detailsMaximized = true"
              />
            </template>
            <template #resize-handle>
              <span
                class="pointer-events-none absolute inset-y-0 start-1/2 w-px -translate-x-1/2 bg-(--ui-border) transition-colors group-hover:bg-primary group-focus-visible:bg-primary"
              />
            </template>
          </USplitter>
          <div v-else class="flex h-full min-h-0 flex-col overflow-hidden">
            <ConsoleSessionNavbar
              :details-open="detailsOpen"
              :external-url="selectedExternalUrl"
              :has-display="Boolean(selectedDisplay)"
              :has-selection="Boolean(selectedInvocationId)"
              :loading="refreshing"
              :project="selectedProject"
              :title="selectedTitle"
              @open-sessions="sessionsOpen = true"
              @refresh="refresh"
              @toggle-details="detailsOpen = !detailsOpen"
            />
            <ConsoleSessionLoading
              v-if="initialSessionLoading"
              class="min-h-0 flex-1"
            />
            <div
              v-else-if="!selectedInvocationId"
              class="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-muted"
            >
              Select an Agent Invocation to inspect its work.
            </div>
            <UEmpty
              v-else-if="errorMessage(detail.error.value) && !invocationView"
              class="min-h-0 flex-1"
              icon="i-ph-cloud-slash-light"
              title="Could not load this session"
              :description="errorMessage(detail.error.value)"
              :actions="[
                { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: refresh },
              ]"
            />
            <ConsoleSessionLoading
              v-else-if="detail.isLoading.value && !invocationView"
              class="min-h-0 flex-1"
            />
            <div v-else-if="invocationView" class="flex min-h-0 flex-1 flex-col">
              <UAlert
                v-if="errorMessage(detail.error.value)"
                class="m-3 shrink-0"
                color="error"
                variant="subtle"
                icon="i-ph-cloud-slash-light"
                title="Could not refresh this session"
                :description="errorMessage(detail.error.value)"
                :actions="[
                  { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: refresh },
                ]"
              />
              <AgentInvocation
                :header="false"
                :invocation="invocationView"
                :selected-activity-id="selectedActivityId"
                class="min-h-0 flex-1"
                @inspect="inspectSession"
              />
            </div>
            <USlideover
              v-if="!isDesktop && invocationView"
              v-model:open="detailsOpen"
              side="right"
              title="Session details"
              :ui="{ content: 'w-full max-w-sm p-0' }"
            >
              <template #content>
                <ConsoleSessionInspector
                  :invocation="invocationView"
                  :maximizable="false"
                  :workspace-base="`${hostBase}/api/invocations`"
                  v-model:tab="inspectorTab"
                  v-model:active-surface="inspectorActiveSurface"
                  v-model:open-views="inspectorOpenViews"
                  v-model:open-paths="inspectorOpenPaths"
                  v-model:selected-path="inspectorSelectedPath"
                  class="h-full"
                  @close="closeDetails"
                  @focus-activity="selectActivity"
                />
              </template>
            </USlideover>
          </div>
        </div>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>

<style>
.vitehub-console {
  height: 100dvh;
  min-height: 32rem;
  overflow: hidden;
}

.vitehub-console [data-slot="invocation"],
.vitehub-console [data-slot="invocation-inspector"] {
  height: 100%;
  width: 100%;
}

.vitehub-console [data-slot="invocation-inspector"] {
  border-inline-start: 0;
}

.vitehub-console__session-navbar {
  background: var(--ui-bg) !important;
  height: 3.25rem !important;
  min-height: 3.25rem !important;
  overflow: visible !important;
  padding: 0 1.25rem !important;
  position: relative;
  z-index: 10;
}

.vitehub-console__session-navbar::after {
  background: linear-gradient(to bottom, var(--ui-bg), transparent);
  content: "";
  height: 0.75rem;
  inset: 100% 0 auto;
  pointer-events: none;
  position: absolute;
}

.vitehub-console .vh-invocation-thread__content {
  max-width: 48rem;
}
</style>
