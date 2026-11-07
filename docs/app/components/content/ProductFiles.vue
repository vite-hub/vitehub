<script setup lang="ts">
// `::product-files` shows example code as a project file tree. Each child code block names its file
// with a path, such as ```ts [server/workspaces/docs.ts]```. The tree lists folders first, like an
// editor, and the first code block opens first. Code blocks inside `::framework{name}` show only for the
// framework that the reader picked, and the header then shows the framework switch.
// In a narrow panel, such as a hero beside its copy, the
// tree becomes one row of file tabs above the code, so the code keeps the width.
import { useElementSize } from "@vueuse/core";
import type { VNode } from "vue";
import { isFramework } from "~/utils/framework";
import type { Framework } from "~/utils/framework";

const slots = defineSlots<{ default?: () => VNode[] }>();
const id = useId();
const selected = ref(0);
const tree = useTemplateRef<HTMLElement>("tree");
const framework = useFramework();
const frame = useTemplateRef<HTMLElement>("frame");
// The tree is a column from 44rem of panel width, the same width as the container query below.
const { width } = useElementSize(frame);
const orientation = computed(() => (width.value === 0 ? undefined : width.value >= 704 ? "vertical" : "horizontal"));

// A `::framework{name}` block is the node whose `name` prop is a framework. Content components resolve lazily, so the
// node type differs between the server and the browser and cannot tell. Code blocks have a `filename`, never a `name`.
function frameworkOf(node: VNode): Framework | undefined {
  const name: unknown = node.props?.name;
  return isFramework(name) ? name : undefined;
}

function slotNodes(node: VNode): VNode[] {
  const children: unknown = node.children;
  if (typeof children !== "object" || children === null || !("default" in children)) return [];
  const slot: unknown = children.default;
  return typeof slot === "function" ? slot() : [];
}

function flatten(nodes: VNode[], all = false): VNode[] {
  return nodes.flatMap((node) => {
    if (typeof node.type === "symbol" && Array.isArray(node.children)) return flatten(node.children as VNode[], all);
    const name = frameworkOf(node);
    if (name === undefined) return [node];
    return all || name === framework.value ? [node, ...flatten(slotNodes(node), all)] : [];
  });
}

const files = computed(() =>
  flatten(slots.default?.() ?? [])
    .map((node) => ({ node, path: String(node.props?.filename ?? "") }))
    .filter((file) => file.path),
);
const switchable = computed(() => flatten(slots.default?.() ?? [], true).some((node) => frameworkOf(node) !== undefined));

// A framework switch keeps the open file when the other framework has a file with the same path.
watch(files, (next, previous) => {
  const path = previous[selected.value]?.path;
  const index = next.findIndex((file) => file.path === path);
  selected.value = index >= 0 ? index : 0;
});

const rows = computed(() => buildFileTree(files.value.map((file) => file.path)));

// The row of tabs hides the folders, so two files with the same name also show their folder.
const sharedNames = computed(() => {
  const names = files.value.map((file) => file.path.split("/").at(-1));
  return new Set(names.filter((name, index) => names.indexOf(name) !== index));
});

function folderOf(path: string) {
  const parts = path.split("/");
  return sharedNames.value.has(parts.at(-1)) && parts.length > 1 ? `${parts.at(-2)}/` : "";
}

// The file rows are tabs. Arrow keys move through them in tree order. The tree is a column or a row,
// depending on the panel width, so both arrow pairs work.
function onTreeKeydown(event: KeyboardEvent) {
  const order = rows.value.flatMap((row) => (row.kind === "file" ? [row.index] : []));
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  const target = event.key === "Home" ? order[0] : event.key === "End" ? order.at(-1)
    : step ? order[(order.indexOf(selected.value) + step + order.length) % order.length] : undefined;
  if (target === undefined) return;
  event.preventDefault();
  selected.value = target;
  tree.value?.querySelector<HTMLElement>(`[data-index="${target}"]`)?.focus();
}
</script>

<template>
  <div ref="frame" class="vh-files-frame">
  <div class="vh-files">
    <div ref="tree" class="vh-files-tree" role="tablist" aria-label="Example files" :aria-orientation="orientation" @keydown="onTreeKeydown">
      <template v-for="row in rows" :key="row.path">
        <div v-if="row.kind === 'folder'" class="vh-files-row is-folder" role="presentation" :style="{ '--depth': row.depth }">
          <UIcon name="i-lucide-folder-open" class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ row.name }}</span>
        </div>
        <button
          v-else
          :id="`${id}-tab-${row.index}`"
          type="button"
          role="tab"
          class="vh-files-row is-file"
          :style="{ '--depth': row.depth }"
          :data-index="row.index"
          :data-state="selected === row.index ? 'active' : 'inactive'"
          :aria-selected="selected === row.index"
          :aria-controls="`${id}-panel-${row.index}`"
          :aria-label="row.path"
          :tabindex="selected === row.index ? 0 : -1"
          @click="selected = row.index"
        >
          <UIcon name="i-lucide-file" class="size-3.5 shrink-0" aria-hidden="true" />
          <span><span v-if="folderOf(row.path)" class="vh-files-folder">{{ folderOf(row.path) }}</span>{{ row.name }}</span>
        </button>
      </template>
    </div>

    <div
      v-for="(file, index) in files"
      :id="`${id}-panel-${index}`"
      :key="file.path"
      role="tabpanel"
      class="vh-files-code"
      :data-state="selected === index ? 'active' : 'inactive'"
      :aria-labelledby="`${id}-tab-${index}`"
    >
      <div class="vh-files-path">
        <span>{{ file.path }}</span>
        <FrameworkSwitch v-if="switchable" />
      </div>
      <div class="vh-files-body">
        <component :is="file.node" hide-header tabindex="-1" />
      </div>
    </div>
  </div>
  </div>
</template>

<style scoped>
/* The panel width, not the viewport, decides where the tree goes. */
.vh-files-frame {
  container-type: inline-size;
}

/* One framed panel, like a small editor: the tree on a tinted pane, the code under a header with its path. */
.vh-files {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 3);
  background: var(--ui-bg);
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.04),
    0 12px 32px -16px rgb(0 0 0 / 0.16);
}

@media (min-width: 40rem) {
  .vh-files {
    height: 26rem;
  }
}

/* Narrow panels: the files are one row of tabs. The path header names the folder. */
.vh-files-tree {
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  white-space: nowrap;
  scrollbar-width: none;
}

.vh-files-row.is-folder {
  display: none;
}

.vh-files-folder {
  color: var(--ui-text-dimmed);
}

/* Wide panels: the tree column fits its longest name, so file names never truncate. The code takes the rest. */
@container (min-width: 44rem) {
  .vh-files {
    grid-template-columns: max-content minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  .vh-files-tree {
    min-width: 9rem;
    flex-direction: column;
    overflow: hidden auto;
    border-right: 1px solid var(--ui-border);
    border-bottom: 0;
    padding: 0.5rem 0.25rem;
  }

  .vh-files-row.is-folder {
    display: flex;
  }

  .vh-files-folder {
    display: none;
  }

  .vh-files-code {
    grid-area: 1 / 2;
  }
}

.vh-files-row {
  display: flex;
  min-height: 1.75rem;
  flex: none;
  align-items: center;
  gap: 0.4375rem;
  border-radius: var(--ui-radius);
  padding-inline: 0.5rem;
  color: var(--ui-text-muted);
  text-align: start;
}

@container (min-width: 44rem) {
  .vh-files-row {
    padding-inline: calc(0.375rem + var(--depth) * 0.75rem) 0.375rem;
  }
}

.vh-files-row.is-folder {
  color: var(--ui-text-dimmed);
}

.vh-files-row.is-file {
  cursor: pointer;
  transition:
    background-color 150ms ease,
    color 150ms ease;
}

.vh-files-row.is-file:hover {
  color: var(--ui-text-highlighted);
}

.vh-files-row.is-file[data-state="active"] {
  background: color-mix(in srgb, var(--ui-text-highlighted) 7%, transparent);
  color: var(--ui-text-highlighted);
}

.vh-files-row.is-file:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

/* Inactive files stay mounted but hidden, so switching files does not move the page. */
.vh-files-code {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.vh-files-code[data-state="inactive"] {
  display: none;
}

/* The header lines up with the first tree row. */
.vh-files-path {
  display: flex;
  min-height: 2.75rem;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0;
  border-bottom: 1px solid var(--ui-border);
  padding-inline: 0.75rem;
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.vh-files-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0.875rem 0.75rem 1rem;
}

.vh-files-body :deep(pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  font-size: 0.75rem;
  line-height: 1.85;
  white-space: pre;
}

.vh-files-body :deep(> div) {
  margin: 0;
}
</style>
