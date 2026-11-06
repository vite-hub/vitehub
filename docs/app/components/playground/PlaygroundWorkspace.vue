<script setup lang="ts">
import { fetchSnapshot } from "@vite-hub/web-container";
import { defineConnect } from "@vite-hub/web-container/connect";
import { ConnectPanel, type ConnectProviderState, useConnectStore } from "@vite-hub/ui/connect-panel";
import { useWorkspace } from "@vite-hub/ui/workspace";
import { WorkspaceBootStatus } from "@vite-hub/ui/workspace-boot-status";
import { WorkspaceEditor } from "@vite-hub/ui/workspace-editor";
import { WorkspaceFileTree } from "@vite-hub/ui/workspace-file-tree";
import { WorkspacePreview } from "@vite-hub/ui/workspace-preview";
import { WorkspaceTerminal } from "@vite-hub/ui/workspace-terminal";
import { useClipboard } from "@vueuse/core";
import { encodePlayground, shareHashKey, shareLimit } from "~/utils/playground-share";
import WorkspacePane from "~/components/workspace/WorkspacePane.vue";
import WorkspaceRunState from "~/components/workspace/WorkspaceRunState.vue";
import WorkspaceTabs from "~/components/workspace/WorkspaceTabs.vue";
import { splitterHitArea, splitterUi, useRunState } from "~/utils/workspace-layout";
import { downloadZip } from "~/utils/zip";

import type { ConnectProviderName } from "@vite-hub/web-container/connect";
import type { PlaygroundTemplate, TutorialFiles } from "~~/modules/tutorials/steps";

const props = defineProps<{
  templates: readonly PlaygroundTemplate[]
  /** The template that this workspace booted with. Its snapshot is mounted. */
  template: PlaygroundTemplate
  /** The files to boot with: the files of the template, or the files of a share link. */
  files: TutorialFiles
}>();
const emit = defineEmits<{
  /** Another template is open. The page keeps it in `?template=`. */
  change: [template: PlaygroundTemplate]
  /** The template needs another snapshot, so the page boots a new workspace with it. One WebContainer runs per page. */
  remount: [template: PlaygroundTemplate]
}>();

// The fixtures run `vite --port 3000`. Nitro starts dev workers on other ports first, and they are not the app.
const appPort = 3000;

// The snapshot holds the dependencies of the template. Files with other dependencies, such as a share link with an
// edited package.json, mount it and then run `npm install` for the difference.
const prebuilt = props.template.snapshot;
// Any manifest edit can affect installation, including devDependencies, optionalDependencies, and overrides.
const sameManifest = props.files["package.json"] === props.template.files["package.json"];

// Tokens stay in this tab (sessionStorage). They reach the app only as environment variables of the dev server.
const connect = defineConnect({ anthropic: true, github: true, netlify: true, openai: true, vercel: true });
const store = useConnectStore();
const workspace = useWorkspace({
  files: props.files,
  port: appPort,
  env: store.env(connect),
  ...prebuilt && {
    // The tutorial with the same dependencies uses this cache name, so the browser keeps one copy of the parts.
    snapshot: () => fetchSnapshot(prebuilt.parts, { cache: `vitehub-tutorial-${props.template.snapshotOf}`, sha256: prebuilt.sha256 }),
    install: sameManifest ? false : "install",
  },
});
const states = computed(() => {
  const result: Partial<Record<ConnectProviderName, ConnectProviderState>> = {};
  for (const provider of connect.providers) {
    if (store.credentials.value[provider.name]) result[provider.name] = { status: "connected" };
  }
  return result;
});
// A new token takes effect when the dev server starts again with the new environment.
watch(() => store.credentials.value, () => {
  if (workspace.container.value && workspace.status.value === "ready") void workspace.restart();
});

const current = shallowRef(props.template);
const firstFile = (template: PlaygroundTemplate, files: TutorialFiles) => files[template.open] === undefined ? Object.keys(files).sort()[0] ?? "" : template.open;
const selected = ref(firstFile(props.template, props.files));
const previewPath = ref(props.template.preview);

// A path whose contents differ from the open template is an edit of the reader.
const edited = computed(() => {
  const base = current.value.files;
  const files = workspace.files.value;
  const paths = new Set([...Object.keys(base), ...Object.keys(files)]);
  return [...paths].filter(path => base[path] !== files[path]).sort();
});
const paths = computed(() => Object.keys(workspace.files.value).sort());
const source = computed({
  get: () => workspace.files.value[selected.value] ?? "",
  set: value => void workspace.setFiles({ [selected.value]: value }),
});
const booting = computed(() => workspace.status.value !== "ready" || !!workspace.failure.value || !workspace.previewUrl.value);

const confirm = ref<{ title: string, label: string, action: () => void }>();
function guard(title: string, label: string, action: () => void) {
  if (edited.value.length === 0) action();
  else confirm.value = { title, label, action };
}
function confirmAction() {
  confirm.value?.action();
  confirm.value = undefined;
}

async function open(template: PlaygroundTemplate) {
  // Another snapshot or an edited manifest needs a fresh dependency tree.
  if (template.snapshotOf !== props.template.snapshotOf || !sameManifest || workspace.files.value["package.json"] !== current.value.files["package.json"]) return emit("remount", template);
  current.value = template;
  selected.value = firstFile(template, template.files);
  previewPath.value = template.preview;
  emit("change", template);
  await workspace.setFiles(template.files, { mode: "replace" });
  // The Vite config can differ, so start the dev server again.
  await workspace.restart();
}
function pick(template: PlaygroundTemplate) {
  if (template.id === current.value.id && edited.value.length === 0) return;
  guard(`Open the ${template.label} template?`, "Replace files", () => void open(template));
}
const templateItems = computed(() => [
  [{ type: "label" as const, label: "Templates" }],
  props.templates.map(template => ({
    label: template.label,
    description: template.description,
    icon: template.id === current.value.id ? "i-lucide-check" : "i-lucide-box",
    onSelect: () => pick(template),
  })),
]);
const moreItems = computed(() => [[
  { label: "Restart dev server", icon: "i-lucide-refresh-cw", disabled: !workspace.container.value, onSelect: () => void workspace.restart() },
  { label: "Discard changes", icon: "i-lucide-rotate-ccw", disabled: edited.value.length === 0, onSelect: reset },
]]);

// The bottom panel holds the dev server output and the Connect form.
const panel = ref<"console" | "connect">("console");
const connected = computed(() => Object.keys(states.value).length);
const panelItems = computed(() => [
  { label: "Console", value: "console" as const, icon: "i-lucide-square-terminal" },
  { label: "Connect", value: "connect" as const, icon: "i-lucide-plug", badge: connected.value ? String(connected.value) : undefined },
]);

const runState = useRunState(workspace);

// An iframe takes the pointer events of a drag that crosses it, so the preview ignores them while a handle moves.
const dragging = ref(false);
const columns = [
  { id: "files", defaultSize: 18, minSize: 12, maxSize: 30, slot: "files" as const },
  { id: "code", defaultSize: 44, minSize: 25, slot: "code" as const },
  { id: "preview", defaultSize: 38, minSize: 20, slot: "preview" as const },
];
const rows = [
  { id: "editor", defaultSize: 68, minSize: 20, slot: "editor" as const },
  { id: "panel", defaultSize: 32, minSize: 12, slot: "panel" as const },
];

function reset() {
  // Remount the snapshot as well as the files, so shared dependencies and the running server are reset too.
  guard(`Discard your changes to the ${current.value.label} template?`, "Discard changes", () => emit("remount", current.value));
}

const toast = useToast();
const { copy } = useClipboard({ legacy: true });
async function share() {
  const code = await encodePlayground({ template: current.value.id, files: workspace.files.value }, current.value.files);
  const url = `${location.origin}${location.pathname}#${shareHashKey}=${code}`;
  if (url.length > shareLimit) {
    toast.add({
      title: "Too big for a link",
      description: `This link would have ${(url.length / 1000).toFixed(1)} KB, and a share link can have ${shareLimit / 1000} KB. Download the files instead.`,
      color: "warning",
      icon: "i-lucide-triangle-alert",
    });
    return;
  }
  await copy(url);
  toast.add({ title: "Link copied", description: "The link holds your files. Nothing is stored on a server.", icon: "i-lucide-link" });
}

function download() {
  downloadZip(workspace.files.value, `vitehub-${current.value.id}`);
}
</script>

<template>
  <div class="vh-playground-workspace" :class="{ 'is-dragging': dragging }">
    <header class="vh-pg-toolbar">
      <UDropdownMenu :items="templateItems" :content="{ align: 'start' }" :ui="{ content: 'w-64' }">
        <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-layout-template" trailing-icon="i-lucide-chevron-down" :aria-label="`Template: ${current.label}`">
          <span class="text-muted">Template</span>
          <span class="font-medium text-highlighted">{{ current.label }}</span>
        </UButton>
      </UDropdownMenu>
      <WorkspaceRunState class="ml-2" :tone="runState.tone" :label="runState.label" />
      <span class="flex-1" />
      <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-download" label="Download" @click="download" />
      <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-link" label="Copy link" @click="share" />
      <UDropdownMenu :items="moreItems" :content="{ align: 'end' }">
        <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-ellipsis" aria-label="More actions" />
      </UDropdownMenu>
    </header>

    <USplitter id="vh-pg-columns" auto-save-id="vitehub:playground:columns" :items="columns" :hit-area-margins="splitterHitArea" :ui="splitterUi" class="min-h-0 flex-1" @dragging="(_, value) => dragging = value">
      <template #files>
        <WorkspacePane label="Files" title="Files" class="vh-pg-files">
          <div class="min-h-0 flex-1 overflow-auto py-1">
            <WorkspaceFileTree v-model:selected="selected" :paths="paths" :modified="edited" />
          </div>
        </WorkspacePane>
      </template>

      <template #code>
        <USplitter id="vh-pg-rows" auto-save-id="vitehub:playground:rows" orientation="vertical" :items="rows" :hit-area-margins="splitterHitArea" :ui="splitterUi" class="min-w-0 flex-1" @dragging="(_, value) => dragging = value">
          <template #editor>
            <WorkspacePane label="Editor">
              <template #header>
                <span class="vh-pg-path">{{ selected }}</span>
                <span v-if="edited.includes(selected)" class="vh-pg-edited">Edited</span>
              </template>
              <WorkspaceEditor v-model="source" :path="selected" />
            </WorkspacePane>
          </template>

          <template #panel>
            <WorkspaceTabs v-model="panel" :items="panelItems">
              <template #console>
                <WorkspaceTerminal :output="workspace.logs.value" />
              </template>
              <template #connect>
                <div class="h-full overflow-auto">
                  <ConnectPanel
                    :connect="connect"
                    :states="states"
                    @connect="(name, token) => store.set(name, token)"
                    @disconnect="name => store.remove(name)"
                    @remove-all="store.clear()"
                    @copy-command="command => copy(command)"
                  />
                </div>
              </template>
            </WorkspaceTabs>
          </template>
        </USplitter>
      </template>

      <template #preview>
        <!-- The checklist takes the preview's place, so the reader can edit while the app starts. -->
        <WorkspacePane v-if="booting" label="Preview" title="Preview">
          <div class="vh-pg-boot">
            <WorkspaceBootStatus
              :status="workspace.status.value"
              :steps="workspace.steps.value"
              :failure="workspace.failure.value"
              :online="workspace.online.value"
              @retry="workspace.boot()"
              @retry-install="workspace.install()"
              @restart="workspace.restart()"
              @show-output="panel = 'console'"
            />
          </div>
        </WorkspacePane>
        <WorkspacePane v-else label="Preview">
          <WorkspacePreview v-model:path="previewPath" :url="workspace.previewUrl.value" />
        </WorkspacePane>
      </template>
    </USplitter>

    <UModal :open="!!confirm" :title="confirm?.title" description="Your edits to the current files are lost. Copy a link or download them first to keep them." @update:open="value => { if (!value) confirm = undefined }">
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="confirm = undefined" />
          <UButton color="neutral" :label="confirm?.label" @click="confirmAction" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.vh-playground-workspace {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

/* The preview iframe would take the pointer during a drag. */
.vh-playground-workspace.is-dragging :deep(iframe) {
  pointer-events: none;
}

.vh-pg-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
  height: 2.75rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0 0.5rem;
}

/* The file column is one tinted surface, header included. */
.vh-pg-files {
  background: var(--ui-bg-muted);
}

.vh-pg-files :deep(.vh-ws-file-tree) {
  --trees-bg-override: var(--ui-bg-muted);
}

.vh-pg-path {
  overflow: hidden;
  color: var(--ui-text);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-pg-edited {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
}

/* The checklist sits in the middle of the preview, with room on every side. */
.vh-pg-boot {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 2rem 1.5rem;
}
</style>
