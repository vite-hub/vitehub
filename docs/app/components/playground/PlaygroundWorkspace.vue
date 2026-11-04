<script setup lang="ts">
import { fetchSnapshot } from "@vite-hub/web-container";
import { defineConnect } from "@vite-hub/web-container/connect";
import { ConnectPanel, type ConnectProviderState, useConnectStore } from "@vite-hub/ui/connect-panel";
import { useWorkspace } from "@vite-hub/ui/workspace";
import { WorkspaceBootStatus } from "@vite-hub/ui/workspace-boot-status";
import { WorkspaceEditor } from "@vite-hub/ui/workspace-editor";
import { WorkspaceFileTree } from "@vite-hub/ui/workspace-file-tree";
import { WorkspacePreview } from "@vite-hub/ui/workspace-preview";
import { WorkspaceShell } from "@vite-hub/ui/workspace-shell";
import { WorkspaceTerminal } from "@vite-hub/ui/workspace-terminal";
import { useClipboard } from "@vueuse/core";
import { encodePlayground, shareHashKey, shareLimit } from "~/utils/playground-share";
import { downloadZip } from "~/utils/zip";
import { dependencyKey } from "~~/modules/tutorials/steps";

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
const snapshotParts = props.template.snapshot;
const sameDependencies = dependencyKey(props.files["package.json"]) === dependencyKey(props.template.files["package.json"]);

// Tokens stay in this tab (sessionStorage). They reach the app only as environment variables of the dev server.
const connect = defineConnect({ anthropic: true, github: true, netlify: true, openai: true, vercel: true });
const store = useConnectStore();
const workspace = useWorkspace({
  files: props.files,
  port: appPort,
  env: store.env(connect),
  ...snapshotParts && {
    // The tutorial with the same dependencies uses this cache name, so the browser keeps one copy of the parts.
    snapshot: () => fetchSnapshot(snapshotParts, { cache: `vitehub-tutorial-${props.template.snapshotOf}` }),
    install: sameDependencies ? false : "install",
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
const firstFile = (files: TutorialFiles) => Object.keys(files).find(path => path.startsWith("server/api/") && !path.endsWith("health.get.ts")) ?? Object.keys(files).sort()[0] ?? "";
const selected = ref(firstFile(props.files));
const previewPath = ref("/api/health");

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
  // Another snapshot needs a new WebContainer.
  if (template.snapshotOf !== props.template.snapshotOf) return emit("remount", template);
  current.value = template;
  selected.value = firstFile(template.files);
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
  { type: "label" as const, label: "Templates" },
  ...props.templates.map(template => ({
    label: template.label,
    description: template.description,
    icon: template.id === current.value.id ? "i-lucide-check" : "i-lucide-file-code",
    onSelect: () => pick(template),
  })),
]);

function reset() {
  guard(`Discard your changes to the ${current.value.label} template?`, "Discard changes", () => void workspace.setFiles(current.value.files, { mode: "replace" }));
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
  <div class="vh-playground-workspace">
    <WorkspaceShell layout="playground" label="Playground workspace" class="min-h-0 flex-1">
      <template #toolbar>
        <UDropdownMenu :items="templateItems" :content="{ align: 'start' }" :ui="{ content: 'w-72' }">
          <UButton size="xs" color="neutral" variant="ghost" :label="current.label" icon="i-lucide-layout-template" trailing-icon="i-lucide-chevron-down" aria-label="Templates" />
        </UDropdownMenu>
        <span class="flex-1" />
        <UButton size="xs" color="neutral" variant="ghost" label="Copy link" icon="i-lucide-link" @click="share" />
        <UButton size="xs" color="neutral" variant="ghost" label="Download" icon="i-lucide-download" @click="download" />
        <UButton size="xs" color="neutral" variant="ghost" label="Reset" icon="i-lucide-rotate-ccw" :disabled="edited.length === 0" @click="reset" />
        <UButton size="xs" color="neutral" variant="ghost" label="Restart" icon="i-lucide-refresh-cw" :disabled="!workspace.container.value" @click="workspace.restart()" />
      </template>
      <template #files>
        <WorkspaceFileTree v-model:selected="selected" :paths="paths" :modified="edited" />
      </template>
      <template #editor>
        <WorkspaceEditor v-model="source" :path="selected" />
      </template>
      <template #preview>
        <!-- The checklist takes the preview's place, so the reader can edit while the app starts. -->
        <WorkspaceBootStatus
          v-if="booting"
          :status="workspace.status.value"
          :steps="workspace.steps.value"
          :failure="workspace.failure.value"
          :online="workspace.online.value"
          @retry="workspace.boot()"
          @retry-install="workspace.install()"
          @restart="workspace.restart()"
        />
        <WorkspacePreview v-else v-model:path="previewPath" :url="workspace.previewUrl.value" />
      </template>
      <template #terminal>
        <WorkspaceTerminal :output="workspace.logs.value" />
      </template>
      <template #connect>
        <ConnectPanel
          :connect="connect"
          :states="states"
          @connect="(name, token) => store.set(name, token)"
          @disconnect="name => store.remove(name)"
          @remove-all="store.clear()"
          @copy-command="command => copy(command)"
        />
      </template>
    </WorkspaceShell>

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
</style>
