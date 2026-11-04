<script setup lang="ts">
import { FileTree, useFileTree } from "@vite-hub/ui";
import { watch } from "vue";

const props = defineProps<{ paths: readonly string[]; selected?: string }>();
const emit = defineEmits<{ select: [path: string] }>();
let syncing = false;
const model = useFileTree({
  paths: props.paths,
  density: "compact",
  search: true,
  unsafeCSS: `
    [data-file-tree-search-container] {
      padding-block: 0.5rem;
    }
    [data-file-tree-search-input] {
      box-sizing: border-box;
      min-width: 0;
      width: 100%;
      height: 2rem;
      font-size: 1rem;
    }
    @media (min-width: 640px) {
      [data-file-tree-search-input] { font-size: 0.8125rem; }
    }
  `,
  initialExpansion: "open",
  initialSelectedPaths: props.selected ? [props.selected] : [],
  onSelectionChange(paths) {
    if (syncing) return;
    const selected = paths.findLast(path => props.paths.includes(path));
    if (selected && selected !== props.selected) emit("select", selected);
  },
});
watch(() => props.selected, selected => {
  syncing = true;
  try {
    for (const path of model.getSelectedPaths()) {
      if (path !== selected) model.getItem(path)?.deselect();
    }
    if (selected) model.getItem(selected)?.select();
  } finally { syncing = false; }
});
</script>

<template>
  <FileTree class="skills-file-tree" :model="model" :paths="paths" aria-label="Skill files" />
</template>

<style scoped>
.skills-file-tree {
  --trees-padding-inline-override: 0.75rem;
  --trees-font-family-override: var(--font-sans);
  --trees-font-size-override: 0.8125rem;
  --trees-accent-override: var(--ui-primary);
  --trees-fg-override: var(--ui-text-toned);
  --trees-bg-override: var(--ui-bg);
  --trees-bg-muted-override: var(--ui-bg-elevated);
  --trees-border-color-override: var(--ui-border);
  --trees-input-bg-override: var(--ui-bg-elevated);
  --trees-selected-bg-override: var(--ui-bg-elevated);
  --trees-selected-fg-override: var(--ui-text-highlighted);
  height: 100%;
  min-height: 0;
  border: 0;
  border-radius: 0;
}
@media (min-width: 640px) {
  .skills-file-tree { --trees-padding-inline-override: 1rem; }
}
</style>
