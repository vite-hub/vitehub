<script setup lang="ts">
import { AgentFileTree, AgentInvocationInspector, type AgentInvocationView } from "@vite-hub/ui";
import type { DropdownMenuItem, TabsItem } from "@nuxt/ui";
import { Diagnostic } from "nostics";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import ConsoleSessionCodePreview from "./console-session-code-preview.vue";
import ConsoleSessionTrace from "./console-session-trace.vue";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

type InspectorTab = "details" | "trace" | "workspace";
type WorkspaceDescriptor = {
  paths: string[];
  pullRequest?: number;
  repository: string;
  revision: string;
};
type WorkspaceFile = { content: string; path: string; revision: string; size: number };

const props = withDefaults(
  defineProps<{
    invocation: AgentInvocationView;
    maximized?: boolean;
    maximizable?: boolean;
    workspaceBase?: string;
  }>(),
  { maximized: false, maximizable: true },
);
const emit = defineEmits<{ close: []; focusActivity: [activityId: string]; toggleMaximized: [] }>();
const tab = defineModel<InspectorTab>("tab", { default: "details" });
const activeSurface = defineModel<string>("activeSurface", { default: "view:details" });
const openViews = defineModel<InspectorTab[]>("openViews", { default: () => ["details"] });
const openPaths = defineModel<string[]>("openPaths", { default: () => [] });
const selectedPath = defineModel<string | undefined>("selectedPath");
const workspace = ref<WorkspaceDescriptor>();
const workspaceError = ref<string>();
const workspaceLoading = ref(false);
const file = ref<WorkspaceFile>();
const fileError = ref<string>();
const fileLoading = ref(false);
const viewMeta: Record<
  InspectorTab,
  { description: string; icon: string; label: string; shortcut: string }
> = {
  details: {
    description: "Review the run, runtime, and identifiers.",
    icon: "i-lucide-circle-dot",
    label: "Invocation",
    shortcut: "I",
  },
  trace: {
    description: "Follow spans, timings, and recorded attributes.",
    icon: "i-lucide-list-tree",
    label: "Trace",
    shortcut: "T",
  },
  workspace: {
    description: "Browse the mounted Agent workspace.",
    icon: "i-lucide-folder-tree",
    label: "Workspace",
    shortcut: "W",
  },
};
const inspectorViews = computed<InspectorTab[]>(() => [
  "details",
  "trace",
  ...(props.workspaceBase ? (["workspace"] as const) : []),
]);
const treeOpen = ref(true);
const tabstrip = ref<HTMLElement>();
const filesPanel = ref<HTMLElement>();
let workspaceRequest: AbortController | undefined;
let workspaceLoad: Promise<void> | undefined;
let fileRequest: AbortController | undefined;

onBeforeUnmount(() => {
  workspaceRequest?.abort();
  fileRequest?.abort();
});

const workspaceLabel = computed(() =>
  workspace.value
    ? `${workspace.value.repository}@${workspace.value.revision.slice(0, 7)}`
    : "Agent Workspace",
);
const invocationUsage = computed(() => record(props.invocation)?.usage);
const breadcrumbs = computed(() => selectedPath.value?.split("/") ?? []);
type InspectorSurfaceItem = TabsItem & {
  icon: string;
  kind: "file" | "view";
  path?: string;
  view?: InspectorTab;
};
const surfaceItems = computed<InspectorSurfaceItem[]>(() => [
  ...openViews.value
    .filter((view) => inspectorViews.value.includes(view))
    .map((view) => ({
      icon: viewMeta[view].icon,
      kind: "view" as const,
      label: viewMeta[view].label,
      value: `view:${view}`,
      view,
    })),
  ...openPaths.value.map((path) => ({
    icon: "i-lucide-file-code-2",
    kind: "file" as const,
    label: fileName(path),
    path,
    value: `file:${path}`,
  })),
]);
const activeSurfaceExists = computed(() =>
  surfaceItems.value.some((item) => String(item.value) === activeSurface.value),
);
const launcherItems = computed<DropdownMenuItem[]>(() =>
  inspectorViews.value.map((view) => ({
    icon: viewMeta[view].icon,
    label: viewMeta[view].label,
    kbds: [viewMeta[view].shortcut],
    onSelect: () => openView(view),
  })),
);
const treeOptions = computed(() => ({
  density: "compact" as const,
  onSelectionChange(paths: readonly string[]) {
    const path = paths.findLast((path) => workspace.value?.paths.includes(path));
    if (path) selectedPath.value = path;
  },
  search: true,
}));

watch(
  [() => props.invocation.id, () => props.workspaceBase],
  () => {
    workspaceRequest?.abort();
    workspaceRequest = undefined;
    workspaceLoad = undefined;
    workspaceLoading.value = false;
    fileRequest?.abort();
    fileRequest = undefined;
    workspace.value = undefined;
    workspaceError.value = undefined;
    file.value = undefined;
    fileError.value = undefined;
    fileLoading.value = false;
    if (tab.value === "workspace") void loadWorkspace();
  },
  { immediate: true },
);

watch(
  tab,
  (value) => {
    if (!openViews.value.includes(value)) openViews.value = [...openViews.value, value];
    if (value === "workspace" && !workspace.value && !workspaceLoading.value) void loadWorkspace();
  },
  { immediate: true },
);

watch(selectedPath, (path) => {
  if (path) {
    if (!openPaths.value.includes(path)) openPaths.value = [...openPaths.value, path];
    tab.value = "workspace";
    activeSurface.value = `file:${path}`;
    void loadFile(path);
  }
});

watch(
  surfaceItems,
  (items) => {
    if (items.some((item) => String(item.value) === activeSurface.value)) return;
    const fallback = items.at(-1)?.value;
    if (fallback !== undefined) activateSurface(fallback);
    else {
      activeSurface.value = "";
      selectedPath.value = undefined;
    }
  },
  { flush: "post" },
);

watch(activeSurface, async () => {
  await nextTick();
  const scroller = tabstrip.value?.querySelector<HTMLElement>(".session-inspector__tabs");
  const activeTab = scroller?.querySelector<HTMLElement>('[data-state="active"]');
  if (!scroller || !activeTab) return;
  const scrollerBounds = scroller.getBoundingClientRect();
  const tabBounds = activeTab.getBoundingClientRect();
  if (tabBounds.left < scrollerBounds.left)
    scroller.scrollLeft -= scrollerBounds.left - tabBounds.left;
  else if (tabBounds.right > scrollerBounds.right)
    scroller.scrollLeft += tabBounds.right - scrollerBounds.right;
});

watch([workspace, treeOpen], async ([value, open]) => {
  if (!value || !open) return;
  await nextTick();
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const host = filesPanel.value?.querySelector<HTMLElement>("file-tree-container");
    const search = host?.shadowRoot?.querySelector<HTMLElement>(
      "[data-file-tree-search-container]",
    );
    if (!search) continue;
    search.style.paddingTop = "var(--trees-item-row-gap)";
    break;
  }
});

function openView(value: InspectorTab) {
  if (!openViews.value.includes(value)) openViews.value = [...openViews.value, value];
  tab.value = value;
  activeSurface.value = `view:${value}`;
  if (value === "workspace") {
    fileRequest?.abort();
    selectedPath.value = undefined;
    file.value = undefined;
    fileError.value = undefined;
    fileLoading.value = false;
  }
}

function openFile(path: string) {
  tab.value = "workspace";
  selectedPath.value = path;
  activeSurface.value = `file:${path}`;
}

async function openWorkspaceInstructions() {
  const invocationId = props.invocation.id;
  openView("workspace");
  if (!workspace.value) await loadWorkspace();
  if (props.invocation.id !== invocationId) return;
  const path = workspace.value?.paths
    .filter((path) => /(^|\/)AGENTS\.md$/i.test(path))
    .sort(
      (left, right) =>
        left.split("/").length - right.split("/").length || left.localeCompare(right),
    )[0];
  if (path) openFile(path);
}

function closeFile(path: string) {
  const index = openPaths.value.indexOf(path);
  if (index === -1) return;
  const wasActive = activeSurface.value === `file:${path}`;
  openPaths.value = openPaths.value.filter((entry) => entry !== path);
  if (selectedPath.value !== path) return;
  if (!wasActive) {
    selectedPath.value = undefined;
    fileRequest?.abort();
    file.value = undefined;
    fileError.value = undefined;
    return;
  }
  const next = openPaths.value[index] ?? openPaths.value[index - 1];
  selectedPath.value = next;
  const fallback = surfaceItems.value.at(-1)?.value;
  activeSurface.value = next
    ? `file:${next}`
    : openViews.value.includes("workspace")
      ? "view:workspace"
      : fallback === undefined
        ? ""
        : String(fallback);
  if (!next) {
    fileRequest?.abort();
    file.value = undefined;
    fileError.value = undefined;
  }
}

function activateSurface(value: string | number) {
  const id = String(value);
  if (id.startsWith("file:")) openFile(id.slice(5));
  else if (id.startsWith("view:")) {
    const view = id.slice(5);
    if (view === "details" || view === "trace" || view === "workspace") openView(view);
  }
}

function closeSurface(item: InspectorSurfaceItem) {
  const itemId = item.value === undefined ? "" : String(item.value);
  const index = surfaceItems.value.findIndex((surface) => String(surface.value) === itemId);
  const wasActive =
    activeSurface.value === itemId ||
    (item.kind === "view" && item.view === tab.value && !selectedPath.value) ||
    (item.kind === "file" && item.path === selectedPath.value);
  if (item.kind === "file" && item.path) {
    closeFile(item.path);
    return;
  }
  if (item.kind === "view" && item.view)
    openViews.value = openViews.value.filter((view) => view !== item.view);
  if (!wasActive) return;
  const next = surfaceItems.value[index] ?? surfaceItems.value[index - 1];
  if (next?.value) activateSurface(next.value);
  else {
    activeSurface.value = "";
    selectedPath.value = undefined;
  }
}

function fileName(path: string) {
  return path.split("/").at(-1) || path;
}

async function loadWorkspace() {
  if (workspaceLoad) return workspaceLoad;
  const load = requestWorkspace();
  workspaceLoad = load;
  try {
    await load;
  } finally {
    if (workspaceLoad === load) workspaceLoad = undefined;
  }
}

async function requestWorkspace() {
  if (!props.workspaceBase) return;
  workspaceRequest?.abort();
  const controller = new AbortController();
  workspaceRequest = controller;
  workspaceLoading.value = true;
  workspaceError.value = undefined;
  try {
    const loadedWorkspace = parseWorkspaceDescriptor(
      await requestJson(
        `${props.workspaceBase}/${encodeURIComponent(props.invocation.id)}/workspace`,
        controller.signal,
      ),
    );
    if (workspaceRequest !== controller) return;
    workspace.value = loadedWorkspace;
    if (selectedPath.value) void loadFile(selectedPath.value);
  } catch (error) {
    if (!controller.signal.aborted) {
      workspaceError.value = message(error);
    }
  } finally {
    if (workspaceRequest === controller) {
      workspaceRequest = undefined;
      workspaceLoading.value = false;
    }
  }
}

async function loadFile(path: string) {
  if (!props.workspaceBase) return;
  fileRequest?.abort();
  const controller = new AbortController();
  fileRequest = controller;
  fileLoading.value = true;
  fileError.value = undefined;
  file.value = undefined;
  try {
    const loadedFile = parseWorkspaceFile(
      await requestJson(
        `${props.workspaceBase}/${encodeURIComponent(props.invocation.id)}/workspace?path=${encodeURIComponent(path)}`,
        controller.signal,
      ),
    );
    if (loadedFile.path !== path || loadedFile.revision !== workspace.value?.revision)
      throw viteHubErrorDiagnostics.VITE_HUB_R0107({ message: "The host returned a Workspace file for a different path or revision." });
    if (fileRequest !== controller || selectedPath.value !== path) return;
    file.value = loadedFile;
  } catch (error) {
    if (!controller.signal.aborted && fileRequest === controller) fileError.value = message(error);
  } finally {
    if (fileRequest === controller) {
      fileRequest = undefined;
      fileLoading.value = false;
    }
  }
}

async function requestJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const payload = record(await response.json().catch(() => undefined));
    throw new RequestError(
      stringValue(payload?.statusMessage) ||
        stringValue(payload?.statusText) ||
        `Request failed with status ${response.status}.`,
      response.status,
    );
  }
  return response.json();
}

class RequestError extends Diagnostic {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super({ code: "VITE_HUB_R0111", docs: "https://vitehub.dev/docs/reference/errors-diagnostics", why: message }, RequestError);
    this.name = "RequestError";
  }
}

function parseWorkspaceDescriptor(value: unknown): WorkspaceDescriptor {
  const descriptor = record(value);
  const rawPaths = descriptor?.paths;
  const paths = Array.isArray(rawPaths) ? rawPaths.map(stringValue) : undefined;
  const hasPullRequest = descriptor !== undefined && "pullRequest" in descriptor;
  const pullRequest = numericValue(descriptor?.pullRequest);
  const repository = stringValue(descriptor?.repository);
  const revision = stringValue(descriptor?.revision);
  if (
    !paths ||
    paths.some((path) => path === undefined) ||
    (hasPullRequest && (pullRequest === undefined || !Number.isInteger(pullRequest))) ||
    !repository ||
    !revision
  )
    throw viteHubErrorDiagnostics.VITE_HUB_R0108({ message: "The host returned an invalid Workspace descriptor." });
  const validatedPaths = paths.filter((path): path is string => path !== undefined);
  const result: WorkspaceDescriptor = {
    paths: validatedPaths,
    repository,
    revision,
  };
  if (pullRequest !== undefined) result.pullRequest = pullRequest;
  return result;
}

function parseWorkspaceFile(value: unknown): WorkspaceFile {
  const file = record(value);
  const content = stringValue(file?.content);
  const path = stringValue(file?.path);
  const revision = stringValue(file?.revision);
  const size = numericValue(file?.size);
  if (content === undefined || !path || !revision || size === undefined)
    throw viteHubErrorDiagnostics.VITE_HUB_R0109({ message: "The host returned an invalid Workspace file." });
  return { content, path, revision, size };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workspace responses are untrusted JSON, so strings are validated at the host boundary.
  return typeof value === "string" ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workspace responses are untrusted JSON, so numbers are validated at the host boundary.
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTokens(value: unknown): string {
  const resolved = numericValue(value);
  if (resolved === undefined) return "Unavailable";
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: resolved >= 10_000 ? "compact" : "standard",
  }).format(resolved);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "This session data is unavailable.";
}
</script>

<template>
  <aside class="session-inspector">
    <header class="session-inspector__header">
      <div ref="tabstrip" class="session-inspector__tabstrip">
        <UTabs
          v-if="surfaceItems.length"
          :model-value="activeSurface"
          :items="surfaceItems"
          :content="false"
          class="session-inspector__tabs"
          color="neutral"
          size="xs"
          variant="pill"
          :ui="{
            root: 'min-w-0',
            list: 'w-max min-w-0 gap-1 bg-transparent p-0',
            indicator: 'hidden',
            trigger:
              'group/tab h-6 max-w-36 shrink-0 grow-0 cursor-pointer justify-start gap-0.5 rounded-md px-1.5 py-0 text-xs',
            label: 'truncate',
          }"
          @update:model-value="activateSurface"
        >
          <template #leading="{ item }">
            <button
              type="button"
              class="session-inspector__tab-close"
              :aria-label="`Close ${item.label}`"
              @click.stop="closeSurface(item)"
            >
              <UIcon :name="item.icon" class="session-inspector__surface-icon" />
              <UIcon name="i-lucide-x" class="session-inspector__surface-close" />
            </button>
          </template>
        </UTabs>
        <UDropdownMenu
          :items="launcherItems"
          :content="{ align: 'start', side: 'bottom', sideOffset: 6 }"
          size="sm"
          :ui="{
            content:
              'session-inspector__launcher-menu w-44 rounded-lg p-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/35%)] ring-1 ring-default',
            viewport: 'gap-0',
            item: 'session-inspector__launcher-item min-h-7 gap-2 rounded-sm px-2 py-1',
            itemLeadingIcon: 'size-4 shrink-0 text-muted',
            itemWrapper: 'min-w-0 flex-1',
            itemLabel: 'truncate text-sm',
            itemTrailing: 'ms-auto',
            itemTrailingKbds: 'ms-auto',
          }"
        >
          <UButton
            class="session-inspector__icon-button"
            icon="i-lucide-plus"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Open tab"
          />
        </UDropdownMenu>
      </div>
      <div class="session-inspector__actions">
        <UTooltip
          v-if="props.maximizable"
          :text="props.maximized ? 'Restore panel size' : 'Maximize panel'"
          ><UButton
            class="session-inspector__icon-button"
            :icon="props.maximized ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="props.maximized ? 'Restore panel size' : 'Maximize panel'"
            :aria-pressed="props.maximized"
            @click="emit('toggleMaximized')"
        /></UTooltip>
        <UTooltip text="Toggle right panel"
          ><UButton
            class="session-inspector__icon-button"
            icon="i-lucide-panel-right"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Toggle right panel"
            aria-pressed="true"
            @click="emit('close')"
        /></UTooltip>
      </div>
    </header>

    <div v-if="!activeSurfaceExists" class="session-inspector__empty">
      <div class="session-inspector__empty-copy">
        <strong>Open a tab</strong>
        <span>Choose what to inspect in this Agent Invocation.</span>
      </div>
      <div class="session-inspector__surface-launcher">
        <button v-for="view in inspectorViews" :key="view" type="button" @click="openView(view)">
          <UKbd>{{ viewMeta[view].shortcut }}</UKbd>
          <span><UIcon :name="viewMeta[view].icon" />{{ viewMeta[view].label }}</span>
          <small>{{ viewMeta[view].description }}</small>
        </button>
      </div>
    </div>

    <AgentInvocationInspector
      v-else-if="tab === 'details'"
      :invocation="invocation"
      :show-error="false"
      :show-status="false"
      :show-timeline="false"
      class="session-inspector__details"
      @select-activity="emit('focusActivity', $event)"
    >
      <template v-if="invocationUsage || !invocation.configuration?.instructions?.length" #metadata>
        <section v-if="invocationUsage">
          <h4>Usage</h4>
          <dl class="grid grid-cols-2 gap-3">
            <div>
              <dt class="text-xs text-muted">Processed tokens</dt>
              <dd class="mt-1 text-sm font-semibold tabular-nums">
                {{ formatTokens(invocationUsage.totalTokens) }}
              </dd>
            </div>
            <div v-if="record(invocationUsage.cost)">
              <dt class="text-xs text-muted">Cost</dt>
              <dd class="mt-1 text-sm font-semibold tabular-nums">
                {{ stringValue(record(invocationUsage.cost)?.display) || "Unavailable" }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted">Input</dt>
              <dd class="mt-1 text-xs tabular-nums text-toned">
                {{ formatTokens(invocationUsage.inputTokens) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted">Output</dt>
              <dd class="mt-1 text-xs tabular-nums text-toned">
                {{ formatTokens(invocationUsage.outputTokens) }}
              </dd>
            </div>
            <div v-if="numericValue(invocationUsage.cachedInputTokens) !== undefined">
              <dt class="text-xs text-muted">Cached input</dt>
              <dd class="mt-1 text-xs tabular-nums text-toned">
                {{ formatTokens(invocationUsage.cachedInputTokens) }}
              </dd>
            </div>
            <div v-if="numericValue(invocationUsage.cacheWriteTokens) !== undefined">
              <dt class="text-xs text-muted">Cache writes</dt>
              <dd class="mt-1 text-xs tabular-nums text-toned">
                {{ formatTokens(invocationUsage.cacheWriteTokens) }}
              </dd>
            </div>
            <div v-if="numericValue(invocationUsage.reasoningTokens) !== undefined">
              <dt class="text-xs text-muted">Reasoning</dt>
              <dd class="mt-1 text-xs tabular-nums text-toned">
                {{ formatTokens(invocationUsage.reasoningTokens) }}
              </dd>
            </div>
          </dl>
          <p v-if="record(invocationUsage.cost)" class="mt-3 text-[11px] leading-4 text-dimmed">
            {{ record(invocationUsage.cost)?.estimated === true ? "Estimated" : "Reported" }}
            by {{ stringValue(record(invocationUsage.cost)?.source) || "the provider" }}
          </p>
        </section>
        <section
          v-if="!invocation.configuration?.instructions?.length"
          class="session-inspector__instruction-fallback"
        >
          <h4>System instructions</h4>
          <p>Resolved instructions were not recorded for this invocation.</p>
          <button v-if="props.workspaceBase" type="button" @click="openWorkspaceInstructions">
            <UIcon name="i-lucide-file-text" />Open AGENTS.md in Workspace<UIcon
              name="i-lucide-arrow-right"
            />
          </button>
        </section>
      </template>
    </AgentInvocationInspector>

    <ConsoleSessionTrace
      v-else-if="tab === 'trace'"
      :invocation="invocation"
      @focus-activity="emit('focusActivity', $event)"
    />

    <div v-else class="session-inspector__workspace">
      <div class="session-inspector__breadcrumbs">
        <span class="session-inspector__repository">{{
          workspace?.repository || "Workspace"
        }}</span>
        <template v-for="(segment, index) in breadcrumbs" :key="`${segment}-${index}`"
          ><UIcon name="i-lucide-chevron-right" /><span
            :data-current="index === breadcrumbs.length - 1"
            >{{ segment }}</span
          ></template
        >
        <small v-if="file">{{ file.size }} bytes</small>
        <div class="session-inspector__workspace-actions">
          <UTooltip text="Reload Workspace"
            ><UButton
              icon="i-lucide-rotate-cw"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="Reload Workspace"
              @click="loadWorkspace"
          /></UTooltip>
          <UTooltip :text="treeOpen ? 'Hide file tree' : 'Show file tree'"
            ><UButton
              icon="i-lucide-folder-tree"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="treeOpen ? 'Hide file tree' : 'Show file tree'"
              :aria-pressed="treeOpen"
              @click="treeOpen = !treeOpen"
          /></UTooltip>
        </div>
      </div>
      <div v-if="workspaceLoading" class="session-inspector__state">
        <UIcon name="i-lucide-loader-circle" class="animate-spin" />Loading Workspace…
      </div>
      <UEmpty
        v-else-if="workspaceError"
        icon="i-lucide-folder-x"
        title="Workspace unavailable"
        :description="workspaceError"
        :actions="[{ label: 'Try again', onClick: loadWorkspace }]"
      />
      <template v-else-if="workspace">
        <div class="session-inspector__workspace-body" :data-tree-open="treeOpen">
          <div class="session-inspector__file">
            <div v-if="!selectedPath" class="session-inspector__snapshot">
              <UIcon name="i-lucide-folder-git-2" />
              <span class="session-inspector__eyebrow">Immutable snapshot</span>
              <strong>{{ workspaceLabel }}</strong>
              <small>
                {{ workspace.paths.length }} files<span v-if="workspace.pullRequest !== undefined">
                  · PR #{{ workspace.pullRequest }}</span
                >
              </small>
            </div>
            <div v-if="fileLoading" class="session-inspector__state">
              <UIcon name="i-lucide-loader-circle" class="animate-spin" />Loading file…
            </div>
            <div v-else-if="fileError" class="session-inspector__state text-error">
              <UIcon name="i-lucide-file-warning" />{{ fileError }}
            </div>
            <ConsoleSessionCodePreview
              v-else-if="selectedPath && file"
              :content="file.content"
              :path="file.path"
            />
            <div v-else-if="selectedPath" class="session-inspector__state">
              <UIcon name="i-lucide-mouse-pointer-2" />Select a file to preview it.
            </div>
          </div>
          <aside v-if="treeOpen" ref="filesPanel" class="session-inspector__files">
            <AgentFileTree
              class="session-inspector__tree"
              :paths="workspace.paths"
              :options="treeOptions"
            />
          </aside>
        </div>
      </template>
    </div>
  </aside>
</template>
