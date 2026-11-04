<script setup lang="ts">
import { fetchSnapshot } from "@vite-hub/web-container";
import { defineConnect } from "@vite-hub/web-container/connect";
import { ConnectPanel } from "@vite-hub/ui/connect-panel";
import { useWorkspace } from "@vite-hub/ui/workspace";
import { WorkspaceBootStatus } from "@vite-hub/ui/workspace-boot-status";
import { WorkspaceEditor } from "@vite-hub/ui/workspace-editor";
import { WorkspaceFileTree } from "@vite-hub/ui/workspace-file-tree";
import { WorkspacePreview } from "@vite-hub/ui/workspace-preview";
import { WorkspaceTerminal } from "@vite-hub/ui/workspace-terminal";
import { runnableTutorials } from "#build/runnable-tutorials.mjs";
import WorkspacePane from "~/components/workspace/WorkspacePane.vue";
import WorkspaceRunState from "~/components/workspace/WorkspaceRunState.vue";
import WorkspaceTabs from "~/components/workspace/WorkspaceTabs.vue";
import { splitterHitArea, splitterUi, useRunState } from "~/utils/workspace-layout";
import { parseCurl, requestScript } from "~/utils/runnable-tutorial";
import { tutorialStepFiles, tutorialWorkspaceFiles } from "~~/modules/tutorials/steps";

import type { TutorialActions } from "~/utils/tutorial-actions";

type Files = Record<string, string>;
type Tutorial = (typeof runnableTutorials)[number];

const props = defineProps<{
  tutorial: Tutorial
  /** The current step, from 0. */
  step: number
  /** Filled with what lesson code blocks can do. */
  actions: TutorialActions
}>();
const selected = defineModel<string>("selected", { required: true });

// The fixtures run `vite --port 3000`. Nitro starts dev workers on other ports first, and they are not the app.
const appPort = 3000;

const stepFiles = (index: number, state: "start" | "solution"): Files => tutorialStepFiles(props.tutorial, index, state);

// The docs build writes a snapshot of node_modules, so the workspace mounts it instead of running `npm install`.
// The browser keeps its parts in Cache Storage for later visits.
const snapshotParts = props.tutorial.snapshot;
const workspace = useWorkspace({
  files: stepFiles(props.step, "start"),
  port: appPort,
  ...snapshotParts && {
    snapshot: () => fetchSnapshot(snapshotParts, { cache: `vitehub-tutorial-${props.tutorial.slug}` }),
    install: false,
  },
});
// The two first tutorials run offline. A tutorial that deploys or calls a model lists its providers here.
const connect = defineConnect({});
const tab = ref<"preview" | "console" | "connect">("preview");
const tabs = [
  { label: "Preview", value: "preview" as const, icon: "i-lucide-app-window" },
  { label: "Console", value: "console" as const, icon: "i-lucide-square-terminal" },
  { label: "Connect", value: "connect" as const, icon: "i-lucide-plug" },
];
const runState = useRunState(workspace);
const moreItems = computed(() => [[
  { label: "Restart dev server", icon: "i-lucide-refresh-cw", disabled: !workspace.container.value, onSelect: () => void workspace.restart() },
]]);

// An iframe takes the pointer events of a drag that crosses it, so the preview ignores them while a handle moves.
const dragging = ref(false);
const rows = [
  { id: "code", defaultSize: 55, minSize: 20, slot: "code" as const },
  { id: "panel", defaultSize: 45, minSize: 15, slot: "panel" as const },
];
const columns = [
  { id: "files", defaultSize: 26, minSize: 15, maxSize: 45, slot: "files" as const },
  { id: "editor", defaultSize: 74, minSize: 40, slot: "editor" as const },
];
const previewPath = ref("/api/health");

// The files that the lesson last loaded. A path whose contents differ from it is an edit of the reader.
const baseline = shallowRef<Files>(stepFiles(props.step, "start"));
const edited = computed(() => {
  const current = workspace.files.value;
  const paths = new Set([...Object.keys(baseline.value), ...Object.keys(current)]);
  return [...paths].filter(path => baseline.value[path] !== current[path]).sort();
});
const paths = computed(() => Object.keys(workspace.files.value).sort());
const source = computed({
  get: () => workspace.files.value[selected.value] ?? "",
  set: value => void workspace.setFiles({ [selected.value]: value }),
});

/** Restores the tutorial-owned files to `target`, and keeps unrelated files that the reader added. */
async function load(target: Files) {
  const next = tutorialWorkspaceFiles(props.tutorial, workspace.files.value, target);
  baseline.value = target;
  await workspace.setFiles(next, { mode: "replace" });
}

// Changing steps loads the files of the new step, unless the reader edited files. Then the bar asks first.
const pendingStep = ref<number>();
watch(() => props.step, (step) => {
  if (edited.value.length === 0) void load(stepFiles(step, "start"));
  else pendingStep.value = step;
});
function loadPending() {
  if (pendingStep.value === undefined) return;
  void load(stepFiles(pendingStep.value, "start"));
  pendingStep.value = undefined;
}
function keepMine() {
  if (pendingStep.value === undefined) return;
  // The reader's files stay. Solve and Reset then work on the new step.
  baseline.value = stepFiles(pendingStep.value, "start");
  pendingStep.value = undefined;
}

const confirm = ref<{ title: string, action: () => void }>();
function guard(title: string, action: () => void) {
  if (edited.value.length === 0) action();
  else confirm.value = { title, action };
}
function solve() {
  guard(`Replace your changes with the solution of step ${props.step + 1}?`, () => void load(stepFiles(props.step, "solution")));
}
function reset() {
  guard(`Discard your changes and go back to the start of step ${props.step + 1}?`, () => void load(stepFiles(props.step, "start")));
}
function confirmAction() {
  confirm.value?.action();
  confirm.value = undefined;
  pendingStep.value = undefined;
}

const booting = computed(() => workspace.status.value !== "ready" || !!workspace.failure.value || !workspace.previewUrl.value);

// The request script lives in node_modules, so the file tree and the starter download never list it.
const requestPath = "node_modules/.vitehub-tutorial-request.mjs";
async function run(command: string): Promise<string> {
  const request = parseCurl(command);
  const container = workspace.container.value;
  if (!request || !container) return "The workspace is not running.";
  await container.fs.writeFile(requestPath, requestScript(request));
  const process = await container.run(["node", requestPath]);
  void process.output.cancel();
  await process.exit;
  // Strip terminal colors from the Node output.
  return (await process.text()).replace(/\u001B\[[\d;]*m/g, "").trim();
}

watchEffect(() => {
  Object.assign(props.actions, {
    available: true,
    running: workspace.status.value === "ready" && !!workspace.previewUrl.value,
    paths: paths.value,
    show(path: string) {
      // A file that the step tells the reader to create opens empty.
      if (!(path in workspace.files.value)) void workspace.setFiles({ [path]: "" });
      selected.value = path;
    },
    run,
  } satisfies TutorialActions);
});
onBeforeUnmount(() => { props.actions.available = false; });
</script>

<template>
  <div class="vh-tutorial-workspace" :class="{ 'is-dragging': dragging }">
    <header class="vh-tutorial-toolbar">
      <WorkspaceRunState :tone="runState.tone" :label="runState.label" />
      <span class="flex-1" />
      <UButton size="sm" color="neutral" variant="ghost" label="Reset step" icon="i-lucide-rotate-ccw" @click="reset" />
      <UButton size="sm" color="neutral" variant="outline" label="Solve" icon="i-lucide-wand-sparkles" @click="solve" />
      <UDropdownMenu :items="moreItems" :content="{ align: 'end' }">
        <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-ellipsis" aria-label="More actions" />
      </UDropdownMenu>
    </header>

    <div v-if="pendingStep !== undefined" class="vh-tutorial-bar" role="status">
      <span class="min-w-0 flex-1">You changed {{ edited.length === 1 ? "1 file" : `${edited.length} files` }}. Step {{ pendingStep + 1 }} has its own version.</span>
      <UButton size="xs" color="neutral" variant="outline" :label="`Load step ${pendingStep + 1}`" @click="loadPending" />
      <UButton size="xs" color="neutral" variant="ghost" label="Keep mine" @click="keepMine" />
    </div>

    <USplitter id="vh-tutorial-rows" auto-save-id="vitehub:tutorial:rows" orientation="vertical" :items="rows" :hit-area-margins="splitterHitArea" :ui="splitterUi" class="min-h-0 flex-1" :aria-label="`${tutorial.title} workspace`" @dragging="(_, value) => dragging = value">
      <template #code>
        <USplitter id="vh-tutorial-columns" auto-save-id="vitehub:tutorial:columns" :items="columns" :hit-area-margins="splitterHitArea" :ui="splitterUi" class="min-w-0 flex-1" @dragging="(_, value) => dragging = value">
          <template #files>
            <WorkspacePane label="Files" title="Files" class="vh-tutorial-files">
              <div class="min-h-0 flex-1 overflow-auto py-1">
                <WorkspaceFileTree v-model:selected="selected" :paths="paths" :modified="edited" />
              </div>
            </WorkspacePane>
          </template>
          <template #editor>
            <WorkspacePane label="Editor">
              <template #header>
                <span class="vh-tutorial-path">{{ selected }}</span>
                <span v-if="edited.includes(selected)" class="vh-tutorial-edited">Edited</span>
              </template>
              <WorkspaceEditor v-model="source" :path="selected" />
            </WorkspacePane>
          </template>
        </USplitter>
      </template>

      <template #panel>
        <WorkspaceTabs v-model="tab" :items="tabs">
          <template #preview>
            <!-- The checklist takes the preview's place, so the reader can read and edit while the app starts. -->
            <div v-if="booting" class="vh-tutorial-boot">
              <WorkspaceBootStatus
                :status="workspace.status.value"
                :steps="workspace.steps.value"
                :failure="workspace.failure.value"
                :online="workspace.online.value"
                @retry="workspace.boot()"
                @retry-install="workspace.install()"
                @restart="workspace.restart()"
                @show-output="tab = 'console'"
              />
            </div>
            <WorkspacePane v-else label="Preview">
              <WorkspacePreview v-model:path="previewPath" :url="workspace.previewUrl.value" />
            </WorkspacePane>
          </template>
          <template #console>
            <WorkspaceTerminal :output="workspace.logs.value" />
          </template>
          <template #connect>
            <div class="h-full overflow-auto">
              <ConnectPanel :connect="connect" empty="No accounts needed for this step." />
            </div>
          </template>
        </WorkspaceTabs>
      </template>
    </USplitter>

    <UModal :open="!!confirm" :title="confirm?.title" description="Your edits in this step are lost." @update:open="open => { if (!open) confirm = undefined }">
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="confirm = undefined" />
          <UButton color="neutral" label="Replace files" @click="confirmAction" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.vh-tutorial-workspace {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

/* The preview iframe would take the pointer during a drag. */
.vh-tutorial-workspace.is-dragging :deep(iframe) {
  pointer-events: none;
}

/* As tall as the step bar of the lesson, so both columns start on one line. */
.vh-tutorial-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
  height: 2.75rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0 0.5rem 0 0.75rem;
}

.vh-tutorial-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
}

.vh-tutorial-files {
  background: var(--ui-bg-muted);
}

.vh-tutorial-files :deep(.vh-ws-file-tree) {
  --trees-bg-override: var(--ui-bg-muted);
}

.vh-tutorial-path {
  overflow: hidden;
  color: var(--ui-text);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-tutorial-edited {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
}

.vh-tutorial-boot {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 1.5rem;
}
</style>
