<script setup lang="ts">
import { WorkspaceEditor, WorkspaceEditorHead } from "@vite-hub/ui/workspace";
import { ref } from "vue";

const path = "src/model/name-tagger.model.ts";
const source = ref("import { defineModel, features as f, layers as l, int6 } from \"gpu-engine\"\n\nexport default defineModel({\n  name: \"name-tagger\",\n  net: [l.embed(20), l.conv({ taps: 3 }), l.biScan(20), l.dense(20, \"relu\")],\n  quant: int6({ qatFrom: 0.7 }),\n})\n");
const wrap = ref(true);
</script>

<template>
  <div class="mx-auto flex h-64 max-w-md flex-col overflow-hidden rounded-md border border-default">
    <div class="flex h-8 flex-none items-center border-b border-default pl-3 pr-1.5">
      <WorkspaceEditorHead v-model:wrap="wrap" :path="path" />
    </div>
    <WorkspaceEditor v-model="source" v-model:wrap="wrap" class="min-h-0 flex-1" :path="path" />
  </div>
</template>
