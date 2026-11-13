<script setup lang="ts">
import {
  AgentSession,
  AgentSessionDetailsRow,
  AgentSessionDetailsSection,
  type AgentSessionSurface,
} from "@vite-hub/ui";
import { computed, ref, watch } from "vue";
import { AgentInvocation, invocationActivities, type AgentInvocationView } from "./invocation";
import ConsoleSessionCopyLink from "./console-session-copy-link.vue";
import ConsoleSessionInspector from "./console-session-inspector.vue";
import ConsoleSessionLoading from "./console-session-loading.vue";
import ConsoleState from "./console-state.vue";
import { invocationBrand, invocationBrandMark, invocationModelMaker, invocationModelName } from "./invocation/internal/invocation-brand";

type SurfaceId = "workspace" | "diff" | "trace" | "capabilities" | "details";

const props = defineProps<{
  invocation?: AgentInvocationView;
  loading: boolean;
  error?: unknown;
  title: string;
  project?: string;
  workspaceBase?: string;
  selectedActivityId?: string;
}>();
const emit = defineEmits<{ focusActivity: [activityId: string]; refresh: [] }>();
/** The Workspace file that the URL names. */
const selectedPath = defineModel<string | undefined>("selectedPath");
const tab = defineModel<SurfaceId>("tab", { default: "details" });
const details = defineModel<"closed" | "open" | "max">("details", { default: "closed" });
// The launcher has no surface ID. Keep the last URL tab for reopening the panel.
const launcherOpen = ref(false);
const surface = computed(() => launcherOpen.value ? null : tab.value);
watch([tab, details], () => { launcherOpen.value = false; });
const panelOpen = computed({
  get: () => details.value !== "closed",
  set: (open: boolean) => { details.value = open ? details.value === "max" ? "max" : "open" : "closed"; },
});
const maximized = computed({
  get: () => details.value === "max",
  set: (value: boolean) => { details.value = value ? "max" : details.value === "closed" ? "closed" : "open"; },
});
function selectSurface(id: string | null) {
  if (id === null) launcherOpen.value = true;
  else if (surfaces.value.some(surface => surface.id === id)) {
    launcherOpen.value = false;
    tab.value = id as SurfaceId;
  }
}

const session = ref<InstanceType<typeof AgentSession> & { openSurface: (id: string) => void }>();

const surfaces = computed<AgentSessionSurface[]>(() => {
  const invocation = props.invocation;
  const items: AgentSessionSurface[] = [];
  if (props.workspaceBase) items.push({ id: "workspace", label: "Workspace", icon: "i-lucide-folder-tree", shortcut: "w" });
  if (invocation && invocationActivities(invocation).some(activity => activity.patches.length))
    items.push({ id: "diff", label: "Changes", icon: "i-lucide-git-compare-arrows", shortcut: "c" });
  items.push({ id: "trace", label: "Trace", icon: "i-lucide-list-tree", shortcut: "t" });
  if (invocation?.configuration?.capabilities?.length)
    items.push({ id: "capabilities", label: "Capabilities", icon: "i-lucide-blocks", shortcut: "a" });
  items.push({ id: "details", label: "Details", icon: "i-lucide-info", shortcut: "d" });
  return items;
});

function openWorkspace(path?: string) {
  if (path) selectedPath.value = path;
  session.value?.openSurface("workspace");
}
defineExpose({ openWorkspace, openSurface: (id: SurfaceId) => session.value?.openSurface(id) });

function inspect(target: "agent" | "workspace", path?: string) {
  if (target === "workspace") openWorkspace(path);
  else session.value?.openSurface("details");
}

// Only the Workspace surface follows the URL's file. The other views would load the file for nothing.
const workspaceModel = computed(() => ({
  selectedPath: selectedPath.value,
  "onUpdate:selectedPath": (path: string | undefined) => (selectedPath.value = path),
}));

const configuration = computed(() => props.invocation?.configuration);
const usage = computed(() => props.invocation?.usage);
const compact = new Intl.NumberFormat("en", { maximumFractionDigits: 1, notation: "compact" });
const tokens = (value: number | undefined) => value === undefined || value <= 0 ? undefined : compact.format(value);
const statusLabels: Record<AgentInvocationView["status"], string> = {
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
  pending: "Queued",
  running: "Working",
};
const statusIcons: Record<AgentInvocationView["status"], string> = {
  cancelled: "i-lucide-circle-slash",
  completed: "i-lucide-circle-check",
  failed: "i-lucide-circle-x",
  pending: "i-lucide-circle-dashed",
  running: "i-lucide-loader-circle",
};
const duration = computed(() => {
  const invocation = props.invocation;
  const end = invocation?.completedAt ?? invocation?.failedAt ?? invocation?.cancelledAt;
  if (!invocation?.startedAt || !end) return;
  const seconds = Math.round((Date.parse(end) - Date.parse(invocation.startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
});
const cost = computed(() => {
  const value = usage.value?.cost;
  if (!value) return;
  // The label says when the cost is an estimate, so the value is the amount alone, in cents.
  const usd = Number(value.usd);
  return value.usd && Number.isFinite(usd) ? `$${usd >= 0.01 ? usd.toFixed(2) : usd.toPrecision(2)}` : value.display;
});
const model = computed(() => configuration.value?.driver?.model?.id);
const harness = computed(() => invocationBrand(configuration.value?.driver?.kind ?? configuration.value?.driver?.provider));
const maker = computed(() => invocationModelMaker(model.value));
// The brand marks are Vue nodes, so the rows take them as small render functions.
const harnessMark = () => invocationBrandMark(harness.value, "vh-agent-session__row-icon");
const makerMark = () => invocationBrandMark(maker.value, "vh-agent-session__row-icon");
const skills = computed(() => configuration.value?.skills ?? []);
const mcpServers = computed(() => configuration.value?.mcpServers ?? []);
const changedFiles = computed(() => {
  const invocation = props.invocation;
  if (!invocation) return 0;
  const files = new Set<string>();
  for (const activity of invocationActivities(invocation))
    for (const path of activity.paths) files.add(path);
  return files.size;
});
</script>

<template>
  <AgentSession
    ref="session"
    v-model:panel-open="panelOpen"
    v-model:maximized="maximized"
    class="console-agent-session"
    :title="title"
    :surfaces="surfaces"
    :surface="surface"
    storage-key="vitehub-console:session-layout"
    :default-panel-open="false"
    @update:surface="selectSurface"
  >
    <template #heading>
      <span v-if="project" class="hidden max-w-40 shrink-0 truncate text-sm text-muted sm:inline">{{ project }}</span>
      <span v-if="project" class="hidden text-sm text-dimmed sm:inline" aria-hidden="true">/</span>
      <h2 class="vh-agent-session__title">{{ title }}</h2>
    </template>

    <template #actions>
      <ConsoleSessionCopyLink />
      <slot name="actions" />
    </template>

    <template #body>
      <div class="console-agent-session__body">
        <div v-if="invocation && error" class="m-3 shrink-0">
          <ConsoleState compact :error="error" title="Could not refresh this session" :retry="() => emit('refresh')" />
        </div>
        <ConsoleSessionLoading v-if="loading && !invocation" class="min-h-0 flex-1" />
        <ConsoleState
          v-else-if="error && !invocation"
          :error="error"
          title="Could not load this session"
          :retry="() => emit('refresh')"
        />
        <AgentInvocation
          v-else-if="invocation"
          :header="false"
          :invocation="invocation"
          :selected-activity-id="selectedActivityId"
          :workspace-inspectable="true"
          class="min-h-0 flex-1"
          @inspect="inspect"
        />
      </div>
    </template>

    <template v-if="invocation" #details>
      <AgentSessionDetailsSection title="Session">
        <AgentSessionDetailsRow :icon="statusIcons[invocation.status]" label="Status" :value="statusLabels[invocation.status]" :tone="invocation.status === 'failed' ? 'error' : 'default'" />
        <AgentSessionDetailsRow v-if="duration" icon="i-lucide-timer" label="Duration" :value="duration" />
        <AgentSessionDetailsRow
          v-if="changedFiles"
          icon="i-lucide-file-diff"
          label="Changed files"
          :value="changedFiles"
          @click="session?.openSurface('diff')"
        />
      </AgentSessionDetailsSection>
      <AgentSessionDetailsSection v-if="model || harness || skills.length || mcpServers.length" title="Agent">
        <AgentSessionDetailsRow v-if="model" :icon="maker ? undefined : 'i-lucide-cpu'" :label="invocationModelName(model)" :title="model">
          <template v-if="maker" #icon><component :is="makerMark" /></template>
        </AgentSessionDetailsRow>
        <AgentSessionDetailsRow v-if="harness && harness.label !== maker?.label" :icon="harness.id === 'fallback' ? 'i-lucide-bot' : undefined" :label="harness.label" value="Harness">
          <template v-if="harness.id !== 'fallback'" #icon><component :is="harnessMark" /></template>
        </AgentSessionDetailsRow>
        <AgentSessionDetailsRow
          v-if="skills.length"
          icon="i-lucide-sparkles"
          label="Skills"
          :value="skills.length"
          :title="skills.map(skill => skill.name).join(', ')"
          @click="session?.openSurface('details')"
        />
        <AgentSessionDetailsRow
          v-if="mcpServers.length"
          icon="i-lucide-plug"
          label="MCP servers"
          :value="mcpServers.map(server => server.name).join(', ')"
        />
      </AgentSessionDetailsSection>
      <AgentSessionDetailsSection v-if="usage" title="Usage">
        <AgentSessionDetailsRow
          v-if="cost"
          icon="i-lucide-coins"
          :label="usage.cost?.estimated ? 'Estimated cost' : 'Cost'"
          :value="cost"
          :title="usage.cost?.source ? `Prices from ${usage.cost.source}` : undefined"
        />
        <AgentSessionDetailsRow v-if="tokens(usage.inputTokens)" icon="i-lucide-arrow-down-to-line" label="Input" :value="tokens(usage.inputTokens)" />
        <AgentSessionDetailsRow v-if="tokens(usage.cachedInputTokens)" icon="i-lucide-database" label="Cached input" :value="tokens(usage.cachedInputTokens)" />
        <AgentSessionDetailsRow v-if="tokens(usage.outputTokens)" icon="i-lucide-arrow-up-from-line" label="Output" :value="tokens(usage.outputTokens)" />
        <AgentSessionDetailsRow v-if="tokens(usage.reasoningTokens)" icon="i-lucide-brain" label="Reasoning" :value="tokens(usage.reasoningTokens)" />
      </AgentSessionDetailsSection>
      <AgentSessionDetailsSection>
        <AgentSessionDetailsRow icon="i-lucide-sliders-horizontal" label="All details" @click="session?.openSurface('details')" />
      </AgentSessionDetailsSection>
    </template>

    <template #surface="{ surface }">
      <ConsoleSessionInspector
        v-if="invocation"
        :key="`${invocation.id}:${surface.id}`"
        v-bind="surface.id === 'workspace' ? workspaceModel : {}"
        class="console-agent-session__surface"
        :invocation="invocation"
        :view="surface.id as SurfaceId"
        :maximizable="false"
        :workspace-base="workspaceBase"
        @focus-activity="emit('focusActivity', $event)"
      />
    </template>
  </AgentSession>
</template>

<style>
.console-agent-session__body {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

/* The timeline keeps clear of an inline details card, like AgentSession's own lane. */
.console-agent-session .vh-invocation-thread {
  padding-inline-end: var(--vh-agent-session-inset-end, 0);
}

.console-agent-session__surface {
  flex: 1 1 0;
  min-height: 0;
}

.console-agent-session__surface[data-single-view] {
  border-inline-start: 0;
}
</style>
