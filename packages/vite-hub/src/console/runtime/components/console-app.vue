<script setup lang="ts">
import {
  AgentInvocation,
  AgentInvocationList,
  agentInvocationContext,
  agentInvocationExternalUrl,
  agentInvocationProject,
  agentInvocationTitle,
} from "./invocation";
import { useAgentInvocation, useAgentInvocations } from "vite-hub/agent/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  resolveConsoleAgentInvocation,
  resolveConsoleAgentInvocationOptions,
  resolveConsoleNewChatAgent,
} from "./console-new-chat";
import {
  readConsoleAgentListOpen,
  rememberConsoleAgentListOpen,
  resolveConsoleAgentCatalog,
  resolveConsoleAgentRows,
} from "./console-agent-list";

import type { CommandPaletteItem } from "@nuxt/ui";
import type {
  AgentInvocationConfiguration,
  AgentInvocationListItem,
  AgentInvocationView,
} from "./invocation";
import {
  decodeAgentRouteParam,
  encodeAgentRouteParam,
  resolveConsoleRouteName,
  resolveUsageSessionsAgent,
} from "../console-route";
import { isConsoleSignInRequired, isRetryableConsoleRequestError, requestConsole } from "../client/request";
import { queryChoice, querySelection, queryText, useConsoleQuery, writeConsoleQuery } from "../client/route-query";
import { useConsoleConnectionUnavailable } from "./console-connection";
import { rememberConsoleSection } from "../sections";
import ConsoleConnectionState from "./console-connection-state.vue";
import ConsoleState from "./console-state.vue";
import ConsoleInvocationComposer from "./console-invocation-composer.vue";
import ConsoleMark from "./console-mark.vue";
import ConsoleSessionLoading from "./console-session-loading.vue";
import ConsoleSessionNavbar from "./console-session-navbar.vue";
import { createConsoleInvocationDeletion } from "../client/invocation-deletion";
import ConsoleSessionCancel from "./console-session-cancel.vue";
import ConsoleSessionActions from "./console-session-actions.vue";
import type { ConsoleSessionRerun } from "./console-session-actions.vue";
import ConsoleSessionInspector from "./console-session-inspector.vue";
import ConsoleAgentSession from "./console-agent-session.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleUsage from "./console-usage.vue";
import { formatConsoleUsageCost } from "./console-usage-model";
import { refreshCapabilityFilteredInvocations, useConsoleSessionBootstrap } from "./console-session-bootstrap";
import "./console-session.css";
import "./invocation/invocation.css";

const route = useRoute();
const router = useRouter();
const props = defineProps<{
  agentsBase: string;
  apiBase: string;
  capabilitiesBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
  usageBase: string;
}>();
const initialAgentParam = decodeAgentRouteParam(route.params.agent);
const selectedInvocationId = ref<string>();
const selectedAgentName = ref(initialAgentParam?.trim() ? initialAgentParam : undefined);
const newChatAgentName = ref<string>();
const inspectorViewNames = ["details", "trace", "workspace", "capabilities", "diff"] as const;
// The session filters, the details panel, and its tab or file live in the URL, so a reload, a shared link, or a new
// tab opens the same view. The session itself is in the path. The sessions drawer of narrow screens stays out: the
// dashboard sidebar closes it on every navigation, so a URL write would close it at once.
const sessionQuery = {
  capability: querySelection({ history: "replace" }),
  details: queryChoice(["closed", "open", "max"], "closed", { history: "push" }),
  file: querySelection(),
  q: queryText(),
  tab: queryChoice(inspectorViewNames, "details", { history: "push" }),
  triggeredBy: querySelection({ history: "replace" }),
};
const {
  capability: selectedCapabilityId,
  details: detailsView,
  file: inspectorSelectedPath,
  q: sessionSearch,
  tab: inspectorTab,
  triggeredBy: selectedTriggeredBy,
} = useConsoleQuery(sessionQuery, {
  active: current => ["vitehub-console-agents", "vitehub-console-agent", "vitehub-console-invocation"]
    .some(name => current.name === resolveConsoleRouteName(current.name, name)),
  onRestore(names) {
    if (names.includes("capability") || names.includes("triggeredBy")) scheduleInvocationListRefresh();
    if (names.includes("tab") || names.includes("file") || (names.includes("details") && detailsOpen.value)) showInspectorSurface();
  },
});
/** The URL query of the page as it shows now, for a route that only fills in the Agent or the first session. */
function currentSessionQuery() {
  return writeConsoleQuery(sessionQuery, {
    capability: selectedCapabilityId.value,
    details: detailsView.value,
    file: inspectorSelectedPath.value,
    q: sessionSearch.value,
    tab: inspectorTab.value,
    triggeredBy: selectedTriggeredBy.value,
  }, route.query);
}
/** The query to keep when another session or Agent opens: the filters, and the details panel unless `closeDetails`. */
function keptSessionQuery(options: { closeDetails?: boolean } = {}) {
  return writeConsoleQuery(sessionQuery, {
    capability: selectedCapabilityId.value,
    q: sessionSearch.value,
    triggeredBy: selectedTriggeredBy.value,
    ...(options.closeDetails ? {} : { details: detailsView.value, tab: inspectorTab.value }),
  }, {});
}
const filterOpen = ref(false);
const capabilityIds = ref<string[]>([]);
const triggeredByValues = ref<string[]>([]);
const capabilitiesLoading = ref(false);
const capabilitiesError = ref<unknown>();
const initialBootstrapPending = ref(!selectedAgentName.value);
const agentNames = ref<string[]>([]);
// Names that appear only in invocation history. Their sessions stay browsable, but they are not listed as Agents.
const historicalAgentNames = ref<string[]>([]);
const sessionAgentNames = computed(() => [...agentNames.value, ...historicalAgentNames.value]);
const agentsLoading = ref(true);
const agentsError = ref<unknown>();
interface ConsoleAgentProfile {
  id: string;
  label?: string;
}
const agentInvocationOptions = ref<Record<string, { profiles: ConsoleAgentProfile[] }>>({});
const nowMs = ref(Date.now());
// Usage links to the sessions with `?sessions=open`.
const sessionsOpen = ref(route.query.sessions === "open");
const detailsOpen = computed({
  get: () => detailsView.value !== "closed",
  set: (open: boolean) => {
    detailsView.value = !open ? "closed" : detailsView.value === "max" ? "max" : "open";
  },
});
const detailsMaximized = computed({
  get: () => detailsView.value === "max",
  set: (maximized: boolean) => {
    detailsView.value = maximized ? "max" : detailsView.value === "closed" ? "closed" : "open";
  },
});
const inspectorActiveSurface = ref("");
const inspectorOpenViews = ref<Array<(typeof inspectorViewNames)[number]>>([]);
const inspectorOpenPaths = ref<string[]>([]);
/** Opens the tab or file of the URL in the inspector, for a link, Back, and Forward. */
function showInspectorSurface(): void {
  const path = inspectorSelectedPath.value;
  if (path) {
    if (!inspectorOpenPaths.value.includes(path)) inspectorOpenPaths.value = [...inspectorOpenPaths.value, path];
    if (inspectorTab.value === "workspace") {
      inspectorActiveSurface.value = `file:${path}`;
      return;
    }
  }
  const view = inspectorTab.value;
  if (!inspectorOpenViews.value.includes(view)) inspectorOpenViews.value = [...inspectorOpenViews.value, view];
  inspectorActiveSurface.value = `view:${view}`;
}
if (detailsOpen.value || inspectorSelectedPath.value || inspectorTab.value !== "details") showInspectorSurface();
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
const sessionPollingEnabled = computed(
  () =>
    pageVisible.value &&
    route.name !== resolveConsoleRouteName(route.name, "vitehub-console-usage"),
);
const listPollInterval = computed(() => (sessionPollingEnabled.value ? 5_000 : false));
const isUsageRoute = computed(
  () => route.name === resolveConsoleRouteName(route.name, "vitehub-console-usage"),
);

async function openSessionsFromUsage(): Promise<void> {
  const agent = resolveUsageSessionsAgent(route.query, selectedAgentName.value);
  if (agent) {
    await router.push({
      name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
      params: { agent: encodeAgentRouteParam(agent) },
      query: { sessions: "open" },
    });
    sessionsOpen.value = true;
    return;
  }
  await router.push({ name: resolveConsoleRouteName(route.name, "vitehub-console-agents"), query: { sessions: "open" } });
  sessionsOpen.value = true;
}

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
  agentNames: sessionAgentNames,
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

// Sign-in covers the whole panel: neither request can succeed until the user signs in again.
const sessionsSignInError = computed(() =>
  [agentsError.value, list.error.value].find((error) => isConsoleSignInRequired(error)),
);
// When the Agents and their sessions both fail for another reason, one state explains both.
const sessionsPanelError = computed(() =>
  sessionsSignInError.value ?? (!connectionUnavailable.value && agentsError.value && list.error.value ? agentsError.value : undefined),
);

const invocationItems = computed<AgentInvocationListItem[]>(() =>
  list.invocations.value.map((invocation) => ({
    agent: invocation.agentName,
    channel: invocation.channelId ? invocation.origin || invocation.channelId : undefined,
    context:
      [invocationCostDisplay(invocation), invocationListContext(invocation)]
        .filter((value): value is string => Boolean(value))
        .join(" · ") || undefined,
    id: invocation.id,
    // The list is already filtered by Agent, so the project line only names a different origin.
    project: agentInvocationProject(invocation) === invocation.agentName ? undefined : agentInvocationProject(invocation),
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
  })).filter(item => matchesSessionSearch(item)),
);
/** The search matches the title or the ID of a loaded session. An empty result keeps reading older pages. */
function matchesSessionSearch(item: Pick<AgentInvocationListItem, "id" | "title">): boolean {
  const query = sessionSearch.value.trim().toLowerCase();
  return !query || `${item.title ?? ""} ${item.id}`.toLowerCase().includes(query);
}
const hasMultipleAgents = computed(() => agentNames.value.length > 1);
const selectedAgentInvocation = computed(() =>
  resolveConsoleAgentInvocation(selectedAgentName.value, agentInvocationOptions.value),
);
const newChatTargetName = computed(() =>
  resolveConsoleNewChatAgent(selectedAgentName.value, agentInvocationOptions.value),
);
const agentListOpen = ref(readConsoleAgentListOpen());
const showAllAgents = ref(false);
// The list shows a few Agents first. The selected Agent stays in it, so the panel always names the active filter.
const agentRows = computed(() =>
  resolveConsoleAgentRows(agentNames.value, selectedAgentName.value, showAllAgents.value),
);
// Search shows the same New chat action as the sidebar button.
const searchActions = computed<CommandPaletteItem[]>(() =>
  newChatTargetName.value
    ? [{
        description: `Start a session with ${newChatTargetName.value}`,
        icon: "i-lucide-square-pen",
        label: "New chat",
        onSelect: () => void startNewChat(),
      }]
    : [],
);
const activeFilterCount = computed(() => Number(Boolean(selectedCapabilityId.value)) + Number(Boolean(selectedTriggeredBy.value)));
interface SessionFilterItem {
  id: string;
  kind: "capability" | "triggeredBy";
  label: string;
  value: string;
}
const sessionFilterGroups = computed(() =>
  [
    {
      id: "capability",
      label: "Used capability",
      items: capabilityIds.value.map((id): SessionFilterItem => ({ id: `capability:${id}`, kind: "capability", label: capabilityLabel(id), value: id })),
    },
    {
      id: "triggeredBy",
      label: "Triggered by",
      items: triggeredByValues.value.map((name): SessionFilterItem => ({ id: `triggeredBy:${name}`, kind: "triggeredBy", label: name, value: name })),
    },
  ].filter((group) => group.items.length),
);
const selectedSessionFilters = computed(() =>
  sessionFilterGroups.value
    .flatMap((group) => group.items)
    .filter((item) => item.value === (item.kind === "capability" ? selectedCapabilityId.value : selectedTriggeredBy.value)),
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
const selectedRefreshable = computed(() =>
  selectedDisplay.value?.status === "pending" || selectedDisplay.value?.status === "running",
);
const selectedActions = computed(() => {
  const invocation = invocationView.value;
  const actions = record(record(detail.invocation.value)?.actions);
  if (!invocation?.agentName || !actions) return;
  const rerun = record(actions.rerun);
  const prompt = stringValue(rerun?.prompt);
  const invokerProfileId = stringValue(rerun?.invokerProfileId);
  return {
    agent: invocation.agentName,
    deletable: record(actions.delete)?.available === true,
    deleteUnavailableReason: stringValue(record(actions.delete)?.reason),
    id: invocation.id,
    rerun: (rerun?.available === true && prompt
      ? { available: true, prompt, ...(invokerProfileId ? { invokerProfileId } : {}) }
      : { available: false, reason: stringValue(rerun?.reason) ?? "unavailable" }) satisfies ConsoleSessionRerun,
  };
});
const selectedCancel = computed(() => {
  const invocation = invocationView.value;
  const actions = record(record(detail.invocation.value)?.actions);
  if (!invocation || record(actions?.cancel)?.available !== true) return;
  const summary = record(invocation);
  const notEnforcedBy = stringValue(summary?.cancelNotEnforcedBy);
  const cancel: {
    cancelRequested: boolean;
    id: string;
    notEnforcedBy?: string;
    terminal: boolean;
  } = {
    cancelRequested: Boolean(stringValue(summary?.cancelRequestedAt)),
    id: invocation.id,
    terminal: invocation.status !== "pending" && invocation.status !== "running",
  };
  if (notEnforcedBy) cancel.notEnforcedBy = notEnforcedBy;
  return cancel;
});
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

/** Opens or closes the details panel. It opens on the tab of the URL, Invocation by default. */
function toggleDetails(): void {
  detailsOpen.value = !detailsOpen.value;
  if (detailsOpen.value && !inspectorActiveSurface.value) showInspectorSurface();
}

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

// On desktop, the session navbar and the inspector move to another layout when the details panel is maximized or
// restored. Vue mounts new elements there, so keyboard focus would fall to the page body. Put it back on the same
// control, on the active inspector tab, or on the details toggle.
watch([detailsOpen, detailsMaximized], () => {
  const focused = document.activeElement;
  const panel = focused instanceof HTMLElement ? focused.closest(".vitehub-console__session-panel") : null;
  if (!isDesktop.value || !(focused instanceof HTMLElement) || !panel) return;
  const slot = focused.dataset.slot;
  void nextTick(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const same = detailsOpen.value && slot ? panel.querySelector(`[data-slot="${CSS.escape(slot)}"]`) : null;
    const tab = detailsOpen.value && slot !== "session-details-toggle" ? panel.querySelector(".session-inspector [aria-selected='true']") : null;
    const target = same ?? tab ?? panel.querySelector("[data-slot='session-details-toggle']");
    if (target instanceof HTMLElement) target.focus();
  });
});

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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invocationUsage(value: unknown): Record<string, unknown> | undefined {
  return record(record(value)?.usage);
}

// A channel thread ID such as `teams:19:…` repeats what the channel icon shows, so the row leaves it out.
function invocationListContext(invocation: Parameters<typeof agentInvocationContext>[0]): string | undefined {
  const context = agentInvocationContext(invocation);
  return invocation.channelId && context === invocation.threadId ? undefined : context;
}

function invocationCostDisplay(value: unknown): string | undefined {
  const cost = record(invocationUsage(value)?.cost);
  const usd = stringValue(cost?.usd);
  return usd ? formatConsoleUsageCost(usd, cost?.estimated === true) : stringValue(cost?.display);
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
    query: keptSessionQuery(),
  });
}

async function selectStartedInvocation(invocation: { agent: string; id: string }): Promise<void> {
  await selectInvocation(invocation);
  scheduleInvocationListRefresh();
}

const deletedInvocations = createConsoleInvocationDeletion();

async function removeDeletedInvocation(id: string): Promise<void> {
  const agentName = selectedAgentName.value;
  const selected = selectedInvocationId.value === id || routeInvocation.value === id;
  await deletedInvocations.remove(id, {
    clearSelection() {
      if (selected) {
        selectedInvocationId.value = undefined;
        closeDetails();
      }
    },
    async navigate() {
      if (selected && agentName) {
        await router.replace({
          name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
          params: { agent: encodeAgentRouteParam(agentName) },
          query: keptSessionQuery({ closeDetails: true }),
        });
      }
    },
    removeFromList() {
      list.invocations.value = deletedInvocations.exclude(list.invocations.value);
    },
    refresh: () => list.refresh().catch(() => undefined),
  });
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
    query: keptSessionQuery({ closeDetails: true }),
  });
  await nextTick();
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Test this Agent"]')?.focus();
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
  await refreshCapabilityFilteredInvocations({
    navigate: () =>
      selectedAgentName.value
        ? router.replace({
            name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
            params: { agent: encodeAgentRouteParam(selectedAgentName.value) },
            query: keptSessionQuery({ closeDetails: true }),
          })
        : Promise.resolve(),
    refresh: () => list.refresh(),
  });
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

/** Each group holds one value: a checked item replaces the other item of its group, and unchecking clears it. */
function updateSessionFilters(value: SessionFilterItem | SessionFilterItem[]): void {
  const items = Array.isArray(value) ? value : [value];
  const previous = new Set(selectedSessionFilters.value.map((item) => item.id));
  const added = items.find((item) => !previous.has(item.id));
  if (added?.kind === "capability") return selectCapability(added.value);
  if (added?.kind === "triggeredBy") return selectTriggeredBy(added.value);
  if (selectedCapabilityId.value && !items.some((item) => item.kind === "capability")) selectCapability(undefined);
  if (selectedTriggeredBy.value && !items.some((item) => item.kind === "triggeredBy")) selectTriggeredBy(undefined);
}

function toggleAgentList(): void {
  agentListOpen.value = !agentListOpen.value;
  rememberConsoleAgentListOpen(agentListOpen.value);
}

function clearSessionSearchAndFilters(): void {
  sessionSearch.value = "";
  resetSessionFilters();
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

// A filtered page can come back empty with a cursor. The list keeps reading, so "No sessions yet" means the end.
watch(
  () => [invocationItems.value.length, list.cursor.value, list.isLoading.value, list.isLoadingMore.value] as const,
  ([count, cursor, loading, loadingMore]) => {
    if (!count && cursor && !loading && !loadingMore) loadMoreSessions();
  },
);

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
    const catalog = resolveConsoleAgentCatalog(value);
    if (agentsRequest === controller) {
      agentNames.value = catalog.agents;
      historicalAgentNames.value = catalog.historicalAgents;
      const invocation = record(value?.invocation);
      agentInvocationOptions.value = Object.fromEntries(
        agentNames.value.flatMap((name) => {
          const options = record(resolveConsoleAgentInvocationOptions(invocation, name));
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
  [routeInvocation, routeAgent, () => list.invocations.value.find(invocation => !deletedInvocations.has(invocation.id)), selectedAgentName, isUsageRoute],
  async (
    [requestedInvocation, requestedAgent, firstInvocation, agentName, usageRoute],
  ) => {
    if (requestedInvocation && deletedInvocations.has(requestedInvocation)) {
      selectedInvocationId.value = undefined;
      return;
    }
    if (usageRoute) {
      newChatAgentName.value = undefined;
      initialBootstrapPending.value = false;
      selectedInvocationId.value = undefined;
      return;
    }
    if (requestedInvocation) newChatAgentName.value = undefined;
    if (requestedInvocation || requestedAgent) {
      initialBootstrapPending.value = false;
    }
    if (!requestedAgent && !agentName) {
      if (!firstInvocation) return;
      if (!firstInvocation.agentName) {
        initialBootstrapPending.value = false;
        return;
      }
      selectedInvocationId.value = firstInvocation.id;
      try {
        await router.replace({
          name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
          params: {
            agent: encodeAgentRouteParam(firstInvocation.agentName),
            invocation: firstInvocation.id,
          },
          query: currentSessionQuery(),
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
      requestedInvocation || (agentRouteReady ? firstInvocation?.id : undefined);
    if (!requestedInvocation && firstInvocation?.id && agentName && agentRouteReady) {
      await router.replace({
        name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
        params: {
          agent: encodeAgentRouteParam(agentName),
          invocation: firstInvocation.id,
        },
        query: currentSessionQuery(),
      });
    }
  },
  { immediate: true },
);

watch(
  [routeAgent, sessionAgentNames, isUsageRoute, initialBootstrapPending],
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
        query: currentSessionQuery(),
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
      query: keptSessionQuery({ closeDetails: true }),
    });
  },
);

watch(selectedInvocationId, () => {
  selectedActivityId.value = undefined;
  selectedDetailStatus.value = undefined;
  const identity = selectedInvocationId.value
    ? `${props.apiBase}/${selectedInvocationId.value}`
    : undefined;
  if (identity !== inspectorWorkspaceIdentity.value) {
    // A new session's URL omits the file. Back and Forward can restore one from the destination session.
    inspectorOpenPaths.value = inspectorSelectedPath.value ? [inspectorSelectedPath.value] : [];
    inspectorWorkspaceIdentity.value = identity;
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
    // Filter values scan every Invocation of the Agent. Load them for the open menu or to validate an active filter.
    if (filterOpen.value || selectedCapabilityId.value || selectedTriggeredBy.value) void loadCapabilityIds();
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
    <UDashboardSidebar
      v-if="!isUsageRoute"
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
        content: 'md:hidden w-[calc(100vw-0.75rem)] max-w-none',
        overlay: 'md:hidden',
      }"
      resizable
    >
      <template #header>
        <div class="vitehub-console__panel-title mx-2 min-w-0 flex-1">
          <span class="min-w-0 flex-1 truncate">Agents</span>
          <UTooltip v-if="newChatTargetName" text="New chat">
            <UButton
              aria-label="New chat"
              icon="i-lucide-square-pen"
              size="xs"
              square
              variant="ghost"
              @click="startNewChat"
            />
          </UTooltip>
          <UPopover
            v-if="!sessionsPanelError"
            v-model:open="filterOpen"
            :content="{ align: 'end', collisionPadding: 12 }"
            :ui="{ content: 'w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden p-0' }"
          >
            <!-- A dot on the funnel marks active filters; the Sessions label says how many. -->
            <UButton
              :aria-label="activeFilterCount ? `Filter sessions, ${activeFilterCount} active` : 'Filter sessions'"
              size="xs"
              square
              variant="ghost"
            >
              <UChip as="span" :show="activeFilterCount > 0" color="neutral" size="sm">
                <UIcon name="i-lucide-funnel" class="size-4" />
              </UChip>
            </UButton>
            <template #content>
              <!-- A select panel like GitHub's filters: search, then one checked value per group. -->
              <div class="flex h-10 items-center gap-2 border-b border-default ps-3 pe-1.5">
                <p class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">Filter sessions</p>
                <UButton
                  v-if="activeFilterCount"
                  label="Clear"
                  size="xs"
                  variant="ghost"
                  @click="resetSessionFilters"
                />
              </div>
              <div
                v-if="capabilitiesLoading"
                class="grid gap-1 p-2"
                aria-label="Loading session filters"
                role="status"
              >
                <USkeleton v-for="index in 4" :key="index" class="h-7" />
              </div>
              <div v-else-if="capabilitiesError" class="p-2">
                <ConsoleState compact :error="capabilitiesError" title="Could not load session filters" :retry="loadCapabilityIds" />
              </div>
              <UEmpty
                v-else-if="!sessionFilterGroups.length"
                variant="naked"
                size="xs"
                icon="i-lucide-list-filter"
                title="No filter values yet"
                description="Sessions record their Capabilities and who triggered them."
              />
              <UCommandPalette
                v-else
                by="id"
                :close="false"
                :groups="sessionFilterGroups"
                :model-value="selectedSessionFilters"
                multiple
                placeholder="Filter values…"
                selected-icon="i-lucide-check"
                size="sm"
                :ui="{ content: 'max-h-72' }"
                @update:model-value="updateSessionFilters"
              />
            </template>
          </UPopover>
        </div>
      </template>

      <template #default>
        <!-- A failure that covers the whole panel shows once, in the main area. -->
        <template v-if="!sessionsPanelError">
        <div v-if="!connectionUnavailable && agentsError" class="px-2 pb-3">
          <ConsoleState compact :error="agentsError" title="Could not load Agents" :retry="loadAgents" />
        </div>
        <section v-if="hasMultipleAgents" class="vitehub-console__agents shrink-0 px-1.5 pb-2">
          <h2 class="m-0">
            <UButton
              class="vitehub-console__section-toggle"
              data-focus-inset
              aria-controls="vitehub-console-agent-list"
              :aria-expanded="agentListOpen"
              block
              size="xs"
              trailing-icon="i-lucide-chevron-right"
              variant="ghost"
              @click="toggleAgentList"
            >
              <span>Agents</span>
              <span class="vitehub-console__section-count">{{ agentNames.length }}</span>
            </UButton>
          </h2>
          <ul
            v-show="agentListOpen"
            id="vitehub-console-agent-list"
            class="grid max-h-48 gap-px overflow-y-auto"
            aria-label="Agents"
          >
            <li v-for="name in agentRows.visible" :key="name">
              <button
                type="button"
                class="vitehub-console__agent-row"
                data-focus-inset
                :aria-current="name === selectedAgentName ? 'true' : undefined"
                :title="name"
                @click="selectAgent(name)"
              >
                <span class="vitehub-console__agent-dot" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate">{{ name }}</span>
              </button>
            </li>
            <li v-if="agentRows.hidden">
              <button
                type="button"
                class="vitehub-console__agent-row vitehub-console__agent-more"
                data-focus-inset
                @click="showAllAgents = true"
              >
                <span class="vitehub-console__agent-dot invisible" aria-hidden="true" />
                <span>Show {{ agentRows.hidden }} more</span>
              </button>
            </li>
          </ul>
        </section>
        <h2 v-if="!connectionUnavailable || invocationItems.length" class="vitehub-console__section-label vitehub-console__sessions-label m-0 shrink-0">
          <span>Sessions</span>
          <span v-if="selectedAgentName" class="vitehub-console__sessions-agent" :title="selectedAgentName">{{
            selectedAgentName
          }}</span>
          <span v-if="activeFilterCount" class="vitehub-console__section-count">{{
            activeFilterCount === 1 ? "1 filter" : `${activeFilterCount} filters`
          }}</span>
        </h2>
        <div v-if="list.invocations.value.length || sessionSearch" class="shrink-0 px-2 pb-1.5">
          <UInput
            v-model="sessionSearch"
            class="w-full"
            icon="i-lucide-search"
            placeholder="Search sessions…"
            aria-label="Search sessions by title or ID"
          />
        </div>
        <div
          v-if="(!connectionUnavailable && list.error.value) || list.loadMoreError.value"
          class="px-2"
        >
          <ConsoleState
            compact
            :error="(!connectionUnavailable && list.error.value) || list.loadMoreError.value"
            title="Could not load sessions"
            :retry="!connectionUnavailable && list.error.value ? list.refresh : undefined"
          />
          <UButton
            v-if="list.cursor.value && list.loadMoreError.value"
            class="mt-2"
            label="Retry loading older sessions"
            variant="outline"
            :loading="list.isLoadingMore.value"
            @click="list.loadMore"
          />
        </div>
        <div
          v-if="!connectionUnavailable && (agentsLoading || list.isLoading.value || (list.cursor.value && !list.loadMoreError.value)) && !invocationItems.length"
          class="grid gap-1 px-2"
          aria-label="Loading sessions"
          role="status"
        >
          <div
            class="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-2 rounded-md px-2 py-2.5"
          >
            <USkeleton class="mt-0.5 size-4" />
            <div class="grid min-w-0 gap-2">
              <div class="flex items-center justify-between gap-3">
                <USkeleton class="h-3 w-16" />
                <USkeleton class="h-3 w-14" />
              </div>
              <USkeleton class="h-4 w-full" />
              <USkeleton class="h-3 w-2/3" />
            </div>
          </div>
        </div>
        <AgentInvocationList
          v-if="
            (!list.isLoading.value || invocationItems.length) &&
            (!list.error.value || invocationItems.length) &&
            (!list.cursor.value || invocationItems.length)
          "
          class="vitehub-console__session-list min-h-0 flex-1 px-1.5 pb-3"
          :continuation-key="list.cursor.value"
          :has-more="Boolean(list.cursor.value)"
          :items="invocationItems"
          :loading="list.isLoading.value || list.isLoadingMore.value"
          group-by="recency"
          :now="nowMs"
          :selected-id="selectedInvocationId"
          @end-reached="loadMoreSessions"
          @select="selectInvocation($event)"
        >
          <template #loading />
          <template #footer>
            <div v-if="list.cursor.value && invocationItems.length" class="flex justify-center px-2 py-3">
              <UButton
                label="Load older sessions"
                size="xs"
                variant="ghost"
                :loading="list.isLoadingMore.value"
                @click="loadMoreSessions"
              />
            </div>
          </template>
          <template #empty
            ><UEmpty
              v-if="activeFilterCount || sessionSearch.trim()"
              class="px-4"
              icon="i-lucide-message-square-more"
              title="No matching sessions"
              :actions="[{ label: 'Clear filters', onClick: clearSessionSearchAndFilters }]" /><ConsoleState
              v-else
              section="agents"
              icon="i-lucide-message-square-more"
              title="No sessions yet"
              description="Invoke an Agent from your app or from this Console. Its session appears here."
          /></template>
        </AgentInvocationList>
        </template>
      </template>

    </UDashboardSidebar>

    <ConsoleSearch
      :actions="searchActions"
      :agent-names="agentNames"
      :historical-agent-names="historicalAgentNames"
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <ConsoleUsage v-if="isUsageRoute" :base="usageBase" @open-sessions="openSessionsFromUsage" />

    <UDashboardPanel
      v-else
      id="chat-session"
      class="vitehub-console__session-panel"
    >
      <template #body>
        <!-- No live region here: the thread is a log, and the connection state is an alert. A polite region around both made screen readers read the session again after each update. -->
        <div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
          <ConsoleConnectionState
            v-if="connectionUnavailable"
            :compact="Boolean(invocationView)"
            :retrying="refreshing"
            @retry="refresh"
            @open-sessions="sessionsOpen = true"
          />
          <div v-if="!connectionUnavailable || invocationView" class="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
            <ConsoleSessionNavbar
              v-if="!(isDesktop && selectedInvocationId)"
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
              @toggle-details="toggleDetails"
            >
              <template v-if="selectedActions || selectedCancel" #actions>
                <ConsoleSessionActions
                  v-if="selectedActions"
                  v-bind="selectedActions"
                  :agents-base="agentsBase"
                  :api-base="apiBase"
                  @deleted="removeDeletedInvocation"
                  @started="selectStartedInvocation"
                />
                <ConsoleSessionCancel
                  v-if="selectedCancel"
                  v-bind="selectedCancel"
                  :api-base="apiBase"
                  @cancelled="refresh"
                />
              </template>
            </ConsoleSessionNavbar>
          <!-- A selected session on a wide screen is one AgentSession: the header, the timeline, a details card, and a
               right panel of Workspace, Changes, Trace and Details. Its toggles keep their place when the panel opens. -->
          <ConsoleAgentSession
            v-if="isDesktop && selectedInvocationId"
            v-model:tab="inspectorTab"
            v-model:details="detailsView"
            v-model:selected-path="inspectorSelectedPath"
            class="min-h-0 flex-1"
            :invocation="invocationView"
            :loading="detail.isLoading.value || initialSessionLoading"
            :error="connectionUnavailable ? undefined : detail.error.value"
            :title="selectedTitle"
            :project="hasMultipleAgents ? selectedProject : ''"
            :workspace-base="apiBase"
            :selected-activity-id="selectedActivityId"
            @focus-activity="selectActivity"
            @refresh="refresh"
          >
            <template #actions>
              <UTooltip v-if="selectedExternalUrl" text="Open related page">
                <UButton :to="selectedExternalUrl" target="_blank" icon="i-lucide-external-link" color="neutral" variant="ghost" size="xs" aria-label="Open related page" />
              </UTooltip>
              <ConsoleSessionActions
                v-if="selectedActions"
                v-bind="selectedActions"
                :agents-base="agentsBase"
                :api-base="apiBase"
                @deleted="removeDeletedInvocation"
                @started="selectStartedInvocation"
              />
              <ConsoleSessionCancel
                v-if="selectedCancel"
                v-bind="selectedCancel"
                :api-base="apiBase"
                @cancelled="refresh"
              />
              <UTooltip v-if="selectedRefreshable" text="Refresh session">
                <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="xs" :loading="refreshing" aria-label="Refresh session" @click="refresh" />
              </UTooltip>
            </template>
          </ConsoleAgentSession>
          <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ConsoleSessionLoading v-if="initialSessionLoading" class="min-h-0 flex-1" />
            <ConsoleState
              v-else-if="!selectedInvocationId && sessionsPanelError"
              :error="sessionsPanelError"
              :title="sessionsSignInError ? 'Sign in to see Agent sessions' : 'Could not load Agents or sessions'"
              :retry="refresh"
            />
            <div v-else-if="!selectedInvocationId" class="min-h-0 flex-1" />
            <ConsoleState
              v-else-if="detail.error.value && !invocationView"
              :error="detail.error.value"
              title="Could not load this session"
              :retry="refresh"
            />
            <ConsoleSessionLoading
              v-else-if="detail.isLoading.value && !invocationView"
              class="min-h-0 flex-1"
            />
            <div v-else-if="invocationView" class="flex min-h-0 flex-1 flex-col">
              <div v-if="!connectionUnavailable && detail.error.value" class="m-3 shrink-0">
                <ConsoleState compact :error="detail.error.value" title="Could not refresh this session" :retry="refresh" />
              </div>
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
              v-if="selectedAgentName && selectedAgentInvocation && !selectedInvocationId && !sessionsPanelError"
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
                :workspace-base="apiBase"
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
</template>

<style>
.vitehub-console {
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
  border-inline-end: 1px solid var(--ui-border);
}

.vitehub-console__sessions [data-slot="header"] {
  min-height: 2.75rem;
}

/* Section labels are quiet sentence-case text with a count, like the labels on onmax.me. */
.vitehub-console__section-label {
  align-items: center;
  color: var(--ui-text-dimmed);
  display: flex;
  font-size: 0.75rem;
  font-weight: 400;
  gap: 0.375rem;
  height: 1.75rem;
  min-width: 0;
  padding-inline: 0.625rem;
  width: 100%;
}

.vitehub-console__section-toggle {
  justify-content: flex-start;
}

.vitehub-console__section-toggle [data-slot="trailingIcon"] {
  transition: transform 150ms ease-out;
}

.vitehub-console__section-toggle[aria-expanded="true"] [data-slot="trailingIcon"] {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: reduce) {
  .vitehub-console__section-toggle [data-slot="trailingIcon"] {
    transition: none;
  }
}

.vitehub-console__section-count {
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  text-transform: none;
}

.vitehub-console__sessions-label {
  padding-inline: 1rem 1rem;
}

.vitehub-console__sessions-agent {
  color: var(--ui-text-dimmed);
  flex: 1;
  letter-spacing: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: none;
  white-space: nowrap;
}

.vitehub-console__agent-row {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-toned);
  cursor: pointer;
  display: flex;
  font-size: 0.8125rem;
  gap: 0.625rem;
  height: 1.875rem;
  padding-inline: 0.625rem;
  text-align: start;
  width: 100%;
}

/* Agent rows are a list of rows, like the section rows of the frame: they change at once, without a transition. */
.vitehub-console__agent-row:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

.vitehub-console__agent-row[aria-current="true"] {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

.vitehub-console__agent-dot {
  background: var(--ui-text-dimmed);
  border-radius: 999px;
  flex: none;
  height: 0.375rem;
  opacity: 0.7;
  width: 0.375rem;
}

[aria-current="true"] > .vitehub-console__agent-dot {
  background: var(--ui-primary);
  opacity: 1;
}

.vitehub-console__agent-more {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
}

/* Recency headings sit under the Sessions label and use the same sentence case. */
.vitehub-console__session-list .vh-invocation-list__group-heading {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0;
  min-height: 1.5rem;
  padding: 0.5rem 0.625rem 0.125rem;
  text-transform: none;
}

.vitehub-console__session-list .vh-invocation-list__groups {
  gap: 0.375rem;
}

.vitehub-console__sessions .vh-invocation-list__item[aria-current="true"] {
  background: var(--ui-bg-accented);
}

.vitehub-console__session-panel > [data-slot="body"] {
  gap: 0 !important;
  padding: 0 !important;
}

.vitehub-console__session-navbar {
  background: var(--ui-bg) !important;
  height: 2.75rem !important;
  min-height: 2.75rem !important;
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
