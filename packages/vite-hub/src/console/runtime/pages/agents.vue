<script setup lang="ts">
import { AgentInvocation, AgentInvocationInspector, AgentInvocationList } from "@vite-hub/ui";
import { useAgentInvocation, useAgentInvocations } from "vite-hub/agent/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { SplitterItem } from "@nuxt/ui";
import type {
  AgentInvocationConfiguration,
  AgentInvocationListItem,
  AgentInvocationView,
} from "@vite-hub/ui";

const route = useRoute();
const router = useRouter();
const selectedInvocationId = ref<string>();
const paginationRetryRevision = ref(0);
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

const request = async (path: string, options: { signal?: AbortSignal }): Promise<unknown> => {
  const response = await fetch(path, { signal: options.signal });
  if (!response.ok) throw new Error(`Console request failed with status ${response.status}.`);
  return response.json();
};
const recordSuccessfulPoll = () => {
  lastSuccessfulPollAt.value = new Date();
};

const list = useAgentInvocations({
  baseURL: apiBase,
  onSuccess: recordSuccessfulPoll,
  pollInterval: 5_000,
  request,
  requestSummaries: request,
});
const detail = useAgentInvocation(selectedInvocationId, {
  baseURL: apiBase,
  onSuccess: recordSuccessfulPoll,
  pollInterval: 3_000,
  request,
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
const routeInvocation = computed(() => {
  const value = route.params.invocation;
  return Array.isArray(value) ? value[0] : value;
});
const selectedSummary = computed(() =>
  list.invocations.value.find((invocation) => invocation.id === selectedInvocationId.value),
);
const invocationView = computed<AgentInvocationView | undefined>(() => {
  const invocation = detail.invocation.value;
  if (!invocation || invocation.id !== selectedInvocationId.value) return;
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

async function selectInvocation(id: string): Promise<void> {
  sessionsOpen.value = false;
  await router.push({ name: "vitehub-console-agents", params: { invocation: id } });
}

async function refresh(): Promise<void> {
  await Promise.all([
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

watch(
  [routeInvocation, () => list.invocations.value[0]?.id],
  async ([requestedInvocation, firstInvocation]) => {
    selectedInvocationId.value = requestedInvocation || firstInvocation;
    if (!requestedInvocation && firstInvocation) {
      await router.replace({
        name: "vitehub-console-agents",
        params: { invocation: firstInvocation },
      });
    }
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
          <span class="text-xs text-dimmed">{{ invocationItems.length }}</span>
        </div>
        <div v-if="!collapsed && errorMessage(list.error.value)" class="px-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Could not load sessions"
            :description="errorMessage(list.error.value)"
          />
          <UButton
            v-if="invocationItems.length && list.cursor.value"
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
                @click="selectInvocation(invocation.id)"
            /></UTooltip>
          </div>
        </div>
        <AgentInvocationList
          v-else-if="
            (!list.isLoading.value || invocationItems.length) &&
            (!errorMessage(list.error.value) || invocationItems.length)
          "
          class="min-h-0 flex-1 px-1 pb-3"
          :has-more="Boolean(list.cursor.value)"
          :items="invocationItems"
          :loading="list.isLoadingMore.value"
          :now="nowMs"
          :retry-key="paginationRetryRevision"
          :selected-id="selectedInvocationId"
          @end-reached="list.loadMore()"
          @select="selectInvocation($event.id)"
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
              ><AgentInvocation :invocation="invocationView" class="h-full"
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
