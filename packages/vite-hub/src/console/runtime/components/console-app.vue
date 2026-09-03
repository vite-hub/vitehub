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
import { isRetryableConsoleRequestError, requestConsole } from "../client/request";
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
const selectedCapabilityId = ref<string>();
const filterOpen = ref(false);
const capabilityIds = ref<string[]>([]);
const capabilitiesLoading = ref(false);
const capabilitiesError = ref<unknown>();
const initialBootstrapPending = ref(!selectedAgentName.value);
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
let agentsRetry: ReturnType<typeof setTimeout> | undefined;
let media: MediaQueryList | undefined;
let agentsRequest: AbortController | undefined;
let capabilitiesRequest: AbortController | undefined;
let capabilityIdsRequest: AbortController | undefined;
let refreshCount = 0;
let invocationListRefreshQueued = false;
let pendingCapabilityFilterRouteTransition: CapabilityFilterRouteTransition | undefined;
const sessionPollingEnabled = computed(
  () =>
    pageVisible.value &&
    activePage.value === "sessions" &&
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
  query: computed(() => ({
    ...(selectedAgentName.value ? { agent: selectedAgentName.value } : {}),
    ...(selectedCapabilityId.value ? { capability: selectedCapabilityId.value } : {}),
    limit: 10,
  })),
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
const initialSessionLoading = computed(() =>
  !selectedInvocationId.value && (agentsLoading.value || list.isLoading.value),
);
const detailPollInterval = computed(() => {
  if (!sessionPollingEnabled.value || !selectedInvocationId.value) return false;
  if (selectedDetailError.value) {
    return isRetryableConsoleRequestError(selectedDetailError.value) ? 3_000 : false;
  }
  const detailStatus = selectedDetailStatus.value;
  const status =
    detailStatus?.id === selectedInvocationId.value
      ? detailStatus.status
      : undefined;
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

const invocationItems = computed<AgentInvocationListItem[]>(() =>
  list.invocations.value.map((invocation) => ({
    agent: invocation.agentName,
    context:
      [invocationCostDisplay(invocation), agentInvocationContext(invocation)]
        .filter((value): value is string => Boolean(value))
        .join(" · ") || undefined,
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
const capabilityFilterLabel = computed(() =>
  selectedCapabilityId.value ? `Used ${selectedCapabilityId.value}` : "All capabilities",
);
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
const selectedCost = computed(() => invocationCostDisplay(selectedDisplay.value));
const selectedTokens = computed(() => invocationTokenDisplay(selectedDisplay.value));
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

async function loadCapabilityIds(): Promise<void> {
  capabilityIdsRequest?.abort();
  const controller = new AbortController();
  capabilityIdsRequest = controller;
  capabilitiesLoading.value = true;
  try {
    const value = record(await requestConsole(props.capabilitiesBase, {
      query: selectedAgentName.value ? { agent: selectedAgentName.value } : undefined,
      signal: controller.signal,
    }));
    const ids = Array.isArray(value?.capabilities)
      ? value.capabilities.map(stringValue).filter((id): id is string => Boolean(id?.trim()))
      : [];
    if (capabilityIdsRequest === controller) {
      capabilityIds.value = [...new Set(ids.map(id => id.trim()))].sort();
      capabilitiesError.value = undefined;
      if (selectedCapabilityId.value && !capabilityIds.value.includes(selectedCapabilityId.value)) {
        selectedCapabilityId.value = undefined;
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
  showSessions();
  sessionsOpen.value = false;
  updateSelectedAgentName(agentName);
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
    params: { agent: encodeAgentRouteParam(agentName), invocation: invocation.id },
  });
}

async function selectAgent(name: string): Promise<void> {
  if (name === selectedAgentName.value) return;
  showSessions();
  updateSelectedAgentName(name);
  selectedInvocationId.value = undefined;
  selectedCapabilityId.value = undefined;
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
    params: { agent: encodeAgentRouteParam(name) },
  });
}

async function selectCapability(capabilityId?: string): Promise<void> {
  if (selectedCapabilityId.value === capabilityId) return;
  selectedCapabilityId.value = capabilityId;
  filterOpen.value = false;
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
      detectHostCapabilities(),
      agents,
      isUsageRoute.value ? Promise.resolve() : list.refresh(),
      selectedInvocationId.value ? detail.refresh() : Promise.resolve(),
    ]);
  } finally {
    refreshCount--;
    refreshing.value = refreshCount > 0;
  }
}

function inspectSession(target: "agent" | "workspace"): void {
  if (target !== "agent") return;
  const view = "details";
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
  [
    routeInvocation,
    routeAgent,
    () => list.invocations.value[0],
    selectedAgentName,
    isUsageRoute,
  ],
  async (
    [requestedInvocation, requestedAgent, firstInvocation, agentName, usageRoute],
    previous,
  ) => {
    if (usageRoute) {
      initialBootstrapPending.value = false;
      selectedInvocationId.value = undefined;
      return;
    }
    const routeChanged =
      !previous || requestedInvocation !== previous[0] || requestedAgent !== previous[1];
    const preserveCapabilityFilter = routeChanged && isCapabilityFilterRouteTransition(
      pendingCapabilityFilterRouteTransition,
      { agent: requestedAgent, invocation: requestedInvocation },
    );
    if (routeChanged) pendingCapabilityFilterRouteTransition = undefined;
    const filterReset = resetCapabilityFilterForRouteTransition({
      preserve: preserveCapabilityFilter,
      routeChanged,
      scheduleRefresh: scheduleInvocationListRefresh,
      selectedCapabilityId,
    });
    const availableFirstInvocation = filterReset ? undefined : firstInvocation;
    if (requestedInvocation || requestedAgent) {
      initialBootstrapPending.value = false;
      if (routeChanged) showSessions();
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
    const agentRouteReady = !requestedAgent || requestedAgent === agentName;
    selectedInvocationId.value =
      requestedInvocation || (agentRouteReady ? availableFirstInvocation?.id : undefined);
    if (!requestedInvocation && availableFirstInvocation?.id && agentName && agentRouteReady) {
      await router.replace({
        name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
        params: { agent: encodeAgentRouteParam(agentName), invocation: availableFirstInvocation.id },
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

watch(
  [() => list.isLoading.value, () => list.error.value],
  ([loading, error]) => {
    if (
      initialBootstrapPending.value &&
      !loading &&
      (Boolean(error) || list.invocations.value.length === 0)
    ) {
      initialBootstrapPending.value = false;
    }
  },
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
    if (!usageRoute) {
      if (!selectedAgentName.value) initialBootstrapPending.value = true;
      if (!list.isLoading.value && list.invocations.value.length === 0) {
        scheduleInvocationListRefresh();
      }
    }
  },
  { immediate: true },
);

watch(selectedAgentName, () => {
  void loadCapabilityIds();
}, { immediate: true });

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
  void detectHostCapabilities();
});

onBeforeUnmount(() => {
  agentsRequest?.abort();
  capabilitiesRequest?.abort();
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
      v-model:collapsed="sessionsCollapsed"
      :default-size="16"
      :collapsed-size="3"
      :min-size="13"
      :max-size="26"
      :menu="{ title: 'Agent sessions', description: 'Browse read-only Agent Invocations.' }"
      :ui="{
        root: 'md:flex',
        body: 'gap-0 overflow-hidden p-0',
        footer: 'px-2 py-1',
        content: 'md:hidden',
        overlay: 'md:hidden',
      }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>

      <template #default="{ collapsed }">
        <div v-if="hasMultipleAgents" class="px-2 pb-2 pt-1">
          <UDropdownMenu
            :items="agentMenuItems"
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
            class="vitehub-console__search min-w-0 flex-1 bg-transparent ring-0 hover:bg-elevated/60"
            label="Search console"
            :ui="{ trailing: 'vitehub-console__search-shortcut' }"
          />
          <UPopover
            v-if="!collapsed"
            v-model:open="filterOpen"
            :content="{ align: 'start', collisionPadding: 12 }"
            :ui="{ content: 'w-64 p-2' }"
          >
            <UButton
              aria-label="Filter sessions"
              :color="selectedCapabilityId ? 'primary' : 'neutral'"
              icon="i-ph-funnel-light"
              square
              :variant="selectedCapabilityId ? 'soft' : 'ghost'"
            />
            <template #content>
              <div class="grid gap-1">
                <div class="flex items-center justify-between gap-3 px-2 py-1">
                  <div>
                    <p class="text-sm font-medium">Filter sessions</p>
                    <p class="text-xs text-muted">Capability actually used</p>
                  </div>
                  <UBadge v-if="selectedCapabilityId" color="primary" size="sm" variant="subtle">1</UBadge>
                </div>
                <UButton
                  block
                  class="justify-start"
                  color="neutral"
                  label="All capabilities"
                  :trailing-icon="!selectedCapabilityId ? 'i-ph-check-light' : undefined"
                  variant="ghost"
                  @click="selectCapability()"
                />
                <USeparator />
                <div
                  v-if="capabilitiesLoading"
                  class="grid gap-2 px-2 py-2"
                  aria-label="Loading capabilities"
                  role="status"
                >
                  <USkeleton v-for="index in 3" :key="index" class="h-7 rounded" />
                </div>
                <p v-else-if="errorMessage(capabilitiesError)" class="px-2 py-2 text-xs text-error">
                  {{ errorMessage(capabilitiesError) }}
                </p>
                <p v-else-if="!capabilityIds.length" class="px-2 py-2 text-xs text-muted">
                  No capability use recorded yet.
                </p>
                <template v-else>
                  <UButton
                    v-for="capabilityId in capabilityIds"
                    :key="capabilityId"
                    block
                    class="justify-start font-mono"
                    color="neutral"
                    :label="capabilityId"
                    :trailing-icon="selectedCapabilityId === capabilityId ? 'i-ph-check-light' : undefined"
                    variant="ghost"
                    @click="selectCapability(capabilityId)"
                  />
                </template>
                <p
                  v-if="selectedCapabilityId"
                  class="truncate px-2 pt-1 text-xs text-muted"
                  :title="capabilityFilterLabel"
                >
                  {{ capabilityFilterLabel }}
                </p>
              </div>
            </template>
          </UPopover>
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
              class="ml-auto max-md:hidden"
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

    <UDashboardPanel
      v-else
      id="agent-session"
      class="vitehub-console__session-panel"
      :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }"
    >
      <template #body>
        <div class="h-full min-h-0 overflow-hidden" aria-live="polite">
          <div
            v-if="isDesktop && detailsOpen && detailsMaximized && selectedInvocationId"
            class="h-full min-h-0 overflow-hidden"
          >
            <ConsoleSessionInspector
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
                  :project="selectedProject"
                  :title="selectedTitle"
                  :tokens="selectedTokens"
                  @open-sessions="sessionsOpen = true"
                  @refresh="refresh"
                  @toggle-details="detailsOpen = !detailsOpen"
                />
                <UAlert
                  v-if="invocationView && errorMessage(detail.error.value)"
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
                  :workspace-inspectable="false"
                  class="min-h-0 flex-1"
                  @inspect="inspectSession"
                />
              </div>
            </template>
            <template #details>
              <ConsoleSessionInspector
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
              :project="selectedProject"
              :title="selectedTitle"
              :tokens="selectedTokens"
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
                :workspace-inspectable="false"
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
  --ui-header-height: 3.25rem;
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
  border: 1px solid var(--ui-border);
}

.vitehub-console__search-shortcut {
  opacity: 0;
  pointer-events: none;
  transform: translateX(0.25rem);
  transition:
    opacity 150ms ease,
    transform 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

@media (hover: hover) and (pointer: fine) {
  .vitehub-console__search:hover .vitehub-console__search-shortcut {
    opacity: 0.75;
    transform: translateX(0);
  }
}

.vitehub-console__search:focus-visible .vitehub-console__search-shortcut {
  opacity: 0.75;
  transform: translateX(0);
}

@media (prefers-reduced-motion: reduce) {
  .vitehub-console__search-shortcut {
    transform: none;
    transition: opacity 150ms ease;
  }
}

.vitehub-console__sessions .vh-invocation-list__item[aria-current="true"] {
  background: #fff;
}

.dark .vitehub-console__sessions .vh-invocation-list__item[aria-current="true"] {
  background: var(--ui-bg-elevated);
}

.vitehub-console__session-panel > [data-slot="body"] {
  gap: 0 !important;
  padding: 0 !important;
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
