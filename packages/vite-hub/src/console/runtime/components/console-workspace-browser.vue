<script setup lang="ts">
import * as v from "valibot";
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from "vue";

import { requestConsole } from "../client/request";
import { querySelection, useConsoleQuery } from "../client/route-query";
import { consoleBytes } from "../client/format";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSessionCodePreview from "./console-session-code-preview.vue";
import ConsoleState from "./console-state.vue";
import { useConsoleWordWrap } from "./console-wrap";
import "./console-session.css";

const ConsoleFileTree = defineAsyncComponent(() => import("@vite-hub/ui/file-tree").then(module => module.FileTree));
const ConsoleFileDiff = defineAsyncComponent(() => import("@vite-hub/ui/file-diff").then(module => module.FileDiff));

/**
 * Browses one Workspace like the session Workspace: its refs and revisions, the file tree, then the open file. A changed
 * file opens as its diff against `main`. `vitehub workspaces files <name>` reads the same data.
 */
const props = defineProps<{
  /** Console route of the `workspaces.files` operation. */
  base: string;
  name: string;
}>();

const revisionSchema = v.object({
  createdAt: v.string(),
  id: v.string(),
  message: v.optional(v.string()),
  ref: v.string(),
});
const changeSchema = v.object({ path: v.string(), status: v.picklist(["added", "deleted", "modified"]) });
const descriptorSchema = v.object({
  base: v.optional(v.object({ ref: v.string(), revision: v.string() })),
  changes: v.optional(v.array(changeSchema)),
  history: v.optional(v.object({
    cursor: v.optional(v.string()),
    ref: v.optional(v.string()),
    refs: v.array(v.object({ head: revisionSchema, name: v.string() })),
    revisions: v.optional(v.array(revisionSchema)),
  })),
  paths: v.array(v.string()),
  ref: v.optional(v.string()),
  repository: v.string(),
  revision: v.string(),
});
const fileSchema = v.object({ content: v.string(), path: v.string(), revision: v.string(), size: v.number() });
type Descriptor = v.InferOutput<typeof descriptorSchema>;
type WorkspaceFile = v.InferOutput<typeof fileSchema>;
type Change = v.InferOutput<typeof changeSchema>;
type Revision = v.InferOutput<typeof revisionSchema>;

// The ref, revision, and file live in the URL, so a reload or a shared link opens the same view.
const { file: selectedPath, ref: selectedRef, revision: selectedRevision } = useConsoleQuery({
  file: querySelection(),
  ref: querySelection({ history: "push" }),
  revision: querySelection({ history: "push" }),
});
const descriptor = ref<Descriptor>();
const loading = ref(true);
const error = ref<unknown>();
const file = ref<WorkspaceFile>();
const baseContent = ref<string>();
const fileLoading = ref(false);
const fileError = ref<unknown>();
const diffOpen = ref(true);
const wrapLines = useConsoleWordWrap();
let request: AbortController | undefined;
let fileRequest: AbortController | undefined;
let historyRequest: AbortController | undefined;
let historyIdentity: string | undefined;
const revisions = ref<Revision[]>([]);
const historyCursor = ref<string>();
const historyLoading = ref(false);
const historyError = ref<unknown>();

const refs = computed(() => [...(descriptor.value?.history?.refs ?? [])].sort((left, right) =>
  Number(right.name === "main") - Number(left.name === "main") || right.head.createdAt.localeCompare(left.head.createdAt)));
// A Workspace can hold one ref per run, so a long list gets a filter.
const refFilter = ref("");
const visibleRefs = computed(() => {
  const query = refFilter.value.trim().toLowerCase();
  return query ? refs.value.filter(item => item.name.toLowerCase().includes(query)) : refs.value;
});
const activeRef = computed(() => descriptor.value?.ref ?? descriptor.value?.history?.ref);
const changes = computed(() => descriptor.value?.changes ?? []);
const selectedChange = computed(() => changes.value.find(change => change.path === selectedPath.value));
const showDiff = computed(() => Boolean(diffOpen.value && selectedChange.value && descriptor.value?.base && baseContent.value !== undefined));
const changeLabels: Record<Change["status"], string> = { added: "Added", deleted: "Deleted", modified: "Modified" };
const treeOptions = computed(() => ({
  density: "compact" as const,
  gitStatus: changes.value.filter(change => change.status !== "deleted"),
  onSelectionChange(paths: readonly string[]) {
    const path = paths.findLast(path => descriptor.value?.paths.includes(path));
    if (path) selectedPath.value = path;
  },
  search: true,
}));

function shortId(id: string): string {
  return id.replace(/^sha256[_:]/, "").slice(0, 7);
}

function subject(message?: string): string | undefined {
  return message?.split("\n", 1)[0]?.trim() || undefined;
}

async function load(): Promise<void> {
  request?.abort();
  historyRequest?.abort();
  historyLoading.value = false;
  historyError.value = undefined;
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = undefined;
  try {
    const result = v.parse(descriptorSchema, await requestConsole(props.base, {
      query: {
        name: props.name,
        ...(selectedRef.value ? { ref: selectedRef.value } : {}),
        ...(selectedRevision.value ? { revision: selectedRevision.value } : {}),
      },
      signal: controller.signal,
    }));
    if (request !== controller) return;
    descriptor.value = result;
    const identity = `${props.name}:${result.history?.ref ?? ""}`;
    if (historyIdentity !== identity) {
      historyIdentity = identity;
      revisions.value = result.history?.revisions ?? [];
      historyCursor.value = result.history?.cursor;
    }
    if (selectedPath.value && !result.paths.includes(selectedPath.value)) selectedPath.value = undefined;
    if (selectedPath.value) void loadFile(selectedPath.value);
  }
  catch (cause) {
    if (!controller.signal.aborted) error.value = cause;
  }
  finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
    }
  }
}

async function loadOlder(): Promise<void> {
  const current = descriptor.value;
  const cursor = historyCursor.value;
  if (!current?.history?.ref || !cursor || historyLoading.value || loading.value) return;
  const controller = new AbortController();
  historyRequest = controller;
  historyLoading.value = true;
  historyError.value = undefined;
  try {
    const page = v.parse(descriptorSchema, await requestConsole(props.base, {
      query: { name: props.name, ref: current.history.ref, revision: current.revision, cursor },
      signal: controller.signal,
    }));
    if (controller.signal.aborted) return;
    revisions.value = [...new Map([...revisions.value, ...(page.history?.revisions ?? [])].map(revision => [revision.id, revision])).values()];
    historyCursor.value = page.history?.cursor;
  }
  catch (cause) {
    if (!controller.signal.aborted) historyError.value = cause;
  }
  finally {
    if (historyRequest === controller) {
      historyRequest = undefined;
      historyLoading.value = false;
    }
  }
}

async function loadFile(path: string): Promise<void> {
  const current = descriptor.value;
  if (!current) return;
  fileRequest?.abort();
  const controller = new AbortController();
  fileRequest = controller;
  fileLoading.value = true;
  fileError.value = undefined;
  file.value = undefined;
  baseContent.value = undefined;
  const read = (revision: string) => requestConsole(props.base, { query: { name: props.name, path, revision }, signal: controller.signal }).then(value => v.parse(fileSchema, value));
  const change = current.changes?.find(entry => entry.path === path);
  try {
    const [loaded, before] = await Promise.all([
      read(current.revision),
      // An added file has no base, so its diff starts from an empty file.
      current.base && change ? change.status === "added" ? Promise.resolve(undefined) : read(current.base.revision) : Promise.resolve(undefined),
    ]);
    if (fileRequest !== controller) return;
    file.value = loaded;
    baseContent.value = current.base && change ? before?.content ?? "" : undefined;
  }
  catch (cause) {
    if (!controller.signal.aborted) fileError.value = cause;
  }
  finally {
    if (fileRequest === controller) {
      fileRequest = undefined;
      fileLoading.value = false;
    }
  }
}

function selectRef(name: string): void {
  selectedRevision.value = undefined;
  selectedRef.value = name;
}

function selectRevision(id: string): void {
  selectedRef.value = activeRef.value;
  selectedRevision.value = id;
}

watch(() => props.name, () => {
  descriptor.value = undefined;
  file.value = undefined;
}, { flush: "sync" });
watch([() => props.name, selectedRef, selectedRevision], () => void load(), { immediate: true });
watch(selectedPath, (path) => {
  if (path) void loadFile(path);
  else {
    fileRequest?.abort();
    file.value = undefined;
    baseContent.value = undefined;
  }
});
onBeforeUnmount(() => {
  request?.abort();
  fileRequest?.abort();
  historyRequest?.abort();
});
</script>

<template>
  <div class="workspace-browser" :aria-busy="loading">
    <nav class="workspace-browser__refs" aria-label="Refs and revisions">
      <h3><span>Refs</span><small v-if="refs.length">{{ refs.length }}</small></h3>
      <template v-if="refs.length">
        <UInput
          v-if="refs.length > 8"
          v-model="refFilter"
          size="sm"
          icon="i-lucide-search"
          placeholder="Filter refs…"
          aria-label="Filter refs"
          :ui="{ base: 'text-base sm:text-sm' }"
        />
        <p v-if="!visibleRefs.length" class="workspace-browser__note">No ref matches “{{ refFilter.trim() }}”.</p>
        <ul>
          <li v-for="item in visibleRefs" :key="item.name">
            <button type="button" :aria-current="item.name === activeRef ? 'true' : undefined" @click="selectRef(item.name)">
              <span class="workspace-browser__ref-name" :title="item.name">{{ item.name }}</span>
              <span class="workspace-browser__ref-meta">
                <code>{{ shortId(item.head.id) }}</code>
                <ConsoleRelativeTime :value="item.head.createdAt" />
              </span>
            </button>
          </li>
        </ul>
        <template v-if="revisions.length > 1 || historyCursor">
          <h3><span>Revisions on {{ activeRef }}</span><small>{{ revisions.length }}</small></h3>
          <ul>
            <li v-for="revision in revisions" :key="revision.id">
              <button
                type="button"
                :aria-current="revision.id === descriptor?.revision ? 'true' : undefined"
                :title="revision.message ?? revision.id"
                @click="selectRevision(revision.id)"
              >
                <span class="workspace-browser__ref-name">{{ subject(revision.message) ?? shortId(revision.id) }}</span>
                <span class="workspace-browser__ref-meta">
                  <code>{{ shortId(revision.id) }}</code>
                  <ConsoleRelativeTime :value="revision.createdAt" />
                </span>
              </button>
            </li>
          </ul>
          <button v-if="historyCursor" type="button" :disabled="historyLoading || loading" @click="loadOlder">
            {{ historyLoading ? "Loading revisions…" : "Load older" }}
          </button>
          <ConsoleState v-if="historyError" compact :error="historyError" title="Could not load older revisions" :retry="loadOlder" />
        </template>
      </template>
      <p v-else-if="descriptor" class="workspace-browser__note">
        {{ descriptor.revision === "current" ? "No retained history. These are the files the Workspace mounts now." : "One revision." }}
      </p>
    </nav>

    <aside class="workspace-browser__tree" aria-label="Files">
      <ConsoleFileTree v-if="descriptor" :key="`${descriptor.revision}`" class="session-inspector__tree" :paths="descriptor.paths" :options="treeOptions" />
      <div v-else-if="loading" class="grid gap-1.5 p-3">
        <USkeleton v-for="index in 6" :key="index" class="h-5 w-full" />
      </div>
    </aside>

    <section class="workspace-browser__file" aria-label="Open file">
      <header class="session-inspector__breadcrumbs">
        <span class="session-inspector__repository">{{ name }}</span>
        <template v-if="selectedPath">
          <template v-for="(segment, index) in selectedPath.split('/')" :key="`${segment}-${index}`">
            <UIcon name="i-lucide-chevron-right" />
            <span :data-current="index === selectedPath.split('/').length - 1">{{ segment }}</span>
          </template>
        </template>
        <div class="session-inspector__workspace-actions">
          <UTooltip v-if="selectedChange && descriptor?.base" :text="diffOpen ? 'Show the whole file' : `Show changes since ${descriptor.base.ref}`">
            <UButton
              icon="i-lucide-git-compare-arrows"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="diffOpen ? 'Show the whole file' : `Show changes since ${descriptor.base.ref}`"
              :aria-pressed="diffOpen"
              @click="diffOpen = !diffOpen"
            />
          </UTooltip>
          <UTooltip :text="wrapLines ? 'Disable line wrap' : 'Enable line wrap'">
            <UButton
              icon="i-lucide-wrap-text"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="wrapLines ? 'Disable line wrap' : 'Enable line wrap'"
              :aria-pressed="wrapLines"
              @click="wrapLines = !wrapLines"
            />
          </UTooltip>
          <UTooltip text="Reload">
            <UButton icon="i-lucide-rotate-cw" color="neutral" variant="ghost" size="xs" aria-label="Reload Workspace" :loading="loading" @click="load" />
          </UTooltip>
        </div>
      </header>
      <div class="workspace-browser__body">
        <ConsoleState v-if="error && !descriptor" :error="error" title="Couldn't open this Workspace" :retry="load" />
        <ConsoleState v-else-if="fileError" :error="fileError" title="Couldn't open this file" :retry="() => selectedPath && loadFile(selectedPath)" />
        <div v-else-if="fileLoading" class="session-inspector__state">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" />Loading file…
        </div>
        <ConsoleFileDiff
          v-else-if="selectedPath && file && showDiff"
          class="session-inspector__file-diff"
          :old-file="{ name: file.path, contents: baseContent ?? '' }"
          :new-file="{ name: file.path, contents: file.content }"
          :options="{ diffStyle: 'unified', overflow: wrapLines ? 'wrap' : 'scroll' }"
        />
        <ConsoleSessionCodePreview v-else-if="selectedPath && file" :content="file.content" :path="file.path" :wrap="wrapLines" />
        <section v-else-if="descriptor && changes.length" class="session-inspector__changes" aria-labelledby="workspace-browser-changes">
          <header>
            <strong id="workspace-browser-changes">Changes since {{ descriptor.base?.ref ?? "base" }}</strong>
            <small>{{ changes.length }} {{ changes.length === 1 ? "file" : "files" }}</small>
          </header>
          <ul>
            <li v-for="change in changes" :key="change.path">
              <button
                type="button"
                :disabled="change.status === 'deleted'"
                :title="change.status === 'deleted' ? `${change.path} is not in this revision` : `Open ${change.path}`"
                @click="selectedPath = change.path"
              >
                <span class="session-inspector__change-status" :data-status="change.status" :aria-label="changeLabels[change.status]">{{ change.status[0]!.toUpperCase() }}</span>
                <span class="session-inspector__change-path">{{ change.path }}</span>
              </button>
            </li>
          </ul>
        </section>
        <p v-else-if="descriptor" class="workspace-browser__hint">Choose a file in the tree.</p>
      </div>
      <footer v-if="descriptor" class="session-inspector__file-status">
        <span :title="descriptor.revision">{{ descriptor.revision === "current" ? "Mounted files" : `${activeRef ? `${activeRef} · ` : ""}${shortId(descriptor.revision)}` }}</span>
        <span v-if="selectedChange">{{ changeLabels[selectedChange.status] }} since {{ descriptor.base?.ref }}</span>
        <span>{{ descriptor.paths.length }} files<template v-if="file"> · {{ consoleBytes(file.size) }}</template></span>
      </footer>
    </section>
  </div>
</template>

<style>
/* Refs and revisions, then the file tree, then the open file, like the session Workspace. */
.workspace-browser {
  display: grid;
  grid-template-columns: 15rem 16rem minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

.workspace-browser__refs,
.workspace-browser__tree {
  border-inline-end: 1px solid var(--ui-border);
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
}

.workspace-browser__refs {
  display: grid;
  align-content: start;
  gap: 0.25rem;
  padding: 0.5rem;
}

.workspace-browser__refs h3 {
  align-items: baseline;
  color: var(--ui-text-dimmed);
  display: flex;
  font-size: 0.75rem;
  font-weight: 400;
  gap: 0.375rem;
  margin: 0.25rem 0 0;
  padding: 0.25rem 0.5rem;
}

.workspace-browser__refs h3 small {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.workspace-browser__refs ul {
  display: grid;
  gap: 1px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.workspace-browser__refs button {
  border-radius: 0.375rem;
  display: grid;
  gap: 0.125rem;
  padding: 0.375rem 0.5rem;
  text-align: start;
  transition: background-color 120ms;
  width: 100%;
}

.workspace-browser__refs button:hover,
.workspace-browser__refs button[aria-current="true"] {
  background: var(--ui-bg-elevated);
}

.workspace-browser__ref-name {
  color: var(--ui-text-highlighted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-browser__ref-meta {
  align-items: baseline;
  color: var(--ui-text-dimmed);
  display: flex;
  font-size: 0.6875rem;
  gap: 0.5rem;
  justify-content: space-between;
}

.workspace-browser__ref-meta code {
  font-variant-numeric: tabular-nums;
}

.workspace-browser__note,
.workspace-browser__hint {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
  margin: 0;
  padding: 0.5rem;
}

.workspace-browser__hint {
  align-self: center;
  justify-self: center;
}

.workspace-browser__file {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 0;
  min-width: 0;
}

.workspace-browser__body {
  display: grid;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

@media (max-width: 64rem) {
  .workspace-browser {
    grid-template-columns: 12rem minmax(0, 1fr);
    grid-template-rows: minmax(0, 14rem) minmax(0, 1fr);
  }

  .workspace-browser__file {
    grid-column: 1 / -1;
  }
}
</style>
