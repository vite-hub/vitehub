<script setup lang="ts">
import { fetchSnapshot } from "@vite-hub/web-container";
import { defineConnect } from "@vite-hub/web-container/connect";
import { ConnectPanel } from "@vite-hub/ui/connect-panel";
import { useWorkspace } from "@vite-hub/ui/workspace";
import { WorkspaceBootStatus } from "@vite-hub/ui/workspace-boot-status";
import { WorkspaceEditor } from "@vite-hub/ui/workspace-editor";
import { WorkspaceFileTree } from "@vite-hub/ui/workspace-file-tree";
import { WorkspacePreview } from "@vite-hub/ui/workspace-preview";
import { WorkspaceShell, type WorkspaceTab } from "@vite-hub/ui/workspace-shell";
import { WorkspaceTerminal } from "@vite-hub/ui/workspace-terminal";
import { runnableTutorials } from "#build/runnable-tutorials.mjs";
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
const prebuilt = props.tutorial.snapshot;
const workspace = useWorkspace({
  files: stepFiles(props.step, "start"),
  port: appPort,
  ...prebuilt && {
    snapshot: () => fetchSnapshot(prebuilt.parts, { cache: `vitehub-tutorial-${props.tutorial.slug}`, sha256: prebuilt.sha256 }),
    install: false,
  },
});
// The two first tutorials run offline. A tutorial that deploys or calls a model lists its providers here.
const connect = defineConnect({});
const tab = ref<WorkspaceTab>("preview");
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
  <div class="vh-tutorial-workspace">
    <div v-if="pendingStep !== undefined" class="vh-tutorial-bar" role="status">
      <span class="min-w-0 flex-1">You changed {{ edited.length === 1 ? "1 file" : `${edited.length} files` }}. Step {{ pendingStep + 1 }} has its own version.</span>
      <UButton size="xs" color="neutral" variant="outline" :label="`Load step ${pendingStep + 1}`" @click="loadPending" />
      <UButton size="xs" color="neutral" variant="ghost" label="Keep mine" @click="keepMine" />
    </div>

    <WorkspaceShell v-model:tab="tab" layout="tutorial" :label="`${tutorial.title} workspace`" class="min-h-0 flex-1">
      <template #toolbar>
        <span class="vh-tutorial-toolbar-title">{{ tutorial.title }}</span>
        <span class="flex-1" />
        <UButton size="xs" color="neutral" variant="ghost" label="Solve" icon="i-lucide-wand-sparkles" @click="solve" />
        <UButton size="xs" color="neutral" variant="ghost" label="Reset" icon="i-lucide-rotate-ccw" @click="reset" />
        <UButton size="xs" color="neutral" variant="ghost" label="Restart" icon="i-lucide-refresh-cw" :disabled="!workspace.container.value" @click="workspace.restart()" />
      </template>
      <template #files>
        <WorkspaceFileTree v-model:selected="selected" :paths="paths" :modified="edited" />
      </template>
      <template #editor>
        <WorkspaceEditor v-model="source" :path="selected" />
      </template>
      <template #preview>
        <!-- The checklist takes the preview's place, so the reader can read and edit while the app installs. -->
        <WorkspaceBootStatus
          v-if="booting"
          :status="workspace.status.value"
          :steps="workspace.steps.value"
          :failure="workspace.failure.value"
          :online="workspace.online.value"
          @retry="workspace.boot()"
          @retry-install="workspace.install()"
          @restart="workspace.restart()"
          @show-output="tab = 'terminal'"
        />
        <WorkspacePreview v-else v-model:path="previewPath" :url="workspace.previewUrl.value" />
      </template>
      <template #terminal>
        <WorkspaceTerminal :output="workspace.logs.value" />
      </template>
      <template #connect>
        <ConnectPanel :connect="connect" empty="No accounts needed for this step." />
      </template>
    </WorkspaceShell>

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

.vh-tutorial-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
}

.vh-tutorial-toolbar-title {
  overflow: hidden;
  color: var(--ui-text-highlighted);
  font-size: 0.8125rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
