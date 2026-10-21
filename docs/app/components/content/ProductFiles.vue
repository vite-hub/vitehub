<script setup lang="ts">
// `::product-files` shows example code as a project file tree. Each child code block names its file
// with a path, such as ```ts [server/workspaces/docs.ts]```. The tree lists folders first, like an
// editor, and the first code block opens first.
import type { VNode } from "vue";

const slots = defineSlots<{ default?: () => VNode[] }>();
const id = useId();
const selected = ref(0);
const tree = useTemplateRef<HTMLElement>("tree");

function flatten(nodes: VNode[]): VNode[] {
  return nodes.flatMap((node) =>
    typeof node.type === "symbol" && Array.isArray(node.children) ? flatten(node.children as VNode[]) : [node],
  );
}

const files = computed(() =>
  flatten(slots.default?.() ?? [])
    .map((node) => ({ node, path: String(node.props?.filename ?? "") }))
    .filter((file) => file.path),
);

const rows = computed(() => buildFileTree(files.value.map((file) => file.path)));

// The file rows are tabs. Arrow keys move through them in tree order, like a vertical tab list.
function onTreeKeydown(event: KeyboardEvent) {
  const order = rows.value.flatMap((row) => (row.kind === "file" ? [row.index] : []));
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  const target = event.key === "Home" ? order[0] : event.key === "End" ? order.at(-1)
    : step ? order[(order.indexOf(selected.value) + step + order.length) % order.length] : undefined;
  if (target === undefined) return;
  event.preventDefault();
  selected.value = target;
  tree.value?.querySelector<HTMLElement>(`[data-index="${target}"]`)?.focus();
}
</script>

<template>
  <div class="vh-files">
    <div ref="tree" class="vh-files-tree" role="tablist" aria-orientation="vertical" aria-label="Example files" @keydown="onTreeKeydown">
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
          <span>{{ row.name }}</span>
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
      <p class="vh-files-path">{{ file.path }}</p>
      <div class="vh-files-body">
        <component :is="file.node" hide-header tabindex="-1" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* One framed panel, like a small editor: the tree on a tinted pane, the code under a header with its path. */
.vh-files {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 3);
  background: var(--ui-bg);
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.04),
    0 12px 32px -16px rgb(0 0 0 / 0.16);
}

/* The tree column fits its longest name, so file names never truncate. The code takes the rest and scrolls. */
@media (min-width: 40rem) {
  .vh-files {
    height: 26rem;
    grid-template-columns: max-content minmax(0, 1fr);
  }
}

.vh-files-tree {
  display: flex;
  min-width: 9rem;
  flex-direction: column;
  overflow-y: auto;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  padding: 0.5rem 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  white-space: nowrap;
}

@media (min-width: 40rem) {
  .vh-files-tree {
    border-right: 1px solid var(--ui-border);
    border-bottom: 0;
  }
}

.vh-files-row {
  display: flex;
  min-height: 1.75rem;
  align-items: center;
  gap: 0.4375rem;
  border-radius: var(--ui-radius);
  padding-inline: calc(0.375rem + var(--depth) * 0.75rem) 0.375rem;
  color: var(--ui-text-muted);
  text-align: start;
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

@media (min-width: 40rem) {
  .vh-files-code {
    grid-area: 1 / 2;
  }
}

/* The header lines up with the first tree row. */
.vh-files-path {
  display: flex;
  min-height: 2.75rem;
  flex: none;
  align-items: center;
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
