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
  <FileTree :model="model" :paths="paths" aria-label="Skill files" />
</template>
