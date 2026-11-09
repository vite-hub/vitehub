<script setup lang="ts">
import { PlaygroundContainer, type PlaygroundContainerTemplate, type PlaygroundContext } from "@vite-hub/ui/workspace";
import { fetchSnapshot } from "@vite-hub/web-container";
import { runnableTutorials } from "#build/runnable-tutorials.mjs";
import { parseCurl, requestScript } from "~/utils/runnable-tutorial";
import { restartsDevServer, tutorialStepFiles, tutorialWorkspaceFiles } from "~~/modules/tutorials/steps";

import type { TutorialActions } from "~/utils/tutorial-actions";

type Files = Record<string, string>;
type Tutorial = (typeof runnableTutorials)[number];

// The steps of a lesson on top of PlaygroundContainer: Solve, Reset step, and the files of each step.
const props = defineProps<{
  tutorial: Tutorial
  /** The current step, from 0. */
  step: number
  /** Filled with what lesson code blocks can do. */
  actions: TutorialActions
}>();
const selected = defineModel<string>("selected", { required: true });
const open = defineModel<boolean>("open", { default: false });

const stepFiles = (index: number, state: "start" | "solution"): Files => tutorialStepFiles(props.tutorial, index, state);

// The docs build writes a snapshot of node_modules, so the workspace mounts it instead of running `npm install`.
// The browser keeps its parts in Cache Storage for later visits.
const prebuilt = props.tutorial.snapshot;
const snapshot = prebuilt && (() => fetchSnapshot(prebuilt.parts, { cache: `vitehub-tutorial-${props.tutorial.slug}`, sha256: prebuilt.sha256 }));

// The files that the lesson last loaded. The container marks a path whose contents differ from them as an edit.
const baseline = shallowRef<Files>(stepFiles(props.step, "start"));
const templates = computed<PlaygroundContainerTemplate[]>(() => [
  { id: props.tutorial.slug, label: props.tutorial.title, files: baseline.value, preview: "/api/health", snapshot },
]);
const context = shallowRef<PlaygroundContext>();

/** Writes `next` and restarts a running dev server when it must start again to see the change. */
async function write(workspace: PlaygroundContext["workspace"], next: Files) {
  const restart = restartsDevServer(workspace.files.value, next) && ["starting", "ready"].includes(workspace.status.value);
  await workspace.setFiles(next, { mode: "replace" });
  if (restart) await workspace.restart();
}

/** Restores the tutorial-owned files to `target`, and keeps unrelated files that the reader added. */
async function load(target: Files) {
  pendingStep.value = undefined;
  const workspace = context.value?.workspace;
  const next = workspace && tutorialWorkspaceFiles(props.tutorial, workspace.files.value, target);
  baseline.value = target;
  if (workspace && next) await write(workspace, next);
}

// Changing steps loads the files of the new step, unless the reader edited files. Then the bar asks first.
const pendingStep = ref<number>();
watch(() => props.step, (step) => {
  if (!context.value || context.value.edited.length === 0) void load(stepFiles(step, "start"));
  else pendingStep.value = step;
});
function loadPending() {
  if (pendingStep.value !== undefined) void load(stepFiles(pendingStep.value, "start"));
}
function keepMine() {
  if (pendingStep.value === undefined) return;
  // The reader's files stay. Solve and Reset then work on the new step.
  baseline.value = stepFiles(pendingStep.value, "start");
  pendingStep.value = undefined;
}

function solve(guard: PlaygroundContext["guard"]) {
  guard(`Replace your changes with the solution of step ${props.step + 1}?`, "Replace files", () => void load(stepFiles(props.step, "solution")));
}
function reset(guard: PlaygroundContext["guard"]) {
  guard(`Discard your changes and go back to the start of step ${props.step + 1}?`, "Replace files", () => void load(stepFiles(props.step, "start")));
}

// The request script lives in node_modules, so the file tree and the zip never list it.
const requestPath = "node_modules/.vitehub-tutorial-request.mjs";
async function run(command: string): Promise<string> {
  const request = parseCurl(command);
  const container = context.value?.workspace.container.value;
  if (!request || !container) return "The workspace is not running.";
  await container.fs.writeFile(requestPath, requestScript(request));
  const process = await container.run(["node", requestPath]);
  void process.output.cancel();
  await process.exit;
  // Strip terminal colors from the Node output.
  return (await process.text()).replace(/\u001B\[[\d;]*m/g, "").trim();
}

watchEffect(() => {
  const workspace = context.value?.workspace;
  Object.assign(props.actions, {
    available: !!workspace,
    running: workspace?.status.value === "ready" && !!workspace.previewUrl.value,
    paths: workspace ? Object.keys(workspace.files.value).sort() : [],
    show(path: string) {
      // A file that the step tells the reader to create opens empty.
      if (workspace && !(path in workspace.files.value)) void write(workspace, { ...workspace.files.value, [path]: "" });
      selected.value = path;
    },
    run,
  } satisfies TutorialActions);
});
onBeforeUnmount(() => { props.actions.available = false; });
</script>

<template>
  <!-- The fixtures run `vite --port 3000`. Nitro starts dev workers on other ports first, and they are not the app. -->
  <PlaygroundContainer
    v-model:open="open"
    v-model:selected="selected"
    layout="tutorial"
    :templates="templates"
    :share="false"
    :port="3000"
    @context="value => context = value"
  >
    <template #toolbar="{ guard }">
      <UButton variant="ghost" label="Reset step" icon="i-lucide-rotate-ccw" @click="reset(guard)" />
      <UButton variant="outline" label="Solve" icon="i-lucide-wand-sparkles" @click="solve(guard)" />
    </template>

    <template v-if="pendingStep !== undefined" #banner="{ edited }">
      <div class="vh-tutorial-bar" role="status">
        <span class="min-w-0 flex-1">You changed {{ edited.length === 1 ? "1 file" : `${edited.length} files` }}. Step {{ pendingStep + 1 }} has its own version.</span>
        <UButton size="xs" variant="outline" :label="`Load step ${pendingStep + 1}`" @click="loadPending" />
        <UButton size="xs" variant="ghost" label="Keep mine" @click="keepMine" />
      </div>
    </template>
  </PlaygroundContainer>
</template>

<style scoped>
.vh-tutorial-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
}
</style>
