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
import { resolveConsoleNewChatAgent } from "./console-new-chat";

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
import { isRetryableConsoleRequestError, requestConsole } from "../client/request";
import { useConsoleConnectionUnavailable } from "./console-connection";
import { consoleSectionDetails, rememberConsoleSection } from "../sections";
import ConsoleFrame from "./console-frame.vue";
import ConsoleConnectionState from "./console-connection-state.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleInvocationComposer from "./console-invocation-composer.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSessionLoading from "./console-session-loading.vue";
import ConsoleSessionNavbar from "./console-session-navbar.vue";
import ConsoleSessionInspector from "./console-session-inspector.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleUsage from "./console-usage.vue";
import {
  isCapabilityFilterRouteTransition,
  refreshCapabilityFilteredInvocations,
  resetCapabilityFilterForRouteTransition,
  useConsoleSessionBootstrap,
} from "./console-session-bootstrap";
import type { CapabilityFilterRouteTransition } from "./console-session-bootstrap";
import "./console-session.css";

const route = useRoute();
const router = useRouter();
const props = defineProps<{
  agentsBase: string;
  apiBase: string;
  capabilitiesBase: string;
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
const newChatAgentName = ref<string>();
const selectedCapabilityId = ref<string>();
const selectedTriggeredBy = ref<string>();
const filterOpen = ref(false);
const capabilityIds = ref<string[]>([]);
const triggeredByValues = ref<string[]>([]);
const capabilitiesLoading = ref(false);
const capabilitiesError = ref<unknown>();
const initialBootstrapPending = ref(!selectedAgentName.value);
const agentNames = ref<string[]>([]);
const agentsLoading = ref(true);
const agentsError = ref<unknown>();
interface ConsoleAgentProfile {
  id: string;
  label?: string;
}
const agentInvocationOptions = ref<Record<string, { profiles: ConsoleAgentProfile[] }>>({});
const nowMs = ref(Date.now());
const sessionsOpen = ref(false);
const detailsOpen = ref(false);
const detailsMaximized = ref(false);
const inspectorTab = ref<"details" | "trace" | "workspace">("details");
const inspectorActiveSurface = ref("");
const inspectorOpenViews = ref<Array<"details" | "trace" | "workspace">>([]);
const inspectorOpenPaths = ref<string[]>([]);
const inspectorSelectedPath = ref<string>();
const inspectorWorkspaceIdentity = ref<string>();
const selectedActivityId = ref<string>();
const isDesktop = ref(false);
const pageVisible = ref(!import.meta.env.SSR && document.visibilityState !== "hidden");
const refreshing = ref(false);
let clock: ReturnType<typeof setInterval> | undefined;
let agentsRetry: ReturnType<typeof setTimeout> | undefined;
let media: MediaQueryList | undefined;
let agentsRequest: AbortController | undefined;
let capabilityIdsRequest: AbortController | undefined;
let refreshCount = 0;
let invocationListRefreshQueued = false;
let pendingCapabilityFilterRouteTransition: CapabilityFilterRouteTransition | undefined;
const sessionPollingEnabled = computed(
  () =>
    pageVisible.value &&
    route.name !== resolveConsoleRouteName(route.name, "vitehub-console-usage"),
);
const listPollInterval = computed(() => (sessionPollingEnabled.value ? 5_000 : false));
const isUsageRoute = computed(
  () => route.name === resolveConsoleRouteName(route.name, "vitehub-console-usage"),
);

const list = useAgentInvocations({
  baseURL: props.apiBase,
  immediate: pageVisible.value && !isUsageRoute.value,
  pollInterval: listPollInterval,
  request: requestConsole,
  requestSummaries: requestConsole,
  watch: false,
  query: computed(() => {
    const query: { agent?: string; capability?: string; limit: number; triggeredBy?: string } = { limit: 50 };
    if (selectedAgentName.value) query.agent = selectedAgentName.value;
    if (selectedCapabilityId.value) query.capability = selectedCapabilityId.value;
    if (selectedTriggeredBy.value) query.triggeredBy = selectedTriggeredBy.value;
    return query;
  }),
});
const selectedSummary = computed(() =>
  list.invocations.value.find((invocation) => invocation.id === selectedInvocationId.value),
);
const { selectAgentName } = useConsoleSessionBootstrap({
  agentNames,
  firstInvocation: computed(() => list.invocations.value[0]),
  initialBootstrapPending,
  isUsageRoute,
  isLoading: list.isLoading,
  scheduleRefresh: scheduleInvocationListRefresh,
  selectedAgentName,
});
const selectedDetailStatus = ref<{
  id: string;
  status: AgentInvocationListItem["status"];
}>();
const selectedDetailError = ref<unknown>();
const initialSessionLoading = computed(
  () =>
    !selectedInvocationId.value &&
    !selectedAgentInvocation.value &&
    (agentsLoading.value || list.isLoading.value),
);
const detailPollInterval = computed(() => {
  if (!sessionPollingEnabled.value || !selectedInvocationId.value) return false;
  if (selectedDetailError.value) {
    return isRetryableConsoleRequestError(selectedDetailError.value) ? 3_000 : false;
  }
  const detailStatus = selectedDetailStatus.value;
  const status = detailStatus?.id === selectedInvocationId.value ? detailStatus.status : undefined;
  return status === "completed" || status === "failed" || status === "cancelled" ? false : 3_000;
});
const detail = useAgentInvocation(selectedInvocationId, {
  baseURL: props.apiBase,
  immediate: pageVisible.value,
  pollInterval: detailPollInterval,
  request: requestConsole,
});
watch(
  () => detail.error.value,
  (error) => {
    selectedDetailError.value = error;
  },
  { flush: "sync", immediate: true },
);

const connectionUnavailable = useConsoleConnectionUnavailable(() => ({
  errors: [agentsError.value, list.error.value, detail.error.value],
  pending: refreshing.value || agentsLoading.value || list.isLoading.value || detail.isLoading.value,
}));

const invocationItems = computed<AgentInvocationListItem[]>(() =>
  list.invocations.value.map((invocation) => ({
    agent: invocation.agentName,
    channel: invocation.channelId ? invocation.origin || invocation.channelId : undefined,
    context:
      [invocationCostDisplay(invocation), agentInvocationContext(invocation)]
        .filter((value): value is string => Boolean(value))
        .join(" · ") || undefined,
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
const selectedAgentInvocation = computed(() =>
  selectedAgentName.value ? agentInvocationOptions.value[selectedAgentName.value] : undefined,
);
const newChatTargetName = computed(() =>
  resolveConsoleNewChatAgent(selectedAgentName.value, agentInvocationOptions.value),
);
const selectedAgentLabel = computed(
  () => selectedAgentName.value || (agentsLoading.value ? "Loading agents" : "Agents"),
);
const agentMenuItems = computed<DropdownMenuItem[]>(() =>
  agentNames.value.map((name) => ({
    label: name,
    onSelect: () => selectAgent(name),
    trailingIcon: selectedAgentName.value === name ? "i-ph-check-light" : undefined,
  })),
);
const activeFilterCount = computed(() => Number(Boolean(selectedCapabilityId.value)) + Number(Boolean(selectedTriggeredBy.value)));
const capabilityOptions = computed(() => capabilityIds.value.map(id => ({ label: capabilityLabel(id), value: id })));
const routeInvocation = computed(() => {
  const value = route.params.invocation;
  return Array.isArray(value) ? value[0] : value;
});
const routeAgent = computed(() => {
  return decodeAgentRouteParam(route.params.agent);
});
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
const selectedRefreshable = computed(() =>
  selectedDisplay.value?.status === "pending" || selectedDisplay.value?.status === "running",
);
const selectedCost = computed(() => invocationCostDisplay(selectedDisplay.value));
const selectedTokens = computed(() => invocationTokenDisplay(selectedDisplay.value));
const selectedTitle = computed(() =>
  selectedDisplay.value
    ? agentInvocationTitle(selectedDisplay.value)
    : selectedAgentName.value || "ViteHub Console",
);
const selectedProject = computed(() =>
  selectedDisplay.value
    ? selectedDisplay.value.agentName || selectedAgentName.value || ""
    : selectedAgentName.value || "",
);
const selectedExternalUrl = computed(() =>
  selectedDisplay.value ? agentInvocationExternalUrl(selectedDisplay.value) : undefined,
);
const splitterItems: SplitterItem[] = [
  {
    id: "thread",
    slot: "thread",
    minSize: 360,
    defaultSize: 720,
    sizeUnit: "px",
    class: "h-full min-h-0 min-w-0 overflow-hidden",
  },
  {
    id: "details",
    slot: "details",
    minSize: 360,
    maxSize: 1080,
    defaultSize: 440,
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

async function loadCapabilityIds(): Promise<void> {
  capabilityIdsRequest?.abort();
  const controller = new AbortController();
  capabilityIdsRequest = controller;
  capabilitiesLoading.value = true;
  try {
    const value = record(
      await requestConsole(props.capabilitiesBase, {
        query: selectedAgentName.value ? { agent: selectedAgentName.value } : undefined,
        signal: controller.signal,
      }),
    );
    const ids = Array.isArray(value?.capabilities)
      ? value.capabilities.map(stringValue).filter((id): id is string => Boolean(id?.trim()))
      : [];
    const people = Array.isArray(value?.triggeredBy)
      ? value.triggeredBy.map(stringValue).filter((name): name is string => Boolean(name?.trim()))
      : [];
    if (capabilityIdsRequest === controller) {
      capabilityIds.value = [...new Set(ids.map((id) => id.trim()))].sort();
      triggeredByValues.value = [...new Set(people.map((name) => name.trim()))].sort((left, right) => left.localeCompare(right));
      capabilitiesError.value = undefined;
      if (selectedCapabilityId.value && !capabilityIds.value.includes(selectedCapabilityId.value)) {
        selectedCapabilityId.value = undefined;
        scheduleInvocationListRefresh();
      }
      if (selectedTriggeredBy.value && !triggeredByValues.value.includes(selectedTriggeredBy.value)) {
        selectedTriggeredBy.value = undefined;
        scheduleInvocationListRefresh();
      }
    }
  } catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return;
    if (capabilityIdsRequest === controller) capabilitiesError.value = error;
  } finally {
    if (capabilityIdsRequest === controller) {
      capabilityIdsRequest = undefined;
      capabilitiesLoading.value = false;
    }
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

function capabilityLabel(id: string): string {
  const packageSuffix = id.match(/(?:^|_)s([a-z][a-z0-9-]*)$/i)?.[1];
  const source = packageSuffix || id.split(/[/:]/).at(-1) || id;
  return source
    .replace(/^@/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b(api|github|mcp|ui)\b/gi, value => value.toLowerCase() === "github" ? "GitHub" : value.toUpperCase())
    .replace(/(^|\s)\p{Ll}/gu, value => value.toUpperCase());
}

function numericValue(value: unknown): number | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Host responses are untrusted JSON, so validate finite numbers at the capability boundary.
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invocationUsage(value: unknown): Record<string, unknown> | undefined {
  return record(record(value)?.usage);
}

function invocationCostDisplay(value: unknown): string | undefined {
  const cost = record(invocationUsage(value)?.cost);
  return stringValue(cost?.display);
}

function invocationTokenDisplay(value: unknown): string | undefined {
  const total = numericValue(invocationUsage(value)?.totalTokens);
  return total === undefined ? undefined : formatTokens(total);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
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
  newChatAgentName.value = undefined;
  updateSelectedAgentName(agentName);
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
    params: { agent: encodeAgentRouteParam(agentName), invocation: invocation.id },
  });
}

async function selectStartedInvocation(invocation: { agent: string; id: string }): Promise<void> {
  await selectInvocation(invocation);
  scheduleInvocationListRefresh();
}

async function startNewChat(): Promise<void> {
  const agentName = newChatTargetName.value;
  if (!agentName) return;
  sessionsOpen.value = false;
  newChatAgentName.value = agentName;
  updateSelectedAgentName(agentName);
  selectedInvocationId.value = undefined;
  closeDetails();
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
    params: { agent: encodeAgentRouteParam(agentName) },
  });
  await nextTick();
  document.querySelector<HTMLElement>('[aria-label="Test this Agent"]')?.focus();
}

async function selectAgent(name: string): Promise<void> {
  if (name === selectedAgentName.value) return;
  newChatAgentName.value = undefined;
  updateSelectedAgentName(name);
  selectedInvocationId.value = undefined;
  selectedCapabilityId.value = undefined;
  selectedTriggeredBy.value = undefined;
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
    params: { agent: encodeAgentRouteParam(name) },
  });
}

async function applySessionFilters(): Promise<void> {
  newChatAgentName.value = undefined;
  selectedInvocationId.value = undefined;
  closeDetails();
  const transition = {
    agent: selectedAgentName.value,
    invocation: undefined,
  } satisfies CapabilityFilterRouteTransition;
  pendingCapabilityFilterRouteTransition = transition;
  try {
    await refreshCapabilityFilteredInvocations({
      navigate: () =>
        selectedAgentName.value
          ? router.replace({
              name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
              params: { agent: encodeAgentRouteParam(selectedAgentName.value) },
            })
          : Promise.resolve(),
      refresh: () => list.refresh(),
    });
  } finally {
    if (pendingCapabilityFilterRouteTransition === transition) {
      pendingCapabilityFilterRouteTransition = undefined;
    }
  }
}

function selectCapability(capabilityId?: string): void {
  if (selectedCapabilityId.value === capabilityId) return;
  selectedCapabilityId.value = capabilityId;
  void applySessionFilters();
}

function selectTriggeredBy(triggeredBy?: string): void {
  if (selectedTriggeredBy.value === triggeredBy) return;
  selectedTriggeredBy.value = triggeredBy;
  void applySessionFilters();
}

function resetSessionFilters(): void {
  if (!activeFilterCount.value) return;
  selectedCapabilityId.value = undefined;
  selectedTriggeredBy.value = undefined;
  void applySessionFilters();
}

function loadMoreSessions(): void {
  if (!list.cursor.value || list.isLoadingMore.value || list.loadMoreError.value) return;
  void list.loadMore();
}

async function toggleUsage(): Promise<void> {
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
function clearAgentsRetry(): void {
  if (agentsRetry) clearTimeout(agentsRetry);
  agentsRetry = undefined;
}

function scheduleAgentsRetry(): void {
  clearAgentsRetry();
  if (!pageVisible.value) return;
  agentsRetry = setTimeout(() => {
    agentsRetry = undefined;
    if (pageVisible.value && agentsError.value) void loadAgents();
  }, 5_000);
}

async function loadAgents(): Promise<void> {
  clearAgentsRetry();
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
      agentNames.value = [...new Set(names)];
      const invocation = record(value?.invocation);
      agentInvocationOptions.value = Object.fromEntries(
        agentNames.value.flatMap((name) => {
          const options = record(invocation?.[name]);
          if (!options) return [];
          const profiles = Array.isArray(options.profiles)
            ? options.profiles.flatMap((value) => {
                const profile = record(value);
                const id = stringValue(profile?.id)?.trim();
                if (!id) return [];
                const label = stringValue(profile?.label)?.trim();
                const resolved: ConsoleAgentProfile = { id };
                if (label) resolved.label = label;
                return [resolved];
              })
            : [];
          return [[name, { profiles }] as const];
        }),
      );
      agentsError.value = undefined;
    }
  } catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return;
    if (agentsRequest === controller) {
      agentsError.value = error;
      if (isRetryableConsoleRequestError(error)) scheduleAgentsRetry();
    }
  } finally {
    if (agentsRequest === controller) {
      agentsRequest = undefined;
      agentsLoading.value = false;
    }
  }
}

function updateSelectedAgentName(name: string, preserveInvocationList = false): void {
  selectAgentName(name, preserveInvocationList);
}

function scheduleInvocationListRefresh(): void {
  if (invocationListRefreshQueued) return;
  invocationListRefreshQueued = true;
  void nextTick(() => {
    invocationListRefreshQueued = false;
    if (pageVisible.value && !isUsageRoute.value) void list.refresh();
  });
}

async function refresh(): Promise<void> {
  refreshCount++;
  refreshing.value = true;
  try {
    const agents = loadAgents();
    await Promise.all([
      agents,
      isUsageRoute.value ? Promise.resolve() : list.refresh(),
      selectedInvocationId.value ? detail.refresh() : Promise.resolve(),
    ]);
  } finally {
    refreshCount--;
    refreshing.value = refreshCount > 0;
  }
}

function inspectSession(target: "agent" | "workspace", path?: string): void {
  const view = target === "agent" ? "details" : "workspace";
  inspectorTab.value = view;
  if (!inspectorOpenViews.value.includes(view)) {
    inspectorOpenViews.value = [...inspectorOpenViews.value, view];
  }
  if (view === "workspace" && path) {
    if (!inspectorOpenPaths.value.includes(path)) inspectorOpenPaths.value = [...inspectorOpenPaths.value, path];
    inspectorSelectedPath.value = path;
    inspectorActiveSurface.value = `file:${path}`;
  } else {
    inspectorSelectedPath.value = undefined;
    inspectorActiveSurface.value = `view:${view}`;
  }
  detailsOpen.value = true;
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
  }, 60_000);
}

function updatePageVisibility(): void {
  const wasVisible = pageVisible.value;
  pageVisible.value = document.visibilityState !== "hidden";
  syncClock();
  if (!pageVisible.value) clearAgentsRetry();
  if (!wasVisible && pageVisible.value) void refresh();
}

watch(
  [routeInvocation, routeAgent, () => list.invocations.value[0], selectedAgentName, isUsageRoute],
  async (
    [requestedInvocation, requestedAgent, firstInvocation, agentName, usageRoute],
    previous,
  ) => {
    if (usageRoute) {
      newChatAgentName.value = undefined;
      initialBootstrapPending.value = false;
      selectedInvocationId.value = undefined;
      return;
    }
    if (requestedInvocation) newChatAgentName.value = undefined;
    const routeChanged =
      !previous || requestedInvocation !== previous[0] || requestedAgent !== previous[1];
    const preserveCapabilityFilter =
      routeChanged &&
      (requestedAgent === agentName || isCapabilityFilterRouteTransition(pendingCapabilityFilterRouteTransition, {
          agent: requestedAgent,
          invocation: requestedInvocation,
        }));
    if (routeChanged) pendingCapabilityFilterRouteTransition = undefined;
    const filterReset = resetCapabilityFilterForRouteTransition({
      preserve: preserveCapabilityFilter,
      routeChanged,
      scheduleRefresh: scheduleInvocationListRefresh,
      selectedCapabilityId,
      selectedTriggeredBy,
    });
    const availableFirstInvocation = filterReset ? undefined : firstInvocation;
    if (requestedInvocation || requestedAgent) {
      initialBootstrapPending.value = false;
    }
    if (!requestedAgent && !agentName) {
      if (!availableFirstInvocation) return;
      if (!availableFirstInvocation.agentName) {
        initialBootstrapPending.value = false;
        return;
      }
      selectedInvocationId.value = availableFirstInvocation.id;
      try {
        await router.replace({
          name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
          params: {
            agent: encodeAgentRouteParam(availableFirstInvocation.agentName),
            invocation: availableFirstInvocation.id,
          },
        });
      } finally {
        initialBootstrapPending.value = false;
      }
      return;
    }
    if (!requestedInvocation && requestedAgent && requestedAgent === newChatAgentName.value) {
      selectedInvocationId.value = undefined;
      return;
    }
    const agentRouteReady = !requestedAgent || requestedAgent === agentName;
    selectedInvocationId.value =
      requestedInvocation || (agentRouteReady ? availableFirstInvocation?.id : undefined);
    if (!requestedInvocation && availableFirstInvocation?.id && agentName && agentRouteReady) {
      await router.replace({
        name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
        params: {
          agent: encodeAgentRouteParam(agentName),
          invocation: availableFirstInvocation.id,
        },
      });
    }
  },
  { immediate: true },
);

watch(
  [routeAgent, agentNames, isUsageRoute, initialBootstrapPending],
  async ([requestedAgent, names, usageRoute, bootstrapPending]) => {
    if (usageRoute) return;
    if (!names.length) return;
    if (!requestedAgent && bootstrapPending) return;
    const currentAgent = selectedAgentName.value;
    const agentName =
      requestedAgent && names.includes(requestedAgent)
        ? requestedAgent
        : currentAgent && names.includes(currentAgent)
          ? currentAgent
          : names[0];
    updateSelectedAgentName(agentName);
    if (requestedAgent !== agentName) {
      await router.replace({
        name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
        params: { agent: encodeAgentRouteParam(agentName) },
      });
    }
  },
  { immediate: true },
);

watch([() => list.isLoading.value, () => list.error.value], ([loading, error]) => {
  if (
    initialBootstrapPending.value &&
    !loading &&
    (Boolean(error) || list.invocations.value.length === 0)
  ) {
    initialBootstrapPending.value = false;
  }
});

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
    if (!usageRoute) {
      if (!selectedAgentName.value) initialBootstrapPending.value = true;
      if (!list.isLoading.value && list.invocations.value.length === 0) {
        scheduleInvocationListRefresh();
      }
    }
  },
  { immediate: true },
);

watch(
  selectedAgentName,
  () => {
    void loadCapabilityIds();
  },
  { immediate: true },
);

watch(filterOpen, (open) => {
  if (open) void loadCapabilityIds();
});

if (pageVisible.value) void loadAgents();

onMounted(() => {
  media = window.matchMedia("(min-width: 981px)");
  updateDesktop();
  detailsOpen.value = isDesktop.value;
  media.addEventListener("change", updateDesktop);
  document.addEventListener("visibilitychange", updatePageVisibility);
  updatePageVisibility();
});

onBeforeUnmount(() => {
  agentsRequest?.abort();
  capabilityIdsRequest?.abort();
  clearAgentsRetry();
  if (clock) clearInterval(clock);
  media?.removeEventListener("change", updateDesktop);
  document.removeEventListener("visibilitychange", updatePageVisibility);
});
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="agent-sessions"
      class="vitehub-console__sessions"
      v-model:open="sessionsOpen"
      :default-size="16"
      :min-size="13"
      :max-size="26"
      :menu="{ title: 'Agent sessions', description: 'Browse read-only Agent Invocations.' }"
      :ui="{
        root: 'md:flex',
        header: 'p-0',
        body: 'gap-0 overflow-hidden p-0',
        footer: 'px-2 py-1',
        content: 'md:hidden',
        overlay: 'md:hidden',
      }"
      resizable
    >
      <template #header>
        <div class="flex min-w-0 items-center gap-2 px-[0.875rem]">
          <ConsoleMark class="size-4" />
          <span class="shrink-0 text-xs font-medium text-muted">ViteHub Agent</span>
          <UDropdownMenu
            v-if="hasMultipleAgents"
            :items="agentMenuItems"
            :content="{ align: 'start', collisionPadding: 12 }"
            :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width)' }"
          >
            <UButton
              class="min-w-0 justify-start rounded-md border border-default px-1.5 hover:bg-elevated"
              color="neutral"
              :label="selectedAgentLabel"
              trailing-icon="i-ph-caret-down-light"
              size="xs"
              variant="ghost"
              :aria-label="`Switch Agent. ${selectedAgentLabel} selected.`"
            />
          </UDropdownMenu>
          <span v-else class="min-w-0 truncate text-xs text-default">{{ selectedAgentLabel }}</span>
        </div>
      </template>

      <template #default>
        <div v-if="!connectionUnavailable && errorMessage(agentsError)" class="px-3 pb-3">
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
        <div class="flex shrink-0 items-center gap-1 px-[0.875rem] pb-2 pt-1">
          <UDashboardSearchButton
            block
            class="vitehub-console__search min-w-0 flex-1 rounded-md bg-transparent px-2 ring-0 hover:bg-elevated/60"
            label="Search console"
            :ui="{ trailing: 'vitehub-console__search-shortcut' }"
          />
          <UTooltip v-if="newChatTargetName" text="New chat">
            <UButton
              aria-label="New chat"
              color="neutral"
              icon="i-ph-note-pencil-light"
              size="xs"
              square
              variant="ghost"
              @click="startNewChat"
            />
          </UTooltip>
          <UPopover
            v-model:open="filterOpen"
            :content="{ align: 'start', collisionPadding: 12 }"
            :ui="{ content: 'w-80 max-w-[calc(100vw-1.5rem)] p-3' }"
          >
            <UButton
              aria-label="Filter sessions"
              :color="activeFilterCount ? 'primary' : 'neutral'"
              icon="i-ph-funnel-light"
              size="xs"
              square
              :variant="activeFilterCount ? 'soft' : 'ghost'"
            />
            <template #content>
              <div class="grid gap-3">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="text-sm font-medium">Filter sessions</p>
                  </div>
                  <UBadge v-if="activeFilterCount" color="primary" size="sm" variant="subtle">{{ activeFilterCount }}</UBadge>
                </div>
                <div
                  v-if="capabilitiesLoading"
                  class="grid gap-2 py-1"
                  aria-label="Loading session filters"
                  role="status"
                >
                  <USkeleton v-for="index in 2" :key="index" class="h-8 rounded" />
                </div>
                <p v-else-if="errorMessage(capabilitiesError)" class="py-1 text-xs text-error">
                  {{ errorMessage(capabilitiesError) }}
                </p>
                <template v-else>
                  <label class="grid gap-1.5 text-xs font-medium">
                    <span>Used capability</span>
                    <USelectMenu
                      aria-label="Used capability"
                      :model-value="selectedCapabilityId"
                      :items="capabilityOptions"
                      value-key="value"
                      label-key="label"
                      placeholder="Any capability"
                      :search-input="{ placeholder: 'Search capabilities…' }"
                      clear
                      size="sm"
                      @update:model-value="selectCapability"
                    />
                  </label>
                  <label class="grid gap-1.5 text-xs font-medium">
                    <span>Triggered by</span>
                    <USelectMenu
                      aria-label="Triggered by"
                      :model-value="selectedTriggeredBy"
                      :items="triggeredByValues"
                      placeholder="Anyone"
                      :search-input="{ placeholder: 'Search people…' }"
                      clear
                      size="sm"
                      @update:model-value="selectTriggeredBy"
                    />
                  </label>
                  <p v-if="!capabilityIds.length && !triggeredByValues.length" class="text-xs text-muted">
                    No filter values recorded yet.
                  </p>
                </template>
                <div class="flex justify-end border-t border-default pt-2">
                  <UButton
                    color="neutral"
                    label="Reset"
                    size="xs"
                    variant="ghost"
                    :disabled="!activeFilterCount"
                    @click="resetSessionFilters"
                  />
                </div>
              </div>
            </template>
          </UPopover>
        </div>
        <div
          v-if="errorMessage((!connectionUnavailable && list.error.value) || list.loadMoreError.value)"
          class="px-3"
        >
          <UAlert
            color="error"
            variant="subtle"
            icon="i-ph-cloud-slash-light"
            title="Could not load sessions"
            :description="errorMessage((!connectionUnavailable && list.error.value) || list.loadMoreError.value)"
            :actions="
              !connectionUnavailable && list.error.value
                ? [
                    {
                      label: 'Try again',
                      icon: 'i-ph-arrows-clockwise-light',
                      onClick: list.refresh,
                    },
                  ]
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
          v-if="!connectionUnavailable && (agentsLoading || list.isLoading.value) && !invocationItems.length"
          class="grid gap-1 px-2"
          aria-label="Loading sessions"
          role="status"
        >
          <div
            v-for="index in 6"
            :key="index"
            class="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-2 rounded-md px-2 py-2.5"
          >
            <USkeleton class="mt-0.5 size-4 rounded" />
            <div class="grid min-w-0 gap-2">
              <div class="flex items-center justify-between gap-3">
                <USkeleton class="h-3 w-16 rounded" />
                <USkeleton class="h-3 w-14 rounded" />
              </div>
              <USkeleton class="h-4 rounded" :class="index % 3 === 0 ? 'w-3/4' : 'w-full'" />
              <USkeleton class="h-3 w-2/3 rounded" />
            </div>
          </div>
        </div>
        <AgentInvocationList
          v-if="
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
          @end-reached="loadMoreSessions"
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
                @click="loadMoreSessions"
              />
            </div>
          </template>
          <template #empty
            ><UEmpty
              class="px-4"
              icon="i-ph-chat-dots-light"
              :title="activeFilterCount ? 'No matching sessions' : 'No sessions yet'"
              :description="activeFilterCount ? undefined : 'The first Agent Invocation will appear here.'"
              :actions="activeFilterCount ? [{ label: 'Clear filters', onClick: resetSessionFilters }] : undefined"
          /></template>
        </AgentInvocationList>
      </template>

      <template #footer>
        <div class="grid min-w-0 gap-1">
          <UButton
            v-if="isUsageRoute"
            block
            class="justify-start"
            icon="i-lucide-arrow-left"
            label="Back"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Back to sessions"
            @click="toggleUsage"
          />
          <div class="flex min-w-0 items-center gap-0.5">
            <ConsolePrimitiveSwitcher
              :active="isUsageRoute ? 'usage' : 'agents'"
              :exclude="['usage']"
              :sections-base="sectionsBase"
            />
            <UTooltip v-if="!isUsageRoute" text="Usage">
              <UButton
                :icon="consoleSectionDetails.usage.icon"
                color="neutral"
                variant="ghost"
                size="xs"
                aria-label="Open Usage"
                @click="toggleUsage"
              />
            </UTooltip>
          </div>
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
    />

    <ConsoleUsage v-if="isUsageRoute" :base="usageBase" @open-sessions="sessionsOpen = true" />

    <UDashboardPanel
      v-else
      id="agent-session"
      class="vitehub-console__session-panel"
      :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }"
    >
      <template #body>
        <div class="flex h-full min-h-0 w-full flex-col overflow-hidden" aria-live="polite">
          <ConsoleConnectionState
            v-if="connectionUnavailable"
            :compact="Boolean(invocationView)"
            :retrying="refreshing"
            @retry="refresh"
            @open-sessions="sessionsOpen = true"
          />
          <div v-if="!connectionUnavailable || invocationView" class="min-h-0 w-full flex-1 overflow-hidden">
          <div
            v-if="isDesktop && detailsOpen && detailsMaximized && selectedInvocationId"
            class="h-full min-h-0 overflow-hidden"
          >
            <ConsoleSessionInspector
                :workspace-base="`${hostBase}/api/_vitehub/console/invocations`"
              v-if="invocationView"
              :invocation="invocationView"
              :maximized="true"
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
            <ConsoleSessionLoading
              v-else-if="detail.isLoading.value"
              class="h-full min-h-0"
              :maximized="true"
              surface="inspector"
              @close="closeDetails"
              @toggle-maximized="detailsMaximized = false"
            />
            <ConsoleSessionLoading
              v-else
              class="h-full min-h-0"
              :error="errorMessage(detail.error.value)"
              :maximized="true"
              surface="inspector"
              @close="closeDetails"
              @retry="refresh"
              @toggle-maximized="detailsMaximized = false"
            />
          </div>
          <USplitter
            v-else-if="isDesktop && detailsOpen && (selectedInvocationId || initialSessionLoading)"
            id="agent-session-layout"
            auto-save-id="vitehub-agent-session-layout-v2"
            :items="splitterItems"
            class="h-full min-h-0 overflow-hidden"
          >
            <template #thread>
              <div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
                <ConsoleSessionNavbar
                  :cost="selectedCost"
                  :details-open="detailsOpen"
                  :external-url="selectedExternalUrl"
                  :has-display="Boolean(selectedDisplay)"
                  :has-selection="Boolean(selectedInvocationId)"
                  :loading="refreshing"
                  :refreshable="selectedRefreshable"
                  :project="hasMultipleAgents ? selectedProject : ''"
                  :title="selectedTitle"
                  :tokens="selectedTokens"
                  @open-sessions="sessionsOpen = true"
                  @refresh="refresh"
                  @toggle-details="detailsOpen = !detailsOpen"
                />
                <UAlert
                  v-if="!connectionUnavailable && invocationView && errorMessage(detail.error.value)"
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
                <ConsoleSessionLoading
                  v-if="(detail.isLoading.value || initialSessionLoading) && !invocationView"
                  class="min-h-0 flex-1"
                />
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
                <AgentInvocation
                  v-else-if="invocationView"
                  :header="false"
                  :invocation="invocationView"
                  :selected-activity-id="selectedActivityId"
                  :workspace-inspectable="true"
                  class="min-h-0 flex-1"
                  @inspect="inspectSession"
                />
              </div>
            </template>
            <template #details>
              <ConsoleSessionInspector
                :workspace-base="`${hostBase}/api/_vitehub/console/invocations`"
                v-if="invocationView"
                :invocation="invocationView"
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
              <ConsoleSessionLoading
                v-else-if="detail.isLoading.value || initialSessionLoading"
                class="h-full min-h-0"
                :maximizable="Boolean(selectedInvocationId)"
                surface="inspector"
                @close="closeDetails"
                @toggle-maximized="detailsMaximized = true"
              />
              <ConsoleSessionLoading
                v-else
                class="h-full min-h-0"
                :error="errorMessage(detail.error.value)"
                surface="inspector"
                @close="closeDetails"
                @retry="refresh"
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
              :cost="selectedCost"
              :details-open="detailsOpen"
              :external-url="selectedExternalUrl"
              :has-display="Boolean(selectedDisplay)"
              :has-selection="Boolean(selectedInvocationId)"
              :loading="refreshing"
              :refreshable="selectedRefreshable"
              :project="hasMultipleAgents ? selectedProject : ''"
              :title="selectedTitle"
              :tokens="selectedTokens"
              @open-sessions="sessionsOpen = true"
              @refresh="refresh"
              @toggle-details="detailsOpen = !detailsOpen"
            />
            <ConsoleSessionLoading v-if="initialSessionLoading" class="min-h-0 flex-1" />
            <div v-else-if="!selectedInvocationId" class="min-h-0 flex-1" />
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
                v-if="!connectionUnavailable && errorMessage(detail.error.value)"
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
                :workspace-inspectable="true"
                class="min-h-0 flex-1"
                @inspect="inspectSession"
              />
            </div>
            <ConsoleInvocationComposer
              v-if="selectedAgentName && selectedAgentInvocation && !selectedInvocationId"
              :agent="selectedAgentName"
              :base="agentsBase"
              :profiles="selectedAgentInvocation.profiles"
              @started="selectStartedInvocation"
            />
            <USlideover
              v-if="!isDesktop && invocationView"
              v-model:open="detailsOpen"
              side="right"
              title="Session details"
              :ui="{ content: 'w-full max-w-sm p-0' }"
            >
              <template #content>
                <ConsoleSessionInspector
                :workspace-base="`${hostBase}/api/_vitehub/console/invocations`"
                  :invocation="invocationView"
                  :maximizable="false"
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
        </div>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>

<style>
.vitehub-console {
  --ui-header-height: 2.5rem;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.vitehub-console,
.vitehub-console :where(*) {
  scrollbar-gutter: auto !important;
  scrollbar-width: none;
}

.vitehub-console::-webkit-scrollbar,
.vitehub-console :where(*)::-webkit-scrollbar {
  display: none;
  height: 0;
  width: 0;
}

.vitehub-console [data-slot="invocation"],
.vitehub-console [data-slot="invocation-inspector"] {
  height: 100%;
  width: 100%;
}

.vitehub-console [data-slot="invocation-inspector"] {
  border-inline-start: 0;
}

.vitehub-console__sessions[data-slot="root"] {
  background: var(--ui-bg-muted);
}

.vitehub-console__search {
  border: 0;
}

.vitehub-console__search-shortcut {
  display: none;
}

.vitehub-console__sessions .vh-invocation-list__item[aria-current="true"] {
  background: var(--ui-bg-accented);
  box-shadow: none;
}

.dark .vitehub-console__sessions .vh-invocation-list__item[aria-current="true"] {
  background: var(--ui-bg-accented);
}

.vitehub-console__session-panel > [data-slot="body"] {
  gap: 0 !important;
  padding: 0 !important;
}

.vitehub-console__session-navbar {
  background: var(--ui-bg) !important;
  height: 2.5rem !important;
  min-height: 2.5rem !important;
  overflow: visible !important;
  padding: 0 1.25rem !important;
  position: relative;
  z-index: 10;
}

.vitehub-console__session-navbar svg,
.session-inspector__header svg {
  opacity: 0.8;
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
