<script setup lang="ts">
// `::product-files` shows example code as a set of file tabs. Each child code block names its file
// with a path, such as ```ts [server/workspaces/docs.ts]```. The tabs list folders first, like an
// editor, and the first code block opens first. A wide panel shows the tabs as a column beside the
// code. A narrow panel, such as a hero beside its copy, shows them as a row above the code.
import type { VNode } from "vue";

const slots = defineSlots<{ default?: () => VNode[] }>();

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
const selected = ref(files.value[0]?.path ?? "");

// The tabs show file names, so two files with the same name also show their folder.
const items = computed(() => {
  const names = files.value.map((file) => file.path.split("/").at(-1));
  const shared = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  return buildFileTree(files.value.map((file) => file.path)).flatMap((row) => {
    if (row.kind !== "file") return [];
    const parts = row.path.split("/");
    const folder = shared.has(row.name) && parts.length > 1 ? `${parts.at(-2)}/` : "";
    return [{ label: row.name, value: row.path, folder }];
  });
});
</script>

<template>
  <div class="vh-files-frame">
    <div class="vh-files">
      <!-- Both tab lists render on the server. The container query shows one, so the layout never moves. -->
      <UTabs v-model="selected" :items="items" :content="false" class="vh-files-tabs is-row items-start font-mono" aria-label="Example files">
        <template #default="{ item }">
          <span v-if="item.folder" class="text-dimmed">{{ item.folder }}</span>{{ item.label }}
        </template>
      </UTabs>
      <UTabs v-model="selected" :items="items" :content="false" orientation="vertical" class="vh-files-tabs is-column items-start font-mono" aria-label="Example files">
        <template #default="{ item }">
          <span v-if="item.folder" class="text-dimmed">{{ item.folder }}</span>{{ item.label }}
        </template>
      </UTabs>

      <div
        v-for="file in files"
        v-show="selected === file.path"
        :key="file.path"
        role="tabpanel"
        class="vh-files-code"
        :aria-label="file.path"
      >
        <p class="vh-files-path">{{ file.path }}</p>
        <div class="vh-files-body">
          <component :is="file.node" hide-header tabindex="-1" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The panel width, not the viewport, decides where the tabs go. */
.vh-files-frame {
  container-type: inline-size;
}

/* One framed code panel: the file tabs, then the code under a header with its path. */
.vh-files {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-bg);
}

@media (min-width: 40rem) {
  .vh-files {
    height: 26rem;
  }
}

.vh-files-tabs.is-column {
  display: none;
}

/* A row of many files scrolls instead of cutting the names. The padding keeps the list's bottom line in view. */
.vh-files-tabs.is-row {
  overflow-x: auto;
  padding-bottom: 1px;
  scrollbar-width: none;
}

.vh-files-tabs.is-row :deep([data-slot="list"]) {
  width: max-content;
  min-width: 100%;
}

.vh-files-tabs.is-row :deep([data-slot="trigger"]) {
  flex: none;
}

/* Wide panels: the tab column fits its longest name, so file names never truncate. The code takes the rest. */
@container (min-width: 44rem) {
  .vh-files {
    grid-template-columns: max-content minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  .vh-files-tabs.is-row {
    display: none;
  }

  .vh-files-tabs.is-column {
    display: flex;
    min-width: 9rem;
    overflow: hidden auto;
    border-right: 1px solid var(--ui-border);
    padding: 0.5rem;
  }

  .vh-files-code {
    grid-area: 1 / 2;
  }
}

.vh-files-code {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.vh-files-path {
  display: flex;
  min-height: 2.5rem;
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
