<script setup lang="ts">
import { AgentInvocation, AgentInvocationInspector } from "@vite-hub/ui";
import { useAgentInvocation, useAgentInvocations } from "vite-hub/agent/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { createConsoleRequest } from "../request.ts";

import type { SplitterItem } from "@nuxt/ui";
import type { AgentInvocationSummary } from "vite-hub/agent";
import type { AgentInvocationConfiguration, AgentInvocationView } from "@vite-hub/ui";

type ConsoleSession = {
  agentName?: string;
  id: string;
  invocations: AgentInvocationSummary[];
  updatedAt: string;
};

const route = useRoute();
const router = useRouter();
const selectedInvocationId = ref<string>();
const lastSuccessfulPollAt = ref<Date>();
const nowMs = ref(Date.now());
const sessionsOpen = ref(false);
const sessionsCollapsed = ref(false);
const detailsOpen = ref(false);
const isDesktop = ref(false);
const appBaseURL = useRuntimeConfig().app.baseURL.replace(/\/+$/, "");
const apiBase = `${appBaseURL}/api/_vitehub/console/invocations`;
let clock: ReturnType<typeof setInterval> | undefined;
let media: MediaQueryList | undefined;

useHead({ title: "Agents · ViteHub Console" });

const request = createConsoleRequest(() => {
  lastSuccessfulPollAt.value = new Date();
});

const list = useAgentInvocations({ baseURL: apiBase, pollInterval: 5_000, request });
const detail = useAgentInvocation(selectedInvocationId, {
  baseURL: apiBase,
  pollInterval: 3_000,
  request,
});

const sessions = computed<ConsoleSession[]>(() => {
  const grouped = new Map<string, ConsoleSession>();
  for (const invocation of list.invocations.value) {
    const id = invocation.threadId || invocation.id;
    const session = grouped.get(id);
    if (session) session.invocations.push(invocation);
    else
      grouped.set(id, {
        agentName: invocation.agentName,
        id,
        invocations: [invocation],
        updatedAt: invocation.updatedAt,
      });
  }
  return [...grouped.values()];
});

const routeSession = computed(() => {
  const value = route.params.session;
  return Array.isArray(value) ? value[0] : value;
});
const selectedSession = computed(() =>
  sessions.value.find((session) => session.id === routeSession.value),
);
const invocationView = computed<AgentInvocationView | undefined>(() => {
  const invocation = detail.invocation.value;
  if (!invocation) return;
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

function relativeDuration(elapsed: number): string {
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  return `${Math.floor(elapsed / 3_600_000)}h`;
}

function relativeTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const elapsed = nowMs.value - date.valueOf();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
}

function runLabel(invocation: AgentInvocationSummary): string {
  const date = new Date(invocation.createdAt);
  return Number.isNaN(date.valueOf())
    ? invocation.createdAt
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function sessionStatus(session: ConsoleSession): AgentInvocationSummary["status"] {
  if (session.invocations.some((invocation) => invocation.status === "running")) return "running";
  if (session.invocations.some((invocation) => invocation.status === "pending")) return "pending";
  return session.invocations[0]?.status ?? "pending";
}

function sessionLabel(session: ConsoleSession): string {
  const name = session.agentName || "Agent session";
  return `${name} · ${session.id.slice(0, 8)}`;
}

function statusIcon(status: AgentInvocationSummary["status"]): string {
  if (status === "running") return "i-lucide-loader-circle";
  if (status === "completed") return "i-lucide-check";
  if (status === "failed") return "i-lucide-x";
  return "i-lucide-clock-3";
}

function statusColor(status: AgentInvocationSummary["status"]): string {
  if (status === "running") return "text-info";
  if (status === "completed") return "text-success";
  if (status === "failed") return "text-error";
  return "text-dimmed";
}

async function selectSession(session: ConsoleSession): Promise<void> {
  sessionsOpen.value = false;
  await router.push({ name: "vitehub-console-agents", params: { session: session.id } });
}

async function refresh(): Promise<void> {
  await Promise.all([
    list.refresh(),
    selectedInvocationId.value ? detail.refresh() : Promise.resolve(),
  ]);
}

function updateDesktop(event?: MediaQueryListEvent): void {
  isDesktop.value = event?.matches ?? media?.matches ?? false;
}

watch(
  sessions,
  async (next) => {
    const requestedSession = routeSession.value;
    const requestedSessionMissing =
      requestedSession && !next.some((session) => session.id === requestedSession);
    if (next.length && (!requestedSession || (requestedSessionMissing && !list.cursor.value)))
      await selectSession(next[0]!);
  },
  { immediate: true },
);

watch(
  selectedSession,
  (session) => {
    selectedInvocationId.value = session?.invocations.some(
      (invocation) => invocation.id === selectedInvocationId.value,
    )
      ? selectedInvocationId.value
      : session?.invocations[0]?.id;
  },
  { immediate: true },
);

onMounted(() => {
  media = window.matchMedia("(min-width: 1024px)");
  updateDesktop();
  media.addEventListener("change", updateDesktop);
  clock = setInterval(() => {
    nowMs.value = Date.now();
  }, 1_000);
});

onBeforeUnmount(() => {
  if (clock) clearInterval(clock);
  media?.removeEventListener("change", updateDesktop);
});
</script>

<template>
  <UDashboardGroup unit="rem" storage-key="vitehub-agent-console">
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
        <NuxtLink
          class="flex min-w-0 items-center gap-2.5 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-primary"
          to="/_vitehub/agents"
        >
          <span
            class="grid size-7 shrink-0 grid-cols-3 items-end gap-0.5 rounded-md bg-highlighted p-1.5"
            aria-hidden="true"
            ><i class="h-2/3 bg-inverted" /><i class="h-full bg-primary" /><i
              class="h-4/5 bg-inverted"
          /></span>
          <span v-if="!collapsed" class="grid min-w-0 leading-none"
            ><small class="text-[10px] font-bold uppercase tracking-[.12em] text-muted"
              >ViteHub</small
            ><strong class="mt-1 truncate text-sm font-semibold text-highlighted"
              >Console</strong
            ></span
          >
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <div v-if="!collapsed" class="flex items-end justify-between px-4 pb-3 pt-5">
          <div>
            <span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted"
              >Agent activity</span
            >
            <h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Sessions</h1>
          </div>
          <span class="text-xs text-dimmed">{{ sessions.length }}</span>
        </div>
        <div v-if="!collapsed && errorMessage(list.error.value)" class="px-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Could not load sessions"
            :description="errorMessage(list.error.value)"
          />
        </div>
        <div v-if="!collapsed && list.isLoading.value && !sessions.length" class="grid gap-2 px-3">
          <USkeleton v-for="index in 4" :key="index" class="h-16 rounded-lg" />
        </div>
        <UEmpty
          v-else-if="!collapsed && !sessions.length && !errorMessage(list.error.value)"
          class="px-4"
          icon="i-lucide-message-square-dashed"
          title="No sessions yet"
          description="The first Agent Invocation will appear here."
        />

        <UScrollArea v-if="collapsed || sessions.length" class="min-h-0 flex-1">
          <nav class="space-y-1 px-2 pb-4" aria-label="Agent sessions">
            <template v-for="session in sessions" :key="session.id">
              <UTooltip
                v-if="collapsed"
                :text="session.agentName || 'Agent session'"
                :content="{ side: 'right' }"
                ><UButton
                  :icon="statusIcon(sessionStatus(session))"
                  :color="sessionStatus(session) === 'failed' ? 'error' : 'neutral'"
                  :variant="selectedSession?.id === session.id ? 'soft' : 'ghost'"
                  block
                  :aria-label="session.agentName || 'Agent session'"
                  @click="selectSession(session)"
              /></UTooltip>
              <div v-else>
                <button
                  type="button"
                  class="group flex w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary"
                  :class="
                    selectedSession?.id === session.id
                      ? 'border-default bg-default shadow-xs'
                      : 'border-transparent hover:bg-elevated/60'
                  "
                  @click="selectSession(session)"
                >
                  <span
                    class="flex size-7 shrink-0 items-center justify-center rounded-md bg-elevated"
                    ><UIcon
                      :name="statusIcon(sessionStatus(session))"
                      class="size-3.5"
                      :class="[
                        statusColor(sessionStatus(session)),
                        sessionStatus(session) === 'running' ? 'animate-spin' : undefined,
                      ]"
                  /></span>
                  <span class="min-w-0 flex-1"
                    ><strong class="block truncate text-sm font-medium text-highlighted">{{
                      sessionLabel(session)
                    }}</strong
                    ><span class="mt-0.5 block truncate text-xs text-muted"
                      >{{ session.invocations.length }} run{{
                        session.invocations.length === 1 ? "" : "s"
                      }}</span
                    ></span
                  >
                  <time class="shrink-0 text-xs text-dimmed">{{
                    relativeTime(session.updatedAt)
                  }}</time>
                </button>
                <div
                  v-if="selectedSession?.id === session.id"
                  class="ml-8 mt-1 space-y-px border-l border-default pl-2"
                  aria-label="Session invocations"
                >
                  <button
                    v-for="invocation in session.invocations"
                    :key="invocation.id"
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs outline-none hover:bg-elevated/60 focus-visible:ring-2 focus-visible:ring-primary"
                    :class="
                      selectedInvocationId === invocation.id
                        ? 'bg-elevated text-highlighted'
                        : 'text-muted'
                    "
                    :aria-pressed="selectedInvocationId === invocation.id"
                    @click="selectedInvocationId = invocation.id"
                  >
                    <UIcon
                      :name="statusIcon(invocation.status)"
                      class="size-3"
                      :class="[
                        statusColor(invocation.status),
                        invocation.status === 'running' ? 'animate-spin' : undefined,
                      ]"
                    /><span class="min-w-0 flex-1 truncate">Run {{ runLabel(invocation) }}</span
                    ><small class="capitalize text-dimmed">{{ invocation.status }}</small>
                  </button>
                </div>
              </div>
            </template>
          </nav>
        </UScrollArea>
        <div v-if="!collapsed && list.cursor.value" class="px-3 pb-2">
          <UButton
            block
            color="neutral"
            label="Load older"
            size="sm"
            variant="ghost"
            :loading="list.isLoadingMore.value"
            @click="list.loadMore"
          />
        </div>
      </template>

      <template #footer="{ collapsed, collapse }">
        <template v-if="!collapsed"
          ><span class="flex items-center gap-1.5 text-xs text-muted"
            ><UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only</span
          ><span class="ml-auto text-xs" :class="syncStale ? 'text-warning' : 'text-dimmed'">{{
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

    <UDashboardPanel id="agent-session">
      <div class="min-h-0 flex-1" aria-live="polite">
        <div
          v-if="!selectedSession"
          class="flex h-full items-center justify-center p-8 text-sm text-muted"
        >
          Select a session to inspect its work.
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
              ><AgentInvocation :invocation="invocationView" class="h-full"
                ><template #title>{{ selectedSession.agentName || "Agent session" }}</template
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
              ><AgentInvocationInspector :invocation="invocationView" class="h-full"
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
          <AgentInvocation v-else :invocation="invocationView" class="min-h-0 flex-1"
            ><template #title>{{ selectedSession.agentName || "Agent session" }}</template
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
              ><AgentInvocationInspector :invocation="invocationView" class="h-full"
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
  </UDashboardGroup>
</template>
