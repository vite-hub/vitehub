<script setup lang="ts">
import { AgentInvocationInspector, invocationActivities, type AgentInvocationView } from "./invocation";
import type { DropdownMenuItem, TabsItem } from "@nuxt/ui";
import { TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { useElementSize } from "@vueuse/core";
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from "vue";
import ConsoleSessionCodePreview from "./console-session-code-preview.vue";
import ConsoleSessionTrace from "./console-session-trace.vue";
import ConsoleState from "./console-state.vue";
import { matchesWorkspaceFile } from "./console-workspace-file";
import { useConsoleWordWrap } from "./console-wrap";
import { consoleBytes } from "../client/format";
import { requestConsole } from "../client/request";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

const ConsoleFileTree = defineAsyncComponent(() => import("./console-lazy-views").then(module => module.FileTree));
const ConsolePatchDiff = defineAsyncComponent(() => import("./console-lazy-views").then(module => module.PatchDiff));
const ConsoleFileDiff = defineAsyncComponent(() => import("./console-lazy-views").then(module => module.FileDiff));
// JSON Render and Zod load with the Capabilities tab, not with every session.
const AgentCapabilityInspector = defineAsyncComponent(() => import("./invocation/agent-capability-inspector").then(module => module.AgentCapabilityInspector));

type InspectorTab = "details" | "trace" | "workspace" | "capabilities" | "diff";
type WorkspaceChange = { path: string; status: "added" | "deleted" | "modified" };
type WorkspaceDescriptor = {
  /** The head of the ref that `changes` compares with, such as `main`. */
  base?: { ref: string; revision: string };
  changes?: WorkspaceChange[];
  paths: string[];
  pullRequest?: number;
  ref?: string;
  repository: string;
  revision: string;
};
type WorkspaceFile = { content: string; path: string; provenance?: { source: string }; revision: string; size: number };

const props = withDefaults(
  defineProps<{
    invocation: AgentInvocationView;
    maximized?: boolean;
    maximizable?: boolean;
    /** Show only this view, without the tab strip, for a layout that has its own tabs such as AgentSession. */
    view?: InspectorTab;
    workspaceBase?: string;
  }>(),
  { maximized: false, maximizable: true },
);
const emit = defineEmits<{ close: []; focusActivity: [activityId: string]; toggleMaximized: [] }>();
const tab = defineModel<InspectorTab>("tab", { default: "details" });
const activeSurface = defineModel<string>("activeSurface", { default: "" });
const openViews = defineModel<InspectorTab[]>("openViews", { default: () => [] });
const openPaths = defineModel<string[]>("openPaths", { default: () => [] });
const selectedPath = defineModel<string | undefined>("selectedPath");
const workspace = ref<WorkspaceDescriptor>();
const workspaceError = ref<unknown>();
const workspaceLoading = ref(false);
const file = ref<WorkspaceFile>();
const fileError = ref<string>();
const fileLoading = ref(false);
// The selected file at the base revision, for the diff of a changed file.
const baseFile = ref<{ content: string; path: string }>();
const diffOpen = ref(true);
const viewMeta: Record<
  InspectorTab,
  { description: string; icon: string; label: string }
> = {
  details: {
    description: "Review the run, its usage, setup, and identifiers.",
    icon: "i-lucide-info",
    label: "Details",
  },
  capabilities: {
    description: "Inspect capabilities, servers, and tool contracts.",
    icon: "i-lucide-blocks",
    label: "Capabilities",
  },
  trace: {
    description: "Follow spans, timings, and recorded attributes.",
    icon: "i-lucide-list-tree",
    label: "Trace",
  },
  workspace: {
    description: "Browse the mounted Agent workspace.",
    icon: "i-lucide-folder-tree",
    label: "Workspace",
  },
  diff: {
    description: "Review code changes from this run or its pull request.",
    icon: "i-lucide-git-compare-arrows",
    label: "Diff",
  },
};
// A tab with nothing to show is left out. Tools without a Capability are listed in the Details tab.
const inspectorViews = computed<InspectorTab[]>(() => [
  "details",
  ...(props.invocation.configuration?.capabilities?.length ? (["capabilities"] as const) : []),
  "trace",
  ...(props.workspaceBase ? (["workspace"] as const) : []),
  ...(diffs.value.length ? (["diff"] as const) : []),
]);
const diffs = computed(() => invocationActivities(props.invocation)
  .filter(activity => activity.patches.length)
  .map(activity => ({ id: activity.id, patches: activity.patches, sequence: activity.sequence })));
const selectedDiffs = ref<number[]>([]);
const diffPanel = ref<HTMLElement | null>(null);
const { width: diffWidth } = useElementSize(diffPanel);
const activeDiffTurn = ref<number | "all">("all");
const diffTurnItems = computed<TabsItem[]>(() => [
  { label: "All changes", value: "all" },
  ...diffs.value.map((_, index) => ({ label: `Turn ${index + 1}`, value: index })),
]);
const allDiffsSelected = computed(() => diffs.value.length > 0 && selectedDiffs.value.length === diffs.value.length);
function toggleAllDiffs() { selectedDiffs.value = allDiffsSelected.value ? [] : diffs.value.map((_, index) => index); }
watch(() => props.invocation.id, () => {
  selectedDiffs.value = [];
  activeDiffTurn.value = "all";
});
watch(diffs, (value, previous) => {
  const identityChanged = !previous || value.length !== previous.length || value.some((diff, index) => diff.id !== previous[index]?.id);
  if (identityChanged) {
    selectedDiffs.value = [];
    activeDiffTurn.value = "all";
    return;
  }
  selectedDiffs.value = selectedDiffs.value.filter((index) => index < value.length);
  if (activeDiffTurn.value !== "all" && activeDiffTurn.value >= value.length) activeDiffTurn.value = "all";
});
const treeOpen = ref(true);
const wrapLines = useConsoleWordWrap();
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
    ? ["current", "live"].includes(workspace.value.revision)
      ? `${workspace.value.repository} · Live workspace`
      : `${workspace.value.repository}@${workspace.value.revision.slice(0, 7)}`
    : "Agent Workspace",
);
const changes = computed(() => workspace.value?.changes ?? []);
const selectedChange = computed(() => changes.value.find(change => change.path === selectedPath.value));
// A changed file opens as its diff against the base. "File" shows the whole file again.
const showDiff = computed(() => Boolean(diffOpen.value && selectedChange.value && workspace.value?.base && file.value));
const changeLabels: Record<WorkspaceChange["status"], string> = { added: "Added", deleted: "Deleted", modified: "Modified" };
const workspaceSources = computed(() => props.invocation.configuration?.workspace?.sources
  ?.map(source => source instanceof Object ? source.id : source)
  .join(" · "));
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
    onSelect: () => openView(view),
  })),
);
const treeOptions = computed(() => ({
  density: "compact" as const,
  gitStatus: changes.value.filter(change => change.status !== "deleted"),
  onSelectionChange(paths: readonly string[]) {
    const path = paths.findLast((path) => workspace.value?.paths.includes(path));
    if (path) selectedPath.value = path;
  },
  search: true,
  unsafeCSS: `
    [data-file-tree-search-container] {
      padding-top: var(--trees-item-row-gap);
    }
    [data-file-tree-search-input] {
      box-sizing: border-box;
      min-width: 0;
      width: 100%;
    }
  `,
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
    if (!props.workspaceBase) {
      openViews.value = openViews.value.filter((view) => view !== "workspace");
      openPaths.value = [];
      selectedPath.value = undefined;
      if (tab.value === "workspace") tab.value = "details";
      if (activeSurface.value === "view:workspace" || activeSurface.value.startsWith("file:")) activeSurface.value = "view:details";
    }
    if (selectedPath.value) void loadFile(selectedPath.value);
    else if (tab.value === "workspace") void loadWorkspace();
  },
  { immediate: true },
);

watch(
  tab,
  (value) => {
    if (!activeSurface.value) return;
    if (!openViews.value.includes(value)) openViews.value = [...openViews.value, value];
    if (value === "workspace" && !selectedPath.value && !workspace.value && !workspaceLoading.value)
      void loadWorkspace();
  },
);

watch(selectedPath, (path) => {
  if (path) {
    if (!openPaths.value.includes(path)) openPaths.value = [...openPaths.value, path];
    // The URL can restore a view and retain its last file. Opening a file explicitly selects Workspace.
    if (tab.value === "workspace") activeSurface.value = `file:${path}`;
    void loadFile(path);
  }
});

watch(
  surfaceItems,
  (items) => {
    if (items.some((item) => String(item.value) === activeSurface.value)) return;
    const fallback = items.at(-1)?.value;
    if (fallback !== undefined) activateSurface(fallback);
    // An open panel always shows something: the Details tab when no other tab is open, such as a link to a tab
    // that this session does not have.
    else openView("details");
  },
  { flush: "post", immediate: true },
);

// A single-view inspector opens its view once the default Details tab is in place, and keeps a file that the caller
// asked for, since opening the Workspace view clears the selection.
watch(
  () => props.view,
  (view) => {
    if (!view) return;
    const path = selectedPath.value;
    openView(view);
    if (path && view === "workspace") selectedPath.value = path;
  },
  { flush: "post", immediate: true },
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

// Opening a tab from the launcher replaces the launcher, and closing a tab removes its button. Move keyboard focus to
// the active tab, so it does not fall to the page body.
async function focusActiveTab() {
  await nextTick();
  tabstrip.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

function openView(value: InspectorTab) {
  if (value === "workspace" && !props.workspaceBase) return;
  if (!openViews.value.includes(value)) openViews.value = [...openViews.value, value];
  tab.value = value;
  activeSurface.value = `view:${value}`;
  if (value === "workspace") {
    fileRequest?.abort();
    selectedPath.value = undefined;
    file.value = undefined;
    fileError.value = undefined;
    fileLoading.value = false;
    if (!workspace.value && !workspaceLoading.value) void loadWorkspace();
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
  if (!workspace.value?.paths.includes("AGENTS.md")) return;
  openFile("AGENTS.md");
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
    if (view === "details" || view === "trace" || view === "workspace" || view === "capabilities" || view === "diff") openView(view);
  }
}

function closeSurface(item: InspectorSurfaceItem) {
  const closesPanel = surfaceItems.value.length === 1;
  const itemId = item.value === undefined ? "" : String(item.value);
  const index = surfaceItems.value.findIndex((surface) => String(surface.value) === itemId);
  const wasActive =
    activeSurface.value === itemId ||
    (item.kind === "view" && item.view === tab.value && !selectedPath.value) ||
    (item.kind === "file" && item.path === selectedPath.value);
  if (item.kind === "file" && item.path) {
    closeFile(item.path);
    if (closesPanel) emit("close");
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
  if (closesPanel) emit("close");
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
      workspaceError.value = error;
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
  baseFile.value = undefined;
  try {
    const loadedFile = parseWorkspaceFile(
      await requestJson(
        `${props.workspaceBase}/${encodeURIComponent(props.invocation.id)}/workspace?path=${encodeURIComponent(path)}`,
        controller.signal,
      ),
    );
    if (!matchesWorkspaceFile(loadedFile, path, workspace.value))
      throw viteHubErrorDiagnostics.VITE_HUB_R0107({
        message: "The host returned a Workspace file for a different path or revision.",
      });
    if (fileRequest !== controller || selectedPath.value !== path) return;
    file.value = loadedFile;
    void loadBaseFile(path, controller);
  } catch (error) {
    if (!controller.signal.aborted && fileRequest === controller) fileError.value = message(error);
  } finally {
    if (fileRequest === controller) {
      fileRequest = undefined;
      fileLoading.value = false;
    }
  }
}

/** Reads the base revision of a modified file. An added file has no base, so its diff starts empty. */
async function loadBaseFile(path: string, controller: AbortController) {
  baseFile.value = undefined;
  const base = workspace.value?.base;
  const change = workspace.value?.changes?.find(entry => entry.path === path);
  if (!base || !change) return;
  if (change.status === "added") {
    baseFile.value = { content: "", path };
    return;
  }
  try {
    const loaded = parseWorkspaceFile(await requestJson(
      `${props.workspaceBase}/${encodeURIComponent(props.invocation.id)}/workspace?path=${encodeURIComponent(path)}&revision=${encodeURIComponent(base.revision)}`,
      controller.signal,
    ));
    if (selectedPath.value === path && loaded.path === path) baseFile.value = { content: loaded.content, path };
  } catch {
    // The whole file still shows. Only the diff is missing.
  }
}

async function requestJson(path: string, signal: AbortSignal): Promise<unknown> {
  return requestConsole(path, { signal });
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
    throw viteHubErrorDiagnostics.VITE_HUB_R0108({
      message: "The host returned an invalid Workspace descriptor.",
    });
  const validatedPaths = paths.filter((path): path is string => path !== undefined);
  const result: WorkspaceDescriptor = {
    paths: validatedPaths,
    repository,
    revision,
  };
  if (pullRequest !== undefined) result.pullRequest = pullRequest;
  const ref = stringValue(descriptor?.ref);
  if (ref) result.ref = ref;
  const base = record(descriptor?.base);
  const baseRef = stringValue(base?.ref);
  const baseRevision = stringValue(base?.revision);
  if (baseRef && baseRevision) result.base = { ref: baseRef, revision: baseRevision };
  if (Array.isArray(descriptor?.changes)) {
    result.changes = descriptor.changes.flatMap((entry) => {
      const change = record(entry);
      const path = stringValue(change?.path);
      const status = change?.status;
      return path && (status === "added" || status === "deleted" || status === "modified") ? [{ path, status }] : [];
    });
  }
  return result;
}

function parseWorkspaceFile(value: unknown): WorkspaceFile {
  const file = record(value);
  const content = stringValue(file?.content);
  const path = stringValue(file?.path);
  const revision = stringValue(file?.revision);
  const size = numericValue(file?.size);
  const provenanceValue = record(file?.provenance);
  const source = stringValue(provenanceValue?.source);
  if (content === undefined || !path || !revision || size === undefined)
    throw viteHubErrorDiagnostics.VITE_HUB_R0109({
      message: "The host returned an invalid Workspace file.",
    });
  const result: WorkspaceFile = { content, path, revision, size };
  if (source) result.provenance = { source };
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


function message(error: unknown) {
  return error instanceof Error ? error.message : "This session data is unavailable.";
}
</script>

<template>
  <aside class="session-inspector" :data-single-view="props.view ? '' : undefined">
    <header v-if="!props.view" class="session-inspector__header">
      <div ref="tabstrip" class="session-inspector__tabstrip">
        <!--
          Reka tabs, not UTabs: each tab has its own close button beside the trigger, and UTabs renders its trailing
          slot inside the trigger button, where a second button is not valid. The look follows the theme's underline tabs.
        -->
        <TabsRoot
          v-if="surfaceItems.length"
          :model-value="activeSurface"
          class="session-inspector__tabs"
          orientation="horizontal"
          @update:model-value="activateSurface"
        >
          <TabsList class="session-inspector__tablist">
            <div
              v-for="item in surfaceItems"
              :key="String(item.value)"
              class="session-inspector__tab"
              :data-active="activeSurface === String(item.value)"
            >
              <TabsTrigger
                :value="String(item.value)"
                class="flex h-7 min-w-0 max-w-36 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:text-highlighted data-[state=active]:text-highlighted"
              >
                <UIcon :name="item.icon" class="session-inspector__surface-icon" aria-hidden="true" />
                <span class="truncate">{{ item.label }}</span>
              </TabsTrigger>
              <UButton
                icon="i-lucide-x"
                variant="ghost"
                size="xs"
                :aria-label="`Close ${item.label}`"
                @click.stop="closeSurface(item); focusActiveTab()"
              />
            </div>
          </TabsList>
        </TabsRoot>
        <UDropdownMenu
          :items="launcherItems"
          :content="{ align: 'start', side: 'bottom', sideOffset: 6 }"
        >
          <UButton
            class="session-inspector__icon-button"
            icon="i-lucide-plus"
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
            data-slot="session-inspector-maximize"
            :icon="props.maximized ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
            variant="ghost"
            size="xs"
            :aria-label="props.maximized ? 'Restore panel size' : 'Maximize panel'"
            :aria-pressed="props.maximized"
            @click="emit('toggleMaximized')"
        /></UTooltip>
        <!-- The session header holds the details toggle. A maximized panel hides that header, so it needs its own. -->
        <UTooltip v-if="props.maximized" text="Close session details"
          ><UButton
            class="session-inspector__icon-button"
            icon="i-lucide-panel-right"
            variant="ghost"
            size="xs"
            aria-label="Close session details"
            @click="emit('close')"
        /></UTooltip>
      </div>
    </header>

    <UEmpty
      v-if="!props.view && !activeSurfaceExists"
      variant="naked"
      class="session-inspector__empty"
      title="Open a tab"
      description="Choose what to inspect in this Agent Invocation."
    >
      <template #body>
        <div class="session-inspector__surface-launcher">
          <UButton
            v-for="view in inspectorViews"
            :key="view"
            variant="outline"
            class="flex-col items-start gap-1 p-3 text-start"
            @click="openView(view); focusActiveTab()"
          >
            <span class="flex items-center gap-2 text-highlighted"><UIcon :name="viewMeta[view].icon" class="size-4 text-muted" />{{ viewMeta[view].label }}</span>
            <span class="text-xs font-normal text-muted">{{ viewMeta[view].description }}</span>
          </UButton>
        </div>
      </template>
    </UEmpty>

    <AgentCapabilityInspector v-else-if="tab === 'capabilities'" :invocation="invocation" @select-activity="emit('focusActivity', $event)" />

    <AgentInvocationInspector
      v-else-if="tab === 'details'"
      :invocation="invocation"
      :show-error="false"
      :show-sources="!workspace || !!workspaceError"
      :show-status="false"
      :show-timeline="false"
      class="session-inspector__details"
      @select-activity="emit('focusActivity', $event)"
    >
      <template #identityActions>
        <UButton
          v-if="props.workspaceBase"
          icon="i-lucide-file-text"
          label="Instructions"
          variant="ghost"
          size="xs"
          @click="openWorkspaceInstructions"
        />
      </template>
    </AgentInvocationInspector>

    <ConsoleSessionTrace
      v-else-if="tab === 'trace'"
      :invocation="invocation"
      @focus-activity="emit('focusActivity', $event)"
    />

    <div v-else-if="tab === 'diff'" ref="diffPanel" class="session-inspector__diff">
      <div class="session-inspector__diff-toolbar">
        <div>
          <strong>Code changes</strong>
          <span class="session-inspector__eyebrow">{{ diffs.length }} turn{{ diffs.length === 1 ? '' : 's' }}</span>
        </div>
        <UButton size="xs" variant="outline" :disabled="!diffs.length" @click="toggleAllDiffs">
          {{ allDiffsSelected ? 'Clear selection' : 'Select all' }}
        </UButton>
      </div>
      <UTabs
        v-if="diffs.length > 1"
        v-model="activeDiffTurn"
        :items="diffTurnItems"
        :content="false"
        aria-label="Diff turns"
        class="session-inspector__diff-turns"
      />
      <UEmpty v-if="!diffs.length" icon="i-lucide-git-compare-arrows" title="No code changes" description="Changes made during this run will appear here." />
      <div v-else class="session-inspector__diff-list">
        <section v-for="(diff, index) in diffs" v-show="activeDiffTurn === 'all' || activeDiffTurn === index" :key="diff.id" class="session-inspector__diff-turn">
          <label class="session-inspector__diff-select">
            <input v-model="selectedDiffs" type="checkbox" :value="index" />
            <span>Turn {{ index + 1 }}</span>
          </label>
          <ConsolePatchDiff v-for="(patch, patchIndex) in diff.patches" :key="patchIndex" :patch="patch" :options="{ diffStyle: diffWidth < 768 ? 'unified' : 'split', overflow: 'wrap' }" class="session-inspector__patch" />
        </section>
      </div>
    </div>
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
        <div class="session-inspector__workspace-actions">
          <UTooltip v-if="selectedChange && workspace?.base" :text="diffOpen ? 'Show the whole file' : `Show changes since ${workspace.base.ref}`">
            <UButton
              icon="i-lucide-git-compare-arrows"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="diffOpen ? 'Show the whole file' : `Show changes since ${workspace.base.ref}`"
              :aria-pressed="diffOpen"
              @click="diffOpen = !diffOpen"
            />
          </UTooltip>
          <UTooltip :text="wrapLines ? 'Disable line wrap' : 'Enable line wrap'">
            <UButton
              icon="i-lucide-wrap-text"
              variant="ghost"
              size="xs"
              :aria-label="wrapLines ? 'Disable line wrap' : 'Enable line wrap'"
              :aria-pressed="wrapLines"
              @click="wrapLines = !wrapLines"
            />
          </UTooltip>
          <UTooltip text="Reload Workspace"
            ><UButton
              icon="i-lucide-rotate-cw"
              variant="ghost"
              size="xs"
              aria-label="Reload Workspace"
              @click="loadWorkspace"
          /></UTooltip>
          <UTooltip v-if="workspace" :text="treeOpen ? 'Hide file tree' : 'Show file tree'"
            ><UButton
              icon="i-lucide-folder-tree"
              variant="ghost"
              size="xs"
              :aria-label="treeOpen ? 'Hide file tree' : 'Show file tree'"
              :aria-pressed="treeOpen"
              @click="treeOpen = !treeOpen"
          /></UTooltip>
        </div>
      </div>
      <div v-if="workspaceLoading && !selectedPath" class="session-inspector__state">
        <UIcon name="i-lucide-loader-circle" class="animate-spin" />Loading Workspace…
      </div>
      <ConsoleState
        v-else-if="workspaceError && !selectedPath"
        :error="workspaceError"
        title="Workspace unavailable"
        :retry="loadWorkspace"
      />
      <template v-else-if="workspace || selectedPath">
        <div class="session-inspector__workspace-body" :data-tree-open="treeOpen && !!workspace">
          <div class="session-inspector__file">
            <section
              v-if="!selectedPath && workspace && changes.length"
              class="session-inspector__changes"
              aria-labelledby="session-inspector-changes"
            >
              <header>
                <strong id="session-inspector-changes">Changes since {{ workspace.base?.ref ?? "base" }}</strong>
                <small>{{ changes.length }} {{ changes.length === 1 ? "file" : "files" }}</small>
              </header>
              <ul>
                <li v-for="change in changes" :key="change.path">
                  <button
                    type="button"
                    data-focus-inset
                    :disabled="change.status === 'deleted'"
                    :title="change.status === 'deleted' ? `${change.path} is not in this revision` : `Open ${change.path}`"
                    @click="openFile(change.path)"
                  >
                    <span class="session-inspector__change-status" :data-status="change.status" :aria-label="changeLabels[change.status]">{{ change.status[0]!.toUpperCase() }}</span>
                    <span class="session-inspector__change-path">{{ change.path }}</span>
                  </button>
                </li>
              </ul>
            </section>
            <div v-else-if="!selectedPath && workspace" class="session-inspector__snapshot">
              <UIcon name="i-lucide-folder-git-2" />
              <span class="session-inspector__eyebrow">{{
                ["current", "live"].includes(workspace.revision) ? "Live workspace" : workspace.base ? `Same files as ${workspace.base.ref}` : "Immutable snapshot"
              }}</span>
              <strong>{{ workspaceLabel }}</strong>
              <small>
                {{ workspace.paths.length }} files<span v-if="workspace.pullRequest !== undefined">
                  · PR #{{ workspace.pullRequest }}</span
                >
              </small>
              <small v-if="workspaceSources">Recorded sources · {{ workspaceSources }}</small>
            </div>
            <div v-if="fileLoading" class="session-inspector__state">
              <UIcon name="i-lucide-loader-circle" class="animate-spin" />Loading file…
            </div>
            <div v-else-if="fileError" class="session-inspector__state text-error">
              <UIcon name="i-lucide-file-warning" />{{ fileError }}
            </div>
            <ConsoleFileDiff
              v-else-if="selectedPath && file && showDiff && baseFile"
              class="session-inspector__file-diff"
              :old-file="{ name: file.path, contents: baseFile.content }"
              :new-file="{ name: file.path, contents: file.content }"
              :options="{ diffStyle: 'unified', overflow: wrapLines ? 'wrap' : 'scroll' }"
            />
            <ConsoleSessionCodePreview
              v-else-if="selectedPath && file"
              :content="file.content"
              :path="file.path"
              :wrap="wrapLines"
            />
            <div v-else-if="selectedPath" class="session-inspector__state">
              <UIcon name="i-lucide-mouse-pointer-2" />Select a file to preview it.
            </div>
          </div>
          <aside v-if="treeOpen && workspace" ref="filesPanel" class="session-inspector__files">
            <ConsoleFileTree
              class="session-inspector__tree"
              :paths="workspace.paths"
              :options="treeOptions"
            />
          </aside>
        </div>
      </template>
      <footer v-if="workspace || file" class="session-inspector__file-status">
        <span v-if="workspace" class="session-inspector__file-revision" :title="workspace.revision === 'current' ? 'Files currently mounted on this host; not a snapshot of this run.' : `${workspace.ref ? `${workspace.ref} · ` : ''}${workspace.revision}`">{{ workspace.revision === 'current' ? 'Current mounted files' : `${workspace.ref ? `${workspace.ref} · ` : ''}${workspace.revision.slice(0, 12)}` }}</span>
        <span v-if="selectedChange" class="session-inspector__change-note">{{ changeLabels[selectedChange.status] }} since {{ workspace?.base?.ref }}</span>
        <span v-else-if="file && workspace?.base" class="session-inspector__change-note">Unchanged since {{ workspace.base.ref }}</span>
        <span v-else-if="file && file.revision !== workspace?.revision" class="session-inspector__file-revision" :title="file.revision">{{ file.revision === "current" ? "Current mounted file" : file.revision.slice(0, 12) }}</span>
        <span v-if="file?.provenance">From {{ file.provenance.source }}</span>
        <span><template v-if="workspace">{{ workspace.paths.length }} files<span v-if="file"> · </span></template><template v-if="file">{{ consoleBytes(file.size) }}</template></span>
      </footer>
    </div>
  </aside>
</template>
